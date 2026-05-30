// UI packaging step (ADR-0011 D6). Runs after `npm run build` (tsc) so `dist/ui/csp.js` exists.
// It requires the nested ui/ package to be installed explicitly by the caller, produces the static
// export, copies it into `dist/ui/static/`, and writes `dist/ui/csp-hashes.json` — the inline-script
// SHA-256 hashes the BFF folds into `script-src` (see src/ui/load-csp.ts). Pure Node ESM, no shell-isms.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extractInlineScriptHashes } from "../dist/ui/csp.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const uiDir = join(repoRoot, "ui");
const exportDir = join(uiDir, "out");
const staticDir = join(repoRoot, "dist", "ui", "static");
const hashesFile = join(repoRoot, "dist", "ui", "csp-hashes.json");

function run(command, args) {
  const result = spawnSync(command, args, { cwd: repoRoot, stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with ${String(result.status)}`);
  }
}

function assertUiDependenciesInstalled() {
  const nextBin = join(
    uiDir,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "next.cmd" : "next",
  );
  if (!existsSync(nextBin)) {
    throw new Error(
      "UI dependencies are missing. Run `npm --prefix ui ci --ignore-scripts` first.",
    );
  }
}

async function collectHtmlFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectHtmlFiles(full)));
    } else if (entry.name.endsWith(".html")) {
      files.push(full);
    }
  }
  return files;
}

async function writeCspHashes() {
  const htmlFiles = await collectHtmlFiles(staticDir);
  const documents = await Promise.all(htmlFiles.map((f) => readFile(f, "utf8")));
  const hashes = extractInlineScriptHashes(documents);
  await writeFile(hashesFile, `${JSON.stringify(hashes, null, 2)}\n`, "utf8");
  console.log(`Wrote ${String(hashes.length)} inline-script CSP hash(es) to ${hashesFile}`);
}

async function main() {
  assertUiDependenciesInstalled();
  run("npm", ["--prefix", "ui", "run", "build"]);
  await rm(staticDir, { recursive: true, force: true });
  await mkdir(staticDir, { recursive: true });
  await cp(exportDir, staticDir, { recursive: true });
  await writeCspHashes();
}

await main();
