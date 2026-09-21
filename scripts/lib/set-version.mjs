import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { resolveHostExecutable } from "./host-executable.mjs";

// One command moves the product version everywhere it lives mechanically: the root manifest, every
// workspace manifest, every dependency pin between workspace packages, the exported
// KEIKO_*_VERSION constants and, through npm, the lockfile. The 1.0.0 cut was written by hand and
// left package-lock.json's workspace entries at 0.3.17 while every manifest said 1.0.0;
// check-version-consistency refuses that now, and this is the command that never produces it. The
// release-impact catalog entry and the documents stay reviewed work.

// SemVer 2.0.0 without build metadata, which no Keiko release carries. Identifier by identifier, so
// no pattern backtracks: numeric identifiers have no leading zero, prerelease identifiers are
// non-empty.
const NUMERIC_IDENTIFIER = /^(?:0|[1-9]\d*)$/u;
const PRERELEASE_IDENTIFIER = /^[0-9A-Za-z-]+$/u;
const DIGITS = /^\d+$/u;
const VERSION_CONSTANT =
  /(export\s+const\s+(?:KEIKO_PRODUCT_VERSION|KEIKO_[A-Z0-9_]*_VERSION)\s*=\s*")[^"]+("\s+as\s+const)/gu;
const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];

class SetVersionError extends Error {}

function fail(message) {
  throw new SetVersionError(`set-version: ${message}`);
}

function prereleaseIdentifier(identifier) {
  if (!PRERELEASE_IDENTIFIER.test(identifier)) return false;
  return !DIGITS.test(identifier) || NUMERIC_IDENTIFIER.test(identifier);
}

function semanticVersion(value) {
  const dash = value.indexOf("-");
  const core = (dash === -1 ? value : value.slice(0, dash)).split(".");
  if (core.length !== 3 || !core.every((part) => NUMERIC_IDENTIFIER.test(part))) return false;
  return (
    dash === -1 ||
    value
      .slice(dash + 1)
      .split(".")
      .every(prereleaseIdentifier)
  );
}

export function requireVersion(value) {
  if (typeof value !== "string" || !semanticVersion(value)) {
    fail(`${JSON.stringify(value)} is not a semantic version.`);
  }
  return value;
}

/**
 * The manifest with its own version and every dependency pin on a workspace package moved. Every
 * manifest here is in prettier's json-stringify form, which is exactly JSON.stringify(…, null, 2), so
 * the rewrite changes nothing but the versions; set-version.test.mjs pins that form for the checkout.
 */
