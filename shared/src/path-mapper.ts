import type { PlatformProfile } from "./protocol";

export interface PathMapperOptions {
  configDir: string;
  platform: PlatformProfile;
  syncPluginId: string;
}

const DEVICE_LOCAL_CONFIG = new Set([
  "workspace.json",
  "workspace-mobile.json",
  "cache"
]);

const PLATFORM_CONFIG = new Set([
  "community-plugins.json"
]);

const TRANSIENT_FILE_NAMES = new Set([
  ".DS_Store",
  "Thumbs.db",
  "desktop.ini"
]);

function cleanPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

function isInside(path: string, parent: string): boolean {
  return path === parent || path.startsWith(`${parent}/`);
}

export function isTransientSyncPath(path: string): boolean {
  return cleanPath(path).split("/").some((segment) =>
    TRANSIENT_FILE_NAMES.has(segment) || segment.startsWith("._")
  );
}

export class SyncPathMapper {
  private readonly configDir: string;
  private readonly platform: PlatformProfile;
  private readonly ownPluginDir: string;

  constructor(options: PathMapperOptions) {
    this.configDir = cleanPath(options.configDir);
    this.platform = options.platform;
    this.ownPluginDir = `${this.configDir}/plugins/${options.syncPluginId}`;
  }

  toRemote(localPath: string): string | null {
    const path = cleanPath(localPath);
    if (!path || isTransientSyncPath(path) || path === ".git" || isInside(path, ".git") || path === ".trash" || isInside(path, ".trash")) {
      return null;
    }
    if (isInside(path, this.ownPluginDir)) {
      return null;
    }
    if (!isInside(path, this.configDir)) {
      return `vault/${path}`;
    }

    const relative = path.slice(this.configDir.length + 1);
    if (!relative || DEVICE_LOCAL_CONFIG.has(relative) || relative.startsWith("cache/")) {
      return null;
    }
    if (PLATFORM_CONFIG.has(relative)) {
      return `config/${this.platform}/${relative}`;
    }
    return `config/shared/${relative}`;
  }

  toLocal(remotePath: string): string | null {
    const path = cleanPath(remotePath);
    if (isTransientSyncPath(path)) {
      return null;
    }
    if (path.startsWith("vault/")) {
      return path.slice("vault/".length);
    }
    const sharedPrefix = "config/shared/";
    if (path.startsWith(sharedPrefix)) {
      const local = `${this.configDir}/${path.slice(sharedPrefix.length)}`;
      return isInside(local, this.ownPluginDir) ? null : local;
    }
    const platformPrefix = `config/${this.platform}/`;
    if (path.startsWith(platformPrefix)) {
      return `${this.configDir}/${path.slice(platformPrefix.length)}`;
    }
    return null;
  }
}
