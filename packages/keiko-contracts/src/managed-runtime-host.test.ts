import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  MANAGED_RUNTIME_HOST_SCHEMA_VERSION,
  MANAGED_RUNTIME_ISOLATION_PROFILE,
  MANAGED_RUNTIME_ISOLATION_PROFILE_CANONICAL_JSON,
  MANAGED_RUNTIME_ISOLATION_PROFILE_DIGEST,
  MANAGED_RUNTIME_CAPABILITY_STATES,
  MANAGED_RUNTIME_LIFECYCLE_KINDS,
  MANAGED_RUNTIME_LIFECYCLE_REASONS,
  MANAGED_RUNTIME_CONTROLLER_KINDS,
  MANAGED_RUNTIME_PLATFORM_TARGETS,
  MANAGED_RUNTIME_REMEDIATIONS,
  MANAGED_RUNTIME_UNAVAILABLE_REASONS,
  MANAGED_RUNTIME_RUNTIME_ENV_NAMES,
  parseManagedRuntimeBundleDescriptor,
  parseManagedRuntimeCapabilityObservation,
  parseManagedRuntimeLifecycleObservation,
  parseManagedRuntimeLaunchRequest,
} from "./index.js";

const DIGEST = "a".repeat(64);

function launchRequest(): Record<string, unknown> {
  return {
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
}

function lifecycleObservation(): Record<string, unknown> {
  const observation: Record<string, unknown> = {
    ...launchRequest(),
    kind: "running-observed",
    reason: "broker-authenticated",
    vmIdentityDigest: "f".repeat(64),
    bootIdentityDigest: "0".repeat(64),
    nonceDigest: "1".repeat(64),
    observedAtMs: 2_000,
    recoveredVmCount: 0,
  };
  delete observation.nonce;
  return observation;
}

describe("managed runtime launch request", () => {
  it("accepts the closed, versioned, fully bound request through the package surface", () => {
    expect(MANAGED_RUNTIME_HOST_SCHEMA_VERSION).toBe("1");
    const parsed = parseManagedRuntimeLaunchRequest(launchRequest());
    expect(parsed).toEqual({ ok: true, value: launchRequest() });
    if (parsed.ok) expect(Object.isFrozen(parsed.value)).toBe(true);
  });

  it("freezes the exact isolation profile and three-name guest environment", () => {
    expect(MANAGED_RUNTIME_RUNTIME_ENV_NAMES).toStrictEqual([
      "KEIKO_RUNTIME_ENDPOINT",
      "KEIKO_MODEL_ALIAS",
      "KEIKO_RUN_CAPABILITY",
    ]);
    expect(new Set(MANAGED_RUNTIME_RUNTIME_ENV_NAMES).size).toBe(3);
    expect(MANAGED_RUNTIME_ISOLATION_PROFILE).toMatchObject({
      topology: "per-run-linux-micro-vm",
      network: "no-vnic",
      ipc: "authenticated-vm-bound-broker",
      hostWorkspace: "not-mounted",
      workspaceInput: "filtered-sha-bound-snapshot",
      workspaceStorage: "disposable-encrypted",
      hostEffects: "keiko-revalidated",
      vmMemoryBytes: 2_147_483_648,
      memoryBallooning: false,
      guestSwap: false,
      cgroup: {
        memoryMaxBytes: 2_147_483_648,
        memorySwapMaxBytes: 0,
        memoryOomGroup: 1,
        pidsMax: 32,
      },
      deadline: { clock: "host-monotonic", durationMs: 900_000 },
      arbitraryProxy: false,
      warmPool: false,
      measuredAttestation: false,
    });
    expect(Object.isFrozen(MANAGED_RUNTIME_ISOLATION_PROFILE)).toBe(true);
    expect(Object.isFrozen(MANAGED_RUNTIME_ISOLATION_PROFILE.cgroup)).toBe(true);
    expect(Object.isFrozen(MANAGED_RUNTIME_RUNTIME_ENV_NAMES)).toBe(true);
    expect(
      createHash("sha256").update(MANAGED_RUNTIME_ISOLATION_PROFILE_CANONICAL_JSON).digest("hex"),
    ).toBe(MANAGED_RUNTIME_ISOLATION_PROFILE_DIGEST);
    expect(JSON.stringify(MANAGED_RUNTIME_ISOLATION_PROFILE)).toBe(
      MANAGED_RUNTIME_ISOLATION_PROFILE_CANONICAL_JSON,
    );
  });

  it.each([
    ["unknown field", { authorityReceipt: true }],
    ["wrong schema", { schemaVersion: "2" }],
    ["unknown platform", { platformTarget: "linux-x64" }],
    ["wrong controller mapping", { controllerKind: "windows-hcs-hyper-v-service" }],
    ["uppercase source SHA", { sourceSha: "B".repeat(40) }],
    ["unpinned controller", { controllerBundleDigest: "a".repeat(63) }],
    ["profile downgrade", { profileDigest: "f".repeat(64) }],
    ["wrong audience", { ipcAudience: "caller-selected" }],
    ["missing nonce entropy", { nonce: "e".repeat(63) }],
    ["zero sequence", { sequence: 0 }],
    ["expired at issue", { expiresAtMs: 1_000 }],
    ["beyond host deadline", { expiresAtMs: 901_001 }],
    ["negative revocation epoch", { revocationEpoch: -1 }],
    ["unsafe policy version", { policyVersion: "../../policy" }],
  ])("rejects %s", (_label, replacement) => {
    expect(parseManagedRuntimeLaunchRequest({ ...launchRequest(), ...replacement }).ok).toBe(false);
  });

  it.each(Object.keys(launchRequest()))("requires launch binding field %s", (field) => {
    const candidate = Object.fromEntries(
      Object.entries(launchRequest()).filter(([key]) => key !== field),
    );
    expect(parseManagedRuntimeLaunchRequest(candidate).ok).toBe(false);
  });

  it("rejects inherited, accessor, symbol, and trapping proxy fields without throwing", () => {
    const inherited = Object.create(launchRequest()) as object;
    const accessor = { ...launchRequest() };
    Object.defineProperty(accessor, "runId", {
      enumerable: true,
      get: (): string => "run-2443",
    });
    const symbolField = { ...launchRequest(), [Symbol("capability")]: "secret" };
    const proxy = new Proxy(launchRequest(), {
      getPrototypeOf: (): never => {
        throw new Error("hostile trap");
      },
    });
    for (const input of [inherited, accessor, symbolField, proxy]) {
      expect(() => parseManagedRuntimeLaunchRequest(input)).not.toThrow();
      expect(parseManagedRuntimeLaunchRequest(input).ok).toBe(false);
    }
  });

  it("treats old timestamps as structural data, never live admission", () => {
    expect(
      parseManagedRuntimeLaunchRequest({ ...launchRequest(), issuedAtMs: 1, expiresAtMs: 2 }).ok,
    ).toBe(true);
  });
});

describe("managed runtime lifecycle observation", () => {
  const observation = lifecycleObservation();

  it("validates immutable content-free status without creating authority", () => {
    expect(MANAGED_RUNTIME_LIFECYCLE_KINDS).toStrictEqual([
      "launch-observed",
      "running-observed",
      "stop-observed",
      "termination-observed",
      "revocation-observed",
      "recovery-observed",
      "failure-observed",
    ]);
    expect(MANAGED_RUNTIME_LIFECYCLE_REASONS).toContain("stale-vm-terminated");
    const parsed = parseManagedRuntimeLifecycleObservation(observation);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(Object.isFrozen(parsed.value)).toBe(true);
    for (const forbidden of [
      "endpoint",
      "runCapability",
      "lease",
      "receipt",
      "workspacePath",
      "output",
      "prompt",
      "diff",
    ]) {
      expect(
        parseManagedRuntimeLifecycleObservation({ ...observation, [forbidden]: "secret" }).ok,
      ).toBe(false);
    }
  });

  it("closes lifecycle kind/reason pairs and rejects replay, timing, and identity drift", () => {
    const acceptedPairs = [
      ["launch-observed", "launch-accepted", 0],
      ["running-observed", "broker-authenticated", 0],
      ["stop-observed", "requested", 0],
      ["stop-observed", "deadline-expired", 0],
      ["stop-observed", "lease-expired", 0],
      ["stop-observed", "lease-revoked", 0],
      ["stop-observed", "bff-disconnected", 0],
      ["stop-observed", "policy-revoked", 0],
      ["termination-observed", "requested", 0],
      ["termination-observed", "deadline-expired", 0],
      ["termination-observed", "lease-expired", 0],
      ["termination-observed", "lease-revoked", 0],
      ["termination-observed", "bff-disconnected", 0],
      ["termination-observed", "controller-crashed", 0],
      ["termination-observed", "machine-restarted", 0],
      ["termination-observed", "stale-vm-terminated", 0],
      ["termination-observed", "guest-failed", 0],
      ["termination-observed", "policy-revoked", 0],
      ["revocation-observed", "lease-revoked", 0],
      ["revocation-observed", "policy-revoked", 0],
      ["recovery-observed", "controller-crashed", 1],
      ["recovery-observed", "machine-restarted", 1],
      ["recovery-observed", "stale-vm-terminated", 1],
      ["recovery-observed", "bff-disconnected", 1],
      ["failure-observed", "controller-crashed", 0],
      ["failure-observed", "guest-failed", 0],
    ] as const;
    for (const [kind, reason, recoveredVmCount] of acceptedPairs) {
      expect(
        parseManagedRuntimeLifecycleObservation({
          ...observation,
          kind,
          reason,
          recoveredVmCount,
        }).ok,
      ).toBe(true);
    }
    for (const replacement of [
      { kind: "enforced" },
      { reason: "caller-asserted" },
      { kind: "launch-observed", reason: "guest-failed" },
      { kind: "recovery-observed", reason: "stale-vm-terminated", recoveredVmCount: 0 },
      { recoveredVmCount: 1 },
      { nonceDigest: "1".repeat(63) },
      { vmIdentityDigest: "F".repeat(64) },
      { observedAtMs: 999 },
      { recoveredVmCount: -1 },
      { sequence: 0 },
      { ipcAudience: "other" },
    ]) {
      expect(parseManagedRuntimeLifecycleObservation({ ...observation, ...replacement }).ok).toBe(
        false,
      );
    }
  });
});

describe("managed runtime capability observation", () => {
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

  it("accepts only closed available and unavailable projections", () => {
    expect(MANAGED_RUNTIME_CAPABILITY_STATES).toStrictEqual(["available", "unavailable"]);
    expect(MANAGED_RUNTIME_UNAVAILABLE_REASONS).toContain("unsupported-windows-edition");
    expect(MANAGED_RUNTIME_REMEDIATIONS).toContain("enable-virtualization");
    expect(parseManagedRuntimeCapabilityObservation(available).ok).toBe(true);
    expect(
      parseManagedRuntimeCapabilityObservation({
        schemaVersion: "1",
        platformTarget: "windows-x64",
        state: "unavailable",
        reason: "virtualization-disabled",
        remediation: "enable-virtualization",
        observedAtMs: 2_000,
      }).ok,
    ).toBe(true);
    for (const replacement of [
      { state: "unknown" },
      { reason: "caller-says-enforced" },
      { remediation: "none", state: "unavailable" },
      { observedAtMs: -1 },
      { receipt: true },
      { controllerBundleDigest: "A".repeat(64) },
    ]) {
      expect(parseManagedRuntimeCapabilityObservation({ ...available, ...replacement }).ok).toBe(
        false,
      );
    }
  });

  it("covers every closed capability reason and remediation", () => {
    for (const reason of MANAGED_RUNTIME_UNAVAILABLE_REASONS) {
      expect(
        parseManagedRuntimeCapabilityObservation({
          schemaVersion: "1",
          platformTarget: "macos-x64",
          state: "unavailable",
          reason,
          remediation: "contact-enterprise-administrator",
          observedAtMs: 1,
        }).ok,
      ).toBe(true);
    }
    for (const remediation of MANAGED_RUNTIME_REMEDIATIONS.filter((item) => item !== "none")) {
      expect(
        parseManagedRuntimeCapabilityObservation({
          schemaVersion: "1",
          platformTarget: "macos-x64",
          state: "unavailable",
          reason: "host-not-installed",
          remediation,
          observedAtMs: 1,
        }).ok,
      ).toBe(true);
    }
  });
});

describe("managed runtime bundle descriptor", () => {
  const descriptor = {
    schemaVersion: "1",
    platformTarget: "macos-arm64",
    controllerKind: "apple-virtualization",
    controllerBundleDigest: DIGEST,
    guestBundleDigest: "d".repeat(64),
    profileDigest: MANAGED_RUNTIME_ISOLATION_PROFILE_DIGEST,
    environmentNames: [...MANAGED_RUNTIME_RUNTIME_ENV_NAMES],
  };

  it("accepts only the platform controller mapping and exact environment tuple", () => {
    expect(MANAGED_RUNTIME_PLATFORM_TARGETS).toStrictEqual([
      "macos-arm64",
      "macos-x64",
      "windows-x64",
    ]);
    expect(MANAGED_RUNTIME_CONTROLLER_KINDS).toStrictEqual([
      "apple-virtualization",
      "windows-hcs-hyper-v-service",
    ]);
    expect(parseManagedRuntimeBundleDescriptor(descriptor).ok).toBe(true);
    expect(
      parseManagedRuntimeBundleDescriptor({
        ...descriptor,
        platformTarget: "windows-x64",
        controllerKind: "windows-hcs-hyper-v-service",
      }).ok,
    ).toBe(true);
    for (const replacement of [
      { controllerKind: "windows-hcs-hyper-v-service" },
      { environmentNames: ["KEIKO_RUNTIME_ENDPOINT", "KEIKO_MODEL_ALIAS"] },
      {
        environmentNames: ["KEIKO_RUNTIME_ENDPOINT", "KEIKO_MODEL_ALIAS", "keiko_run_capability"],
      },
      {
        environmentNames: ["KEIKO_RUNTIME_ENDPOINT", "KEIKO_MODEL_ALIAS", "KEIKO_MODEL_ALIAS"],
      },
      { environmentNames: [...MANAGED_RUNTIME_RUNTIME_ENV_NAMES, "PATH"] },
      { endpoint: "http://host.invalid" },
    ]) {
      expect(parseManagedRuntimeBundleDescriptor({ ...descriptor, ...replacement }).ok).toBe(false);
    }
  });

  it("rejects a trapping environment tuple without throwing", () => {
    const environmentNames = new Proxy([...MANAGED_RUNTIME_RUNTIME_ENV_NAMES], {
      get: (): never => {
        throw new Error("hostile nested trap");
      },
    });
    expect(() =>
      parseManagedRuntimeBundleDescriptor({ ...descriptor, environmentNames }),
    ).not.toThrow();
    expect(parseManagedRuntimeBundleDescriptor({ ...descriptor, environmentNames }).ok).toBe(false);
  });
});
