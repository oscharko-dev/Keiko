#!/usr/bin/env node

import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { buildCompilerEnvironment } from "./build-secure-workspace-read.mjs";
import { RUNTIME_QUALIFICATION_SUITE } from "./runtime-activation-manifest.mjs";

const SHA256 = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const SOURCE = resolve("native/runtime-attestation/windows/keiko_runtime_attestation.c");
const EXECUTABLE_RELATIVE_PATH = "runtime/native/keiko-runtime-attestation.exe";

export class WindowsRuntimeAttestationError extends Error {}

function fail(message) {
  throw new WindowsRuntimeAttestationError(`windows-runtime-attestation: ${message}`);
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
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

export function generateWindowsRuntimeAttestation(options) {
  if (process.platform !== "win32") fail("generation requires Windows");
  const stageRoot = resolve(required(options, "stage-root"));
  const receipt = readReceipt(resolve(required(options, "receipt")));
  const activation = join(stageRoot, "payload", "Keiko", ".portable", "runtime-activation.json");
  if (sha256(activation) !== receipt.activationManifestSha256) {
    fail("qualification receipt activation binding is stale");
  }
  const destination = join(stageRoot, "payload", "Keiko", ...EXECUTABLE_RELATIVE_PATH.split("/"));
  mkdirSync(dirname(destination), { recursive: true });
  buildCarrier(destination, receipt);
  bindCarrierManifest(stageRoot, destination);
  writeFileSync(
    resolve(required(options, "catalog")),
    `payload/Keiko/${EXECUTABLE_RELATIVE_PATH}\n`,
    { mode: 0o600 },
  );
}

function buildCarrier(destination, receipt) {
  const scratch = mkdtempSync(join(tmpdir(), "keiko-runtime-attestation-"));
  try {
    const header = join(scratch, "runtime_attestation_payload.h");
    const object = join(scratch, "keiko-runtime-attestation.obj");
    writeFileSync(header, payloadHeader(Buffer.from(`${JSON.stringify(receipt)}\n`, "utf8")), {
      mode: 0o600,
    });
    const result = spawnSync(
      "cl",
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
        env: buildCompilerEnvironment("windows-x64", process.env),
      },
    );
    if (result.status !== 0) fail("native attestation carrier build failed");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  const entry = statSync(destination);
  if (!entry.isFile() || entry.size <= 0) fail("native attestation carrier build failed");
}

function bindCarrierManifest(stageRoot, destination) {
  const entry = statSync(destination);
  const manifestPath = join(stageRoot, "manifest", "portable-manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.runtimeAttestation = {
    schemaVersion: 1,
    carrierKind: "authenticode-executable",
    executablePath: EXECUTABLE_RELATIVE_PATH,
    shippedSha256: sha256(destination),
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
