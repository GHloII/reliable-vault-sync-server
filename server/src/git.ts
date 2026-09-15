import { spawn } from "node:child_process";

export interface GitResult {
  code: number;
  stdout: Buffer;
  stderr: Buffer;
}

export interface GitOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string | Buffer;
  allowFailure?: boolean;
}

export async function runGit(args: string[], options: GitOptions = {}): Promise<GitResult> {
  return await new Promise<GitResult>((resolve, reject) => {
    const child = spawn("git", args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      const result: GitResult = {
        code: code ?? -1,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr)
      };
      if (result.code !== 0 && !options.allowFailure) {
        reject(new Error(`git ${args.join(" ")} failed: ${result.stderr.toString("utf8").trim()}`));
        return;
      }
      resolve(result);
    });
    if (options.input !== undefined) {
      child.stdin.end(options.input);
    } else {
      child.stdin.end();
    }
  });
}

export function gitIdentityEnv(deviceId: string): NodeJS.ProcessEnv {
  const safeDeviceId = deviceId.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "unknown";
  return {
    GIT_AUTHOR_NAME: `Vault Sync ${safeDeviceId}`,
    GIT_AUTHOR_EMAIL: `${safeDeviceId}@vault-sync.local`,
    GIT_COMMITTER_NAME: "Vault Sync Server",
    GIT_COMMITTER_EMAIL: "server@vault-sync.local"
  };
}
