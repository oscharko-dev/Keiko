// UI packaging step (ADR-0011 D6, ADR-0021 bundled-product contract). Invokes the workspace build
// of @oscharko-dev/keiko-ui, produces the static export, copies it into `dist/ui/static/`, and
// writes `dist/ui/csp-hashes.json` — the inline-script SHA-256 hashes the BFF folds into
// `script-src`. The static-export tree IS the bundled UI runtime artifact carried by the packed
// root product; the keiko-ui workspace package itself is intentionally NOT listed in
// bundleDependencies because consumers never resolve `@oscharko-dev/keiko-ui` at runtime.
//
// `extractInlineScriptHashes` is imported through the @oscharko-dev/keiko-server package barrel
// (the BFF that the static export composes with at runtime). Pure Node ESM.

import { spawnSync } from "node:child_process";
import { access, cp, mkdir, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { extractInlineScriptHashes } from "@oscharko-dev/keiko-server";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const uiDir = join(repoRoot, "packages", "keiko-ui");
const exportDir = join(uiDir, "out");
const staticDir = join(repoRoot, "dist", "ui", "static");
const hashesFile = join(repoRoot, "dist", "ui", "csp-hashes.json");
const EXPORT_READY_TIMEOUT_MS = 10_000;
const EXPORT_READY_POLL_MS = 100;

function run(command, args) {
  // `npm` resolves to `npm.cmd` on Windows, and modern Node refuses to spawn a `.cmd`/`.bat` without
  // a shell (CVE-2024-27980 hardening) — without `shell: true` the spawn fails immediately with a
  // null status, which is exactly the Windows-only failure the #284 cross-platform CI surfaced. The
  // arguments are hardcoded literals (no untrusted input), so the shell carries no injection surface.
  // POSIX (Linux/macOS) is unaffected: the shell runs the same `npm …` invocation.
  const result = spawnSync(command, args, { cwd: repoRoot, stdio: "inherit", shell: true });
  if (result.error) {
    throw new Error(`${command} ${args.join(" ")} failed to spawn: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with ${String(result.status)}`);
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

async function waitForExportDir() {
  const deadline = Date.now() + EXPORT_READY_TIMEOUT_MS;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      await access(exportDir);
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await sleep(EXPORT_READY_POLL_MS);
    }
  }
  throw new Error(
    `Next static export did not produce ${exportDir} within ${String(
      EXPORT_READY_TIMEOUT_MS,
    )}ms after the UI build completed. Last error: ${lastError}`,
  );
}

async function main() {
  run("npm", ["run", "build", "--workspace", "@oscharko-dev/keiko-ui"]);
  await waitForExportDir();
  await rm(staticDir, { recursive: true, force: true });
  await mkdir(staticDir, { recursive: true });
  await cp(exportDir, staticDir, { recursive: true });
  await writeCspHashes();
}

await main();
