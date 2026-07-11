import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join, posix, relative, resolve } from "node:path";

const TARGETS = new Set(["macos-arm64", "macos-x64"]);
const MAX_FILES = 50_000;
const MAX_DEPTH = 32;
const MAX_CODE_OBJECTS = 4_096;
const MACH_O_MAGICS = new Set([
  0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca,
]);
const BUNDLE_PATTERN = /\.(?:app|appex|bundle|framework|xpc)$/iu;

export class BoundedMacSigningError extends Error {}

export function boundedMacSigningFail(message) {
  throw new BoundedMacSigningError(`macos-portable-signing: ${message}`);
}

function hasUnsafeText(value) {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return character === "\\" || code < 32 || code === 127;
  });
}

function isSafePortablePath(path) {
  return (
    typeof path === "string" &&
    /^[^/]+(?:\/[^/]+)*$/u.test(path) &&
    !hasUnsafeText(path) &&
    !path.split("/").some((part) => part === "." || part === "..")
  );
}

function portablePath(root, path) {
  return relative(root, path).replaceAll("\\", "/");
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function isMachO(path) {
  if (statSync(path).size < 4) return false;
  const descriptor = openSync(path, "r");
  try {
    const header = Buffer.alloc(4);
    if (readSync(descriptor, header, 0, 4, 0) !== 4) return false;
    return MACH_O_MAGICS.has(header.readUInt32BE(0));
  } finally {
    closeSync(descriptor);
  }
}

function roleFor(path) {
  if (path === "Keiko.app/Contents/Resources/runtime/node/bin/node") return "node-runtime";
  if (path.startsWith("Keiko.app/Contents/Resources/runtime/sidecars/")) return "sidecar-runtime";
  return "default";
}

function inspectFile(root, path, name, entry, state) {
  if (!entry.isFile()) boundedMacSigningFail("payload contains a special file");
  if (entry.nlink !== 1) boundedMacSigningFail("payload contains a hard-linked file");
  state.files += 1;
  if (state.files > MAX_FILES) boundedMacSigningFail("payload exceeds the bounded file count");
  const relativePath = portablePath(root, path);
  if (
    relativePath.startsWith("../") ||
    posix.isAbsolute(relativePath) ||
    !isSafePortablePath(relativePath)
  )
    boundedMacSigningFail("payload escapes its root");
  const macho = isMachO(path);
  if (/\.(?:dylib|node)$/iu.test(name) && !macho)
    boundedMacSigningFail("native-named payload file is not Mach-O");
  if (macho) state.code.push({ relativePath, role: roleFor(relativePath), sha256: sha256(path) });
}

function walk(root, current, depth, state) {
  if (depth > MAX_DEPTH) boundedMacSigningFail("payload exceeds the bounded directory depth");
  for (const name of readdirSync(current).sort()) {
    const path = join(current, name);
    const entry = lstatSync(path);
    if (entry.isSymbolicLink()) boundedMacSigningFail("payload contains a link");
    if (entry.isDirectory()) {
      if (BUNDLE_PATTERN.test(name) && path !== join(root, "Keiko.app")) {
        state.bundles.push(portablePath(root, path));
      }
      walk(root, path, depth + 1, state);
    } else {
      inspectFile(root, path, name, entry, state);
    }
  }
}

export function inventoryMacPortableCode(payloadRoot, target) {
  if (!TARGETS.has(target))
    boundedMacSigningFail("target must be a supported macOS portable target");
  const root = resolve(payloadRoot);
  if (!existsSync(root) || !lstatSync(root).isDirectory())
    boundedMacSigningFail("payload root is missing");
  const state = { bundles: [], code: [], files: 0 };
  walk(root, root, 0, state);
  state.code.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  state.bundles.sort(
    (left, right) => right.split("/").length - left.split("/").length || left.localeCompare(right),
  );
  if (state.code.length === 0 || state.code.length > MAX_CODE_OBJECTS)
    boundedMacSigningFail("Mach-O inventory is empty or exceeds its bound");
  const lower = state.code.map((entry) => entry.relativePath.toLowerCase());
  if (new Set(lower).size !== lower.length)
    boundedMacSigningFail("Mach-O inventory contains case-colliding paths");
  requirePrimaryCode(state.code);
  return { schemaVersion: 1, target, codeObjects: state.code, nestedBundles: state.bundles };
}

function requirePrimaryCode(codeObjects) {
  const paths = new Set(codeObjects.map((entry) => entry.relativePath));
  if (!paths.has("Keiko.app/Contents/MacOS/Keiko"))
    boundedMacSigningFail("primary macOS launcher is missing");
  if (!paths.has("Keiko.app/Contents/Resources/runtime/node/bin/node"))
    boundedMacSigningFail("bundled Node executable is missing");
}

function hasExactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify(keys)
  );
}

