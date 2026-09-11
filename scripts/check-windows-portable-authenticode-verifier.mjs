import { Buffer } from "node:buffer";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import {
  DEFAULT_GENERATED_ASSET,
  DEFAULT_VERIFIER_SOURCE,
  FRAMEWORK_REFERENCE_NAMES,
  generateVerifierAsset,
  sha256,
} from "./generate-windows-portable-authenticode-verifier.mjs";
import {
  WINDOWS_RFC3161_VERIFIER_ASSEMBLY_BASE64,
  WINDOWS_RFC3161_VERIFIER_ASSEMBLY_BYTE_LENGTH,
  WINDOWS_RFC3161_VERIFIER_ASSEMBLY_SHA256,
  WINDOWS_RFC3161_VERIFIER_COMPILER_SHA256,
  WINDOWS_RFC3161_VERIFIER_COMPILER_DISTRIBUTION,
  WINDOWS_RFC3161_VERIFIER_REFERENCE_SHA256,
  WINDOWS_RFC3161_VERIFIER_SOURCE,
  WINDOWS_RFC3161_VERIFIER_SOURCE_SHA256,
} from "../packages/keiko-server/src/coding-runtime/windowsPortableAuthenticodeVerifier.generated.ts";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const VISUAL_STUDIO_DIRECTORY = "Microsoft Visual Studio";
const COMPILER_SUFFIX = join("MSBuild", "Current", "Bin", "Roslyn", "csc.exe");
const FRAMEWORK_REFERENCE_SUFFIX = join(
  "Reference Assemblies",
  "Microsoft",
  "Framework",
  ".NETFramework",
  "v4.8.1",
);

function assertContainedPath(root, candidate, label) {
  const contained = relative(root, candidate);
  if (
    contained === "" ||
    contained === ".." ||
    contained.startsWith(`..${sep}`) ||
    isAbsolute(contained)
  ) {
    throw new Error(`${label} path escapes its approved system root`);
  }
  return contained;
}

function trustedCompilerPath(candidate, visualStudioRoot) {
  const lexicalCandidate = resolve(candidate);
  const lexicalRelative = assertContainedPath(visualStudioRoot, lexicalCandidate, "C# compiler");
  if (!lexicalRelative.endsWith(`${sep}${COMPILER_SUFFIX}`)) {
    throw new Error("C# compiler path is outside the approved Visual Studio toolchain layout");
  }
  const canonicalRoot = realpathSync(visualStudioRoot);
  const canonicalCandidate = realpathSync(lexicalCandidate);
  assertContainedPath(canonicalRoot, canonicalCandidate, "C# compiler");
  if (!lstatSync(canonicalCandidate).isFile()) {
    throw new Error("C# compiler path is not a regular file");
  }
  return canonicalCandidate;
}

export function resolveTrustedVerifierToolchain(options, environment = process.env) {
  const programFiles = environment.ProgramFiles;
  const programFilesX86 = environment["ProgramFiles(x86)"];
  if (
    programFiles === undefined ||
    !isAbsolute(programFiles) ||
    programFilesX86 === undefined ||
    !isAbsolute(programFilesX86)
  ) {
    throw new Error(
      "ProgramFiles and ProgramFiles(x86) are required for the Windows verifier check",
    );
  }
  const programFilesRoot = resolve(programFiles);
  const programFilesX86Root = resolve(programFilesX86);
  const visualStudioRoot = resolve(programFilesRoot, VISUAL_STUDIO_DIRECTORY);
  const expectedReferences = resolve(programFilesX86Root, FRAMEWORK_REFERENCE_SUFFIX);
  if (resolve(options.referenceDirectory) !== expectedReferences) {
    throw new Error("framework references path is not the approved .NET Framework 4.8.1 path");
  }
  const canonicalReferences = realpathSync(expectedReferences);
  assertContainedPath(
    realpathSync(programFilesX86Root),
    canonicalReferences,
    "framework references",
  );
  if (!lstatSync(canonicalReferences).isDirectory()) {
    throw new Error("framework references path is not a directory");
  }
  return {
    compilerPath: trustedCompilerPath(options.compilerPath, visualStudioRoot),
    referenceDirectory: canonicalReferences,
  };
}

function assertSourceBinding(asset) {
  if (
    !SHA256_PATTERN.test(asset.sourceSha256) ||
    sha256(Buffer.from(asset.source, "utf8")) !== asset.sourceSha256
  ) {
    throw new Error("generated verifier source digest is invalid");
  }
}

function decodeBoundAssembly(asset) {
  if (
    !Number.isSafeInteger(asset.assemblyByteLength) ||
    asset.assemblyByteLength <= 0 ||
    !BASE64_PATTERN.test(asset.assemblyBase64)
  ) {
    throw new Error("generated verifier assembly encoding is invalid");
  }
  const assembly = Buffer.from(asset.assemblyBase64, "base64");
  if (
    assembly.byteLength !== asset.assemblyByteLength ||
    !SHA256_PATTERN.test(asset.assemblySha256) ||
    sha256(assembly) !== asset.assemblySha256
  ) {
    throw new Error("generated verifier assembly digest is invalid");
  }
  return assembly;
}

