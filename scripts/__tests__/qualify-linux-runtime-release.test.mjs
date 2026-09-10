import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assertQualificationReport,
  exactCleanHead,
  LinuxRuntimeQualificationError,
  linuxQualificationVitestArgs,
  parseQualificationArgs,
  qualificationReceiptFor,
  qualifyLinuxRuntimeRelease,
  runQualificationTests,
} from "../qualify-linux-runtime-release.mjs";
import { RUNTIME_QUALIFICATION_SUITE } from "../runtime-activation-manifest.mjs";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const TARGET = "linux-x64";
const roots = [];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function fixture() {
  const stageRoot = mkdtempSync(join(tmpdir(), "keiko-linux-runtime-qualification-"));
  roots.push(stageRoot);
  const resourceRoot = join(stageRoot, "payload", "Keiko");
  const supervisor = Buffer.from("compiled sandbox runtime\n");
  const secureRead = Buffer.from("secure workspace read\n");
  const usearch = Buffer.from("native usearch addon\n");
  const nativeHelpers = [
    {
      name: "keiko-runtime-supervisor",
      platformTarget: TARGET,
      executablePath: "app/node_modules/@oscharko-dev/keiko-sandbox/dist/runtime.js",
      sizeBytes: supervisor.length,
      shippedSha256: sha256(supervisor),
    },
    {
      name: "keiko-secure-workspace-read",
      platformTarget: TARGET,
      executablePath: "runtime/native/keiko-secure-workspace-read",
      sizeBytes: secureRead.length,
      shippedSha256: sha256(secureRead),
    },
  ];
  for (const [helper, bytes] of [
    [nativeHelpers[0], supervisor],
    [nativeHelpers[1], secureRead],
  ]) {
    const path = join(resourceRoot, ...helper.executablePath.split("/"));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
  }
  for (const [path, bytes] of [
    ["Keiko", Buffer.from("native launcher\n")],
    ["runtime/node/bin/node", Buffer.from("node runtime\n")],
    ["runtime/native/usearch.node", usearch],
  ]) {
    const destination = join(resourceRoot, ...path.split("/"));
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, bytes);
  }
  const activation = {
    schemaVersion: 1,
    suiteVersion: RUNTIME_QUALIFICATION_SUITE,
    sourceCommitSha: COMMIT,
    platformTarget: TARGET,
    artifact: { platformTarget: TARGET },
    runtime: { nodePlatform: "linux", nodeArchitecture: "x64" },
    security: { verificationStatus: "verified-production" },
    nativeHelpers,
    nativeAddons: [
      {
        name: "usearch",
        platformTarget: TARGET,
        executablePath: "runtime/native/usearch.node",
        sizeBytes: usearch.length,
        shippedSha256: sha256(usearch),
      },
    ],
    sidecarRuntimes: [
      { name: "opencode-compatible", platformTarget: TARGET, payloadSha256: "a".repeat(64) },
    ],
  };
  const activationPath = join(resourceRoot, ".portable", "runtime-activation.json");
  mkdirSync(dirname(activationPath), { recursive: true });
  writeFileSync(activationPath, `${JSON.stringify(activation)}\n`);
  return { activation, activationPath, resourceRoot, stageRoot };
}