export function versionedManifest(text, workspaceNames, version) {
  const manifest = JSON.parse(text);
  if (typeof manifest.version !== "string") fail("a manifest has no version field.");
  manifest.version = version;
  const workspaces = new Set(workspaceNames);
  for (const field of DEPENDENCY_FIELDS) {
    for (const name of Object.keys(manifest[field] ?? {})) {
      if (workspaces.has(name)) manifest[field][name] = version;
    }
  }
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/** The source text with every exported KEIKO_*_VERSION constant moved. */
export function versionedSource(text, version) {
  return text.replace(VERSION_CONSTANT, (_match, head, tail) => `${head}${version}${tail}`);
}

const LOCKFILE_VERSION_PLACEHOLDER = "0.0.0-version-normalized";
// The root manifest ("") and exactly this repository's configured workspace glob
// (package.json "workspaces": ["packages/*"]) -- never "no resolved field", which npm also uses for
// a bundled node_modules/* dependency (`inBundle: true`, no `resolved`). That shape would
// misclassify a real, unreviewed dependency change as harmless workspace version noise and let
// normalizedLockfileText normalize it away (#3555 review).
const WORKSPACE_LOCKFILE_PATH = /^packages\/[^/]+$/u;

function isWorkspaceLockfilePath(path) {
  return path === "" || WORKSPACE_LOCKFILE_PATH.test(path);
}

function workspaceLockfileEntries(packages) {
  return Object.entries(packages)
    .filter(
      ([path, entry]) =>
        isWorkspaceLockfilePath(path) && entry !== null && typeof entry === "object",
    )
    .map(([, entry]) => entry);
}

function normalizeWorkspaceLockfileEntry(entry, workspaceNames) {
  if (typeof entry.version === "string") entry.version = LOCKFILE_VERSION_PLACEHOLDER;
  for (const field of DEPENDENCY_FIELDS) {
    const dependencies = entry[field];
    if (dependencies === null || typeof dependencies !== "object") continue;
    for (const name of Object.keys(dependencies)) {
      if (workspaceNames.has(name)) dependencies[name] = LOCKFILE_VERSION_PLACEHOLDER;
    }
  }
}

/**
 * `text` with every workspace package's own `version` field, and every dependency pin ON a
 * workspace package, replaced by a fixed placeholder. A workspace-local `packages/*` entry (and
 * the root `""` entry) is identified by its lockfile path, exactly this repository's configured
 * workspace glob -- never by content shape. This module moves exactly these fields on a version
 * bump and nothing else a lockfile refresh can reach, so the normalized text is unchanged across a
 * version-only bump while any other lockfile change -- a real dependency added, removed or
 * re-resolved, third-party version bumped, a bundled node_modules/* entry with no `resolved` -- still
 * moves it.
 */
export function normalizedLockfileText(text) {
  const lockfile = JSON.parse(text);
  if (typeof lockfile.version === "string") lockfile.version = LOCKFILE_VERSION_PLACEHOLDER;
  const packages = lockfile.packages;
  if (packages === null || typeof packages !== "object") return text;
  const entries = workspaceLockfileEntries(packages);
  const workspaceNames = new Set(entries.map((entry) => entry.name).filter(Boolean));
  for (const entry of entries) normalizeWorkspaceLockfileEntry(entry, workspaceNames);
  return JSON.stringify(lockfile);
}

function rewrite(path, readText, writeText, produce) {
  const before = readText(path);
  const after = produce(before);
  if (after === before) return false;
  writeText(path, after);
  return true;
}

function runStep(spawn, root, label, executable, args) {
  const result = spawn(executable, args, root);
  if (result?.error !== undefined || result?.status !== 0) {
    const detail = result?.stderr ? `: ${String(result.stderr).trim()}` : ".";
    fail(`${label} failed${detail}`);
  }
}

/**
 * Writes the version into every manifest, pin and constant under `root`, refreshes the lockfile
 * and proves the result with check-version-consistency.
 *
 * @param listWorkspaceDirs  (packagesDir) => absolute workspace directories
 * @param readOptionalText   (path) => text, or undefined when the file does not exist
 * @param spawn              (executable, args, cwd) => {status, stdout, stderr, error}
 * @returns the files that changed
 */
export function applySetVersion({
  listWorkspaceDirs,
  readOptionalText,
  readText,
  root,
  spawn,
  version,
  writeText,
}) {
  requireVersion(version);
  const workspaceDirs = listWorkspaceDirs(join(root, "packages"));
  const workspaceNames = workspaceDirs.map(
    (dir) => JSON.parse(readText(join(dir, "package.json"))).name,
  );
  const changed = [];
  for (const path of [
    join(root, "package.json"),
    ...workspaceDirs.map((dir) => join(dir, "package.json")),
  ]) {
    const produce = (text) => versionedManifest(text, workspaceNames, version);
    if (rewrite(path, readText, writeText, produce)) changed.push(path);
  }
  for (const dir of workspaceDirs) {
    const path = join(dir, "src", "version.ts");
    if (readOptionalText(path) === undefined) continue;
    if (rewrite(path, readText, writeText, (text) => versionedSource(text, version))) {
      changed.push(path);
    }
  }
  runStep(spawn, root, "the lockfile refresh", "npm", [
    "install",
    "--package-lock-only",
    "--ignore-scripts",
  ]);
  runStep(spawn, root, "the version consistency check", "node", [
    "scripts/check-version-consistency.mjs",
  ]);
  return changed;
}

/**
 * The real Node.js/host seams applySetVersion needs, minus `root` and `version`, wired once for the
 * CLI that moves the product version (scripts/set-version.mjs).
 */
export function nodeSetVersionHost() {
  return {
    listWorkspaceDirs: (packagesDir) =>
      readdirSync(packagesDir)
        .map((name) => join(packagesDir, name))
        .filter((dir) => statSync(dir).isDirectory() && existsSync(join(dir, "package.json"))),
    readOptionalText: (path) => (existsSync(path) ? readFileSync(path, "utf8") : undefined),
    readText: (path) => readFileSync(path, "utf8"),
    spawn: (executable, args, cwd) =>
      spawnSync(resolveHostExecutable(executable), args, { cwd, encoding: "utf8" }),
    writeText: (path, text) => writeFileSync(path, text, "utf8"),
  };
}

/**
 * The CLI around applySetVersion: one report on stdout, or one error line on stderr and exit 1.
 *
 * @param write  (stream: "stdout" | "stderr", text) => void
 */
export function setVersionMain({ argv, write, ...seams }) {
  try {
    const version = requireVersion(argv[0]);
    const changed = applySetVersion({ ...seams, version });
    write(
      "stdout",
      `set-version: ${version} written to ${changed.length} file(s); the lockfile and ` +
        "check-version-consistency agree.\n" +
        "set-version: the release-impact catalog entry, docs/PUBLIC_API_SURFACE.md and the " +
        "regenerated evidence documents stay reviewed work.\n",
    );
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const report = error instanceof SetVersionError ? message : `set-version: ${message}`;
    write("stderr", `${report}\n`);
    return 1;
  }
}
