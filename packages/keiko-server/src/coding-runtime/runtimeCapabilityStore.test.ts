import { describe, expect, it } from "vitest";
import {
  createInMemoryRuntimeCapabilityStore,
  type RuntimeCapabilityBinding,
  type RuntimeCapabilityStore,
} from "./runtimeCapabilityStore.js";

const binding = (runId = "run-1"): RuntimeCapabilityBinding => ({
  runId,
  workspaceRootDigest: "a".repeat(64),
  envelopeDigest: "b".repeat(64),
  adapterKind: "model-gateway-sidecar" as const,
  expiresAtMs: 1_000,
});

function issueCapability(store: RuntimeCapabilityStore, runId = "run-1"): string {
  const issued = store.issue(binding(runId));
  if (!issued.ok) throw new Error(`capability issue failed: ${issued.reason}`);
  return issued.capability;
}

describe("RuntimeCapabilityStore", () => {
  it("retains only a hash while binding a capability to its run, workspace, envelope, adapter, and expiry", () => {
    const store = createInMemoryRuntimeCapabilityStore({ nowMs: () => 0 });
    const capability = issueCapability(store);

    expect(store.authenticate(capability, 999)).toEqual({ ok: true, binding: binding() });
    expect(store.resolve({ capability, ...binding(), nowMs: 999 })).toEqual({
      ok: true,
      binding: binding(),
    });
    expect(
      store.resolve({
        capability,
        ...binding(),
        adapterKind: "codex-cli-adapter",
        nowMs: 999,
      }),
    ).toEqual({ ok: false, reason: "invalid" });
    expect(store.resolve({ capability, ...binding(), nowMs: 1_000 })).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("keeps run revocation monotonic and cannot revive it through a repeat issue", () => {
    const store = createInMemoryRuntimeCapabilityStore({ nowMs: () => 0 });
    const capability = issueCapability(store);
    store.revokeRun("run-1");

    expect(store.resolve({ capability, ...binding(), nowMs: 1 })).toEqual({
      ok: false,
      reason: "revoked",
    });
    expect(store.issue(binding())).toEqual({ ok: false, reason: "revoked" });
    expect(store.issue(binding("run-2"))).toMatchObject({ ok: true });
  });

  it("prunes expired capabilities and bounds live capability and revocation state", () => {
    let nowMs = 1;
    const store = createInMemoryRuntimeCapabilityStore({ maxRecords: 2, nowMs: () => nowMs });
    expect(store.issue({ ...binding("expired"), expiresAtMs: 2 })).toMatchObject({ ok: true });
    store.revokeRun("expired");
    expect(store.issue(binding("live-1"))).toMatchObject({ ok: true });
    expect(store.issue(binding("live-2"))).toEqual({ ok: false, reason: "invalid" });

    nowMs = 3;
    expect(store.issue(binding("live-2"))).toMatchObject({ ok: true });
    expect(store.issue(binding("expired"))).toEqual({ ok: false, reason: "invalid" });
  });
});
