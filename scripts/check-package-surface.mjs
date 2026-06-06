// Package-surface verification (ADR-0011 D6). Asserts the publish tarball ships the UI assets,
// exposes an executable CLI bin, and includes nothing it must not: no source maps, no `.env`,
// no workspace `packages/keiko-ui/` source, and no absolute local paths. Run from `prepack`/`prepublishOnly`
// after the build steps.

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
// Inline-script SHA-256 helper for the CSP-hash audit. Lives on the BFF package
// (@oscharko-dev/keiko-server) — the BFF folds the hashes into script-src at request time, and
// this script audits the packed UI bundle against the same set.
import { extractInlineScriptHashes } from "@oscharko-dev/keiko-server";

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

// The SDK sentinel — a single named export the README documents — proves the SDK root barrel
// did not regress to an empty re-export shell. Chosen because `runVerification` is the canonical
// entry point per tests/sdk/ and any breakage of the verification surface would surface here.
const SDK_SENTINEL_TOKEN = "runVerification";
const WORKFLOW_HANDOFF_DIST_FILES = [
  "node_modules/@oscharko-dev/keiko-contracts/dist/workflow-handoff.js",
  "node_modules/@oscharko-dev/keiko-contracts/dist/workflow-handoff.d.ts",
];

function assertServerRuntimeSurface(paths) {
  for (const required of ["dist/ui/csp-hashes.json"]) {
    if (!paths.includes(required)) {
      fail(
        `the tarball does not include ${required} ` +
          "(keiko-server runtime surface — run `npm run build && npm run build:ui`).",
      );
    }
  }
}

async function assertSdkRootExport(paths) {
  for (const required of ["dist/index.js", "dist/index.d.ts"]) {
    if (!paths.includes(required)) {
      fail(`the tarball does not include ${required} (SDK root export — run \`npm run build\`).`);
    }
  }
  const source = readFileSync("dist/index.js", "utf8");
  if (
    !/\b(export\s*\{|export\s*\*|export\s+const\b|export\s+function\b|export\s+class\b)/.test(
      source,
    )
  ) {
    fail(
      "dist/index.js has no top-level `export` declarations (empty barrel). " +
        "Re-run `npm run build` and verify src/index.ts re-exports the SDK surface.",
    );
  }
  // The sentinel is re-exported via `export *` from a sub-barrel, so a literal grep of
  // dist/index.js does not see it. Resolve it by importing the barrel and checking the named
  // export resolves — this is structurally robust to refactors that move the function between
  // sub-barrels.
  const url = pathToFileURL(resolve("dist/index.js")).href;
  const mod = await import(url);
  if (typeof mod[SDK_SENTINEL_TOKEN] !== "function") {
    fail(
      `SDK root export does not expose \`${SDK_SENTINEL_TOKEN}\` as a function ` +
        "— the SDK root barrel may have dropped the verification surface.",
    );
  }
}

function assertBundledPayload(paths) {
  const manifest = JSON.parse(readFileSync("package.json", "utf8"));
  const bundled = Array.isArray(manifest.bundleDependencies) ? manifest.bundleDependencies : [];
  if (bundled.length === 0) {
    fail("package.json declares no bundleDependencies — the workspace bundle would be empty.");
  }
  for (const name of bundled) {
    const shortName = name.replace(/^@oscharko-dev\//, "");
    const distPrefix = `node_modules/@oscharko-dev/${shortName}/dist/`;
    if (!paths.some((p) => p.startsWith(distPrefix))) {
      fail(
        `bundleDependencies entry ${name} ships no files under ${distPrefix} ` +
          "— the workspace bundle is incomplete (run `npm run build:packages`).",
      );
    }
  }
}

function assertWorkflowHandoffSubpath(paths) {
  for (const required of WORKFLOW_HANDOFF_DIST_FILES) {
    if (!paths.includes(required)) {
      fail(
        `workflow-handoff contract subpath is missing ${required} ` +
          "— the #186 governed handoff contract is not publishable.",
      );
    }
  }
}

function assertLocalKnowledgeDistPath(paths) {
  const required = "node_modules/@oscharko-dev/keiko-local-knowledge/dist/index.js";
  if (!paths.includes(required)) {
    fail(
      `the tarball does not include ${required} ` +
        "— keiko-local-knowledge is missing from bundleDependencies (Epic #189 O7).",
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
  // `.js.map` is the runtime source-map artifact (can leak absolute paths from the original
  // sources). `.d.ts.map` is a declaration map — relative-only and used by editors to resolve
  // "go to definition" across bundled workspace packages, so it stays.
  { test: (p) => p.endsWith(".js.map"), label: "a JS source map" },
  { test: (p) => p === ".env" || p.startsWith(".env."), label: "an environment file" },
  {
    test: (p) => p === "packages/keiko-ui" || p.startsWith("packages/keiko-ui/"),
    label: "keiko-ui workspace source",
  },
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
assertServerRuntimeSurface(paths);
await assertSdkRootExport(paths);
assertBundledPayload(paths);
assertWorkflowHandoffSubpath(paths);
assertLocalKnowledgeDistPath(paths);

console.log(`package-surface check passed: ${String(paths.length)} files, dist/ui/static present.`);
