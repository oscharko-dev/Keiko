import { describe, expect, it } from "vitest";
import {
  MANAGED_RUNTIME_DIGEST_DOMAINS,
  MANAGED_RUNTIME_ISOLATION_PROFILE_DIGEST,
  MANAGED_RUNTIME_LIFECYCLE_KINDS,
  MANAGED_RUNTIME_LIFECYCLE_REASONS,
  parseManagedRuntimeLifecycleObservation,
} from "./index.js";

const lifecycle = {
  schemaVersion: "1",
  runIdDigest: "1".repeat(64),
  taskIdDigest: "2".repeat(64),
  workspaceIdDigest: "3".repeat(64),
  sourceSha: "b".repeat(40),
  treeSha: "c".repeat(40),
  platformTarget: "macos-arm64",
  controllerKind: "apple-virtualization",
  controllerBundleDigest: "a".repeat(64),
  controllerInstanceDigest: "4".repeat(64),
  guestBundleDigest: "d".repeat(64),
  profileDigest: MANAGED_RUNTIME_ISOLATION_PROFILE_DIGEST,
  sequence: 1,
  issuedAtUnixMs: 1_000,
  expiresAtUnixMs: 901_000,
  revocationEpoch: 3,
  policyVersionDigest: "5".repeat(64),
  kind: "running-observed",
  reason: "broker-authenticated",
  vmIdentityDigest: "f".repeat(64),
  bootIdentityDigest: "0".repeat(64),
  nonceDigest: "6".repeat(64),
  observedAtUnixMs: 2_000,
};

describe("managed runtime lifecycle observation", () => {
  it("accepts a digest-only per-run observation and excludes machine recovery", () => {
    expect(parseManagedRuntimeLifecycleObservation(lifecycle)).toEqual({
      ok: true,
      value: lifecycle,
    });
    expect(MANAGED_RUNTIME_LIFECYCLE_KINDS).not.toContain("recovery-observed");
    expect(MANAGED_RUNTIME_LIFECYCLE_REASONS).not.toContain("machine-restarted");
    expect(MANAGED_RUNTIME_LIFECYCLE_REASONS).not.toContain("stale-vm-terminated");
  });

  it("publishes exact digest domains and rejects raw or authority-bearing fields", () => {
    expect(Object.isFrozen(MANAGED_RUNTIME_DIGEST_DOMAINS)).toBe(true);
    expect(MANAGED_RUNTIME_DIGEST_DOMAINS).toMatchObject({
      runIdDigest: "keiko-managed-runtime-v1:run-id\0",
      taskIdDigest: "keiko-managed-runtime-v1:task-id\0",
      workspaceIdDigest: "keiko-managed-runtime-v1:workspace-id\0",
      policyVersionDigest: "keiko-managed-runtime-v1:policy-version\0",
      controllerInstanceDigest: "keiko-managed-runtime-v1:controller-instance\0",
    });
    for (const field of [
      "runId",
      "taskId",
      "workspaceId",
      "policyVersion",
      "ipcAudience",
      "launchBindingDigest",
      "authority",
      "recoveredVmCount",
    ]) {
      expect(
        parseManagedRuntimeLifecycleObservation({ ...lifecycle, [field]: "forbidden" }).ok,
      ).toBe(false);
    }
  });

  it("accepts the second macOS architecture with the Apple controller", () => {
    expect(
      parseManagedRuntimeLifecycleObservation({ ...lifecycle, platformTarget: "macos-x64" }).ok,
    ).toBe(true);
  });

  it.each([
    ["bad kind/reason pair", { kind: "launch-observed", reason: "guest-failed" }],
    ["machine recovery kind", { kind: "recovery-observed" }],
    ["machine recovery reason", { reason: "machine-restarted" }],
    ["uppercase identity digest", { runIdDigest: "A".repeat(64) }],
    ["short policy digest", { policyVersionDigest: "5".repeat(63) }],
    ["mismatched controller family", { controllerKind: "windows-hcs-hyper-v-service" }],
    ["pre-issue observation", { observedAtUnixMs: 999 }],
    ["empty validity window", { expiresAtUnixMs: 1_000 }],
    ["overlong validity window", { expiresAtUnixMs: 901_001 }],
    ["coercible source SHA", { sourceSha: { toString: (): string => "b".repeat(40) } }],
    ["zero sequence", { sequence: 0 }],
    ["legacy observed time", { observedAtUnixMs: undefined, observedAtMs: 2_000 }],
  ])("rejects %s", (_label, replacement) => {
    expect(parseManagedRuntimeLifecycleObservation({ ...lifecycle, ...replacement }).ok).toBe(
      false,
    );
  });

  it.each(Object.keys(lifecycle))("requires digest lifecycle field %s", (field) => {
    const candidate = Object.fromEntries(
      Object.entries(lifecycle).filter(([key]) => key !== field),
    );
    expect(parseManagedRuntimeLifecycleObservation(candidate).ok).toBe(false);
  });
});
