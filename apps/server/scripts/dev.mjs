import { build } from "esbuild";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Bundle the local development server like the real one, then run it.
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outfile = join(root, "dist/dev-server.mjs");
await build({
  entryPoints: [join(root, "src/dev.ts")],
  outfile,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  external: ["pg", "pg-native", "@electric-sql/pglite"],
  banner: { js: "import { createRequire as leaflogueCreateRequire } from 'node:module'; const require = leaflogueCreateRequire(import.meta.url);" },
});
const child = spawn(process.execPath, [outfile], { stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code) => process.exit(code ?? 0));
