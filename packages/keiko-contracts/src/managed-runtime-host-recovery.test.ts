import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  MANAGED_RUNTIME_DIGEST_DOMAINS,
  MANAGED_RUNTIME_EMPTY_INVENTORY_DIGEST,
  MANAGED_RUNTIME_ISOLATION_PROFILE_DIGEST,
  MANAGED_RUNTIME_RECOVERY_STATES,
  MANAGED_RUNTIME_RECOVERY_TRIGGERS,
  parseManagedRuntimeRecoveryObservation,
} from "./index.js";

function recoveryObservation(): Record<string, unknown> {
  return {
    schemaVersion: "1",
    state: "completed",
    trigger: "startup",
    platformTarget: "windows-x64",
    controllerKind: "windows-hcs-hyper-v-service",
    controllerBundleDigest: "a".repeat(64),
    profileDigest: MANAGED_RUNTIME_ISOLATION_PROFILE_DIGEST,
    policyVersionDigest: "5".repeat(64),
    observedAtUnixMs: 2_000,
    enumeratedVmCount: 0,
    staleVmCount: 0,
    unrecognizedVmCount: 0,
    terminatedVmCount: 0,
    failureCount: 0,
    inventoryDigest: MANAGED_RUNTIME_EMPTY_INVENTORY_DIGEST,
  };
}

describe("managed runtime machine recovery observation", () => {
  it("accepts a completed all-zero startup inventory scan", () => {
    expect(MANAGED_RUNTIME_EMPTY_INVENTORY_DIGEST).toMatch(/^[a-f0-9]{64}$/);
    expect(
      createHash("sha256")
        .update(`${MANAGED_RUNTIME_DIGEST_DOMAINS.inventoryDigest}[]`)
        .digest("hex"),
    ).toBe(MANAGED_RUNTIME_EMPTY_INVENTORY_DIGEST);
    expect(MANAGED_RUNTIME_RECOVERY_STATES).toStrictEqual(["pending", "completed", "failed"]);
    expect(MANAGED_RUNTIME_RECOVERY_TRIGGERS).toStrictEqual(["startup", "restart"]);
    expect(parseManagedRuntimeRecoveryObservation(recoveryObservation())).toEqual({
      ok: true,
      value: recoveryObservation(),
    });
  });

  it.each([
    ["pending empty scan", { state: "pending" }],
    [
      "pending partial scan",
      {
        state: "pending",
        enumeratedVmCount: 3,
        staleVmCount: 2,
        unrecognizedVmCount: 1,
        terminatedVmCount: 1,
        failureCount: 0,
        inventoryDigest: "7".repeat(64),
      },
    ],
    [
      "completed non-empty scan",
      {
        enumeratedVmCount: 2,
        staleVmCount: 1,
        unrecognizedVmCount: 1,
        terminatedVmCount: 2,
        inventoryDigest: "7".repeat(64),
      },
    ],
    [
      "failed settled scan",
      {
        state: "failed",
        enumeratedVmCount: 2,
        staleVmCount: 2,
        terminatedVmCount: 1,
        failureCount: 1,
        inventoryDigest: "7".repeat(64),
      },
    ],
  ])("accepts a coherent %s", (_label, replacement) => {
    expect(
      parseManagedRuntimeRecoveryObservation({ ...recoveryObservation(), ...replacement }).ok,
    ).toBe(true);
  });

  it.each([
    ["unknown state", { state: "ready" }],
    ["unknown trigger", { trigger: "caller-request" }],
    ["wrong controller", { controllerKind: "apple-virtualization" }],
    ["arbitrary empty digest", { inventoryDigest: "7".repeat(64) }],
    ["unclassified VM", { enumeratedVmCount: 1 }],
    ["over-settled scan", { terminatedVmCount: 1 }],
    ["pending over-settled scan", { state: "pending", terminatedVmCount: 1 }],
    [
      "completed with accounted failure",
      {
        enumeratedVmCount: 1,
        staleVmCount: 1,
        failureCount: 1,
        inventoryDigest: "7".repeat(64),
      },
    ],
    [
      "failed with unsettled VM",
      {
        state: "failed",
        enumeratedVmCount: 2,
        staleVmCount: 2,
        failureCount: 1,
        inventoryDigest: "7".repeat(64),
      },
    ],
    ["failed without failure", { state: "failed" }],
    [
      "pending fully settled",
      {
        state: "pending",
        enumeratedVmCount: 1,
        staleVmCount: 1,
        terminatedVmCount: 1,
        inventoryDigest: "7".repeat(64),
      },
    ],
    ["uppercase policy digest", { policyVersionDigest: "A".repeat(64) }],
    ["string count", { failureCount: "0" }],
    ["unsafe count", { failureCount: Number.MAX_SAFE_INTEGER + 1 }],
    ["negative count", { failureCount: -1 }],
    ["legacy observed time", { observedAtUnixMs: undefined, observedAtMs: 2_000 }],
    ["unknown field", { recoveryReceipt: true }],
  ])("rejects %s", (_label, replacement) => {
    expect(
      parseManagedRuntimeRecoveryObservation({ ...recoveryObservation(), ...replacement }).ok,
    ).toBe(false);
  });

  it.each(Object.keys(recoveryObservation()))("requires recovery field %s", (field) => {
    const candidate = Object.fromEntries(
      Object.entries(recoveryObservation()).filter(([key]) => key !== field),
    );
    expect(parseManagedRuntimeRecoveryObservation(candidate).ok).toBe(false);
  });
});
