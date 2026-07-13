import { describe, expect, it } from "vitest";
import {
  assertPlanBoundToRequest,
  deriveCanonicalDebugProvisioningDigest,
  type DebugCapsulePlanBinding,
  type DebugSpawnArtifactIdentity,
  type Layer2DebugCapsulePlan,
} from "./debugCapsulePlan.js";

const binding: DebugCapsulePlanBinding = {
  workspacePartitionKey: "partition_a",
  activationRevision: 7,
  targetKind: "file",
};

const artifact: DebugSpawnArtifactIdentity = {
  capsulePath: "/opt/adapter",
  hostPath: "/trusted/adapter",
  realPath: "/trusted/adapter",
  approvedRootRealPath: "/trusted",
  identityDigest: "a".repeat(64),
  device: 1,
  inode: 2,
  size: 3,
  mode: 0o100755,
  ownerUid: 501,
};

function plan(overrides: Partial<DebugCapsulePlanBinding> = {}): Layer2DebugCapsulePlan {
  return Object.freeze({
    schemaVersion: "1",
    planId: "plan_a",
    epoch: 1,
    expiresAtMs: 10_000,
    backend: "oci",
    runtimeIdentityDigest: "b".repeat(64),
    ...binding,
    ...overrides,
    endpoint: {
      kind: "posixSocket",
      runtimeDirectory: "/private/runtime",
      socketPath: "/private/runtime/dap.sock",
      runtimeIdentity: "runtime_a",
    },
    attestation: {
      filesystem: "executionRoot",
      network: "none",
      processScope: "capsule",
      runtimeDirectoryMode: "0700",
      endpointOwnership: "currentUser",
    },
    launchRequest: { command: "launch", arguments: { request: "launch", noDebug: false } },
  }) as unknown as Layer2DebugCapsulePlan;
}

describe("opaque Layer-2 debug capsule handoff", () => {
  it("derives an order-independent provisioning identity", () => {
    const second = { ...artifact, capsulePath: "/opt/node", identityDigest: "b".repeat(64) };
    const forward = deriveCanonicalDebugProvisioningDigest([artifact, second]);
    const reverse = deriveCanonicalDebugProvisioningDigest([second, artifact]);
    expect(forward).toMatch(/^[a-f0-9]{64}$/u);
    expect(reverse).toBe(forward);
  });

  it.each([
    ["capsulePath", "/opt/changed"],
    ["realPath", "/trusted/changed"],
    ["approvedRootRealPath", "/other"],
    ["identityDigest", "c".repeat(64)],
    ["device", 4],
    ["inode", 5],
    ["size", 6],
    ["mode", 0o100700],
    ["ownerUid", 502],
  ] as const)("binds provisioning artifact field %s", (key, value) => {
    expect(deriveCanonicalDebugProvisioningDigest([{ ...artifact, [key]: value }])).not.toBe(
      deriveCanonicalDebugProvisioningDigest([artifact]),
    );
  });

  it("accepts every exact identity binding", () => {
    expect(() => {
      assertPlanBoundToRequest(plan(), binding);
    }).not.toThrow();
  });

  it("surfaces a closed typed error without plan content", () => {
    try {
      assertPlanBoundToRequest(plan({ activationRevision: 8 }), binding);
      throw new Error("expected rejection");
    } catch (error: unknown) {
      expect(error).toMatchObject({
        name: "DebugCapsulePlanError",
        message: "INVALID_CAPSULE_PLAN",
        code: "INVALID_CAPSULE_PLAN",
      });
    }
  });

  it.each([
    ["workspacePartitionKey", "partition_b"],
    ["activationRevision", 8],
    ["targetKind", "catalog"],
  ] as const)("rejects drift in %s", (key, value) => {
    expect(() => {
      assertPlanBoundToRequest(plan({ [key]: value }), binding);
    }).toThrow(expect.objectContaining({ code: "INVALID_CAPSULE_PLAN" }));
  });
});
