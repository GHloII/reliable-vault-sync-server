import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  ClientChange,
  IncrementalSyncResponse,
  ManifestEntry,
  ManifestResponse,
  MergeConflict,
  SnapshotFile,
  SyncResponse
} from "../../shared/src/protocol";
import { INCREMENTAL_PROTOCOL_VERSION, PROTOCOL_VERSION } from "../../shared/src/protocol";
import { isTransientSyncPath } from "../../shared/src/path-mapper";
import { mergeIndependentTextChanges } from "../../shared/src/three-way-merge";
import { gitIdentityEnv, runGit } from "./git";
import { KeyedLock } from "./lock";

const EMPTY_SHA256 = createHash("sha256").update(Buffer.alloc(0)).digest("hex");

function validateId(value: string, label: string): string {
  if (!/^[a-zA-Z0-9._-]{1,80}$/.test(value)) {
    throw new Error(`${label} contains unsupported characters`);
  }
  return value;
}

export function validateRemotePath(value: string): string {
  if (!value || value.includes("\\") || value.includes("\0") || isAbsolute(value)) {
    throw new Error("Invalid remote path");
  }
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment === ".git")) {
    throw new Error("Invalid remote path");
  }
  return segments.join("/");
}

function worktreePath(root: string, remotePath: string): string {
  const candidate = resolve(root, ...validateRemotePath(remotePath).split("/"));
  const expectedPrefix = `${resolve(root)}${sep}`;
  if (!candidate.startsWith(expectedPrefix)) {
    throw new Error("Remote path escapes the worktree");
  }
  return candidate;
}

function isBinary(buffer: Buffer | null): boolean {
  return buffer?.includes(0) ?? false;
}

function gitBlobObjectHash(content: Buffer): string {
  const header = Buffer.from(`blob ${content.length}\0`, "utf8");
  return createHash("sha1").update(header).update(content).digest("hex");
}

async function listFiles(root: string, current = root): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === ".git") {
      continue;
    }
    const absolute = join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(root, absolute));
    } else if (entry.isFile()) {
      files.push(relative(root, absolute).split(sep).join("/"));
    }
  }
  return files;
}

export interface GitVaultStoreOptions {
  dataDir: string;
}

type MutationResult =
  | { status: "ok"; revision: string }
  | { status: "conflict"; serverRevision: string; clientRevision: string; conflicts: MergeConflict[] };

export class GitVaultStore {
  private readonly dataDir: string;
  private readonly lock = new KeyedLock();

  constructor(options: GitVaultStoreOptions) {
    this.dataDir = resolve(options.dataDir);
  }

  async sync(vaultIdInput: string, deviceIdInput: string, baseRevision: string | null, changes: ClientChange[]): Promise<SyncResponse> {
    const vaultId = validateId(vaultIdInput, "vaultId");
    const deviceId = validateId(deviceIdInput, "deviceId");
    return await this.lock.run(vaultId, async () => {
      const repo = await this.ensureRepository(vaultId);
      const result = await this.applyChanges(repo, deviceId, baseRevision, changes);
      if (result.status === "ok") {
        return {
          protocolVersion: PROTOCOL_VERSION,
          status: "ok",
          revision: result.revision,
          snapshot: await this.snapshot(repo, result.revision)
        };
      }
      return {
        protocolVersion: PROTOCOL_VERSION,
        status: "conflict",
        serverRevision: result.serverRevision,
        clientRevision: result.clientRevision,
        snapshot: await this.snapshot(repo, result.serverRevision),
        conflicts: result.conflicts
      };
    });
  }

  async syncIncremental(
    vaultIdInput: string,
    deviceIdInput: string,
    baseRevision: string | null,
    changes: ClientChange[]
  ): Promise<IncrementalSyncResponse> {
    const vaultId = validateId(vaultIdInput, "vaultId");
    const deviceId = validateId(deviceIdInput, "deviceId");
    return await this.lock.run(vaultId, async () => {
      const repo = await this.ensureRepository(vaultId);
      const result = await this.applyChanges(repo, deviceId, baseRevision, changes);
      return { protocolVersion: INCREMENTAL_PROTOCOL_VERSION, ...result };
    });
  }

