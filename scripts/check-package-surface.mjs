// Package-surface verification (ADR-0011 D6). Asserts the publish tarball ships the UI assets,
// exposes an executable CLI bin, and includes nothing it must not: no source maps, no `.env`,
// no `ui/` source, and no absolute local paths in the file list. Run from `prepack`/`prepublishOnly`
// after the build steps.

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { extractInlineScriptHashes } from "../dist/ui/csp.js";

function packFiles() {
  // `--ignore-scripts` prevents the prepack hook from re-running this check recursively (npm runs
  // prepack on `npm pack`); the build steps already ran before this check in the prepack chain.
  const result = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`npm pack --dry-run failed: ${result.stderr}`);
  }
  const parsed = JSON.parse(result.stdout);
  const entry = Array.isArray(parsed) ? parsed[0] : parsed;
  return entry?.files ?? [];
}

function fail(message) {
  console.error(`package-surface check failed: ${message}`);
  process.exit(1);
}

function collectHtmlFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectHtmlFiles(full));
    } else if (entry.name.endsWith(".html")) {
      files.push(full);
    }
  }
  return files;
}

function readJsonArray(path) {
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  return Array.isArray(parsed) ? parsed : [];
}

function assertCspHashesMatchStaticHtml() {
  const staticRoot = join("dist", "ui", "static");
  const htmlFiles = collectHtmlFiles(staticRoot);
  const expected = extractInlineScriptHashes(htmlFiles.map((file) => readFileSync(file, "utf8")));
  const actual = readJsonArray(join("dist", "ui", "csp-hashes.json")).filter(
    (entry) => typeof entry === "string",
  );
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  const missing = expected.filter((hash) => !actualSet.has(hash));
  const stale = actual.filter((hash) => !expectedSet.has(hash));
  if (missing.length > 0 || stale.length > 0 || expected.length !== actual.length) {
    fail(
      "dist/ui/csp-hashes.json does not match dist/ui/static HTML inline scripts " +
        `(missing ${String(missing.length)}, stale ${String(stale.length)}). Run \`npm run build:ui\`.`,
    );
  }
}

const files = packFiles();
const paths = files.map((f) => f.path);

if (!paths.some((p) => p.startsWith("dist/ui/static/"))) {
  fail("the tarball does not include dist/ui/static (run `npm run build:ui`).");
}

if (!paths.includes("dist/ui/csp-hashes.json")) {
  fail("the tarball does not include dist/ui/csp-hashes.json (run `npm run build:ui`).");
}

if (!paths.includes("NOTICE")) {
  fail("the tarball does not include NOTICE.");
}

if (!paths.includes("TRADEMARKS.md")) {
  fail("the tarball does not include TRADEMARKS.md.");
}

const cliBin = files.find((file) => file.path === "dist/cli/index.js");
if (cliBin === undefined) {
  fail("the tarball does not include dist/cli/index.js.");
}

if ((cliBin.mode & 0o111) === 0) {
  fail("dist/cli/index.js is not executable in the tarball (run `npm run prepare:bin`).");
}

const forbidden = [
  { test: (p) => p.endsWith(".map"), label: "a source map" },
  { test: (p) => p === ".env" || p.startsWith(".env."), label: "an environment file" },
  { test: (p) => p === "ui" || p.startsWith("ui/"), label: "ui/ source" },
  { test: (p) => p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p), label: "an absolute local path" },
];

for (const path of paths) {
  for (const rule of forbidden) {
    if (rule.test(path)) {
      fail(`tarball contains ${rule.label}: ${path}`);
    }
  }
}

assertCspHashesMatchStaticHtml();

console.log(`package-surface check passed: ${String(paths.length)} files, dist/ui/static present.`);
