import { spawnSync } from "node:child_process";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  lstatSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const FRAMEWORK_REFERENCE_NAMES = Object.freeze([
  "mscorlib.dll",
  "System.dll",
  "System.Core.dll",
  "System.Security.dll",
]);

const SCRIPT_ROOT = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_VERIFIER_SOURCE = resolve(
  SCRIPT_ROOT,
  "../packages/keiko-server/src/coding-runtime/windows-portable-authenticode-verifier.cs",
);
export const DEFAULT_GENERATED_ASSET = resolve(
  SCRIPT_ROOT,
  "../packages/keiko-server/src/coding-runtime/windowsPortableAuthenticodeVerifier.generated.ts",
);
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_TOOLCHAIN_FILES = 4_096;
const MAX_TOOLCHAIN_FILE_BYTES = 256 * 1024 * 1024;
const MAX_TOOLCHAIN_TOTAL_BYTES = 1024 * 1024 * 1024;
const COMPILER_TIMEOUT_MS = 60_000;
const COMPILER_OUTPUT_BYTES = 1024 * 1024;

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalSource(path) {
  const source = readFileSync(path, "utf8");
  if (source.codePointAt(0) === 0xfeff || source.includes("\r") || !source.endsWith("\n")) {
    throw new Error("verifier source must be UTF-8 without BOM, LF-only, and newline-terminated");
  }
  return source;
}

function referencePaths(referenceDirectory) {
  return Object.fromEntries(
    FRAMEWORK_REFERENCE_NAMES.map((name) => [name, resolve(referenceDirectory, name)]),
  );
}

function compareToolchainFiles(left, right) {
  if (left.relativePath < right.relativePath) return -1;
  if (left.relativePath > right.relativePath) return 1;
  return 0;
}

function recordToolchainEntry({ files, path, pending, root, stat }) {
  if (stat.isSymbolicLink()) throw new Error("toolchain trees must not contain symbolic links");
  if (stat.isDirectory()) {
    pending.push(path);
    return;
  }
  if (!stat.isFile())
    throw new Error("toolchain trees may contain only directories and regular files");
  if (stat.size > MAX_TOOLCHAIN_FILE_BYTES) {
    throw new Error("toolchain file exceeds the bounded hashing limit");
  }
  files.push({
    path,
    relativePath: relative(root, path).replaceAll("\\", "/"),
    size: stat.size,
  });
  if (files.length > MAX_TOOLCHAIN_FILES) {
    throw new Error("toolchain tree exceeds the bounded file-count limit");
  }
}

export function boundedDirectoryDigest(rootPath) {
  const root = resolve(rootPath);
  const pending = [root];
  const files = [];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const name of readdirSync(directory).sort().reverse()) {
      const path = join(directory, name);
      const stat = lstatSync(path);
      recordToolchainEntry({ files, path, pending, root, stat });
    }
  }
  files.sort(compareToolchainFiles);
  const digest = createHash("sha256");
  let totalBytes = 0;
  for (const file of files) {
    totalBytes += file.size;
    if (totalBytes > MAX_TOOLCHAIN_TOTAL_BYTES) {
      throw new Error("toolchain tree exceeds the bounded total-byte limit");
    }
    const fileDigest = sha256(readFileSync(file.path));
    digest.update(file.relativePath, "utf8");
    digest.update("\0", "utf8");
    digest.update(String(file.size), "ascii");
    digest.update("\0", "utf8");
    digest.update(fileDigest, "ascii");
    digest.update("\n", "utf8");
  }
  if (files.length === 0) throw new Error("toolchain tree is empty");
  return { fileCount: files.length, sha256: digest.digest("hex"), totalBytes };
}

export function inspectVerifierToolchain({ compilerPath, referenceDirectory }) {
  const compiler = resolve(compilerPath);
  const references = referencePaths(referenceDirectory);
  return {
    compilerDistribution: boundedDirectoryDigest(dirname(compiler)),
    compilerSha256: sha256(readFileSync(compiler)),
    referenceSha256: Object.fromEntries(
      FRAMEWORK_REFERENCE_NAMES.map((name) => [name, sha256(readFileSync(references[name]))]),
    ),
  };
}

function assertSha256(value, label) {
  if (!SHA256_PATTERN.test(value)) throw new Error(`${label} must be a lowercase SHA-256 digest`);
}

export function assertPinnedToolchain(actual, expected) {
  assertSha256(expected.compilerSha256, "expected compiler digest");
  if (actual.compilerSha256 !== expected.compilerSha256) {
    throw new Error("C# compiler digest does not match the reviewed generated-asset pin");
  }
  for (const [label, actualDistribution, expectedDistribution] of [
    ["compiler distribution", actual.compilerDistribution, expected.compilerDistribution],
  ]) {
    assertSha256(expectedDistribution.sha256, `expected ${label} digest`);
    if (
      actualDistribution.sha256 !== expectedDistribution.sha256 ||
      actualDistribution.fileCount !== expectedDistribution.fileCount ||
      actualDistribution.totalBytes !== expectedDistribution.totalBytes
    ) {
      throw new Error(`${label} does not match the reviewed generated-asset pin`);
    }
  }
  for (const name of FRAMEWORK_REFERENCE_NAMES) {
    const digest = expected.referenceSha256[name];
    assertSha256(digest, `expected ${name} digest`);
    if (actual.referenceSha256[name] !== digest) {
      throw new Error(`${name} digest does not match the reviewed generated-asset pin`);
    }
  }
}

