import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Workspace packages ship TypeScript with extensionless imports, so the server
// is bundled into one file. `pg` stays external: it is installed beside it.
const root = dirname(dirname(fileURLToPath(import.meta.url)));

await build({
  entryPoints: [join(root, "src/main.ts")],
  outfile: join(root, "dist/server.mjs"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  external: ["pg", "pg-native"],
  sourcemap: true,
  legalComments: "linked",
  // Some bundled CommonJS code calls require() for Node built-ins.
  banner: { js: "import { createRequire as leaflogueCreateRequire } from 'node:module'; const require = leaflogueCreateRequire(import.meta.url);" },
});
