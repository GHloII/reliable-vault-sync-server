import { resolve } from "node:path";
import { GitVaultStore } from "./git-store";
import { createSyncHttpServer } from "./http-server";

export interface ServerConfiguration {
  host: string;
  port: number;
  token: string;
  dataDir: string;
}

export function configurationFromEnvironment(environment: NodeJS.ProcessEnv): ServerConfiguration {
  const token = environment.SYNC_TOKEN;
  if (!token || token.length < 16) {
    throw new Error("SYNC_TOKEN must contain at least 16 characters");
  }
  const port = Number(environment.PORT ?? "8787");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be a valid TCP port");
  }
  return {
    host: environment.HOST ?? "0.0.0.0",
    port,
    token,
    dataDir: resolve(environment.DATA_DIR ?? "./data")
  };
}

export async function startServer(configuration: ServerConfiguration): Promise<void> {
  const store = new GitVaultStore({ dataDir: configuration.dataDir });
  const server = createSyncHttpServer({ token: configuration.token, store });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(configuration.port, configuration.host, () => resolveListen());
  });
  console.log(`Vault Sync server listening on http://${configuration.host}:${configuration.port}`);
}
