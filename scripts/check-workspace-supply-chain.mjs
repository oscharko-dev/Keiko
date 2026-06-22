// Workspace SBOM + license gate (Issue #169 D4, AC4). For every workspace package, emits a
// CycloneDX SBOM under `sbom/workspace-<short>.cdx.json`, then aggregates the union of license
// IDs/names across all per-workspace SBOMs PLUS the root SBOM and asserts every license falls
// inside a vetted allow-list. Also asserts every workspace package's own `license` field is
// `Apache-2.0` so a sub-package never drifts from the root license at the manifest level.
//
// Retained separately from the QI supply-chain gate because this script owns bundle-wide SBOM and
// license evidence, while the QI script owns the migration-specific deny-list and manifest policy.
//
// Run via `npm run check:workspace-supply-chain`. Wired into the CI release job after the root
// SBOM step so the per-workspace artifacts can be uploaded alongside the root SBOM.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// SPDX IDs and names already present in the repo's resolved transitive graph plus a small
// permissive set explicitly approved in spec D4. Adding a new license requires a deliberate edit
// to this constant — surfaced via PR review.
export const APPROVED_LICENSES = new Set([
  "Apache-2.0",
  "MIT",
  "ISC",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "0BSD",
  "BlueOak-1.0.0",
  "CC-BY-4.0",
  "CC0-1.0",
  "Python-2.0",
  "Unlicense",
  "WTFPL",
]);

const REQUIRED_WORKSPACE_LICENSE = "Apache-2.0";
const repoRoot = process.cwd();
const sbomDir = join(repoRoot, "sbom");
const packagesDir = join(repoRoot, "packages");

function fail(message) {
  console.error(`workspace supply-chain check failed: ${message}`);
  process.exit(1);
}

function listWorkspacePackages() {
  const entries = readdirSync(packagesDir, { withFileTypes: true });
  const packages = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(packagesDir, entry.name, "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    packages.push({ shortName: entry.name, manifestPath, manifest });
  }
  return packages;
}

function generateSbom(workspaceName, outPath) {
  const result = spawnSync(
    "npm",
    ["sbom", "--sbom-format", "cyclonedx", "--omit", "dev", "--workspace", workspaceName],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    fail(`npm sbom --workspace ${workspaceName} exited ${String(result.status)}: ${result.stderr}`);
  }
  writeFileSync(outPath, result.stdout);
  return JSON.parse(result.stdout);
}

function generateRootSbom(outPath) {
  // Reuse the CI-generated `sbom.cdx.json` at the repo root when present (CI emits it in the
  // step just before this gate runs, see ci.yml). Standalone local runs fall through to a fresh
  // `npm sbom` so the script remains usable outside CI (Copilot review on #169).
  const ciRootSbomPath = join(repoRoot, "sbom.cdx.json");
  const sbomJson = existsSync(ciRootSbomPath)
    ? readFileSync(ciRootSbomPath, "utf8")
    : runRootSbom();
  writeFileSync(outPath, sbomJson);
  return JSON.parse(sbomJson);
}

function runRootSbom() {
  const result = spawnSync("npm", ["sbom", "--sbom-format", "cyclonedx", "--omit", "dev"], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    fail(`npm sbom (root) exited ${String(result.status)}: ${result.stderr}`);
  }
  return result.stdout;
}

