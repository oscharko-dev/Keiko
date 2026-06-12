// Quality Intelligence supply-chain gate (Issue #287; ADR-0023 §D5/§D11/§D12 — ADR-0023 is the
// historical Epic #270 migration record, superseded by ADR-0025, but D5/D11/D12 remain in force and
// are enforced live by this script and by the `arch:check` provider-SDK-isolation rule).
//
// Retained separately from the workspace supply-chain gate because this script enforces the
// QI-specific deny-list, lifecycle-hook, telemetry, and decision-matrix contract rather than SBOMs.
//
// Fail-closed checks that the native Quality Intelligence migration does not bloat Keiko's public
// package surface or runtime dependency graph. Eight checks, in order:
//
//   1. No source under packages/*/src, packages/*/test, scripts, or src imports
//      `@oscharko-dev/test-intelligence` or the `@oscharko-dev/ti-*` namespace. This also catches
//      the dynamic-evasion form `import(`@oscharko-dev/${x}`)` / `require(`@oscharko-dev/ti-${x}`)`
//      where the package name is built from a template literal so the forbidden substring never
//      appears contiguously.
//   2. The root package.json `dependencies`/`devDependencies`/`peerDependencies`/
//      `optionalDependencies`/`bundleDependencies` does not list any test-intelligence or ti-*
//      package.
//   3. Every packages/*/package.json `dependencies`/`devDependencies`/`peerDependencies`/
//      `optionalDependencies` is free of the same forbidden namespaces.
//   4. The dependency decision matrix exists and is internally consistent against the live
//      manifests: every `approved-runtime` row is present somewhere; every `denied` row is absent
//      everywhere; every `defer-to-decision` row is treated as denied (must be absent until promoted).
//   5. No package manifest declares a `preinstall`/`install`/`postinstall` lifecycle hook.
//   6. No manifest mentions a telemetry/analytics library substring (incl. `optionalDependencies`).
//   7. Completeness (fail-closed on unapproved deps): every external dependency that SHIPS in the
//      published `@oscharko-dev/keiko` runtime graph — i.e. the `dependencies`/`optionalDependencies`
//      of the root manifest and of every bundleDependencies workspace package — maps to an
//      `approved-runtime` matrix row. Workspace `@oscharko-dev/*` packages (governed by the bundle
//      contract) and `@types/*` type-only stubs (no runtime code, install hook, or network) are
//      exempt.
//   8. Every `approved-runtime`/`approved-dev` matrix row declares a non-empty license (ADR-0023 /
//      Issue #287 AC1: each governed dependency documents owner, purpose, license, risk, and a
//      rejection alternative).
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

