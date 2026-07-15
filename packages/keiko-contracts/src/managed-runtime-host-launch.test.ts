import { describe, expect, it } from "vitest";
import {
  MANAGED_RUNTIME_ISOLATION_PROFILE_DIGEST,
  parseManagedRuntimeLaunchRequest,
  type ManagedRuntimeLaunchRequest,
} from "./index.js";

function launchRequest(): ManagedRuntimeLaunchRequest {
  return {
    schemaVersion: "1",
    runId: "run-2443",
    taskId: "issue-2443",
    workspaceId: "workspace-2443",
    sourceSha: "b".repeat(40),
    treeSha: "c".repeat(40),
    platformTarget: "macos-arm64",
    controllerKind: "apple-virtualization",
    controllerBundleDigest: "a".repeat(64),
    controllerInstanceDigest: "4".repeat(64),
    guestBundleDigest: "d".repeat(64),
    profileDigest: MANAGED_RUNTIME_ISOLATION_PROFILE_DIGEST,
    ipcAudience: "keiko-managed-runtime-broker-v1",
    nonce: "e".repeat(64),
    sequence: 1,
    issuedAtUnixMs: 1_000,
    expiresAtUnixMs: 901_000,
    revocationEpoch: 3,
    policyVersion: "policy-v1",
  };
}

describe("managed runtime launch request Unix freshness binding", () => {
  it("requires the controller instance and explicit Unix epoch window", () => {
    expect(parseManagedRuntimeLaunchRequest(launchRequest())).toEqual({
      ok: true,
      value: launchRequest(),
    });
  });

  it.each([
    ["missing instance", { controllerInstanceDigest: undefined }],
    ["uppercase instance", { controllerInstanceDigest: "A".repeat(64) }],
    ["short instance", { controllerInstanceDigest: "4".repeat(63) }],
    ["legacy issue time", { issuedAtUnixMs: undefined, issuedAtMs: 1_000 }],
    ["legacy expiry time", { expiresAtUnixMs: undefined, expiresAtMs: 901_000 }],
    ["empty window", { expiresAtUnixMs: 1_000 }],
    ["overlong window", { expiresAtUnixMs: 901_001 }],
  ])("rejects %s", (_label, replacement) => {
    expect(parseManagedRuntimeLaunchRequest({ ...launchRequest(), ...replacement }).ok).toBe(false);
  });

  it("keeps historical UTC values structural instead of consulting the wall clock", () => {
    expect(
      parseManagedRuntimeLaunchRequest({
        ...launchRequest(),
        issuedAtUnixMs: 1,
        expiresAtUnixMs: 2,
      }).ok,
    ).toBe(true);
  });
});