  async manifest(vaultIdInput: string): Promise<ManifestResponse> {
    const vaultId = validateId(vaultIdInput, "vaultId");
    return await this.lock.run(vaultId, async () => {
      const repo = await this.ensureRepository(vaultId);
      const revision = await this.head(repo);
      return {
        protocolVersion: INCREMENTAL_PROTOCOL_VERSION,
        revision,
        files: await this.manifestAt(repo, revision)
      };
    });
  }

  async readRevisionFile(vaultIdInput: string, revision: string, pathInput: string): Promise<Buffer | null> {
    const vaultId = validateId(vaultIdInput, "vaultId");
    const path = validateRemotePath(pathInput);
    if (isTransientSyncPath(path)) {
      return null;
    }
    return await this.lock.run(vaultId, async () => {
      const repo = await this.ensureRepository(vaultId);
      await this.assertCommit(repo, revision);
      const result = await runGit(["--git-dir", repo, "show", `${revision}:${path}`], { allowFailure: true });
      return result.code === 0 ? result.stdout : null;
    });
  }

  private async applyChanges(
    repo: string,
    deviceId: string,
    baseRevision: string | null,
    changes: ClientChange[]
  ): Promise<MutationResult> {
    const serverRevision = await this.head(repo);
    const base = baseRevision ?? await this.rootRevision(repo);
    await this.assertCommit(repo, base);
    const currentFiles = new Map((await this.manifestAt(repo, serverRevision)).map((entry) => [entry.path, entry.hash]));
    const effectiveChanges = changes.filter((change) => {
      if (isTransientSyncPath(change.path)) {
        return false;
      }
      const currentHash = currentFiles.get(change.path);
      if (change.type === "delete") {
        return currentHash !== undefined;
      }
      return currentHash !== gitBlobObjectHash(Buffer.from(change.contentBase64, "base64"));
    });
    if (effectiveChanges.length === 0) {
      return { status: "ok", revision: serverRevision };
    }
    const clientRevision = await this.createClientCommit(repo, base, deviceId, effectiveChanges);

    if (clientRevision === base) {
      return { status: "ok", revision: serverRevision };
    }
    if (serverRevision === base) {
      await runGit(["--git-dir", repo, "update-ref", "refs/heads/main", clientRevision, serverRevision]);
      return { status: "ok", revision: clientRevision };
    }

    const merge = await this.merge(repo, serverRevision, clientRevision, deviceId);
    if (merge.status === "conflict") {
      const conflictRef = `refs/vault-sync-conflicts/${deviceId}/${Date.now()}-${randomUUID()}`;
      await runGit(["--git-dir", repo, "update-ref", conflictRef, clientRevision]);
      return {
        status: "conflict",
        serverRevision,
        clientRevision,
        conflicts: merge.conflicts
      };
    }

    await runGit(["--git-dir", repo, "update-ref", "refs/heads/main", merge.revision, serverRevision]);
    return { status: "ok", revision: merge.revision };
  }

  private repositoryPath(vaultId: string): string {
    return join(this.dataDir, `${vaultId}.git`);
  }

  private async ensureRepository(vaultId: string): Promise<string> {
    await mkdir(this.dataDir, { recursive: true });
    const repo = this.repositoryPath(vaultId);
    try {
      await stat(join(repo, "HEAD"));
      await this.configureRepository(repo);
      return repo;
    } catch {
      await mkdir(repo, { recursive: true });
      await runGit(["init", "--bare", "--initial-branch=main", repo]);
      await this.configureRepository(repo);
      const tree = (await runGit(["--git-dir", repo, "mktree"], { input: "" })).stdout.toString("utf8").trim();
      const commit = (await runGit(["--git-dir", repo, "commit-tree", tree, "-m", "Initialize vault"], {
        env: gitIdentityEnv("server")
      })).stdout.toString("utf8").trim();
      await runGit(["--git-dir", repo, "update-ref", "refs/heads/main", commit]);
      return repo;
    }
  }

