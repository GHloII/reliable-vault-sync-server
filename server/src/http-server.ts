import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import type { EventAuthMessage, IncrementalSyncRequest, RevisionEvent, SyncRequest } from "../../shared/src/protocol";
import { INCREMENTAL_PROTOCOL_VERSION, PROTOCOL_VERSION } from "../../shared/src/protocol";
import { GitVaultStore } from "./git-store";

const MAX_BODY_BYTES = 128 * 1024 * 1024;

interface AuthenticatedSocket extends WebSocket {
  vaultId?: string;
  deviceId?: string;
}

export interface SyncHttpServerOptions {
  token: string;
  store: GitVaultStore;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const encoded = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(encoded),
    "cache-control": "no-store"
  });
  response.end(encoded);
}

function sendBinary(response: ServerResponse, content: Buffer): void {
  response.writeHead(200, {
    "content-type": "application/octet-stream",
    "content-length": content.byteLength,
    "cache-control": "no-store"
  });
  response.end(content);
}

function setCors(request: IncomingMessage, response: ServerResponse): void {
  const origin = request.headers.origin;
  const allowed = origin === "app://obsidian.md" || origin === "capacitor://localhost" || origin === "http://localhost";
  if (allowed) {
    response.setHeader("access-control-allow-origin", origin);
    response.setHeader("vary", "Origin");
  }
  response.setHeader("access-control-allow-headers", "authorization, content-type");
  response.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
}

function tokenMatches(actual: string | undefined, expected: string): boolean {
  if (!actual?.startsWith("Bearer ")) {
    return false;
  }
  const actualToken = Buffer.from(actual.slice("Bearer ".length));
  const expectedToken = Buffer.from(expected);
  return actualToken.length === expectedToken.length && timingSafeEqual(actualToken, expectedToken);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new Error("Request body is too large");
    }
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function isSyncRequest(value: unknown): value is SyncRequest {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const request = value as Partial<SyncRequest>;
  return request.protocolVersion === PROTOCOL_VERSION
    && typeof request.deviceId === "string"
    && (request.baseRevision === null || typeof request.baseRevision === "string")
    && Array.isArray(request.changes)
    && request.changes.every((change) => {
      if (typeof change !== "object" || change === null) {
        return false;
      }
      const candidate = change as unknown as Record<string, unknown>;
      return (candidate.type === "delete" && typeof candidate.path === "string")
        || (candidate.type === "put" && typeof candidate.path === "string" && typeof candidate.contentBase64 === "string");
    });
}

function isIncrementalSyncRequest(value: unknown): value is IncrementalSyncRequest {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const request = value as Partial<IncrementalSyncRequest>;
  return request.protocolVersion === INCREMENTAL_PROTOCOL_VERSION
    && typeof request.deviceId === "string"
    && (request.baseRevision === null || typeof request.baseRevision === "string")
    && Array.isArray(request.changes)
    && request.changes.every((change) => {
      if (typeof change !== "object" || change === null) {
        return false;
      }
      const candidate = change as unknown as Record<string, unknown>;
      return (candidate.type === "delete" && typeof candidate.path === "string")
        || (candidate.type === "put" && typeof candidate.path === "string" && typeof candidate.contentBase64 === "string");
    });
}

function isEventAuthMessage(value: unknown): value is EventAuthMessage {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const message = value as Partial<EventAuthMessage>;
  return message.type === "authenticate"
    && typeof message.token === "string"
    && typeof message.vaultId === "string"
    && typeof message.deviceId === "string";
}

