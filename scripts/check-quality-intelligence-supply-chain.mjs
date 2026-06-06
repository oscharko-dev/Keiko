// Quality Intelligence supply-chain gate (Issue #287, ADR-0023 D5/D11/D12).
//
// Retained separately from the workspace supply-chain gate because this script enforces the
// QI-specific deny-list, lifecycle-hook, telemetry, and decision-matrix contract rather than SBOMs.
//
// Fail-closed checks that the native Quality Intelligence migration does not bloat Keiko's public
// package surface or runtime dependency graph. Six checks, in order:
//
//   1. No source under packages/*/src, packages/*/test, scripts, or src imports
//      `@oscharko-dev/test-intelligence` or the `@oscharko-dev/ti-*` namespace.
//   2. The root package.json `dependencies`/`devDependencies`/`bundleDependencies` does not list
//      any test-intelligence or ti-* package.
//   3. Every packages/*/package.json `dependencies`/`devDependencies`/`peerDependencies` is free of
//      the same forbidden namespaces.
//   4. The dependency decision matrix exists and is internally consistent against the live
//      manifests: every `approved-runtime` row is present somewhere; every `denied` row is absent
//      everywhere.
//   5. No package manifest declares a `preinstall`/`install`/`postinstall` lifecycle hook.
//   6. No manifest mentions a telemetry/analytics library substring.
//
// Runs on Node 22+ with no new runtime dependency. Use:
//   node scripts/check-quality-intelligence-supply-chain.mjs [--matrix=<path>] [--root=<path>]
//
// The `--root` flag is for the test harness (synthetic temp repos); production callers omit it
// and the script defaults to `process.cwd()`.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const DEFAULT_MATRIX = "docs/release/quality-intelligence-dependency-decision-matrix.md";

const FORBIDDEN_IMPORT_PATTERNS = ["@oscharko-dev/test-intelligence", "@oscharko-dev/ti-"];

const TELEMETRY_SUBSTRINGS = [
  "@sentry/",
  "@opentelemetry/",
  "posthog",
  "mixpanel",
  "analytics",
  "tracker",
];

const LIFECYCLE_HOOKS = ["preinstall", "install", "postinstall"];

const SOURCE_SCAN_ROOTS = [
  { dir: "src", recurse: true },
  { dir: "scripts", recurse: true },
];

const PACKAGES_SCAN_ROOTS = [
  { subdir: "src", recurse: true },
  { subdir: "test", recurse: true },
];

const SCANNABLE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
]);

const IGNORED_DIRECTORIES = new Set([
  "node_modules",
  "dist",
  ".next",
  "out",
  ".git",
  "coverage",
  "sbom",
  "__tests__",
]);

function parseArgs(argv) {
  const args = { matrix: DEFAULT_MATRIX, root: process.cwd() };
  for (const arg of argv) {
    if (arg.startsWith("--matrix=")) {
      args.matrix = arg.slice("--matrix=".length);
    } else if (arg.startsWith("--root=")) {
      args.root = arg.slice("--root=".length);
    }
  }
  return args;
}

function safeStat(path) {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function listEntries(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function walkFiles(dir, files) {
  for (const entry of listEntries(dir)) {
    if (IGNORED_DIRECTORIES.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(full, files);
      continue;
    }
    if (!entry.isFile()) continue;
    const dot = entry.name.lastIndexOf(".");
    if (dot === -1) continue;
    const ext = entry.name.slice(dot);
    if (!SCANNABLE_EXTENSIONS.has(ext)) continue;
    files.push(full);
  }
}

function walkIfDir(root, relative, files) {
  const full = join(root, relative);
  if (safeStat(full)?.isDirectory()) {
    walkFiles(full, files);
  }
}

function walkWorkspaceSourceTrees(root, files) {
  const packagesDir = join(root, "packages");
  if (!safeStat(packagesDir)?.isDirectory()) return;
  for (const entry of listEntries(packagesDir)) {
    if (!entry.isDirectory()) continue;
    for (const scan of PACKAGES_SCAN_ROOTS) {
      walkIfDir(join(packagesDir, entry.name), scan.subdir, files);
    }
  }
}

function listScannableSourceFiles(root) {
  const files = [];
  for (const scan of SOURCE_SCAN_ROOTS) {
    walkIfDir(root, scan.dir, files);
  }
  walkWorkspaceSourceTrees(root, files);
  return files;
}

// Files that legitimately contain the forbidden literals because they ARE the deny
// machinery: the gate script and its tests. Matched by basename (suffix) so the same
// allow-list works for source checkouts and for synthetic test roots.
const SELF_REFERENTIAL_BASENAMES = new Set([
  "check-quality-intelligence-supply-chain.mjs",
  "check-quality-intelligence-supply-chain.test.mjs",
]);

function isSelfReferential(file) {
  const slash = Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\"));
  const base = slash === -1 ? file : file.slice(slash + 1);
  return SELF_REFERENTIAL_BASENAMES.has(base);
}

function findForbiddenImportHits(files) {
  const hits = [];
  for (const file of files) {
    if (isSelfReferential(file)) continue;
    let content;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const pattern of FORBIDDEN_IMPORT_PATTERNS) {
      if (content.includes(pattern)) {
        hits.push({ file, pattern });
      }
    }
  }
  return hits;
}

function manifestDependencySections(manifest, sections) {
  const collected = [];
  for (const section of sections) {
    const value = manifest[section];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      collected.push({ section, names: Object.keys(value) });
    }
  }
  return collected;
}

