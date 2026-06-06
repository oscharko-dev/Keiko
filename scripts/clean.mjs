// Graph-derived clean: discover every workspace package's emit directory from
// packages/* and delete it, plus root dist/ and coverage/. Keeps the cleaned-path
// list in sync with the workspace topology automatically (no hand-maintained list).
//
// Per-package emit conventions:
//   - keiko-* tsc packages emit to dist/
//   - keiko-ui (Next.js) emits to .next/ and out/

import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

const ROOT = process.cwd();
const PACKAGES_DIR = join(ROOT, "packages");
const ROOT_TARGETS = ["dist", "coverage"];
const UI_TARGETS = [".next", "out"];

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function rmIfExists(path) {
  if (await exists(path)) {
    await rm(path, { recursive: true, force: true });
    console.log(`removed ${path}`);
  }
}

async function main() {
  for (const target of ROOT_TARGETS) {
    await rmIfExists(join(ROOT, target));
  }

  const entries = await readdir(PACKAGES_DIR);
  for (const name of entries) {
    const pkgDir = join(PACKAGES_DIR, name);
    if (!(await stat(pkgDir)).isDirectory()) continue;
    if (name === "keiko-ui") {
      for (const target of UI_TARGETS) {
        await rmIfExists(join(pkgDir, target));
      }
      continue;
    }
    await rmIfExists(join(pkgDir, "dist"));
  }
}

await main();