export function createSyncHttpServer(options: SyncHttpServerOptions): Server {
  const sockets = new Set<AuthenticatedSocket>();
  const broadcastRevision = (vaultId: string, deviceId: string, revision: string): void => {
    const event: RevisionEvent = { type: "revision", vaultId, revision };
    const payload = JSON.stringify(event);
    for (const socket of sockets) {
      if (socket.readyState === WebSocket.OPEN && socket.vaultId === vaultId && socket.deviceId !== deviceId) {
        socket.send(payload);
      }
    }
  };
  const server = createServer(async (request, response) => {
    setCors(request, response);
    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }
    const parsedUrl = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "GET" && parsedUrl.pathname === "/health") {
      sendJson(response, 200, {
        status: "ok",
        protocolVersion: PROTOCOL_VERSION,
        incrementalProtocolVersion: INCREMENTAL_PROTOCOL_VERSION
      });
      return;
    }

    const legacyMatch = parsedUrl.pathname.match(/^\/v1\/vaults\/([a-zA-Z0-9._-]{1,80})\/sync$/);
    const incrementalMatch = parsedUrl.pathname.match(/^\/v2\/vaults\/([a-zA-Z0-9._-]{1,80})\/sync$/);
    const manifestMatch = parsedUrl.pathname.match(/^\/v2\/vaults\/([a-zA-Z0-9._-]{1,80})\/manifest$/);
    const fileMatch = parsedUrl.pathname.match(/^\/v2\/vaults\/([a-zA-Z0-9._-]{1,80})\/file$/);
    const recognized = (request.method === "POST" && (legacyMatch !== null || incrementalMatch !== null))
      || (request.method === "GET" && (manifestMatch !== null || fileMatch !== null));
    if (!recognized) {
      sendJson(response, 404, { error: "Not found" });
      return;
    }
    if (!tokenMatches(request.headers.authorization, options.token)) {
      sendJson(response, 401, { error: "Unauthorized" });
      return;
    }
    try {
      if (request.method === "GET" && manifestMatch !== null) {
        sendJson(response, 200, await options.store.manifest(manifestMatch[1]!));
        return;
      }
      if (request.method === "GET" && fileMatch !== null) {
        const revision = parsedUrl.searchParams.get("revision");
        const path = parsedUrl.searchParams.get("path");
        if (!revision || !path) {
          sendJson(response, 400, { error: "revision and path are required" });
          return;
        }
        const content = await options.store.readRevisionFile(fileMatch[1]!, revision, path);
        if (content === null) {
          sendJson(response, 404, { error: "File not found" });
          return;
        }
        sendBinary(response, content);
        return;
      }

      const body = await readJson(request);
      if (incrementalMatch !== null) {
        if (!isIncrementalSyncRequest(body)) {
          sendJson(response, 400, { error: "Invalid incremental sync request" });
          return;
        }
        const vaultId = incrementalMatch[1]!;
        const result = await options.store.syncIncremental(vaultId, body.deviceId, body.baseRevision, body.changes);
        sendJson(response, 200, result);
        if (result.status === "ok" && body.changes.length > 0) {
          broadcastRevision(vaultId, body.deviceId, result.revision);
        }
        return;
      }
      if (legacyMatch === null || !isSyncRequest(body)) {
        sendJson(response, 400, { error: "Invalid sync request" });
        return;
      }
      const vaultId = legacyMatch[1]!;
      const result = await options.store.sync(vaultId, body.deviceId, body.baseRevision, body.changes);
      sendJson(response, 200, result);
      if (result.status === "ok" && body.changes.length > 0) {
        broadcastRevision(vaultId, body.deviceId, result.revision);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unexpected error";
      const status = message.includes("Unknown base revision")
        ? 409
        : message.includes("Invalid remote path") || message.includes("unsupported characters")
          ? 400
          : 500;
      sendJson(response, status, { error: message });
    }
  });

  const webSocketServer = new WebSocketServer({ server, path: "/v1/events" });
  webSocketServer.on("connection", (socket: AuthenticatedSocket) => {
    const timeout = setTimeout(() => socket.close(4001, "Authentication timeout"), 10_000);
    socket.once("message", (payload) => {
      try {
        const message: unknown = JSON.parse(payload.toString());
        if (!isEventAuthMessage(message) || message.token !== options.token) {
          socket.close(4003, "Unauthorized");
          return;
        }
        clearTimeout(timeout);
        socket.vaultId = message.vaultId;
        socket.deviceId = message.deviceId;
        sockets.add(socket);
        socket.send(JSON.stringify({ type: "authenticated", protocolVersion: PROTOCOL_VERSION }));
      } catch {
        socket.close(4002, "Invalid authentication message");
      }
    });
    socket.on("close", () => {
      clearTimeout(timeout);
      sockets.delete(socket);
    });
  });
  server.on("close", () => webSocketServer.close());
  return server;
}