  private async configureRepository(repo: string): Promise<void> {
    await runGit(["--git-dir", repo, "config", "core.autocrlf", "false"]);
    await runGit(["--git-dir", repo, "config", "core.safecrlf", "false"]);
    await runGit(["--git-dir", repo, "config", "gc.auto", "0"]);
    await runGit(["--git-dir", repo, "config", "maintenance.auto", "false"]);
    await mkdir(join(repo, "info"), { recursive: true });
    await writeFile(join(repo, "info", "attributes"), "* -text merge=text\n");
  }

  private async head(repo: string): Promise<string> {
    return (await runGit(["--git-dir", repo, "rev-parse", "refs/heads/main"])).stdout.toString("utf8").trim();
  }

  private async rootRevision(repo: string): Promise<string> {
    return (await runGit(["--git-dir", repo, "rev-list", "--max-parents=0", "refs/heads/main"])).stdout.toString("utf8").trim().split(/\s+/)[0] ?? "";
  }

  private async assertCommit(repo: string, revision: string): Promise<void> {
    const result = await runGit(["--git-dir", repo, "cat-file", "-e", `${revision}^{commit}`], { allowFailure: true });
    if (result.code !== 0) {
      throw new Error("Unknown base revision; a full rebase is required");
    }
  }

  private async withWorktree<T>(repo: string, revision: string, operation: (directory: string) => Promise<T>): Promise<T> {
    const directory = await mkdtemp(join(tmpdir(), "vault-sync-"));
    await rm(directory, { recursive: true, force: true });
    await runGit(["--git-dir", repo, "worktree", "add", "--detach", directory, revision]);
    try {
      return await operation(directory);
    } finally {
      await runGit(["--git-dir", repo, "worktree", "remove", "--force", directory], { allowFailure: true });
      await rm(directory, { recursive: true, force: true });
      await runGit(["--git-dir", repo, "worktree", "prune"], { allowFailure: true });
    }
  }

