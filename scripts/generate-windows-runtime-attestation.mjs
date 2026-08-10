#!/usr/bin/env node

import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, win32 } from "node:path";
import { tmpdir } from "node:os";

import { buildCompilerEnvironment } from "./build-secure-workspace-read.mjs";
import { RUNTIME_QUALIFICATION_SUITE } from "./runtime-activation-manifest.mjs";
import { sha256File } from "./lib/digest.mjs";

const SHA256 = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const SOURCE = resolve("native/runtime-attestation/windows/keiko_runtime_attestation.c");
const EXECUTABLE_RELATIVE_PATH = "runtime/native/keiko-runtime-attestation.exe";
const WINDOWS_BUILD_ROOTS = [
  String.raw`C:\Program Files`,
  String.raw`C:\Program Files (x86)`,
  String.raw`C:\Windows\System32`,
];

export class WindowsRuntimeAttestationError extends Error {}

function fail(message) {
  throw new WindowsRuntimeAttestationError(`windows-runtime-attestation: ${message}`);
}

function readReceipt(path) {
  let value;
  try {
    const entry = lstatSync(path);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 || entry.size > 65_536) {
      fail("qualification receipt is invalid");
    }
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error instanceof WindowsRuntimeAttestationError) throw error;
    fail("qualification receipt is invalid");
  }
  if (!receiptIsValid(value)) fail("qualification receipt is invalid");
  return value;
}

function receiptIsValid(value) {
  return (
    receiptHeaderIsValid(value) && receiptDigestsAreValid(value) && receiptSidecarsAreValid(value)
  );
}

function receiptHeaderIsValid(value) {
  return (
    value?.schemaVersion === 1 &&
    value.suiteVersion === RUNTIME_QUALIFICATION_SUITE &&
    value.platformTarget === "windows-x64" &&
    COMMIT.test(value.sourceCommitSha) &&
    value.backend === "windows-job-object" &&
    value.result === "passed"
  );
}

function receiptDigestsAreValid(value) {
  return (
    SHA256.test(value?.activationManifestSha256) &&
    SHA256.test(value?.supervisorSha256) &&
    SHA256.test(value?.secureReadSha256)
  );
}

function receiptSidecarsAreValid(value) {
  return (
    Array.isArray(value?.sidecars) &&
    value.sidecars.length === 1 &&
    value.sidecars[0]?.name === "opencode-compatible" &&
    SHA256.test(value.sidecars[0]?.sha256)
  );
}

function payloadHeader(bytes) {
  const values = [...bytes].map((byte) => `0x${byte.toString(16).padStart(2, "0")}`);
  return [
    "#ifndef KEIKO_RUNTIME_ATTESTATION_PAYLOAD_H",
    "#define KEIKO_RUNTIME_ATTESTATION_PAYLOAD_H",
    `static const unsigned char KEIKO_RUNTIME_ATTESTATION[] = {${values.join(",")}};`,
    `static const size_t KEIKO_RUNTIME_ATTESTATION_LENGTH = ${String(bytes.length)}u;`,
    "#endif",
    "",
  ].join("\n");
}

function parse(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) fail("invalid arguments");
    options[key.slice(2)] = value;
  }
  return options;
}

function required(options, name) {
  const value = options[name];
  if (typeof value !== "string" || value.length === 0) fail(`--${name} is required`);
  return value;
}

export function generateWindowsRuntimeAttestation(
  options,
  { buildCarrierFn = buildWindowsRuntimeAttestationCarrier, platform = process.platform } = {},
) {
  if (platform !== "win32") fail("generation requires Windows");
  const stageRoot = resolve(required(options, "stage-root"));
  const receipt = readReceipt(resolve(required(options, "receipt")));
  const activation = join(stageRoot, "payload", "Keiko", ".portable", "runtime-activation.json");
  if (sha256File(activation) !== receipt.activationManifestSha256) {
    fail("qualification receipt activation binding is stale");
  }
  const destination = join(stageRoot, "payload", "Keiko", ...EXECUTABLE_RELATIVE_PATH.split("/"));
  mkdirSync(dirname(destination), { recursive: true });
  buildCarrierFn(destination, receipt);
  bindCarrierManifest(stageRoot, destination);
  writeFileSync(
    resolve(required(options, "catalog")),
    `payload/Keiko/${EXECUTABLE_RELATIVE_PATH}\n`,
    { mode: 0o600 },
  );
}