function assertToolchainPins(asset) {
  if (!SHA256_PATTERN.test(asset.compilerSha256)) {
    throw new Error("generated verifier compiler pin is invalid");
  }
  assertCompilerDistributionPin(asset.compilerDistribution);
  assertFrameworkReferencePins(asset.referenceSha256);
}

function assertCompilerDistributionPin(distribution) {
  if (
    distribution === null ||
    typeof distribution !== "object" ||
    !SHA256_PATTERN.test(distribution.sha256 ?? "") ||
    !Number.isSafeInteger(distribution.fileCount) ||
    distribution.fileCount <= 0 ||
    !Number.isSafeInteger(distribution.totalBytes) ||
    distribution.totalBytes <= 0
  ) {
    throw new Error("generated verifier compiler-distribution pin is invalid");
  }
}

function assertFrameworkReferencePins(referenceSha256) {
  for (const name of FRAMEWORK_REFERENCE_NAMES) {
    if (!SHA256_PATTERN.test(referenceSha256[name] ?? "")) {
      throw new Error(`generated verifier ${name} pin is invalid`);
    }
  }
}

export function assertCommittedVerifierAsset(asset) {
  assertSourceBinding(asset);
  const assembly = decodeBoundAssembly(asset);
  assertToolchainPins(asset);
  return assembly;
}

export const COMMITTED_VERIFIER_ASSET = Object.freeze({
  assemblyBase64: WINDOWS_RFC3161_VERIFIER_ASSEMBLY_BASE64,
  assemblyByteLength: WINDOWS_RFC3161_VERIFIER_ASSEMBLY_BYTE_LENGTH,
  assemblySha256: WINDOWS_RFC3161_VERIFIER_ASSEMBLY_SHA256,
  compilerSha256: WINDOWS_RFC3161_VERIFIER_COMPILER_SHA256,
  compilerDistribution: WINDOWS_RFC3161_VERIFIER_COMPILER_DISTRIBUTION,
  referenceSha256: WINDOWS_RFC3161_VERIFIER_REFERENCE_SHA256,
  source: WINDOWS_RFC3161_VERIFIER_SOURCE,
  sourceSha256: WINDOWS_RFC3161_VERIFIER_SOURCE_SHA256,
});

export function checkWindowsPortableAuthenticodeVerifier({
  compilerPath,
  referenceDirectory,
  generatedAssetPath = DEFAULT_GENERATED_ASSET,
  sourcePath = DEFAULT_VERIFIER_SOURCE,
}) {
  const committedAssembly = assertCommittedVerifierAsset(COMMITTED_VERIFIER_ASSET);
  const canonicalSource = readFileSync(sourcePath, "utf8");
  if (
    canonicalSource !== COMMITTED_VERIFIER_ASSET.source ||
    sha256(Buffer.from(canonicalSource, "utf8")) !== COMMITTED_VERIFIER_ASSET.sourceSha256
  ) {
    throw new Error("canonical verifier source does not match the generated asset");
  }
  const expectedToolchain = {
    compilerSha256: COMMITTED_VERIFIER_ASSET.compilerSha256,
    compilerDistribution: COMMITTED_VERIFIER_ASSET.compilerDistribution,
    referenceSha256: COMMITTED_VERIFIER_ASSET.referenceSha256,
  };
  const first = generateVerifierAsset({
    compilerPath,
    expectedToolchain,
    referenceDirectory,
    sourcePath,
  });
  const second = generateVerifierAsset({
    compilerPath,
    expectedToolchain,
    referenceDirectory,
    sourcePath,
  });
  if (!first.assembly.equals(second.assembly) || first.asset !== second.asset) {
    throw new Error("verifier regeneration was not byte-deterministic across isolated builds");
  }
  if (!first.assembly.equals(committedAssembly)) {
    throw new Error("regenerated verifier assembly does not match the committed asset");
  }
  if (readFileSync(generatedAssetPath, "utf8") !== first.asset) {
    throw new Error("generated verifier TypeScript asset is stale");
  }
}

function parseArguments(argv) {
  const options = {};
  for (let index = 2; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`missing value for ${String(key)}`);
    if (key === "--compiler") options.compilerPath = value;
    else if (key === "--references") options.referenceDirectory = value;
    else throw new Error(`unknown argument ${String(key)}`);
  }
  if (options.compilerPath === undefined || options.referenceDirectory === undefined) {
    throw new Error("--compiler and --references are required");
  }
  return options;
}

export function executeCheckCli(argv = process.argv) {
  const options = resolveTrustedVerifierToolchain(parseArguments(argv));
  checkWindowsPortableAuthenticodeVerifier(options);
  process.stdout.write("windows-portable-authenticode-verifier: PASS\n");
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  executeCheckCli();
}
