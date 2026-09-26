import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  finalizeLinuxQualifiedPayload,
  LinuxPortableSigningError,
  parseLinuxPortableSigningArgs,
  prepareLinuxQualifiedPayload,
  signingLane,
  verifyLinuxQualifiedPayload,
} from "../linux-portable-signing.mjs";
import {
  verifyLinuxQualificationBundle,
  verifyLinuxQualificationRehearsalBundle,
} from "../../packages/keiko-server/src/coding-runtime/linuxPortableSigstore.ts";
import { runSignLinuxRuntimeQualificationCli } from "../sign-linux-runtime-qualification.mjs";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const TARGET = "linux-x64";
const roots = [];

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function qualificationReceipt() {
  return {
    schemaVersion: 2,
    suiteVersion: "runtime-tree-qualification-v1",
    platformTarget: TARGET,
    sourceCommitSha: COMMIT,
    activationManifestSha256: "a".repeat(64),
    supervisorSha256: "b".repeat(64),
    secureReadSha256: "c".repeat(64),
    sidecars: [{ name: "opencode-compatible", sha256: "d".repeat(64) }],
    runtimeComponents: [
      { name: "primary-launcher", sha256: "e".repeat(64) },
      { name: "node-runtime", sha256: "f".repeat(64) },
      { name: "usearch", sha256: "0".repeat(64) },
    ],
    backend: "linux-namespace-gateway",
    result: "passed",
  };
}

function manifest() {
  return {
    artifact: {
      platformTarget: TARGET,
      assetName: "keiko-linux-x64.zip",
      sizeBytes: 1,
      sha256: "e".repeat(64),
    },
    nativeAddons: [{ name: "usearch", signing: {} }],
    nativeHelpers: [
      { name: "keiko-runtime-supervisor", signing: {} },
      { name: "keiko-secure-workspace-read", signing: {} },
    ],
    releaseImpact: { reviewedBinding: {} },
    runtimeActivation: { trustAnchor: "unverified-staging" },
    security: {},
    sidecarRuntimes: [{ name: "opencode-compatible", signing: {} }],
    updateEligibility: { requiredPredicates: { platformSignatureLocallyVerified: false } },
  };
}

function optionsFor(stageRoot) {
  return { "source-commit-sha": COMMIT, "stage-root": stageRoot };
}

function fixture() {
  const stageRoot = mkdtempSync(join(tmpdir(), "keiko-linux-portable-signing-"));
  roots.push(stageRoot);
  const resourceRoot = join(stageRoot, "payload", "Keiko");
  const receipt = qualificationReceipt();
  for (const [path, bytes] of [
    [".portable/runtime-activation.json", Buffer.from("{}\n")],
    [".portable/runtime-qualification.json", Buffer.from(`${JSON.stringify(receipt)}\n`)],
    [".portable/runtime-qualification.sigstore.json", Buffer.from("{}\n")],
    [".portable/setup-manifest.json", Buffer.from("{}\n")],
    ["app/node_modules/@oscharko-dev/keiko-sandbox/dist/runtime.js", Buffer.from("runtime\n")],
    ["runtime/native/keiko-secure-workspace-read", Buffer.from("secure read\n")],
  ]) {
    const destination = join(resourceRoot, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, bytes);
  }
  mkdirSync(join(stageRoot, "manifest"), { recursive: true });
  mkdirSync(join(stageRoot, "evidence"), { recursive: true });
  writeFileSync(
    join(stageRoot, "manifest", "portable-manifest.json"),
    `${JSON.stringify(manifest())}\n`,
  );
  return { receipt, resourceRoot, stageRoot };
}