export function buildWindowsRuntimeAttestationCarrier(
  destination,
  receipt,
  {
    environment = process.env,
    spawnSyncImpl = spawnSync,
    toolchain = windowsBuildToolchain(environment),
  } = {},
) {
  const scratch = mkdtempSync(join(tmpdir(), "keiko-runtime-attestation-"));
  try {
    const header = join(scratch, "runtime_attestation_payload.h");
    const object = join(scratch, "keiko-runtime-attestation.obj");
    writeFileSync(header, payloadHeader(Buffer.from(`${JSON.stringify(receipt)}\n`, "utf8")), {
      mode: 0o600,
    });
    const result = spawnSyncImpl(
      toolchain.compiler,
      [
        "/nologo",
        "/std:c11",
        "/W4",
        "/WX",
        "/O2",
        "/DUNICODE",
        "/D_UNICODE",
        `/I${scratch}`,
        `/Fo:${object}`,
        `/Fe:${destination}`,
        SOURCE,
      ],
      {
        stdio: "inherit",
        env: toolchain.environment,
      },
    );
    if (result.status !== 0) fail("native attestation carrier build failed");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  const entry = statSync(destination);
  if (!entry.isFile() || entry.size <= 0) fail("native attestation carrier build failed");
}

function allowedWindowsBuildPath(path) {
  const normalized = win32.resolve(path).toLowerCase();
  return WINDOWS_BUILD_ROOTS.some((root) => {
    const normalizedRoot = win32.resolve(root).toLowerCase();
    return normalized === normalizedRoot || normalized.startsWith(`${normalizedRoot}\\`);
  });
}

export function windowsBuildToolchain(
  environment,
  { lstat = lstatSync, realpath = (path) => realpathSync.native(path) } = {},
) {
  const compilerEnvironment = buildCompilerEnvironment("windows-x64", environment);
  const pathEntries = (compilerEnvironment.PATH ?? "")
    .split(win32.delimiter)
    .map((path) => path.trim().replace(/^"|"$/gu, ""))
    .filter((path) => path.length > 0 && allowedWindowsBuildPath(path));
  const compiler = pathEntries
    .map((path) => win32.join(path, "cl.exe"))
    .find((path) => {
      try {
        const sourceEntry = lstat(path);
        const resolved = realpath(path);
        const entry = lstat(resolved);
        if (sourceEntry.isSymbolicLink() || !allowedWindowsBuildPath(resolved)) return false;
        return entry.isFile() && !entry.isSymbolicLink() && entry.nlink === 1;
      } catch {
        return false;
      }
    });
  if (compiler === undefined || pathEntries.length === 0) {
    fail("approved MSVC compiler path is unavailable");
  }
  return {
    compiler: realpath(compiler),
    environment: { ...compilerEnvironment, PATH: pathEntries.join(win32.delimiter) },
  };
}

function bindCarrierManifest(stageRoot, destination) {
  const entry = statSync(destination);
  const manifestPath = join(stageRoot, "manifest", "portable-manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.runtimeAttestation = {
    schemaVersion: 1,
    carrierKind: "authenticode-executable",
    executablePath: EXECUTABLE_RELATIVE_PATH,
    shippedSha256: sha256File(destination),
    sizeBytes: entry.size,
    signing: {
      signatureKind: "authenticode",
      verificationStatus: "unverified-staging",
      signatureVerified: false,
      notarizationRequired: false,
      notarizationVerified: false,
    },
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  try {
    generateWindowsRuntimeAttestation(parse(process.argv.slice(2)));
  } catch (error) {
    console.error(
      error instanceof WindowsRuntimeAttestationError
        ? error.message
        : "windows-runtime-attestation: redacted failure",
    );
    process.exit(1);
  }
}