// Evaluate an SPDX license expression (CycloneDX `licenses[].expression`) against the allow-list
// with correct SPDX precedence: `AND` binds tighter than `OR`, parentheses group, `OR` lets the
// licensee choose any satisfied operand, and `AND` requires every operand. This recognises
// dual-licensed transitive dependencies in the resolved graph — e.g. `(MPL-2.0 OR Apache-2.0)`,
// used here under its approved Apache-2.0 option — without adding any new license to
// APPROVED_LICENSES. It is fail-closed: any unparseable or unrecognised form (unbalanced
// parentheses, `WITH` exceptions, `+` suffixes, leftover tokens) yields `false`, so a
// precedence-sensitive expression such as `GPL-3.0-only AND (MIT OR ISC)` is never falsely approved
// by a lone permissive operand.
export function isLicenseExpressionApproved(expression) {
  if (typeof expression !== "string" || expression.trim().length === 0) {
    return false;
  }
  const tokens = expression
    .replaceAll("(", " ( ")
    .replaceAll(")", " ) ")
    .split(/\s+/)
    .filter((token) => token.length > 0);

  // Hand-written recursive-descent over OR > AND > atom. Each parse function returns
  // { ok, value, pos }: `ok` is false on a structural error (fail closed), `value` is whether the
  // sub-expression is satisfiable, `pos` is the next unconsumed token index.
  const parseAtom = (pos) => {
    const token = tokens[pos];
    if (token === "(") {
      const inner = parseOr(pos + 1);
      if (!inner.ok || tokens[inner.pos] !== ")") {
        return { ok: false, value: false, pos };
      }
      return { ok: true, value: inner.value, pos: inner.pos + 1 };
    }
    if (token === undefined || token === ")" || token === "AND" || token === "OR") {
      return { ok: false, value: false, pos };
    }
    return { ok: true, value: APPROVED_LICENSES.has(token), pos: pos + 1 };
  };

  const parseBinary = (pos, operator, combine, next) => {
    let current = next(pos);
    if (!current.ok) {
      return current;
    }
    let value = current.value;
    while (tokens[current.pos] === operator) {
      const operand = next(current.pos + 1);
      if (!operand.ok) {
        return operand;
      }
      value = combine(value, operand.value);
      current = operand;
    }
    return { ok: true, value, pos: current.pos };
  };

  function parseAnd(pos) {
    return parseBinary(pos, "AND", (left, right) => left && right, parseAtom);
  }
  function parseOr(pos) {
    return parseBinary(pos, "OR", (left, right) => left || right, parseAnd);
  }

  const result = parseOr(0);
  // Fail closed unless the whole expression parsed cleanly with no leftover tokens.
  return result.ok && result.pos === tokens.length && result.value;
}

// Evaluate one CycloneDX `licenses[]` entry against the allow-list. CycloneDX expresses a single
// license as `{ license: { id | name } }` and a compound license choice as
// `{ expression: "<SPDX expression>" }`. Returns the offending license string, or null when the
// entry is acceptable.
function entryLicenseOffense(entry) {
  if (typeof entry?.expression === "string") {
    return isLicenseExpressionApproved(entry.expression) ? null : entry.expression;
  }
  const license = entry?.license ?? {};
  const candidate = license.id ?? license.name ?? "<unknown>";
  return APPROVED_LICENSES.has(candidate) ? null : candidate;
}

export function offendersForComponent(component) {
  const id = `${component.name}@${component.version}`;
  const licenses = Array.isArray(component.licenses) ? component.licenses : [];
  // CycloneDX entries without an explicit `licenses` array are treated as offenders — we cannot
  // prove they are acceptable without a declaration.
  if (licenses.length === 0) {
    return [{ id, license: "<missing>" }];
  }
  const offenders = [];
  for (const entry of licenses) {
    const offense = entryLicenseOffense(entry);
    if (offense !== null) {
      offenders.push({ id, license: offense });
    }
  }
  return offenders;
}

function collectLicenseOffenders(sbom) {
  const components = Array.isArray(sbom.components) ? sbom.components : [];
  return components.flatMap(offendersForComponent);
}

function assertWorkspaceManifestLicense(packages) {
  for (const { shortName, manifest } of packages) {
    if (manifest.license !== REQUIRED_WORKSPACE_LICENSE) {
      fail(
        `packages/${shortName}/package.json declares license="${String(manifest.license)}", ` +
          `expected "${REQUIRED_WORKSPACE_LICENSE}".`,
      );
    }
  }
}

function main() {
  mkdirSync(sbomDir, { recursive: true });
  const packages = listWorkspacePackages();
  assertWorkspaceManifestLicense(packages);

  const allOffenders = [];
  const rootSbomPath = join(sbomDir, "root.cdx.json");
  const rootSbom = generateRootSbom(rootSbomPath);
  allOffenders.push(
    ...collectLicenseOffenders(rootSbom).map((entry) => ({ ...entry, source: "root" })),
  );

  for (const { shortName, manifest } of packages) {
    const outPath = join(sbomDir, `workspace-${shortName}.cdx.json`);
    const sbom = generateSbom(manifest.name, outPath);
    allOffenders.push(
      ...collectLicenseOffenders(sbom).map((entry) => ({ ...entry, source: shortName })),
    );
  }

  if (allOffenders.length > 0) {
    for (const offender of allOffenders) {
      console.error(`[${offender.source}] ${offender.id} → ${offender.license}`);
    }
    fail(`${String(allOffenders.length)} license violation(s) — see list above.`);
  }

  console.log(
    `workspace supply-chain ok: ${String(packages.length)} per-workspace SBOMs emitted under ` +
      `${resolve(sbomDir)}, all licenses within the allow-list.`,
  );
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main();
}