  private async createClientCommit(repo: string, base: string, deviceId: string, changes: ClientChange[]): Promise<string> {
    return await this.withWorktree(repo, base, async (directory) => {
      for (const change of changes) {
        const path = worktreePath(directory, change.path);
        if (change.type === "put") {
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, Buffer.from(change.contentBase64, "base64"));
        } else {
          await rm(path, { recursive: true, force: true });
        }
      }
      await runGit(["add", "-A"], { cwd: directory });
      const diff = await runGit(["diff", "--cached", "--quiet"], { cwd: directory, allowFailure: true });
      if (diff.code === 0) {
        return base;
      }
      if (diff.code !== 1) {
        throw new Error(diff.stderr.toString("utf8") || "Unable to inspect client changes");
      }
      await runGit(["commit", "-m", `Sync from ${deviceId}`], {
        cwd: directory,
        env: gitIdentityEnv(deviceId)
      });
      return (await runGit(["rev-parse", "HEAD"], { cwd: directory })).stdout.toString("utf8").trim();
    });
  }

  private async merge(repo: string, serverRevision: string, clientRevision: string, deviceId: string): Promise<{ status: "ok"; revision: string } | { status: "conflict"; conflicts: MergeConflict[] }> {
    return await this.withWorktree(repo, serverRevision, async (directory) => {
      const result = await runGit(["merge", "--no-ff", "--no-edit", clientRevision], {
        cwd: directory,
        env: gitIdentityEnv(deviceId),
        allowFailure: true
      });
      if (result.code === 0) {
        const revision = (await runGit(["rev-parse", "HEAD"], { cwd: directory })).stdout.toString("utf8").trim();
        const [mergedTree, serverTree] = await Promise.all([
          runGit(["rev-parse", `${revision}^{tree}`], { cwd: directory }),
          runGit(["rev-parse", `${serverRevision}^{tree}`], { cwd: directory })
        ]);
        if (mergedTree.stdout.equals(serverTree.stdout)) {
          return { status: "ok", revision: serverRevision };
        }
        return { status: "ok", revision };
      }

      const namesResult = await runGit(["diff", "--name-only", "--diff-filter=U", "-z"], { cwd: directory });
      const paths = namesResult.stdout.toString("utf8").split("\0").filter(Boolean);
      if (paths.length === 0) {
        throw new Error(`Git merge failed without conflicts: ${result.stderr.toString("utf8").trim()}`);
      }
      const conflicts: MergeConflict[] = [];
      const automaticallyMerged: Array<{ path: string; content: Buffer }> = [];
      for (const path of paths) {
        const base = await this.readStage(directory, 1, path);
        const remote = await this.readStage(directory, 2, path);
        const local = await this.readStage(directory, 3, path);
        const kind = base === null || local === null || remote === null
          ? "delete-modify"
          : isBinary(base) || isBinary(local) || isBinary(remote)
            ? "binary"
            : "text";
        if (kind === "text") {
          const merged = mergeIndependentTextChanges(
            base!.toString("utf8"),
            local!.toString("utf8"),
            remote!.toString("utf8")
          );
          if (merged !== null) {
            automaticallyMerged.push({ path, content: Buffer.from(merged, "utf8") });
          }
        }
        conflicts.push({
          path,
          kind,
          baseBase64: base?.toString("base64") ?? null,
          localBase64: local?.toString("base64") ?? null,
          remoteBase64: remote?.toString("base64") ?? null
        });
      }
      if (automaticallyMerged.length === conflicts.length) {
        for (const merged of automaticallyMerged) {
          const path = worktreePath(directory, merged.path);
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, merged.content);
        }
        await runGit(["add", "-A"], { cwd: directory });
        await runGit(["commit", "--no-edit"], { cwd: directory, env: gitIdentityEnv(deviceId) });
        const revision = (await runGit(["rev-parse", "HEAD"], { cwd: directory })).stdout.toString("utf8").trim();
        return { status: "ok", revision };
      }
      await runGit(["merge", "--abort"], { cwd: directory, allowFailure: true });
      return { status: "conflict", conflicts };
    });
  }

  private async readStage(directory: string, stage: number, path: string): Promise<Buffer | null> {
    const result = await runGit(["show", `:${stage}:${path}`], { cwd: directory, allowFailure: true });
    return result.code === 0 ? result.stdout : null;
  }

  private async manifestAt(repo: string, revision: string): Promise<ManifestEntry[]> {
    const result = await runGit(["--git-dir", repo, "ls-tree", "-r", "-z", "--long", revision]);
    const entries: ManifestEntry[] = [];
    for (const record of result.stdout.toString("utf8").split("\0")) {
      if (!record) {
        continue;
      }
      const match = record.match(/^\d+ blob ([0-9a-f]+)\s+(\d+)\t([\s\S]+)$/);
      if (match === null) {
        continue;
      }
      entries.push({
        path: match[3]!,
        hash: match[1]!,
        size: Number.parseInt(match[2]!, 10)
      });
    }
    return entries.filter((entry) => !isTransientSyncPath(entry.path));
  }

  private async snapshot(repo: string, revision: string): Promise<SnapshotFile[]> {
    return await this.withWorktree(repo, revision, async (directory) => {
      const paths = await listFiles(directory);
      const syncedPaths = paths.filter((path) => !isTransientSyncPath(path));
      syncedPaths.sort((left, right) => left.localeCompare(right));
      return await Promise.all(syncedPaths.map(async (path) => {
        const content = await readFile(worktreePath(directory, path));
        return {
          path,
          contentBase64: content.toString("base64"),
          hash: createHash("sha256").update(content).digest("hex") || EMPTY_SHA256
        };
      }));
    });
  }
}
