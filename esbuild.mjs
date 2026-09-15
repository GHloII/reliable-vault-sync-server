import { build } from "esbuild";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = dirname(fileURLToPath(import.meta.url));
const fromRoot = (...segments) => join(projectRoot, ...segments);

await rm(fromRoot("dist"), { recursive: true, force: true });

await build({
  absWorkingDir: projectRoot,
  entryPoints: [fromRoot("server", "src", "cli.ts")],
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node22",
  outfile: fromRoot("dist", "index.cjs"),
  sourcemap: true,
  logLevel: "info"
});