function expectActivationRejection(mutate, expectedMessage) {
  const value = fixture();
  mutate(value.activation);
  writeFileSync(value.activationPath, `${JSON.stringify(value.activation)}\n`);
  expect(() =>
    qualificationReceiptFor({
      activationPath: value.activationPath,
      resourceRoot: value.resourceRoot,
      sourceCommitSha: COMMIT,
    }),
  ).toThrow(expectedMessage);
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe("Linux runtime qualification", () => {
  it("parses paired CLI options and rejects malformed argument vectors", () => {
    expect(
      parseQualificationArgs(["--source-commit-sha", COMMIT, "--stage-root", "/tmp/stage"]),
    ).toEqual({ "source-commit-sha": COMMIT, "stage-root": "/tmp/stage" });
    expect(() => parseQualificationArgs(["source-commit-sha", COMMIT])).toThrow(
      "invalid arguments",
    );
    expect(() => parseQualificationArgs(["--source-commit-sha"])).toThrow("invalid arguments");
  });

  it("requires the exact clean source head", () => {
    const clean = vi.fn((_command, args) => (args[0] === "rev-parse" ? `${COMMIT}\n` : ""));
    expect(() => exactCleanHead(COMMIT, clean)).not.toThrow();
    expect(clean).toHaveBeenCalledTimes(2);

    const wrongHead = vi.fn((_command, args) =>
      args[0] === "rev-parse" ? `${"f".repeat(40)}\n` : "",
    );
    expect(() => exactCleanHead(COMMIT, wrongHead)).toThrow(
      "qualification checkout is not the clean exact source head",
    );

    const dirty = vi.fn((_command, args) =>
      args[0] === "rev-parse" ? `${COMMIT}\n` : " M changed.ts\n",
    );
    expect(() => exactCleanHead(COMMIT, dirty)).toThrow(
      "qualification checkout is not the clean exact source head",
    );
  });

  it("binds the exact production activation, helper bytes, and sidecar", () => {
    const value = fixture();
    expect(
      qualificationReceiptFor({
        activationPath: value.activationPath,
        resourceRoot: value.resourceRoot,
        sourceCommitSha: COMMIT,
      }),
    ).toMatchObject({
      schemaVersion: 2,
      platformTarget: TARGET,
      supervisorSha256: value.activation.nativeHelpers[0].shippedSha256,
      secureReadSha256: value.activation.nativeHelpers[1].shippedSha256,
      runtimeComponents: [
        { name: "primary-launcher", sha256: sha256("native launcher\n") },
        { name: "node-runtime", sha256: sha256("node runtime\n") },
        { name: "usearch", sha256: sha256("native usearch addon\n") },
      ],
      sidecars: [{ name: "opencode-compatible", sha256: "a".repeat(64) }],
      backend: "linux-namespace-gateway",
      result: "passed",
    });
  });

  it("runs the mandatory proof and persists the canonical receipt", () => {
    const value = fixture();
    const exactCleanHead = vi.fn();
    const runQualificationTests = vi.fn();
    const receipt = qualifyLinuxRuntimeRelease(
      {
        "source-commit-sha": COMMIT,
        "stage-root": value.stageRoot,
        "test-report": join(value.stageRoot, "tests.json"),
      },
      { exactCleanHead, platform: "linux", runQualificationTests },
    );
    expect(exactCleanHead).toHaveBeenCalledWith(COMMIT);
    expect(runQualificationTests).toHaveBeenCalledOnce();
    expect(
      JSON.parse(
        readFileSync(join(value.resourceRoot, ".portable", "runtime-qualification.json"), "utf8"),
      ),
    ).toEqual(receipt);
    qualifyLinuxRuntimeRelease(
      { ...optionsFor(value), "verify-only": "true" },
      { exactCleanHead, platform: "linux", runQualificationTests },
    );
  });

  it("fails closed on the wrong host, invalid identity, and changed helper bytes", () => {
    const value = fixture();
    const options = {
      "source-commit-sha": COMMIT,
      "stage-root": value.stageRoot,
      "test-report": join(value.stageRoot, "tests.json"),
    };
    expect(() => qualifyLinuxRuntimeRelease(options, { platform: "darwin" })).toThrow(
      "qualification requires Linux",
    );
    expect(() =>
      qualifyLinuxRuntimeRelease(
        { ...options, "source-commit-sha": "not-a-commit" },
        { platform: "linux" },
      ),
    ).toThrow("source commit is invalid");
    expect(() =>
      qualifyLinuxRuntimeRelease(
        { ...options, "verify-only": "sometimes" },
        { exactCleanHead: vi.fn(), platform: "linux", runQualificationTests: vi.fn() },
      ),
    ).toThrow("--verify-only is invalid");
    writeFileSync(
      join(value.resourceRoot, "runtime", "native", "keiko-secure-workspace-read"),
      "changed\n",
    );
    expect(() =>
      qualificationReceiptFor({
        activationPath: value.activationPath,
        resourceRoot: value.resourceRoot,
        sourceCommitSha: COMMIT,
      }),
    ).toThrow(LinuxRuntimeQualificationError);
  });

  it("rejects incomplete helper, addon, and runtime-component inputs", () => {
    const missingHelpers = fixture();
    delete missingHelpers.activation.nativeHelpers;
    writeFileSync(missingHelpers.activationPath, `${JSON.stringify(missingHelpers.activation)}\n`);
    expect(() =>
      qualificationReceiptFor({
        activationPath: missingHelpers.activationPath,
        resourceRoot: missingHelpers.resourceRoot,
        sourceCommitSha: COMMIT,
      }),
    ).toThrow("activation helper set is invalid");

    const missingAddons = fixture();
    delete missingAddons.activation.nativeAddons;
    writeFileSync(missingAddons.activationPath, `${JSON.stringify(missingAddons.activation)}\n`);
    expect(() =>
      qualificationReceiptFor({
        activationPath: missingAddons.activationPath,
        resourceRoot: missingAddons.resourceRoot,
        sourceCommitSha: COMMIT,
      }),
    ).toThrow("activation native addon set is invalid");

    const missingRuntime = fixture();
    rmSync(join(missingRuntime.resourceRoot, "Keiko"));
    expect(() =>
      qualificationReceiptFor({
        activationPath: missingRuntime.activationPath,
        resourceRoot: missingRuntime.resourceRoot,
        sourceCommitSha: COMMIT,
      }),
    ).toThrow("runtime component bytes are invalid");

    const emptyRuntime = fixture();
    writeFileSync(join(emptyRuntime.resourceRoot, "runtime", "node", "bin", "node"), "");
    expect(() =>
      qualificationReceiptFor({
        activationPath: emptyRuntime.activationPath,
        resourceRoot: emptyRuntime.resourceRoot,
        sourceCommitSha: COMMIT,
      }),
    ).toThrow("runtime component bytes are invalid");
  });

  it("rejects every malformed helper and native-addon binding field", () => {
    for (const mutate of [
      (activation) => (activation.nativeHelpers[0].platformTarget = "windows-x64"),
      (activation) => (activation.nativeHelpers[0].executablePath = "runtime/other"),
      (activation) => (activation.nativeHelpers[0].sizeBytes = 1.5),
      (activation) => (activation.nativeHelpers[0].sizeBytes = 0),
      (activation) => (activation.nativeHelpers[0].shippedSha256 = "invalid"),
    ]) {
      expectActivationRejection(mutate, "activation helper set is invalid");
    }
    for (const mutate of [
      (activation) => (activation.nativeAddons[0].name = "other"),
      (activation) => (activation.nativeAddons[0].platformTarget = "windows-x64"),
      (activation) => (activation.nativeAddons[0].executablePath = "runtime/native/other.node"),
      (activation) => (activation.nativeAddons[0].sizeBytes = 1.5),
      (activation) => (activation.nativeAddons[0].sizeBytes = 0),
      (activation) => (activation.nativeAddons[0].shippedSha256 = "invalid"),
    ]) {
      expectActivationRejection(mutate, "activation native addon set is invalid");
    }
  });

  it.each(["Keiko", "runtime/node/bin/node"])(
    "changes the signed qualification binding when %s changes",
    (relativePath) => {
      const value = fixture();
      const before = qualificationReceiptFor({
        activationPath: value.activationPath,
        resourceRoot: value.resourceRoot,
        sourceCommitSha: COMMIT,
      });
      writeFileSync(
        join(value.resourceRoot, ...relativePath.split("/")),
        "changed runtime bytes\n",
      );
      const after = qualificationReceiptFor({
        activationPath: value.activationPath,
        resourceRoot: value.resourceRoot,
        sourceCommitSha: COMMIT,
      });

      expect(after.runtimeComponents).not.toEqual(before.runtimeComponents);
    },
  );

  it("rejects qualification when USearch differs from its activation binding", () => {
    const value = fixture();
    writeFileSync(
      join(value.resourceRoot, "runtime", "native", "usearch.node"),
      "changed runtime bytes\n",
    );

    expect(() =>
      qualificationReceiptFor({
        activationPath: value.activationPath,
        resourceRoot: value.resourceRoot,
        sourceCommitSha: COMMIT,
      }),
    ).toThrow(LinuxRuntimeQualificationError);
  });

  it("pins the real namespace-gateway and production-composition suites", () => {
    expect(linuxQualificationVitestArgs("/tmp/report.json")).toEqual(
      expect.arrayContaining([
        "packages/keiko-sandbox/src/linux-gateway-launcher.test.ts",
        "packages/keiko-server/src/coding-runtime/productionOpenCodeBackend.test.ts",
        "--reporter=json",
        "--outputFile=/tmp/report.json",
      ]),
    );
  });

  it("rejects a green report when a mandatory proof is absent", () => {
    const value = fixture();
    const reportPath = join(value.stageRoot, "incomplete-report.json");
    writeFileSync(
      reportPath,
      JSON.stringify({
        success: true,
        numFailedTests: 0,
        numPendingTests: 0,
        testResults: [
          {
            assertionResults: [
              {
                status: "passed",
                title: "permits only the configured gateway and isolates concurrent gateway ports",
              },
            ],
          },
        ],
      }),
    );

    expect(() => assertQualificationReport(reportPath)).toThrow(
      "Linux gateway qualification proof is incomplete",
    );
  });

  it("runs the pinned proof command and validates its complete report", () => {
    const value = fixture();
    const reportPath = join(value.stageRoot, "complete-report.json");
    writeFileSync(
      reportPath,
      JSON.stringify({
        success: true,
        numFailedTests: 0,
        numPendingTests: 0,
        testResults: [
          {
            assertionResults: [
              {
                status: "passed",
                title: "permits only the configured gateway and isolates concurrent gateway ports",
              },
              {
                status: "passed",
                title:
                  "composes a release-qualified Linux run through the namespace gateway backend",
              },
            ],
          },
        ],
      }),
    );
    const spawn = vi.fn(() => ({ status: 0 }));

    expect(() => runQualificationTests(reportPath, spawn)).not.toThrow();
    expect(spawn).toHaveBeenCalledOnce();
    expect(spawn.mock.calls[0]?.[0]).toBe(process.execPath);

    expect(() =>
      runQualificationTests(
        reportPath,
        vi.fn(() => ({ status: 1 })),
      ),
    ).toThrow("Linux gateway tests failed");
    expect(() =>
      runQualificationTests(
        reportPath,
        vi.fn(() => ({ error: new Error("spawn failed") })),
      ),
    ).toThrow("Linux gateway tests failed");
  });

  it("redacts unreadable qualification-report details", () => {
    const value = fixture();
    expect(() => assertQualificationReport(join(value.stageRoot, "missing.json"))).toThrow(
      "qualification test report is invalid",
    );
  });

  it("rejects a stale qualification receipt in verify-only mode", () => {
    const value = fixture();
    const options = optionsFor(value);
    const dependencies = {
      exactCleanHead: vi.fn(),
      platform: "linux",
      runQualificationTests: vi.fn(),
    };
    qualifyLinuxRuntimeRelease(options, dependencies);
    const receiptPath = join(value.resourceRoot, ".portable", "runtime-qualification.json");
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    writeFileSync(
      receiptPath,
      `${JSON.stringify({ ...receipt, backend: "windows-job-object" })}\n`,
    );

    expect(() =>
      qualifyLinuxRuntimeRelease({ ...options, "verify-only": "true" }, dependencies),
    ).toThrow("qualification receipt binding is invalid");
  });
});

function optionsFor(value) {
  return {
    "source-commit-sha": COMMIT,
    "stage-root": value.stageRoot,
    "test-report": join(value.stageRoot, "tests.json"),
  };
}
