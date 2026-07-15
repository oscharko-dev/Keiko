import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  MANAGED_RUNTIME_HOST_SCHEMA_VERSION,
  MANAGED_RUNTIME_ISOLATION_PROFILE,
  MANAGED_RUNTIME_ISOLATION_PROFILE_CANONICAL_JSON,
  MANAGED_RUNTIME_ISOLATION_PROFILE_DIGEST,
  MANAGED_RUNTIME_CAPABILITY_STATES,
  MANAGED_RUNTIME_CONTROLLER_KINDS,
  MANAGED_RUNTIME_PLATFORM_TARGETS,
  MANAGED_RUNTIME_REMEDIATIONS,
  MANAGED_RUNTIME_UNAVAILABLE_REASONS,
  MANAGED_RUNTIME_RUNTIME_ENV_NAMES,
  parseManagedRuntimeBundleDescriptor,
  parseManagedRuntimeCapabilityObservation,
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
    ["expired at issue", { expiresAtUnixMs: 1_000 }],
    ["beyond host deadline", { expiresAtUnixMs: 901_001 }],
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
      parseManagedRuntimeLaunchRequest({
        ...launchRequest(),
        issuedAtUnixMs: 1,
        expiresAtUnixMs: 2,
      }).ok,
    ).toBe(true);
  });
});

describe("managed runtime capability observation", () => {
  const available = {
    schemaVersion: "1",
    platformTarget: "windows-x64",
    state: "available",
    reason: "ready",
    remediation: "none",
    observedAtUnixMs: 2_000,
    controllerBundleDigest: DIGEST,
    guestBundleDigest: "d".repeat(64),
    profileDigest: MANAGED_RUNTIME_ISOLATION_PROFILE_DIGEST,
    policyVersionDigest: "5".repeat(64),
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
        observedAtUnixMs: 2_000,
      }).ok,
    ).toBe(true);
    for (const replacement of [
      { state: "unknown" },
      { reason: "caller-says-enforced" },
      { remediation: "none", state: "unavailable" },
      { observedAtUnixMs: -1 },
      { policyVersionDigest: "A".repeat(64) },
      { policyVersion: "policy-v1" },
      { recoveryObservationDigest: "7".repeat(64) },
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
          observedAtUnixMs: 1,
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
          observedAtUnixMs: 1,
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