function dependencies(receipt = qualificationReceipt()) {
  return {
    discoverQualifiedRuntime: vi.fn(() => ({
      target: TARGET,
      platformAssurance: "release-qualified",
      qualification: { backend: "linux-namespace-gateway" },
    })),
    qualificationReceiptFor: vi.fn(() => receipt),
    rebindExistingSignedArchive: vi.fn(async (_stageRoot, value, archivePath) => {
      const bytes = readFileSync(archivePath);
      value.artifact.sizeBytes = bytes.byteLength;
      value.artifact.sha256 = sha256(bytes);
    }),
    rebindSignedPayload: vi.fn(),
    validateManifest: vi.fn(() => []),
    verifyQualificationBundle: vi.fn(),
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("linux-portable-signing CLI module graph", () => {
  // This suite cannot see the defect it guards without spawning a real node: vitest resolves a
  // relative "./x.js" specifier to "./x.ts", and plain node does not. scripts/linux-portable-signing.mjs
  // imported packages/keiko-server/src/coding-runtime/productionPortableCodingRuntime.ts, whose own
  // graph carries ten relative ".js" specifiers pointing at ".ts" sources, so every invocation --
  // prepare, finalize and verify -- died at module load with ERR_MODULE_NOT_FOUND on the release
  // runner while this suite stayed green. The sibling entry points it imports have zero such
  // specifiers, which is why only this one broke.
  it("loads under plain node, the runtime the release workflow actually uses", () => {
    const result = spawnSync(process.execPath, [resolve("scripts/linux-portable-signing.mjs")], {
      encoding: "utf8",
    });

    expect(result.stderr).not.toContain("ERR_MODULE_NOT_FOUND");
    expect(result.stderr).not.toContain("Cannot find module");
  });
});

describe("Linux portable qualification sealing", () => {
  it("parses every command and rejects malformed CLI arguments", () => {
    for (const command of ["prepare", "finalize", "verify"]) {
      expect(
        parseLinuxPortableSigningArgs([
          command,
          "--stage-root",
          "/tmp/stage",
          "--source-commit-sha",
          COMMIT,
        ]),
      ).toEqual({
        command,
        options: { "source-commit-sha": COMMIT, "stage-root": "/tmp/stage" },
      });
    }
    expect(() => parseLinuxPortableSigningArgs(["publish"])).toThrow("unsupported command");
    expect(() => parseLinuxPortableSigningArgs(["verify", "stage-root", "/tmp/stage"])).toThrow(
      "invalid arguments",
    );
    expect(() => parseLinuxPortableSigningArgs(["verify", "--stage-root"])).toThrow(
      "invalid arguments",
    );
  });

  it("rejects malformed and relabelled manifests before changing signing state", () => {
    const malformed = fixture();
    const malformedPath = join(malformed.stageRoot, "manifest", "portable-manifest.json");
    writeFileSync(malformedPath, "{");
    expect(() => prepareLinuxQualifiedPayload(optionsFor(malformed.stageRoot))).toThrow(
      "manifest is invalid",
    );

    const relabelled = fixture();
    const relabelledPath = join(relabelled.stageRoot, "manifest", "portable-manifest.json");
    const relabelledManifest = JSON.parse(readFileSync(relabelledPath, "utf8"));
    relabelledManifest.artifact.platformTarget = "windows-x64";
    writeFileSync(relabelledPath, `${JSON.stringify(relabelledManifest)}\n`);
    expect(() => prepareLinuxQualifiedPayload(optionsFor(relabelled.stageRoot))).toThrow(
      "manifest target is not Linux x64",
    );
  });

  it("marks only a complete Linux component set as production", () => {
    const value = fixture();
    const deps = dependencies(value.receipt);

    prepareLinuxQualifiedPayload(optionsFor(value.stageRoot), deps);

    const prepared = JSON.parse(
      readFileSync(join(value.stageRoot, "manifest", "portable-manifest.json"), "utf8"),
    );
    expect(prepared.security).toMatchObject({
      signatureKind: "github-oidc-attested",
      signatureVerified: true,
      verificationChecks: { provenanceVerified: true },
    });
    expect(prepared.runtimeActivation.trustAnchor).toBe("sigstore-qualification-receipt");
    expect(deps.rebindSignedPayload).toHaveBeenCalledOnce();

    prepared.nativeAddons = [];
    writeFileSync(
      join(value.stageRoot, "manifest", "portable-manifest.json"),
      `${JSON.stringify(prepared)}\n`,
    );
    expect(() => prepareLinuxQualifiedPayload(optionsFor(value.stageRoot), deps)).toThrow(
      "manifest production component set is invalid",
    );
  });

  it("finalizes and independently verifies the receipt, archive, and production discovery", async () => {
    const value = fixture();
    const deps = dependencies(value.receipt);
    prepareLinuxQualifiedPayload(optionsFor(value.stageRoot), deps);

    await finalizeLinuxQualifiedPayload(optionsFor(value.stageRoot), deps);

    const archive = join(value.stageRoot, "keiko-linux-x64.zip");
    expect(statSync(archive).size).toBeGreaterThan(0);
    expect(deps.verifyQualificationBundle).toHaveBeenCalledTimes(2);
    expect(deps.validateManifest).toHaveBeenCalledOnce();
    expect(deps.discoverQualifiedRuntime).toHaveBeenCalledOnce();
    expect(() => verifyLinuxQualifiedPayload(optionsFor(value.stageRoot), deps)).not.toThrow();
  });

  it("defaults to the release lane: release verifier and product discovery", () => {
    const lane = signingLane({});
    expect(lane.verifyQualificationBundle).toBe(verifyLinuxQualificationBundle);
    expect(lane.assertsProductDiscovery).toBe(true);
    expect(signingLane({ lane: "release" })).toBe(lane);
  });

  it("rehearses with the rehearsal verifier and never the product discovery", async () => {
    const lane = signingLane({ lane: "rehearsal" });
    expect(lane.verifyQualificationBundle).toBe(verifyLinuxQualificationRehearsalBundle);
    expect(lane.assertsProductDiscovery).toBe(false);

    // The product discovery verifies against the release identity only; a rehearsal-signed
    // qualification must never be offered to it, so the rehearsal chain does not call it.
    const value = fixture();
    const deps = dependencies(value.receipt);
    const options = { ...optionsFor(value.stageRoot), lane: "rehearsal" };
    prepareLinuxQualifiedPayload(options, deps);
    await finalizeLinuxQualifiedPayload(options, deps);

    expect(deps.verifyQualificationBundle).toHaveBeenCalledTimes(2);
    expect(deps.discoverQualifiedRuntime).not.toHaveBeenCalled();
    expect(() => verifyLinuxQualifiedPayload(options, deps)).not.toThrow();
    expect(deps.discoverQualifiedRuntime).not.toHaveBeenCalled();
  });

  it.each(["production", "evaluation", "toString", "", 7])(
    "refuses the unknown signing lane %s",
    (lane) => {
      expect(() => signingLane({ lane })).toThrow("unsupported signing lane");
    },
  );

  it("rejects stale receipts, tampered archives, and unavailable production discovery", async () => {
    const value = fixture();
    const deps = dependencies(value.receipt);
    prepareLinuxQualifiedPayload(optionsFor(value.stageRoot), deps);
    await finalizeLinuxQualifiedPayload(optionsFor(value.stageRoot), deps);
    const receiptPath = join(value.resourceRoot, ".portable", "runtime-qualification.json");
    writeFileSync(
      receiptPath,
      `${JSON.stringify({ ...value.receipt, backend: "windows-job-object" })}\n`,
    );
    expect(() => verifyLinuxQualifiedPayload(optionsFor(value.stageRoot), deps)).toThrow(
      "qualification receipt binding is invalid",
    );

    writeFileSync(receiptPath, `${JSON.stringify(value.receipt)}\n`);
    appendFileSync(join(value.stageRoot, "keiko-linux-x64.zip"), "tampered");
    expect(() => verifyLinuxQualifiedPayload(optionsFor(value.stageRoot), deps)).toThrow(
      "production archive binding is invalid",
    );

    await finalizeLinuxQualifiedPayload(optionsFor(value.stageRoot), deps);
    deps.discoverQualifiedRuntime.mockReturnValue(undefined);
    expect(() => verifyLinuxQualifiedPayload(optionsFor(value.stageRoot), deps)).toThrow(
      "production runtime discovery is unavailable",
    );
  });

  it("rejects a bound archive with incomplete qualification evidence", async () => {
    const value = fixture();
    const deps = dependencies(value.receipt);
    prepareLinuxQualifiedPayload(optionsFor(value.stageRoot), deps);
    rmSync(join(value.resourceRoot, ".portable", "setup-manifest.json"));

    await expect(finalizeLinuxQualifiedPayload(optionsFor(value.stageRoot), deps)).rejects.toThrow(
      "production archive evidence is incomplete",
    );
  });

  it("rejects a payload symlink that escapes the signed resource root", async () => {
    const value = fixture();
    const deps = dependencies(value.receipt);
    prepareLinuxQualifiedPayload(optionsFor(value.stageRoot), deps);
    const outside = join(value.stageRoot, "outside-resource-root");
    writeFileSync(outside, "must not be archived\n");
    symlinkSync(outside, join(value.resourceRoot, "escape"));

    await expect(finalizeLinuxQualifiedPayload(optionsFor(value.stageRoot), deps)).rejects.toThrow(
      "ZIP source symlink escapes the archive root",
    );
  });

  it("redacts qualification-signing dependency failures at the CLI boundary", async () => {
    const stderr = { write: vi.fn() };
    const status = await runSignLinuxRuntimeQualificationCli(
      ["node", "signer", "/sensitive/receipt.json", "/sensitive/bundle.json"],
      {
        readFile: vi.fn(() => Buffer.from("receipt")),
        signReceipt: vi.fn(() => Promise.reject(new Error("provider dependency details"))),
        writeFile: vi.fn(),
      },
      stderr,
    );

    expect(status).toBe(1);
    expect(stderr.write).toHaveBeenCalledWith(
      "linux-runtime-qualification-signing: redacted failure\n",
    );
    const output = stderr.write.mock.calls.flat().join("");
    expect(output).not.toContain("/sensitive/");
    expect(output).not.toContain("provider dependency details");
  });

  it("uses the dedicated error type for fail-closed signing failures", () => {
    expect(() => verifyLinuxQualifiedPayload({})).toThrow(LinuxPortableSigningError);
  });
});
