// tsc compiles TypeScript and nothing else, so the logos would never reach dist
// and every deployed report would come out unbranded. Run after the build.
import { cp, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const from = join(root, "src", "assets");
const to = join(root, "dist", "assets");

if (!existsSync(from)) {
  console.log("copy-assets: no hay src/assets, nada que copiar");
  process.exit(0);
}

await mkdir(dirname(to), { recursive: true });
await cp(from, to, { recursive: true });
console.log(`copy-assets: ${from} -> ${to}`);