function nameMatchesForbidden(name) {
  for (const pattern of FORBIDDEN_IMPORT_PATTERNS) {
    if (name === pattern) return pattern;
    if (name.startsWith(pattern)) return pattern;
  }
  return null;
}

function checkRootManifestForbidden(rootManifestPath) {
  const manifest = readJson(rootManifestPath);
  const hits = [];
  const sections = manifestDependencySections(manifest, ["dependencies", "devDependencies"]);
  for (const { section, names } of sections) {
    for (const name of names) {
      const match = nameMatchesForbidden(name);
      if (match) hits.push({ section, name, match });
    }
  }
  const bundled = Array.isArray(manifest.bundleDependencies) ? manifest.bundleDependencies : [];
  for (const name of bundled) {
    const match = nameMatchesForbidden(name);
    if (match) hits.push({ section: "bundleDependencies", name, match });
  }
  return hits;
}

function checkWorkspaceManifestForbidden(packagesDir) {
  const hits = [];
  if (!safeStat(packagesDir)?.isDirectory()) return hits;
  for (const entry of listEntries(packagesDir)) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(packagesDir, entry.name, "package.json");
    if (!safeStat(manifestPath)?.isFile()) continue;
    const manifest = readJson(manifestPath);
    const sections = manifestDependencySections(manifest, [
      "dependencies",
      "devDependencies",
      "peerDependencies",
    ]);
    for (const { section, names } of sections) {
      for (const name of names) {
        const match = nameMatchesForbidden(name);
        if (match) hits.push({ package: entry.name, section, name, match });
      }
    }
  }
  return hits;
}

function listAllManifestPaths(rootManifestPath, packagesDir) {
  const manifests = [{ label: "<root>", path: rootManifestPath }];
  if (!safeStat(packagesDir)?.isDirectory()) return manifests;
  for (const entry of listEntries(packagesDir)) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(packagesDir, entry.name, "package.json");
    if (safeStat(manifestPath)?.isFile()) {
      manifests.push({ label: entry.name, path: manifestPath });
    }
  }
  return manifests;
}

function lifecycleHitsFromScripts(label, scripts) {
  if (!scripts || typeof scripts !== "object") return [];
  const hits = [];
  for (const hook of LIFECYCLE_HOOKS) {
    if (Object.prototype.hasOwnProperty.call(scripts, hook)) {
      hits.push({ package: label, hook });
    }
  }
  return hits;
}

function checkLifecycleHooks(rootManifestPath, packagesDir) {
  const hits = [];
  for (const { label, path } of listAllManifestPaths(rootManifestPath, packagesDir)) {
    const manifest = readJson(path);
    hits.push(...lifecycleHitsFromScripts(label, manifest.scripts));
  }
  return hits;
}

function telemetryHitsForName(label, section, name) {
  const hits = [];
  for (const needle of TELEMETRY_SUBSTRINGS) {
    if (name.includes(needle)) {
      hits.push({ package: label, section, name, needle });
    }
  }
  return hits;
}

function telemetryHitsForManifest(label, manifest) {
  const hits = [];
  const sections = manifestDependencySections(manifest, [
    "dependencies",
    "devDependencies",
    "peerDependencies",
  ]);
  for (const { section, names } of sections) {
    for (const name of names) {
      hits.push(...telemetryHitsForName(label, section, name));
    }
  }
  return hits;
}