// A static substring scan cannot see a forbidden package whose name is assembled at runtime, e.g.
// `import(`@oscharko-dev/${pkg}`)`. This pattern flags any dynamic `import(...)`/`require(...)` whose
// template-literal argument interpolates within the `@oscharko-dev/` package-name segment — the only
// realistic way to reach `test-intelligence`/`ti-*` without the contiguous literal. `[^`/]*` keeps
// the match inside the package-name segment, so legitimate dynamic SUBPATHS of statically-named
// packages (`import(`@oscharko-dev/keiko-foo/${sub}`)`) are NOT flagged.
const FORBIDDEN_DYNAMIC_SCOPE_PATTERN =
  /\b(?:import|require)\s*\(\s*`[^`]*@oscharko-dev\/[^`/]*\$\{/u;

const TELEMETRY_SUBSTRINGS = [
  "@sentry/",
  "@opentelemetry/",
  "posthog",
  "mixpanel",
  "analytics",
  "tracker",
];

const LIFECYCLE_HOOKS = ["preinstall", "install", "postinstall"];

// Dependency manifest sections scanned by the deny-list, telemetry, and name-collection checks.
// `optionalDependencies` is included because an optional dep is still installed by default and would
// otherwise be a blind spot for the forbidden-namespace and telemetry scanners.
const SCANNED_DEPENDENCY_SECTIONS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

// Manifest sections that determine what ships in the published `@oscharko-dev/keiko` runtime graph.
// `devDependencies`/`peerDependencies` are deliberately excluded — they do not ship in the tarball.
const PUBLISHED_RUNTIME_SECTIONS = ["dependencies", "optionalDependencies"];

// Namespaces exempt from the published-runtime completeness check (check 7). Workspace packages are
// governed by the bundle contract (`check-package-surface.mjs`); `@types/*` packages are
// declaration-only (no runtime JS, install hook, or network reach) so they carry no supply-chain
// execution risk even when declared under `dependencies`.
const COMPLETENESS_EXEMPT_PREFIXES = ["@oscharko-dev/", "@types/"];

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
    if (FORBIDDEN_DYNAMIC_SCOPE_PATTERN.test(content)) {
      hits.push({ file, pattern: "dynamic @oscharko-dev/ package-name import (template literal)" });
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
  const sections = manifestDependencySections(manifest, SCANNED_DEPENDENCY_SECTIONS);
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
    const sections = manifestDependencySections(manifest, SCANNED_DEPENDENCY_SECTIONS);
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
  const sections = manifestDependencySections(manifest, SCANNED_DEPENDENCY_SECTIONS);
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

// Matrix rows are markdown table lines with at least 5 pipe-delimited cells. We tolerate any
// extra columns and ignore the header/separator rows. Column order (ADR-0023 / Issue #287 AC1):
// `package | namespace | runtime role | decision | license | owner | rationale | risk-class |
// rejection alternative`. The decision token stays at index 3; license is captured at index 4 for
// the AC1 license-declared check (check 8).
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
    rows.push({
      name: cells[0],
      namespace: cells[1],
      role: cells[2],
      decision,
      license: cells.length > 4 ? cells[4] : "",
    });
  }
  return rows;
}

function addDependencyNamesFromManifest(manifest, seen) {
  for (const section of SCANNED_DEPENDENCY_SECTIONS) {
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
  // `defer-to-decision` is documented as "treat as denied until promoted by a follow-up PR", so it
  // shares the denied enforcement: the package must be absent from every manifest.
  if (row.decision === "denied" || row.decision === "defer-to-decision") {
    const hit = anyDependencyMatchesRow(row, names);
    if (hit === null) return null;
    const kind = row.decision === "denied" ? "denied-present" : "deferred-present";
    return { kind, row: row.name, present: hit };
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

// --- Check 7: published-runtime completeness (fail-closed on unapproved dependencies) ---

function isCompletenessExempt(name) {
  for (const prefix of COMPLETENESS_EXEMPT_PREFIXES) {
    if (name.startsWith(prefix)) return true;
  }
  return false;
}

function externalRuntimeNamesFromManifest(manifest) {
  const entries = [];
  for (const section of PUBLISHED_RUNTIME_SECTIONS) {
    const value = manifest[section];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const name of Object.keys(value)) {
        if (!isCompletenessExempt(name)) entries.push({ name, section });
      }
    }
  }
  return entries;
}

// The published runtime surface = the root manifest's runtime/optional deps plus the runtime/optional
// deps of every `bundleDependencies` workspace package — those are the only manifests whose declared
// externals are packed into the published tarball. Returns name -> { label, section } of the first
// manifest that declared it.
function collectPublishedRuntimeDependencies(rootManifestPath, packagesDir) {
  const rootManifest = readJson(rootManifestPath);
  const collected = new Map();
  const add = (name, label, section) => {
    if (!collected.has(name)) collected.set(name, { label, section });
  };
  for (const { name, section } of externalRuntimeNamesFromManifest(rootManifest)) {
    add(name, "<root>", section);
  }
  const bundled = Array.isArray(rootManifest.bundleDependencies)
    ? rootManifest.bundleDependencies
    : [];
  for (const fullName of bundled) {
    const shortName = fullName.replace(/^@oscharko-dev\//, "");
    const manifestPath = join(packagesDir, shortName, "package.json");
    if (!safeStat(manifestPath)?.isFile()) continue;
    for (const { name, section } of externalRuntimeNamesFromManifest(readJson(manifestPath))) {
      add(name, shortName, section);
    }
  }
  return collected;
}

function checkUnapprovedRuntimeDependencies(matrixPath, rootManifestPath, packagesDir) {
  if (!safeStat(matrixPath)?.isFile()) return [];
  const approved = parseDecisionMatrix(readFileSync(matrixPath, "utf8")).filter(
    (row) => row.decision === "approved-runtime",
  );
  const published = collectPublishedRuntimeDependencies(rootManifestPath, packagesDir);
  const hits = [];
  for (const [name, { label, section }] of published) {
    const covered = approved.some((row) => rowMatchesName(row, name));
    if (!covered) hits.push({ name, label, section });
  }
  return hits;
}

// --- Check 8: every shipping / approved-dev row declares a license (Issue #287 AC1) ---

function checkMatrixLicenses(matrixPath) {
  if (!safeStat(matrixPath)?.isFile()) return [];
  const rows = parseDecisionMatrix(readFileSync(matrixPath, "utf8"));
  const hits = [];
  for (const row of rows) {
    if (row.decision !== "approved-runtime" && row.decision !== "approved-dev") continue;
    const license = (row.license ?? "").trim();
    if (license === "" || license.toLowerCase() === "n/a") {
      hits.push({ row: row.name, decision: row.decision, license });
    }
  }
  return hits;
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
  } else if (m.kind === "deferred-present") {
    console.error(
      `  matrix row "${m.row}" is defer-to-decision (treated as denied until promoted) but a ` +
        `manifest declares ${m.present}`,
    );
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

function reportMissingLicenseHits(hits) {
  for (const hit of hits) {
    console.error(
      `  matrix row "${hit.row}" (${hit.decision}) declares no license ` +
        `(found ${hit.license === "" ? "<empty>" : `"${hit.license}"`})`,
    );
  }
  fail(
    "an approved decision-matrix row omits a license. Issue #287 AC1 requires every governed " +
      "dependency to document owner, purpose, license, risk, and rejection alternative.",
  );
}

function reportUnapprovedRuntimeHits(hits) {
  for (const hit of hits) {
    console.error(
      `  unapproved runtime dependency: ${hit.name} (declared in ${hit.label} ${hit.section}) ` +
        "ships in the published package but has no approved-runtime decision-matrix row",
    );
  }
  fail(
    `${String(hits.length)} runtime dependency(ies) ship in the published package without an ` +
      "approved-runtime row. Add a row to " +
      "docs/release/quality-intelligence-dependency-decision-matrix.md (owner, license, risk, " +
      "rejection alternative) before shipping. See ADR-0023 D11 / Issue #287 AC4.",
  );
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

  const licenseHits = checkMatrixLicenses(matrixPath);
  if (licenseHits.length > 0) reportMissingLicenseHits(licenseHits);

  const lifecycleHits = checkLifecycleHooks(rootManifestPath, packagesDir);
  if (lifecycleHits.length > 0) reportLifecycleHits(lifecycleHits);

  const telemetryHits = checkTelemetryStrings(rootManifestPath, packagesDir);
  if (telemetryHits.length > 0) reportTelemetryHits(telemetryHits);

  const unapprovedHits = checkUnapprovedRuntimeDependencies(
    matrixPath,
    rootManifestPath,
    packagesDir,
  );
  if (unapprovedHits.length > 0) reportUnapprovedRuntimeHits(unapprovedHits);

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
  checkUnapprovedRuntimeDependencies,
  checkMatrixLicenses,
  collectPublishedRuntimeDependencies,
  findForbiddenImportHits,
  checkRootManifestForbidden,
  checkWorkspaceManifestForbidden,
  checkLifecycleHooks,
  checkTelemetryStrings,
  listScannableSourceFiles,
  main,
};
