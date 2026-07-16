import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SCHEMA_BUNDLE_ALGORITHM = "keiko-codex-schema-bundle-v1";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_BUNDLE_DIRECTORY = resolve(
  repoRoot,
  "packages/keiko-server/resources/codex-app-server-schema",
);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort(compareCodeUnits)
        .map((key) => [key, canonicalJson(value[key])]),
    );
  }
  return value;
}

/** Matches the default Array#sort string ordering: locale-independent UTF-16 code-unit order. */
function compareCodeUnits(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function canonicalJsonBytes(source, filename = "JSON input") {
  let parsed;
  try {
    parsed = JSON.parse(Buffer.isBuffer(source) ? source.toString("utf8") : source);
  } catch (error) {
    throw new Error(
      `${filename} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  return Buffer.from(JSON.stringify(canonicalJson(parsed)), "utf8");
}

export function normalizeSchemaRelativePath(path) {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    /^[A-Za-z]:[\\/]/u.test(path) ||
    /^[\\/]/u.test(path)
  ) {
    throw new Error(`Schema path must be relative: ${path}`);
  }
  const segments = path.split(/[\\/]+/u);
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new Error(`Schema path contains traversal: ${path}`);
  }
  return segments.join("/");
}

function compareCodePoints(first, second) {
  const firstPoints = Array.from(first);
  const secondPoints = Array.from(second);
  const length = Math.min(firstPoints.length, secondPoints.length);
  for (let index = 0; index < length; index += 1) {
    const difference = firstPoints[index].codePointAt(0) - secondPoints[index].codePointAt(0);
    if (difference !== 0) return difference;
  }
  return firstPoints.length - secondPoints.length;
}

function compareSchemaPaths(left, right) {
  return (
    compareCodePoints(left.toLowerCase(), right.toLowerCase()) || compareCodePoints(left, right)
  );
}

function jsonFiles(directory) {
  if (!existsSync(directory)) throw new Error(`Schema directory does not exist: ${directory}`);
  const files = [];
  function visit(current) {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolute = resolve(current, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) {
        const path = normalizeSchemaRelativePath(relative(directory, absolute));
        if (!path.endsWith(".json")) throw new Error(`Unexpected non-JSON schema file: ${path}`);
        files.push({ absolute, path });
      } else throw new Error(`Unsupported schema filesystem entry: ${entry.name}`);
    }
  }
  visit(directory);
  return files.sort((left, right) => compareSchemaPaths(left.path, right.path));
}

export function hashSchemaDirectory(directory) {
  const files = jsonFiles(directory);
  const digest = createHash("sha256");
  for (const file of files) {
    const canonical = canonicalJsonBytes(readFileSync(file.absolute), file.path);
    digest.update(file.path, "utf8");
    digest.update("\0", "utf8");
    digest.update(canonical);
    digest.update("\0", "utf8");
  }
  return { digest: digest.digest("hex"), files };
}

function loadManifest(bundleDirectory) {
  const path = resolve(bundleDirectory, "manifest.json");
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `Cannot load schema bundle manifest: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (manifest.algorithm !== SCHEMA_BUNDLE_ALGORITHM) {
    throw new Error(`Unexpected schema bundle algorithm: ${manifest.algorithm}`);
  }
  if (
    !Number.isInteger(manifest.generatedFileCount) ||
    typeof manifest.generatedFolderSha256 !== "string"
  ) {
    throw new TypeError("Schema bundle manifest is malformed");
  }
  if (!Array.isArray(manifest.vendoredFiles) || manifest.vendoredFiles.length === 0) {
    throw new Error("Schema bundle manifest has no vendored files");
  }
  return manifest;
}

function assertVendoredFileSet(bundleDirectory, vendoredFiles) {
  const expected = new Set(["manifest.json", ...vendoredFiles.map((file) => file.path)]);
  const actual = new Set(jsonFiles(bundleDirectory).map((file) => file.path));
  for (const file of expected) {
    if (file !== "manifest.json" && !actual.has(file)) {
      throw new Error(`Vendored schema file is missing: ${file}`);
    }
  }
  for (const file of actual) {
    if (!expected.has(file)) throw new Error(`Unexpected vendored schema file: ${file}`);
  }
}

function verifyVendoredFile(bundleDirectory, file) {
  if (typeof file.path !== "string" || !/^[A-Za-z0-9._/-]+\.json$/.test(file.path)) {
    throw new Error("Schema bundle manifest contains an invalid vendored path");
  }
  const absolute = resolve(bundleDirectory, file.path);
  const pathFromBundle = relative(resolve(bundleDirectory), absolute);
  if (
    pathFromBundle === "" ||
    pathFromBundle === ".." ||
    pathFromBundle.startsWith("..\\") ||
    pathFromBundle.startsWith("../") ||
    isAbsolute(pathFromBundle)
  ) {
    throw new Error(`Unsafe vendored path: ${file.path}`);
  }
  const source = readFileSync(absolute, "utf8");
  const canonical = canonicalJsonBytes(source, file.path);
  if (canonical.toString("utf8") !== source) {
    throw new Error(`Vendored schema is not canonical: ${file.path}`);
  }
  if (sha256(canonical) !== file.canonicalSha256) {
    throw new Error(`Vendored schema digest drift: ${file.path}`);
  }
}

export function verifyVendoredSchemaBundle(bundleDirectory = DEFAULT_BUNDLE_DIRECTORY) {
  const manifest = loadManifest(bundleDirectory);
  assertVendoredFileSet(bundleDirectory, manifest.vendoredFiles);
  for (const file of manifest.vendoredFiles) verifyVendoredFile(bundleDirectory, file);
  return manifest;
}

export function verifyGeneratedSchemaDirectory(
  directory,
  bundleDirectory = DEFAULT_BUNDLE_DIRECTORY,
) {
  const manifest = verifyVendoredSchemaBundle(bundleDirectory);
  const result = hashSchemaDirectory(directory);
  if (result.files.length !== manifest.generatedFileCount) {
    throw new Error(
      `Generated schema file count drift: expected ${manifest.generatedFileCount}, received ${result.files.length}`,
    );
  }
  if (result.digest !== manifest.generatedFolderSha256) {
    throw new Error(
      `Generated schema digest drift: expected ${manifest.generatedFolderSha256}, received ${result.digest}`,
    );
  }
  return { ...result, manifest };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const generatedIndex = process.argv.indexOf("--generated-dir");
    if (
      generatedIndex !== -1 &&
      (!process.argv[generatedIndex + 1] || process.argv[generatedIndex + 2])
    ) {
      throw new Error(
        "Usage: node scripts/codex-app-server-schema.mjs [--generated-dir <directory>]",
      );
    }
    const result =
      generatedIndex === -1
        ? { manifest: verifyVendoredSchemaBundle() }
        : verifyGeneratedSchemaDirectory(resolve(process.argv[generatedIndex + 1]));
    console.log(
      `codex-app-server-schema: PASS - ${result.manifest.version} (${result.manifest.generatedFolderSha256})`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
