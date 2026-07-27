import { describe, expect, it } from "vitest";

import {
  CLOSED_RUNTIME_LAUNCH_PROFILE,
  qualificationFromReceipt,
  qualifyLongLivedRuntime,
  type RuntimeQualificationReceipt,
  type LongLivedRuntimeQualification,
} from "./runtime.js";

const qualified: LongLivedRuntimeQualification = {
  platform: "win32",
  arch: "x64",
  backend: "windows-job-object",
  releaseReceipt: `sha256:${"a".repeat(64)}`,
};

const receipt: RuntimeQualificationReceipt = {
  schemaVersion: 1,
  suiteVersion: "runtime-tree-qualification-v1",
  platformTarget: "windows-x64",
  sourceCommitSha: "1".repeat(40),
  activationManifestSha256: "2".repeat(64),
  supervisorSha256: "3".repeat(64),
  secureReadSha256: "5".repeat(64),
  sidecars: [{ name: "opencode", sha256: "4".repeat(64) }],
  backend: "windows-job-object",
  result: "passed",
};

describe("long-lived runtime qualification", () => {
  it("requires an exact platform, architecture, backend, and release receipt match", () => {
    expect(qualifyLongLivedRuntime(qualified, [qualified])).toEqual({
      ok: true,
      qualification: qualified,
      launchProfile: CLOSED_RUNTIME_LAUNCH_PROFILE,
    });
    expect(
      qualifyLongLivedRuntime({ ...qualified, releaseReceipt: `sha256:${"b".repeat(64)}` }, [
        qualified,
      ]),
    ).toEqual({ ok: false, reason: "runtime-unqualified" });
    expect(qualifyLongLivedRuntime(qualified)).toEqual({
      ok: false,
      reason: "runtime-unqualified",
    });
  });

  it("rejects malformed receipts and platform/backend mismatches even if listed", () => {
    const malformed = { ...qualified, releaseReceipt: "release-2258" };
    const mismatched = { ...qualified, backend: "macos-app-sandbox" } as const;
    const invalidPlatform = {
      ...qualified,
      platform: "linux",
      arch: "ia32",
      backend: "macos-app-sandbox",
    } as unknown as LongLivedRuntimeQualification;
    const extraKey = { ...qualified, unreviewed: true } as LongLivedRuntimeQualification;

    expect(qualifyLongLivedRuntime(malformed, [malformed])).toEqual({
      ok: false,
      reason: "runtime-unqualified",
    });
    expect(qualifyLongLivedRuntime(mismatched, [mismatched])).toEqual({
      ok: false,
      reason: "runtime-unqualified",
    });
    expect(qualifyLongLivedRuntime(invalidPlatform, [invalidPlatform])).toEqual({
      ok: false,
      reason: "runtime-unqualified",
    });
    expect(qualifyLongLivedRuntime(extraKey, [extraKey])).toEqual({
      ok: false,
      reason: "runtime-unqualified",
    });
  });

  it("describes disabled upstream authority without guessing adapter flags", () => {
    expect(CLOSED_RUNTIME_LAUNCH_PROFILE).toEqual({
      upstreamEditAuthority: false,
      upstreamShellAuthority: false,
      upstreamGitAuthority: false,
      upstreamDeliveryAuthority: false,
      upstreamConnectorAuthority: false,
      upstreamBrowserAuthority: false,
      unrestrictedNetworkAuthority: false,
    });
  });

  it("materializes a qualification only from a current receipt bound to installed bytes", () => {
    const result = qualificationFromReceipt(receipt, {
      platformTarget: "windows-x64",
      sourceCommitSha: "1".repeat(40),
      activationManifestSha256: "2".repeat(64),
      supervisorSha256: "3".repeat(64),
      secureReadSha256: "5".repeat(64),
      sidecars: [{ name: "opencode", sha256: "4".repeat(64) }],
    });

    expect(result).toMatchObject({
      ok: true,
      qualification: {
        platform: "win32",
        arch: "x64",
        backend: "windows-job-object",
      },
    });
    if (result.ok) expect(result.qualification.releaseReceipt).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it.each([
    ["activationManifestSha256", "6".repeat(64)],
    ["supervisorSha256", "6".repeat(64)],
    ["secureReadSha256", "6".repeat(64)],
    ["sourceCommitSha", "5".repeat(40)],
  ] as const)("rejects stale receipt binding %s", (key, value) => {
    expect(
      qualificationFromReceipt(receipt, {
        platformTarget: "windows-x64",
        sourceCommitSha: "1".repeat(40),
        activationManifestSha256: "2".repeat(64),
        supervisorSha256: "3".repeat(64),
        secureReadSha256: "5".repeat(64),
        sidecars: [{ name: "opencode", sha256: "4".repeat(64) }],
        [key]: value,
      }),
    ).toEqual({ ok: false, reason: "runtime-unqualified" });
  });

  it("rejects failed, secret-bearing, path-bearing, and malformed receipts", () => {
    const binding = {
      platformTarget: "windows-x64" as const,
      sourceCommitSha: "1".repeat(40),
      activationManifestSha256: "2".repeat(64),
      supervisorSha256: "3".repeat(64),
      secureReadSha256: "5".repeat(64),
      sidecars: [{ name: "opencode", sha256: "4".repeat(64) }],
    };
    const candidates = [
      { ...receipt, result: "failed" },
      { ...receipt, token: "sk-secret-value" },
      { ...receipt, workspace: "/Users/customer/private-repository" },
      { ...receipt, sidecars: [{ name: "../opencode", sha256: "4".repeat(64) }] },
      { ...receipt, sidecars: [{ name: "opencode", sha256: "z".repeat(64) }] },
    ];

    for (const candidate of candidates) {
      expect(qualificationFromReceipt(candidate, binding)).toEqual({
        ok: false,
        reason: "runtime-unqualified",
      });
    }
  });

  it.each(["macos-arm64", "macos-x64"] as const)(
    "accepts %s only for an Endpoint Security qualification receipt",
    (platformTarget) => {
      const candidate = {
        ...receipt,
        platformTarget,
        backend: "macos-endpoint-security",
      };
      const result = qualificationFromReceipt(candidate, {
        platformTarget,
        sourceCommitSha: receipt.sourceCommitSha,
        activationManifestSha256: receipt.activationManifestSha256,
        supervisorSha256: receipt.supervisorSha256,
        secureReadSha256: receipt.secureReadSha256,
        sidecars: receipt.sidecars,
      });
      expect(result).toMatchObject({
        ok: true,
        qualification: {
          platform: "darwin",
          arch: platformTarget === "macos-arm64" ? "arm64" : "x64",
          backend: "macos-endpoint-security",
        },
      });
    },
  );
});
