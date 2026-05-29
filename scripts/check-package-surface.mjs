// Package-surface verification (ADR-0011 D6). Asserts the publish tarball ships the UI assets and
// nothing it must not: no source maps, no `.env`, no `ui/` source, and no absolute local paths in
// the file list. Run from `prepack`/`prepublishOnly` after the build steps.

import { spawnSync } from "node:child_process";

function packFileList() {
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
  const files = entry?.files ?? [];
  return files.map((f) => f.path);
}

function fail(message) {
  console.error(`package-surface check failed: ${message}`);
  process.exit(1);
}

const paths = packFileList();

if (!paths.some((p) => p.startsWith("dist/ui/static/"))) {
  fail("the tarball does not include dist/ui/static (run `npm run build:ui`).");
}

if (!paths.includes("dist/ui/csp-hashes.json")) {
  fail("the tarball does not include dist/ui/csp-hashes.json (run `npm run build:ui`).");
}

const forbidden = [
  // Browser source maps must never ship in the UI export (productionBrowserSourceMaps: false). The
  // root library's `.d.ts.map`/`.js.map` are the pre-existing, intentional SDK surface and are out
  // of scope here; only the UI static assets are checked for maps.
  { test: (p) => p.startsWith("dist/ui/static/") && p.endsWith(".map"), label: "a UI source map" },
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

console.log(`package-surface check passed: ${String(paths.length)} files, dist/ui/static present.`);
