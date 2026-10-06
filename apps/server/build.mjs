// Bundles the server (and the shared package) into dist/, keeping npm dependencies external.
import { build } from "esbuild";
import { cpSync, readFileSync, rmSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
const external = Object.keys(pkg.dependencies ?? {}).filter((d) => !d.startsWith("@nx/"));

rmSync("dist", { recursive: true, force: true });
await build({
  entryPoints: { main: "src/main.ts", "migrate-cli": "src/db/migrate-cli.ts" },
  outdir: "dist",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: true,
  external,
  banner: { js: "import { createRequire as __nxCreateRequire } from 'node:module'; const require = __nxCreateRequire(import.meta.url);" },
});
cpSync("src/db/migrations", "dist/migrations", { recursive: true });
console.log("server built → dist/");
