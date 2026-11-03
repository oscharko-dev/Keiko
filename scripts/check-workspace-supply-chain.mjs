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
import { Buffer } from "node:buffer";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveHostExecutable } from "./lib/host-executable.mjs";

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

// Engineering-reviewed component disposition in #3895: exact original npm artifacts and their
// preserved full notices only; no global license allowance.
// GitHub's pinned license-exclusion matcher ignores versions. The same decision owner therefore
// validates the canonical lock before emitting package-wide exclusions to that action.
const COMPONENT_LICENSE_DECISIONS = new Map([
  [
    // Mermaid's colour library (#3906, owner decision of 2026-10-24). The manifest declares no
    // license; the artifact's own `license` file is the MIT text (SHA-256
    // 66b333b0f66759a0b710459e03f7029abe17f4358114a128d2c972e642961b49), and the pinned integrity
    // binds that file. Only this exact artifact may stand without a declaration.
    "pkg:npm/khroma@2.1.0",
    {
      name: "khroma",
      version: "2.1.0",
      integrity:
        "sha512-Ls993zuzfayK269Svk9hzpeGUKob/sIgZzyHYdjQoAdQetRKpOLj+k/QQQ/6Qi0Yz65mlROrfd+Ev+1+7dz9Kw==",
      resolved: "https://registry.npmjs.org/khroma/-/khroma-2.1.0.tgz",
      declaredLicense: undefined,
      licenses: ["MIT"],
      undeclaredLicense: "MIT",
    },
  ],
  [
    // Mermaid's geometry predicates, through d3-delaunay (#3906, owner decision of 2026-10-24). The
    // manifest declares Unlicense and the artifact's LICENSE is the Unlicense text (SHA-256
    // 88d9b4eb60579c191ec391ca04c16130572d7eedc4a86daa58bf28c6e14c9bcd); GitHub's scanner reads the
    // same text as `LicenseRef-scancode-public-domain AND Unlicense`. No other license is admitted.
    "pkg:npm/robust-predicates@3.0.3",
    {
      name: "robust-predicates",
      version: "3.0.3",
      integrity:
        "sha512-NS3levdsRIUOmiJ8FZWCP7LG3QpJyrs/TE0Zpf1yvZu8cAJJ6QMW92H1c7kWpdIHo8RvmLxN/o2JXTKHp74lUA==",
      resolved: "https://registry.npmjs.org/robust-predicates/-/robust-predicates-3.0.3.tgz",
      declaredLicense: "Unlicense",
      licenses: [],
    },
  ],
]);

function approvedLicensesForComponent(component) {
  const decision = COMPONENT_LICENSE_DECISIONS.get(component.purl);
  if (
    decision === undefined ||
    decision.name !== component.name ||
    decision.version !== component.version
  ) {
    return APPROVED_LICENSES;
  }
  return new Set([...APPROVED_LICENSES, ...decision.licenses]);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function lockPackageName(path) {
  return /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)$/u.exec(path)?.[1];
}

function recordLicenseDecision(path, entry) {
  const resolvedName =
    typeof entry.resolved === "string"
      ? /^https:\/\/registry\.npmjs\.org\/([^/]+)\/-\//u.exec(entry.resolved)?.[1]
      : undefined;
  const names = [lockPackageName(path), entry.name, resolvedName];
  return [...COMPONENT_LICENSE_DECISIONS.values()].find(
    (decision) =>
      names.some((name) => typeof name === "string" && name.toLowerCase() === decision.name) ||
      entry.resolved === decision.resolved ||
      entry.integrity === decision.integrity,
  );
}

function reviewedRecordMatches(path, entry, decision) {
  return (
    lockPackageName(path) === decision.name &&
    (entry.name === undefined || entry.name === decision.name) &&
    entry.version === decision.version &&
    entry.integrity === decision.integrity &&
    entry.resolved === decision.resolved &&
    entry.license === decision.declaredLicense &&
    offendersForComponent({
      name: decision.name,
      version: decision.version,
      purl: `pkg:npm/${decision.name}@${decision.version}`,
      licenses: entry.license === undefined ? [] : [{ expression: entry.license }],
    }).length === 0
  );
}

