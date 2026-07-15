import { describe, expect, it } from "vitest";
import {
  MANAGED_RUNTIME_ISOLATION_PROFILE_DIGEST,
  MANAGED_RUNTIME_RUNTIME_ENV_NAMES,
  parseManagedRuntimeBundleDescriptor,
  parseManagedRuntimeCapabilityObservation,
  parseManagedRuntimeLaunchRequest,
  parseManagedRuntimeLifecycleObservation,
} from "./index.js";

const DIGEST = "a".repeat(64);
const launch = {
  schemaVersion: "1",
  runId: "run-2443",
  taskId: "issue-2443",
  workspaceId: "workspace-2443",
  sourceSha: "b".repeat(40),
  treeSha: "c".repeat(40),
  platformTarget: "macos-arm64",
  controllerKind: "apple-virtualization",
  controllerBundleDigest: DIGEST,
  guestBundleDigest: "d".repeat(64),
  profileDigest: MANAGED_RUNTIME_ISOLATION_PROFILE_DIGEST,
  ipcAudience: "keiko-managed-runtime-broker-v1",
  nonce: "e".repeat(64),
  sequence: 1,
  issuedAtMs: 1_000,
  expiresAtMs: 901_000,
  revocationEpoch: 3,
  policyVersion: "policy-v1",
};
const lifecycle: Record<string, unknown> = {
  ...launch,
  nonce: undefined,
  kind: "running-observed",
  reason: "broker-authenticated",
  vmIdentityDigest: "f".repeat(64),
  bootIdentityDigest: "0".repeat(64),
  nonceDigest: "1".repeat(64),
  observedAtMs: 2_000,
  recoveredVmCount: 0,
};
delete lifecycle.nonce;
const descriptor = {
  schemaVersion: "1",
  platformTarget: "macos-arm64",
  controllerKind: "apple-virtualization",
  controllerBundleDigest: DIGEST,
  guestBundleDigest: "d".repeat(64),
  profileDigest: MANAGED_RUNTIME_ISOLATION_PROFILE_DIGEST,
  environmentNames: [...MANAGED_RUNTIME_RUNTIME_ENV_NAMES],
};
const available = {
  schemaVersion: "1",
  platformTarget: "windows-x64",
  state: "available",
  reason: "ready",
  remediation: "none",
  observedAtMs: 2_000,
  controllerBundleDigest: DIGEST,
  guestBundleDigest: "d".repeat(64),
  profileDigest: MANAGED_RUNTIME_ISOLATION_PROFILE_DIGEST,
  policyVersion: "policy-v1",
  revocationEpoch: 3,
};
const unavailable = {
  schemaVersion: "1",
  platformTarget: "windows-x64",
  state: "unavailable",
  reason: "host-not-installed",
  remediation: "install-machine-managed-host",
  observedAtMs: 1,
};

