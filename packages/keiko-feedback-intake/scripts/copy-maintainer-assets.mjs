import { copyFile, mkdir, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = resolve(packageRoot, "..", "..");
const assets = ["keiko-tokens.css", "keiko-semantic-tokens.css"];

await mkdir(resolve(packageRoot, "assets"), { recursive: true });
await Promise.all(
  assets.map(async (asset) => {
    const source = resolve(sourceRoot, "design-system", asset);
    const target = resolve(packageRoot, "assets", asset);
    const metadata = await stat(source);
    if (!metadata.isFile()) throw new Error(`Missing governed design-system asset: ${asset}`);
    await copyFile(source, target);
  }),
);