function reviewedLockFailures(lock, seen) {
  if (
    !isRecord(lock) ||
    lock.lockfileVersion !== 3 ||
    !isRecord(lock.packages) ||
    !isRecord(lock.packages[""])
  ) {
    return ["malformed canonical npm lock metadata"];
  }
  const failures = [];
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (!isRecord(entry)) {
      failures.push("malformed canonical npm package record");
      continue;
    }
    const decision = recordLicenseDecision(path, entry);
    if (decision === undefined) continue;
    seen.add(decision.name);
    if (!reviewedRecordMatches(path, entry, decision)) {
      failures.push(`${decision.name}: reviewed artifact, identity or license drift`);
    }
  }
  return failures;
}

export function reviewedDependencyLicenseFailures(lockfiles) {
  if (!Array.isArray(lockfiles) || lockfiles.length !== 1) {
    return ["the canonical root npm lock is required"];
  }
  const seen = new Set();
  const failures = lockfiles.flatMap((lock) => reviewedLockFailures(lock, seen));
  for (const { name } of COMPONENT_LICENSE_DECISIONS.values()) {
    if (!seen.has(name)) failures.push(`${name}: reviewed dependency metadata missing`);
  }
  return failures;
}

function reviewedDependencyLicensePreflight() {
  let locks;
  try {
    locks = [JSON.parse(readFileSync(join(repoRoot, "package-lock.json"), "utf8"))];
  } catch {
    fail("cannot read the canonical dependency license lockfile");
  }
  const failures = reviewedDependencyLicenseFailures(locks);
  if (failures.length > 0) fail(failures.join("; "));
  console.log(
    [...COMPONENT_LICENSE_DECISIONS.values()].map(({ name }) => `pkg:npm/${name}`).join(", "),
  );
}

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

function runtimeNodeReference(node) {
  if (!isRecord(node)) throw new TypeError("Invalid npm production dependency node.");
  // npm ls leaves empty nodes for optional platform packages that are not installed. A missing
  // required dependency makes npm ls fail before this projection is called.
  if (Object.keys(node).length === 0) return undefined;
  if (typeof node.name !== "string" || typeof node.version !== "string") {
    throw new TypeError("npm production dependency identity is incomplete.");
  }
  return `${node.name}@${node.version}`;
}

function runtimeDependencyGraph(tree, graph = new Map()) {
  const ref = runtimeNodeReference(tree);
  if (ref === undefined) return graph;
  const edges = graph.get(ref) ?? new Set();
  graph.set(ref, edges);
  for (const child of Object.values(tree.dependencies ?? {})) {
    const childRef = runtimeNodeReference(child);
    if (childRef !== undefined) edges.add(childRef);
    runtimeDependencyGraph(child, graph);
  }
  return graph;
}

/** npm's .dev selector also matches shared prod/dev ancestry; npm ls supplies the actual closure. */
export function projectProductionSbom(sbom, runtimeTree) {
  const graph = runtimeDependencyGraph(runtimeTree);
  const rootRef = sbom.metadata?.component?.["bom-ref"];
  if (!graph.has(rootRef) || !Array.isArray(sbom.components)) {
    throw new TypeError("SBOM and npm production root do not match.");
  }
  const components = sbom.components.filter((component) => graph.has(component["bom-ref"]));
  const available = new Set([rootRef, ...components.map((component) => component["bom-ref"])]);
  if ([...graph.keys()].some((ref) => !available.has(ref))) {
    throw new Error("SBOM is missing a productive dependency component.");
  }
  const dependencies = [...graph.keys()].sort(compareCodeUnits).map((ref) => ({
    ref,
    dependsOn: [...graph.get(ref)].sort(compareCodeUnits),
  }));
  return { ...sbom, components, dependencies };
}