export function verifierCompilerArguments({ outputPath, sourcePath, scratchRoot, references }) {
  return [
    "/nologo",
    "/noconfig",
    "/nostdlib+",
    "/deterministic+",
    "/optimize+",
    "/debug-",
    "/warn:4",
    "/warnaserror+",
    "/target:library",
    "/platform:anycpu",
    "/langversion:5",
    "/utf8output",
    `/pathmap:${scratchRoot}=/_/`,
    `/out:${outputPath}`,
    ...FRAMEWORK_REFERENCE_NAMES.map((name) => `/reference:${references[name]}`),
    sourcePath,
  ];
}

function compileVerifier({
  compilerPath,
  referenceDirectory,
  source,
  scratchRoot,
  spawn = spawnSync,
}) {
  const sourceDirectory = join(scratchRoot, "source");
  const outputDirectory = join(scratchRoot, "output");
  const sourcePath = join(sourceDirectory, "windows-portable-authenticode-verifier.cs");
  const outputPath = join(outputDirectory, "Keiko.Portable.Runtime.Authenticode.dll");
  const references = referencePaths(referenceDirectory);
  mkdirSync(sourceDirectory, { recursive: true });
  mkdirSync(outputDirectory, { recursive: true });
  writeFileSync(sourcePath, source, { encoding: "utf8", flag: "wx" });
  const result = spawn(
    resolve(compilerPath),
    verifierCompilerArguments({ outputPath, sourcePath, scratchRoot, references }),
    {
      cwd: dirname(resolve(compilerPath)),
      encoding: "utf8",
      env: {
        LIBPATH: "",
        SystemRoot: process.env.SystemRoot,
        TEMP: scratchRoot,
        TMP: scratchRoot,
        VSLANG: "1033",
        WINDIR: process.env.WINDIR ?? process.env.SystemRoot,
      },
      shell: false,
      timeout: COMPILER_TIMEOUT_MS,
      maxBuffer: COMPILER_OUTPUT_BYTES,
      windowsHide: true,
    },
  );
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(
      `deterministic verifier compilation failed (${String(result.error?.code ?? result.status ?? "unknown")})`,
    );
  }
  return readFileSync(outputPath);
}

export function renderGeneratedVerifierAsset({ assembly, source, toolchain }) {
  const sourceSha256 = sha256(Buffer.from(source, "utf8"));
  const assemblySha256 = sha256(assembly);
  const referenceLines = FRAMEWORK_REFERENCE_NAMES.map(
    (name) => `  ${JSON.stringify(name)}: ${JSON.stringify(toolchain.referenceSha256[name])},`,
  ).join("\n");
  return (
    `// Generated by scripts/generate-windows-portable-authenticode-verifier.mjs. Do not edit.\n` +
    `export const WINDOWS_RFC3161_VERIFIER_SOURCE = ${JSON.stringify(source)};\n` +
    `export const WINDOWS_RFC3161_VERIFIER_SOURCE_SHA256 = ${JSON.stringify(sourceSha256)};\n` +
    `export const WINDOWS_RFC3161_VERIFIER_ASSEMBLY_BYTE_LENGTH = ${String(assembly.byteLength)};\n` +
    `export const WINDOWS_RFC3161_VERIFIER_ASSEMBLY_SHA256 = ${JSON.stringify(assemblySha256)};\n` +
    `export const WINDOWS_RFC3161_VERIFIER_ASSEMBLY_BASE64 = ${JSON.stringify(assembly.toString("base64"))};\n` +
    `export const WINDOWS_RFC3161_VERIFIER_COMPILER_SHA256 = ${JSON.stringify(toolchain.compilerSha256)};\n` +
    `export const WINDOWS_RFC3161_VERIFIER_COMPILER_DISTRIBUTION = Object.freeze(${JSON.stringify(toolchain.compilerDistribution)});\n` +
    `export const WINDOWS_RFC3161_VERIFIER_REFERENCE_SHA256 = Object.freeze({\n${referenceLines}\n});\n`
  );
}

export function generateVerifierAsset({
  compilerPath,
  expectedToolchain,
  referenceDirectory,
  sourcePath = DEFAULT_VERIFIER_SOURCE,
  spawn = spawnSync,
}) {
  const source = canonicalSource(sourcePath);
  const actualToolchain = inspectVerifierToolchain({ compilerPath, referenceDirectory });
  assertPinnedToolchain(actualToolchain, expectedToolchain);
  const scratchRoot = mkdtempSync(join(tmpdir(), "keiko-authenticode-verifier-"));
  try {
    const assembly = compileVerifier({
      compilerPath,
      referenceDirectory,
      source,
      scratchRoot,
      spawn,
    });
    return {
      assembly,
      asset: renderGeneratedVerifierAsset({
        assembly,
        source,
        toolchain: actualToolchain,
      }),
    };
  } finally {
    rmSync(scratchRoot, { force: true, recursive: true });
  }
}