function validInventoryShape(value) {
  return (
    hasExactKeys(value, ["codeObjects", "nestedBundles", "schemaVersion", "target"]) &&
    value.schemaVersion === 1 &&
    TARGETS.has(value.target) &&
    Array.isArray(value.codeObjects) &&
    Array.isArray(value.nestedBundles) &&
    value.codeObjects.length > 0 &&
    value.codeObjects.length <= MAX_CODE_OBJECTS &&
    value.nestedBundles.length <= MAX_CODE_OBJECTS
  );
}

function assertCanonicalOrder(values, compare) {
  const sorted = [...values].sort(compare);
  if (JSON.stringify(values) !== JSON.stringify(sorted))
    boundedMacSigningFail("macOS code inventory is invalid");
}

function validateInventoryEntry(entry, seen) {
  if (
    !hasExactKeys(entry, ["relativePath", "role", "sha256"]) ||
    typeof entry.relativePath !== "string" ||
    !isSafePortablePath(entry.relativePath) ||
    !/^[a-f0-9]{64}$/u.test(entry.sha256) ||
    entry.role !== roleFor(entry.relativePath)
  )
    boundedMacSigningFail("macOS code inventory is invalid");
  const key = entry.relativePath.toLowerCase();
  if (seen.has(key)) boundedMacSigningFail("macOS code inventory is invalid");
  seen.add(key);
}

function validateNestedBundles(bundles) {
  const seen = new Set();
  for (const bundle of bundles) {
    const key = typeof bundle === "string" ? bundle.toLowerCase() : "";
    if (!isSafePortablePath(bundle) || !bundle.startsWith("Keiko.app/"))
      boundedMacSigningFail("macOS code inventory is invalid");
    if (!BUNDLE_PATTERN.test(bundle) || seen.has(key))
      boundedMacSigningFail("macOS code inventory is invalid");
    seen.add(key);
  }
  assertCanonicalOrder(
    bundles,
    (left, right) => right.split("/").length - left.split("/").length || left.localeCompare(right),
  );
}

export function readMacPortableInventory(path) {
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (!validInventoryShape(value)) boundedMacSigningFail("macOS code inventory is invalid");
  const seen = new Set();
  for (const entry of value.codeObjects) validateInventoryEntry(entry, seen);
  requirePrimaryCode(value.codeObjects);
  assertCanonicalOrder(
    value.codeObjects.map((entry) => entry.relativePath),
    (left, right) => left.localeCompare(right),
  );
  validateNestedBundles(value.nestedBundles);
  return value;
}

export function macPortableInventoriesMatch(expected, actual, includeHashes) {
  const project = (inventory) =>
    inventory.codeObjects.map((entry) => (includeHashes ? entry : entry.relativePath));
  return (
    expected.target === actual.target &&
    JSON.stringify(project(expected)) === JSON.stringify(project(actual)) &&
    JSON.stringify(expected.nestedBundles) === JSON.stringify(actual.nestedBundles)
  );
}
