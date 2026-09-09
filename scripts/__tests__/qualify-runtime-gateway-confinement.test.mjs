import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";

import { sha256 } from "../lib/digest.mjs";
import {
  buildRuntimeGatewayConfinementArtifact,
  runtimeGatewayConfinementArtifactErrors,
} from "../lib/runtime-gateway-confinement-evidence.mjs";
import { confinementVitestArgs } from "../qualify-runtime-gateway-confinement.mjs";

const SOURCE = "a".repeat(40);
const CORRELATION = "run-1";
const REQUIRED_TITLES = [
  "denies an unapproved child executable while permitting the real Apple git chain",
  "denies a hostile loopback destination while permitting only the configured gateway port",
  "denies a hostile loopback destination from a forked grandchild while permitting the gateway port",
  "denies a hostile loopback destination while permitting the gateway port via spawnOwnedTree",
];

function passingInput() {
  const binding = {
    catalogRevision: "7".repeat(64),
    profile: { id: "opencode", version: 1 },
    projectionDigest: "8".repeat(64),
    handlerSetDigest: "9".repeat(64),
  };
  const event = {
    op: "runtime.confinement.spawned",
    correlationId: CORRELATION,
    backend: "seatbelt",
    profile: "keiko-gateway",
    childExecutablePolicy: "runtime-and-attested-git-only",
    policyDigest: "1".repeat(64),
    authorityDigest: "2".repeat(64),
    runtimeArtifactDigest: "3".repeat(64),
    modelProfileDigest: "4".repeat(64),
    treeBindingId: "5".repeat(64),
    childExecutableDigest: "6".repeat(64),
  };
  const activityBytes = Buffer.from(`${JSON.stringify(event)}\n`);
  return {
    sourceCommitSha: SOURCE,
    platform: "darwin",
    architecture: "arm64",
    testReport: {
      success: true,
      numTotalTests: 4,
      numPassedTests: 4,
      numFailedTests: 0,
      numPendingTests: 0,
      testResults: [
        {
          assertionResults: REQUIRED_TITLES.map((title) => ({ title, status: "passed" })),
        },
      ],
    },
    testReportBytes: Buffer.from("test-report"),
    realBinaryReport: {
      sourceHead: SOURCE,
      runtime: { name: "opencode-compatible", version: "1.17.17", target: "macos-arm64" },
      journey: { exitCode: 0 },
      activityLog: { status: "retained", sha256: sha256(activityBytes) },
      managedCatalog: { correlationId: CORRELATION, binding },
    },
    managedObservation: {
      schemaVersion: 1,
      sourceHead: SOURCE,
      consumer: "managed-opencode",
      terminalStatus: "completed",
      binding,
      runBinding: { correlationId: CORRELATION, activityLogSha256: sha256(activityBytes) },
    },
    activityBytes,
    correlationId: CORRELATION,
    approvedRuntime: {
      name: "opencode-compatible",
      version: "1.17.17",
      target: "macos-arm64",
    },
  };
}

describe("runtime gateway confinement qualification evidence", () => {
  it("requires zero-skip kernel and production-backend proofs plus the actual spawn event", () => {
    expect(() =>
      buildRuntimeGatewayConfinementArtifact({
        sourceCommitSha: SOURCE,
        platform: "darwin",
        architecture: "arm64",
        testReport: {
          success: true,
          numTotalTests: 4,
          numPassedTests: 3,
          numFailedTests: 0,
          numPendingTests: 1,
          testResults: [],
        },
        testReportBytes: Buffer.from("test-report"),
        realBinaryReport: {
          sourceHead: SOURCE,
          journey: { exitCode: 0 },
          activityLog: { status: "retained", sha256: "b".repeat(64) },
          managedCatalog: { correlationId: "run-1" },
        },
        managedObservation: {
          schemaVersion: 1,
          sourceHead: "a".repeat(40),
          consumer: "managed-opencode",
          terminalStatus: "completed",
          runBinding: { correlationId: CORRELATION, activityLogSha256: "b".repeat(64) },
        },
        activityBytes: Buffer.from("{}\n"),
        correlationId: CORRELATION,
        approvedRuntime: {
          name: "opencode-compatible",
          version: "1.17.17",
          target: "macos-arm64",
        },
      }),
    ).toThrow("confinement test report is not an unskipped passing run");
  });

  it("builds a closed artifact from an actual production event and validates it", () => {
    const artifact = buildRuntimeGatewayConfinementArtifact(passingInput());
    expect(runtimeGatewayConfinementArtifactErrors(artifact)).toEqual([]);
    expect(artifact).toMatchObject({
      scenarioId: "egress-confinement-macos-arm64",
      platformTarget: "macos-arm64",
      result: "passed",
      tests: { total: 4, passed: 4, failed: 0, skipped: 0 },
      runtime: {
        correlationId: CORRELATION,
        backend: "seatbelt",
        profile: "keiko-gateway",
      },
    });
    expect(
      runtimeGatewayConfinementArtifactErrors({ ...artifact, rawOutput: "secret" }),
    ).not.toEqual([]);
  });

  it("runs exactly the two owning real test files through Vitest JSON", () => {
    const args = confinementVitestArgs("/tmp/report.json");
    expect(args).toContain("packages/keiko-sandbox/src/runtime-gateway.test.ts");
    expect(args).toContain(
      "packages/keiko-server/src/coding-runtime/devLaneRuntimeProcessBackend.test.ts",
    );
    expect(args).toContain("--reporter=json");
  });

  it("rejects a runtime report whose handler binding or pinned version differs", () => {
    const input = passingInput();
    expect(() =>
      buildRuntimeGatewayConfinementArtifact({
        ...input,
        managedObservation: {
          ...input.managedObservation,
          binding: { ...input.managedObservation.binding, handlerSetDigest: "f".repeat(64) },
        },
      }),
    ).toThrow("not bound to one successful production run");
    expect(() =>
      buildRuntimeGatewayConfinementArtifact({
        ...input,
        realBinaryReport: {
          ...input.realBinaryReport,
          runtime: { ...input.realBinaryReport.runtime, version: "1.18.0" },
        },
      }),
    ).toThrow("not bound to one successful production run");
  });

  it("rejects a cross-run join even when both runs use the same catalog binding", () => {
    const input = passingInput();
    expect(() =>
      buildRuntimeGatewayConfinementArtifact({
        ...input,
        managedObservation: {
          ...input.managedObservation,
          runBinding: {
            ...input.managedObservation.runBinding,
            correlationId: "run-other",
          },
        },
      }),
    ).toThrow("not bound to one successful production run");
    expect(() =>
      buildRuntimeGatewayConfinementArtifact({
        ...input,
        realBinaryReport: { ...input.realBinaryReport, sourceHead: "f".repeat(40) },
      }),
    ).toThrow("not bound to one successful production run");
    expect(() =>
      buildRuntimeGatewayConfinementArtifact({
        ...input,
        managedObservation: {
          ...input.managedObservation,
          runBinding: {
            ...input.managedObservation.runBinding,
            activityLogSha256: "f".repeat(64),
          },
        },
      }),
    ).toThrow("not bound to one successful production run");
  });
});
