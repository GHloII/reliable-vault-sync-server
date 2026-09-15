export const PROTOCOL_VERSION = 1 as const;
export const INCREMENTAL_PROTOCOL_VERSION = 2 as const;

export type PlatformProfile = "desktop" | "mobile";

export interface PutChange {
  type: "put";
  path: string;
  contentBase64: string;
}

export interface DeleteChange {
  type: "delete";
  path: string;
}

export type ClientChange = PutChange | DeleteChange;

export interface SyncRequest {
  protocolVersion: typeof PROTOCOL_VERSION;
  deviceId: string;
  baseRevision: string | null;
  changes: ClientChange[];
}

export interface SnapshotFile {
  path: string;
  contentBase64: string;
  hash: string;
}

export interface MergeConflict {
  path: string;
  kind: "text" | "binary" | "delete-modify";
  baseBase64: string | null;
  localBase64: string | null;
  remoteBase64: string | null;
}

export interface SyncSuccessResponse {
  protocolVersion: typeof PROTOCOL_VERSION;
  status: "ok";
  revision: string;
  snapshot: SnapshotFile[];
}

export interface SyncConflictResponse {
  protocolVersion: typeof PROTOCOL_VERSION;
  status: "conflict";
  serverRevision: string;
  clientRevision: string;
  snapshot: SnapshotFile[];
  conflicts: MergeConflict[];
}

export type SyncResponse = SyncSuccessResponse | SyncConflictResponse;

export interface IncrementalSyncRequest {
  protocolVersion: typeof INCREMENTAL_PROTOCOL_VERSION;
  deviceId: string;
  baseRevision: string | null;
  changes: ClientChange[];
}

export interface ManifestEntry {
  path: string;
  hash: string;
  size: number;
}

export interface ManifestResponse {
  protocolVersion: typeof INCREMENTAL_PROTOCOL_VERSION;
  revision: string;
  files: ManifestEntry[];
}

export interface IncrementalSyncSuccessResponse {
  protocolVersion: typeof INCREMENTAL_PROTOCOL_VERSION;
  status: "ok";
  revision: string;
}

export interface IncrementalSyncConflictResponse {
  protocolVersion: typeof INCREMENTAL_PROTOCOL_VERSION;
  status: "conflict";
  serverRevision: string;
  clientRevision: string;
  conflicts: MergeConflict[];
}

export type IncrementalSyncResponse = IncrementalSyncSuccessResponse | IncrementalSyncConflictResponse;

export interface ErrorResponse {
  error: string;
}

export interface EventAuthMessage {
  type: "authenticate";
  token: string;
  vaultId: string;
  deviceId: string;
}

export interface RevisionEvent {
  type: "revision";
  vaultId: string;
  revision: string;
}