describe("managed runtime plain-data boundary", () => {
  it("rejects inherited and accessor records through every public parser", () => {
    const cases = [
      [parseManagedRuntimeLaunchRequest, launch],
      [parseManagedRuntimeLifecycleObservation, lifecycle],
      [parseManagedRuntimeBundleDescriptor, descriptor],
      [parseManagedRuntimeCapabilityObservation, unavailable],
    ] as const;
    for (const [parser, input] of cases) {
      const accessor = { ...input };
      Object.defineProperty(accessor, "schemaVersion", { enumerable: true, get: () => "1" });
      expect(parser(Object.create(input)).ok).toBe(false);
      expect(parser(accessor).ok).toBe(false);
    }
  });

  it("rejects non-records, hidden fields, and scalar coercion", () => {
    for (const input of [undefined, null, [], "launch", 1, true, Symbol("launch")]) {
      expect(parseManagedRuntimeLaunchRequest(input).ok).toBe(false);
    }
    const hidden = { ...launch };
    Object.defineProperty(hidden, "hidden", { enumerable: false, value: true });
    expect(parseManagedRuntimeLaunchRequest(hidden).ok).toBe(false);

    const shaLike = { toString: (): string => "b".repeat(40) };
    const digestLike = { toString: (): string => DIGEST };
    for (const replacement of [
      { runId: { toString: (): string => "run-2443" } },
      { sourceSha: shaLike },
      { controllerBundleDigest: digestLike },
      { nonce: digestLike },
      { issuedAtMs: "1000" },
      { expiresAtMs: Number.MAX_SAFE_INTEGER + 1 },
      { sequence: Number.NaN },
    ]) {
      expect(parseManagedRuntimeLaunchRequest({ ...launch, ...replacement }).ok).toBe(false);
    }
  });

  it("binds both platform families in both directions", () => {
    expect(parseManagedRuntimeLaunchRequest({ ...launch, platformTarget: "macos-x64" }).ok).toBe(
      true,
    );
    expect(
      parseManagedRuntimeLaunchRequest({
        ...launch,
        platformTarget: "windows-x64",
        controllerKind: "apple-virtualization",
      }).ok,
    ).toBe(false);
    expect(
      parseManagedRuntimeBundleDescriptor({
        ...descriptor,
        platformTarget: "windows-x64",
        controllerKind: "apple-virtualization",
      }).ok,
    ).toBe(false);
  });

  it("rejects coercible capability and lifecycle fields", () => {
    const digestLike = { toString: (): string => DIGEST };
    for (const replacement of [
      { schemaVersion: "2" },
      { platformTarget: "linux-x64" },
      { remediation: "repair-machine-managed-host" },
      { controllerBundleDigest: digestLike },
      { profileDigest: "f".repeat(64) },
      { policyVersion: { toString: (): string => "policy-v1" } },
      { observedAtMs: "2000" },
    ]) {
      expect(parseManagedRuntimeCapabilityObservation({ ...available, ...replacement }).ok).toBe(
        false,
      );
    }
    for (const replacement of [
      { reason: "caller-defined" },
      { remediation: "caller-defined" },
      { remediation: "none" },
    ]) {
      expect(parseManagedRuntimeCapabilityObservation({ ...unavailable, ...replacement }).ok).toBe(
        false,
      );
    }
    for (const replacement of [
      { vmIdentityDigest: digestLike },
      { recoveredVmCount: "0" },
      { observedAtMs: Number.POSITIVE_INFINITY },
    ]) {
      expect(parseManagedRuntimeLifecycleObservation({ ...lifecycle, ...replacement }).ok).toBe(
        false,
      );
    }
  });

  it("rejects non-data and non-plain environment tuples", () => {
    const accessor = [...MANAGED_RUNTIME_RUNTIME_ENV_NAMES];
    Object.defineProperty(accessor, "0", {
      enumerable: true,
      get: () => "KEIKO_RUNTIME_ENDPOINT",
    });
    class EnvironmentNames extends Array<string> {}
    for (const environmentNames of [
      "KEIKO_RUNTIME_ENDPOINT",
      accessor,
      new EnvironmentNames(...MANAGED_RUNTIME_RUNTIME_ENV_NAMES),
    ]) {
      expect(parseManagedRuntimeBundleDescriptor({ ...descriptor, environmentNames }).ok).toBe(
        false,
      );
    }
    expect(
      parseManagedRuntimeBundleDescriptor({
        ...descriptor,
        controllerBundleDigest: { toString: (): string => DIGEST },
      }).ok,
    ).toBe(false);
  });

  it("returns stable content-free failure projections", () => {
    expect(parseManagedRuntimeLaunchRequest(null)).toEqual({
      ok: false,
      errors: ["invalid managed runtime launch"],
    });
    expect(parseManagedRuntimeBundleDescriptor(null)).toEqual({
      ok: false,
      errors: ["invalid runtime bundle"],
    });
    expect(parseManagedRuntimeCapabilityObservation(null)).toEqual({
      ok: false,
      errors: ["invalid runtime capability"],
    });
    expect(parseManagedRuntimeLifecycleObservation(null)).toEqual({
      ok: false,
      errors: ["invalid runtime lifecycle observation"],
    });
  });
});