// Match Array#sort's default UTF-16 code-unit ordering without locale-dependent collation.
function compareCodeUnits(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function npmJson(arguments_, purpose) {
  const result = spawnSync(resolveHostExecutable("npm"), arguments_, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    fail(`${purpose} exited ${String(result.status)}: ${result.stderr}`);
  }
  return JSON.parse(result.stdout);
}

function productionSbom(workspaceName) {
  const workspace = workspaceName === undefined ? [] : ["--workspace", workspaceName];
  // The unfiltered official SBOM owns license/hash metadata. The actual productive npm tree owns
  // inclusion and edges; filtering .dev would erase packages also reached by development tools.
  const complete = npmJson(
    ["sbom", "--sbom-format", "cyclonedx", "--include=dev", ...workspace],
    "npm sbom",
  );
  const runtimeTree = npmJson(
    ["ls", "--omit=dev", "--all", "--long", "--json", ...workspace],
    "npm ls production closure",
  );
  return projectProductionSbom(complete, runtimeTree);
}

function generateSbom(workspaceName, outPath) {
  const sbom = productionSbom(workspaceName);
  writeFileSync(outPath, `${JSON.stringify(sbom, null, 2)}\n`);
  return sbom;
}

function generateRootSbom(outPath) {
  // CI's initial npm --omit=dev document has the same shared-dependency omission. Replace it
  // with this owner-validated productive graph before license checks and artifact upload.
  const ciRootSbomPath = join(repoRoot, "sbom.cdx.json");
  const lockfile = JSON.parse(readFileSync(join(repoRoot, "package-lock.json"), "utf8"));
  const sbom = addTypeScriptRuntimeToSbom(
    productionSbom(),
    lockfile.packages?.["node_modules/typescript"],
  );
  const renderedSbom = `${JSON.stringify(sbom, null, 2)}\n`;
  writeFileSync(outPath, renderedSbom);
  if (existsSync(ciRootSbomPath)) {
    writeFileSync(ciRootSbomPath, renderedSbom);
  }
  return sbom;
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
  return isLicenseExpressionAllowed(expression, APPROVED_LICENSES);
}

function isLicenseExpressionAllowed(expression, approvedLicenses) {
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
    return { ok: true, value: approvedLicenses.has(token), pos: pos + 1 };
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
function entryLicenseOffense(entry, approvedLicenses) {
  if (typeof entry?.expression === "string") {
    return isLicenseExpressionAllowed(entry.expression, approvedLicenses) ? null : entry.expression;
  }
  const license = entry?.license ?? {};
  const candidate = license.id ?? license.name ?? "<unknown>";
  return approvedLicenses.has(candidate) ? null : candidate;
}

export function offendersForComponent(component) {
  const id = `${component.name}@${component.version}`;
  const licenses = Array.isArray(component.licenses) ? component.licenses : [];
  // CycloneDX entries without an explicit `licenses` array are treated as offenders — we cannot
  // prove they are acceptable without a declaration — unless this exact artifact's license was
  // reviewed from its own license file.
  if (licenses.length === 0) {
    return undeclaredLicenseReviewed(component) ? [] : [{ id, license: "<missing>" }];
  }
  const offenders = [];
  for (const entry of licenses) {
    const offense = entryLicenseOffense(entry, approvedLicensesForComponent(component));
    if (offense !== null) {
      offenders.push({ id, license: offense });
    }
  }
  return offenders;
}

function undeclaredLicenseReviewed(component) {
  const decision = COMPONENT_LICENSE_DECISIONS.get(component.purl);
  return (
    decision?.undeclaredLicense !== undefined &&
    decision.name === component.name &&
    decision.version === component.version
  );
}

function collectLicenseOffenders(sbom) {
  const components = Array.isArray(sbom.components) ? sbom.components : [];
  return components.flatMap(offendersForComponent);
}

function integrityHash(integrity) {
  if (typeof integrity !== "string" || !integrity.startsWith("sha512-")) return null;
  const encoded = integrity.slice("sha512-".length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return null;
  try {
    const digest = Buffer.from(encoded, "base64");
    return digest.length === 64 ? digest.toString("hex") : null;
  } catch {
    return null;
  }
}

function hasCompleteTypeScriptLockMetadata(lockEntry, version, resolved, hash) {
  return (
    lockEntry !== null &&
    typeof lockEntry === "object" &&
    version !== "" &&
    resolved !== "" &&
    hash !== null &&
    lockEntry.license === "Apache-2.0"
  );
}

function typescriptRuntimeComponent(lockEntry) {
  const version = typeof lockEntry?.version === "string" ? lockEntry.version : "";
  const resolved = typeof lockEntry?.resolved === "string" ? lockEntry.resolved : "";
  const hash = integrityHash(lockEntry?.integrity);
  if (!hasCompleteTypeScriptLockMetadata(lockEntry, version, resolved, hash)) {
    return null;
  }
  return {
    "bom-ref": `typescript@${version}`,
    type: "library",
    name: "typescript",
    version,
    scope: "required",
    purl: `pkg:npm/typescript@${version}`,
    properties: [{ name: "cdx:npm:package:path", value: "node_modules/typescript" }],
    externalReferences: [{ type: "distribution", url: resolved }],
    hashes: [{ alg: "SHA-512", content: hash }],
    licenses: [{ license: { id: "Apache-2.0" } }],
  };
}

function addDependencyReference(sbom, componentRef) {
  const rootRef = sbom.metadata?.component?.["bom-ref"];
  const dependencies = Array.isArray(sbom.dependencies) ? sbom.dependencies : [];
  const rootDependency = dependencies.find(({ ref }) => ref === rootRef);
  if (rootDependency !== undefined) {
    const dependsOn = Array.isArray(rootDependency.dependsOn) ? rootDependency.dependsOn : [];
    rootDependency.dependsOn = [...new Set([...dependsOn, componentRef])].sort((left, right) =>
      left.localeCompare(right),
    );
  }
  if (!dependencies.some(({ ref }) => ref === componentRef)) {
    dependencies.push({ ref: componentRef, dependsOn: [] });
  }
  sbom.dependencies = dependencies;
}

export function addTypeScriptRuntimeToSbom(sbom, lockEntry) {
  const component = typescriptRuntimeComponent(lockEntry);
  if (component === null) {
    throw new Error("TypeScript runtime lock metadata is incomplete.");
  }
  const components = Array.isArray(sbom.components) ? sbom.components : [];
  if (
    !components.some(({ name, version }) => name === "typescript" && version === component.version)
  ) {
    components.push(component);
    components.sort((left, right) =>
      String(left["bom-ref"]).localeCompare(String(right["bom-ref"])),
    );
  }
  sbom.components = components;
  addDependencyReference(sbom, component["bom-ref"]);
  return sbom;
}

function componentIdentity(component) {
  const group = typeof component?.group === "string" ? component.group : "";
  const name = typeof component?.name === "string" ? component.name : "";
  const version = typeof component?.version === "string" ? component.version : "";
  return { group, name, version };
}

function isNativeTypeScriptComponent(component) {
  const { group, name } = componentIdentity(component);
  return (
    group === "@typescript" ||
    name === "@typescript/native" ||
    name.startsWith("@typescript/typescript-") ||
    (group === "@typescript" && name.startsWith("typescript-"))
  );
}

export function typescriptToolchainSbomFailures(sbom, expectedApiVersion) {
  const components = Array.isArray(sbom?.components) ? sbom.components : [];
  const identities = components.map(componentIdentity);
  const apiMatches = identities.filter(
    ({ group, name, version }) =>
      group === "" && name === "typescript" && version === expectedApiVersion,
  );
  const nativeCount = components.filter(isNativeTypeScriptComponent).length;
  const unexpectedApiCount = identities.filter(
    ({ group, name, version }) =>
      group === "" && name === "typescript" && version !== expectedApiVersion,
  ).length;
  const failures = [];
  if (apiMatches.length !== 1) {
    failures.push("root SBOM must contain exactly one productive TypeScript API component.");
  }
  if (nativeCount > 0) {
    failures.push("root SBOM contains a development-only native TypeScript component.");
  }
  if (unexpectedApiCount > 0) {
    failures.push("root SBOM contains an unexpected TypeScript API version.");
  }
  return failures;
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
  const apiManifest = JSON.parse(
    readFileSync(join(repoRoot, "node_modules", "typescript", "package.json"), "utf8"),
  );
  const toolchainFailures = typescriptToolchainSbomFailures(rootSbom, apiManifest.version);
  if (toolchainFailures.length > 0) {
    fail(toolchainFailures.join(" "));
  }
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
  if (process.argv[2] === "--check-reviewed-dependency-licenses") {
    reviewedDependencyLicensePreflight();
  } else {
    main();
  }
}
