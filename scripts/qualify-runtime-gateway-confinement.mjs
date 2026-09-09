// Produces the canonical #3390 macOS gateway-confinement receipt from the existing real Seatbelt
// and production-backend tests, joined to one successful managed-runtime confinement event.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { writeQualificationEvidenceReceipt } from "./lib/qualification-evidence-receipt.mjs";
import { buildRuntimeGatewayConfinementArtifact } from "./lib/runtime-gateway-confinement-evidence.mjs";
import { resolveHostExecutable } from "./lib/host-executable.mjs";
import { loadPortableRuntimeApprovals } from "./portable-runtime-approvals.mjs";

const MAX_EVIDENCE_BYTES = 32 * 1024 * 1024;

function required(options, name) {
  const value = options[name];
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`missing --${name}`);
  return value;
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new TypeError("invalid arguments");
    options[key.slice(2)] = value;
  }
  return options;
}

function readBounded(path) {
  const bytes = readFileSync(resolve(path));
  if (bytes.length === 0 || bytes.length > MAX_EVIDENCE_BYTES) {
    throw new TypeError("qualification evidence input size is invalid");
  }
  return bytes;
}

function readJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new TypeError(`${label} is not valid JSON`);
  }
}

export function confinementVitestArgs(reportPath) {
  return [
    resolve("node_modules/vitest/vitest.mjs"),
    "run",
    "packages/keiko-sandbox/src/runtime-gateway.test.ts",
    "packages/keiko-server/src/coding-runtime/devLaneRuntimeProcessBackend.test.ts",
    "--reporter=json",
    `--outputFile=${reportPath}`,
  ];
}

function exactCleanHead(sourceCommitSha) {
  const git = resolveHostExecutable("git");
  const head = execFileSync(git, ["rev-parse", "HEAD"], {
    encoding: "utf8",
    timeout: 30_000,
  }).trim();
  const status = execFileSync(git, ["status", "--porcelain=v1"], {
    encoding: "utf8",
    timeout: 30_000,
  });
  if (head !== sourceCommitSha || status.length > 0) {
    throw new TypeError("qualification checkout is not the clean exact source head");
  }
}

function approvedRuntime() {
  const approved = loadPortableRuntimeApprovals(resolve(import.meta.dirname, ".."))
    .sidecarRuntimes[0];
  if (approved === undefined) throw new TypeError("approved runtime is unavailable");
  return { name: approved.name, version: approved.upstream.version, target: "macos-arm64" };
}

export function qualifyRuntimeGatewayConfinement(options, run = spawnSync) {
  const sourceCommitSha = required(options, "source-commit-sha");
  exactCleanHead(sourceCommitSha);
  const tempRoot = mkdtempSync(join(tmpdir(), "keiko-confinement-qualification-"));
  try {
    const reportPath = join(tempRoot, "vitest.json");
    const result = run(process.execPath, confinementVitestArgs(reportPath), {
      cwd: resolve(import.meta.dirname, ".."),
      encoding: "utf8",
      shell: false,
      timeout: 120_000,
    });
    if (result.error !== undefined || result.status !== 0) {
      throw new Error("runtime confinement qualification tests failed");
    }
    const testReportBytes = readBounded(reportPath);
    const activityBytes = readBounded(required(options, "activity-log"));
    const realBinaryBytes = readBounded(required(options, "real-binary-report"));
    const observationBytes = readBounded(required(options, "managed-observation"));
    const artifact = buildRuntimeGatewayConfinementArtifact({
      sourceCommitSha,
      platform: process.platform,
      architecture: process.arch,
      testReport: readJson(testReportBytes, "confinement test report"),
      testReportBytes,
      realBinaryReport: readJson(realBinaryBytes, "real-binary report"),
      managedObservation: readJson(observationBytes, "managed observation"),
      activityBytes,
      correlationId: required(options, "correlation-id"),
      approvedRuntime: approvedRuntime(),
    });
    const receiptsDir = resolve(required(options, "receipts"));
    mkdirSync(receiptsDir, { recursive: true, mode: 0o700 });
    writeQualificationEvidenceReceipt({
      receiptsDir,
      scenarioId: "egress-confinement-macos-arm64",
      receipt: artifact,
      recordedAt: new Date().toISOString(),
      provenance: "production-functional",
    });
    return artifact;
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    qualifyRuntimeGatewayConfinement(parseArgs(process.argv.slice(2)));
    process.stdout.write("Runtime gateway confinement qualification passed.\n");
  } catch (error) {
    process.stderr.write(`FAIL ${error instanceof Error ? error.message : "unknown error"}\n`);
    process.exitCode = 1;
  }
}
