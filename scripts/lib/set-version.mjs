import { join } from "node:path";

// One command moves the product version everywhere it lives mechanically: the root manifest, every
// workspace manifest, every dependency pin between workspace packages, the exported
// KEIKO_*_VERSION constants and, through npm, the lockfile. The 1.0.0 cut was written by hand and
// left package-lock.json's workspace entries at 0.3.17 while every manifest said 1.0.0;
// check-version-consistency refuses that now, and this is the command that never produces it. The
// release-impact catalog entry and the documents stay reviewed work.

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const VERSION_CONSTANT =
  /(export\s+const\s+(?:KEIKO_PRODUCT_VERSION|KEIKO_[A-Z0-9_]*_VERSION)\s*=\s*")[^"]+("\s+as\s+const)/gu;
const OWN_VERSION = /^(\s*"version":\s*")[^"]+(")/mu;

class SetVersionError extends Error {}

function fail(message) {
  throw new SetVersionError(`set-version: ${message}`);
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
}

export function requireVersion(value) {
  if (typeof value !== "string" || !VERSION.test(value)) {
    fail(`${JSON.stringify(value)} is not a semantic version.`);
  }
  return value;
}

/**
 * The manifest text with its own version and every pin on a workspace package moved, formatting
 * untouched; the result is parsed back so a manifest without a version field fails closed.
 */
export function versionedManifest(text, workspaceNames, version) {
  let result = text.replace(OWN_VERSION, (_match, head, tail) => `${head}${version}${tail}`);
  for (const name of workspaceNames) {
    const pin = new RegExp(String.raw`^(\s*"${escapeRegExp(name)}":\s*")[^"]+(")`, "gmu");
    result = result.replace(pin, (_match, head, tail) => `${head}${version}${tail}`);
  }
  if (JSON.parse(result).version !== version) fail("a manifest has no version field.");
  return result;
}

/** The source text with every exported KEIKO_*_VERSION constant moved. */
export function versionedSource(text, version) {
  return text.replace(VERSION_CONSTANT, (_match, head, tail) => `${head}${version}${tail}`);
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
    fail(`${label} failed${result?.stderr ? `: ${String(result.stderr).trim()}` : "."}`);
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