function checkTelemetryStrings(rootManifestPath, packagesDir) {
  const hits = [];
  for (const { label, path } of listAllManifestPaths(rootManifestPath, packagesDir)) {
    hits.push(...telemetryHitsForManifest(label, readJson(path)));
  }
  return hits;
}

// Matrix rows are markdown table lines with at least 4 pipe-delimited cells. We tolerate any
// extra columns and ignore the header/separator rows.
function parseDecisionMatrix(markdown) {
  const rows = [];
  const lines = markdown.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) continue;
    if (/^\|\s*-+/.test(trimmed)) continue;
    const cells = trimmed
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.length < 4) continue;
    // Skip the header row (first column literally reads "package" or contains no decision token).
    const decision = cells[3];
    if (
      decision !== "approved-runtime" &&
      decision !== "approved-dev" &&
      decision !== "denied" &&
      decision !== "defer-to-decision"
    ) {
      continue;
    }
    rows.push({ name: cells[0], namespace: cells[1], role: cells[2], decision });
  }
  return rows;
}

function addDependencyNamesFromManifest(manifest, seen) {
  for (const section of ["dependencies", "devDependencies", "peerDependencies"]) {
    const value = manifest[section];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const name of Object.keys(value)) seen.add(name);
    }
  }
  if (Array.isArray(manifest.bundleDependencies)) {
    for (const name of manifest.bundleDependencies) seen.add(name);
  }
}

function collectAllManifestDependencyNames(rootManifestPath, packagesDir) {
  const seen = new Set();
  for (const { path } of listAllManifestPaths(rootManifestPath, packagesDir)) {
    addDependencyNamesFromManifest(readJson(path), seen);
  }
  return seen;
}

function rowMatchesName(row, name) {
  // Namespace patterns end with `*` or `-*` and are tested as prefix matches.
  const candidate = row.name;
  if (candidate.endsWith("*")) {
    const prefix = candidate.slice(0, -1);
    return name.startsWith(prefix);
  }
  return candidate === name;
}

function anyDependencyMatchesRow(row, names) {
  for (const name of names) {
    if (rowMatchesName(row, name)) return name;
  }
  return null;
}

function mismatchForRow(row, names) {
  if (row.decision === "approved-runtime") {
    const hit = anyDependencyMatchesRow(row, names);
    return hit === null ? { kind: "approved-runtime-missing", row: row.name } : null;
  }
  if (row.decision === "denied") {
    const hit = anyDependencyMatchesRow(row, names);
    return hit === null ? null : { kind: "denied-present", row: row.name, present: hit };
  }
  return null;
}

function tallyRowCounts(rows) {
  const counts = { approvedRuntime: 0, approvedDev: 0, denied: 0, deferred: 0, total: rows.length };
  for (const row of rows) {
    if (row.decision === "approved-runtime") counts.approvedRuntime += 1;
    else if (row.decision === "approved-dev") counts.approvedDev += 1;
    else if (row.decision === "denied") counts.denied += 1;
    else if (row.decision === "defer-to-decision") counts.deferred += 1;
  }
  return counts;
}

function checkMatrixConsistency(matrixPath, rootManifestPath, packagesDir) {
  const stat = safeStat(matrixPath);
  if (!stat?.isFile()) {
    return { mismatches: [{ kind: "missing", path: matrixPath }], rowCounts: null };
  }
  const rows = parseDecisionMatrix(readFileSync(matrixPath, "utf8"));
  const names = collectAllManifestDependencyNames(rootManifestPath, packagesDir);
  const mismatches = [];
  for (const row of rows) {
    const mismatch = mismatchForRow(row, names);
    if (mismatch) mismatches.push(mismatch);
  }
  return { mismatches, rowCounts: tallyRowCounts(rows) };
}

function fail(message) {
  console.error(`qi-supply-chain check failed: ${message}`);
  process.exit(1);
}

function reportImportHits(hits) {
  for (const hit of hits) {
    console.error(`  forbidden import: ${hit.file} contains ${hit.pattern}`);
  }
  fail(
    `${String(hits.length)} source file(s) reference forbidden Test Intelligence ` +
      "package(s). See ADR-0023 D12.",
  );
}

function reportRootHits(hits) {
  for (const hit of hits) {
    console.error(`  forbidden root ${hit.section} entry: ${hit.name} (matched ${hit.match})`);
  }
  fail("root package.json declares a forbidden Test Intelligence dependency. See ADR-0023 D12.");
}

function reportWorkspaceHits(hits) {
  for (const hit of hits) {
    console.error(
      `  forbidden ${hit.section} entry in packages/${hit.package}: ${hit.name} ` +
        `(matched ${hit.match})`,
    );
  }
  fail("a workspace package declares a forbidden Test Intelligence dependency. See ADR-0023 D12.");
}

function reportMatrixMismatch(m) {
  if (m.kind === "missing") {
    console.error(`  decision matrix file is missing: ${m.path}`);
  } else if (m.kind === "approved-runtime-missing") {
    console.error(`  matrix row "${m.row}" is approved-runtime but no manifest declares it`);
  } else if (m.kind === "denied-present") {
    console.error(`  matrix row "${m.row}" is denied but a manifest declares ${m.present}`);
  }
}

function reportMatrixMismatches(mismatches) {
  for (const m of mismatches) reportMatrixMismatch(m);
  fail("dependency decision matrix is inconsistent with live manifests.");
}

function reportLifecycleHits(hits) {
  for (const hit of hits) {
    console.error(`  lifecycle hook ${hit.hook} declared in ${hit.package}`);
  }
  fail("a package manifest declares an install lifecycle hook (forbidden).");
}

function reportTelemetryHits(hits) {
  for (const hit of hits) {
    console.error(
      `  telemetry dependency in ${hit.package} ${hit.section}: ${hit.name} ` +
        `(matched substring ${hit.needle})`,
    );
  }
  fail("a manifest declares a telemetry/analytics dependency (forbidden).");
}

function formatSummary(rowCounts) {
  if (!rowCounts) return "matrix not parsed";
  return (
    `${String(rowCounts.total)} matrix rows (${String(rowCounts.approvedRuntime)} approved-runtime, ` +
    `${String(rowCounts.approvedDev)} approved-dev, ${String(rowCounts.denied)} denied, ` +
    `${String(rowCounts.deferred)} deferred)`
  );
}

function runChecksOrFail(root, rootManifestPath, packagesDir, matrixPath) {
  const importHits = findForbiddenImportHits(listScannableSourceFiles(root));
  if (importHits.length > 0) reportImportHits(importHits);

  const rootHits = checkRootManifestForbidden(rootManifestPath);
  if (rootHits.length > 0) reportRootHits(rootHits);

  const workspaceHits = checkWorkspaceManifestForbidden(packagesDir);
  if (workspaceHits.length > 0) reportWorkspaceHits(workspaceHits);

  const { mismatches, rowCounts } = checkMatrixConsistency(
    matrixPath,
    rootManifestPath,
    packagesDir,
  );
  if (mismatches.length > 0) reportMatrixMismatches(mismatches);

  const lifecycleHits = checkLifecycleHooks(rootManifestPath, packagesDir);
  if (lifecycleHits.length > 0) reportLifecycleHits(lifecycleHits);

  const telemetryHits = checkTelemetryStrings(rootManifestPath, packagesDir);
  if (telemetryHits.length > 0) reportTelemetryHits(telemetryHits);

  return rowCounts;
}

function main(argv) {
  const args = parseArgs(argv);
  const root = resolve(args.root);
  const rootManifestPath = join(root, "package.json");
  const packagesDir = join(root, "packages");
  if (!safeStat(rootManifestPath)?.isFile()) {
    fail(`no package.json at ${rootManifestPath}`);
  }
  const matrixPath = resolve(root, args.matrix);
  const rowCounts = runChecksOrFail(root, rootManifestPath, packagesDir, matrixPath);
  console.log(`qi-supply-chain check passed: ${formatSummary(rowCounts)}`);
}

// Allow the test harness to import this module without running main().
const invokedDirectly =
  process.argv[1] &&
  resolve(process.argv[1]).endsWith("check-quality-intelligence-supply-chain.mjs");
if (invokedDirectly) {
  main(process.argv.slice(2));
}

export {
  parseDecisionMatrix,
  checkMatrixConsistency,
  findForbiddenImportHits,
  checkRootManifestForbidden,
  checkWorkspaceManifestForbidden,
  checkLifecycleHooks,
  checkTelemetryStrings,
  listScannableSourceFiles,
  main,
};
