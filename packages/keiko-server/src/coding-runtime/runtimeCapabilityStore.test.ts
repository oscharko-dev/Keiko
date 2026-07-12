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
  audience: "tool-facade",
  expiresAtMs: 1_000,
});

type CapabilityAudience = "model-gateway" | "tool-facade";

function audienceBinding(
  audience: CapabilityAudience,
  runId = "run-1",
): RuntimeCapabilityBinding & { readonly audience: CapabilityAudience } {
  return { ...binding(runId), audience };
}

function issueCapability(store: RuntimeCapabilityStore, runId = "run-1"): string {
  const issued = store.issue(binding(runId));
  if (!issued.ok) throw new Error(`capability issue failed: ${issued.reason}`);
  return issued.capability;
}

describe("RuntimeCapabilityStore", () => {
  it("rejects a legacy binding that omits its closed capability audience", () => {
    const store = createInMemoryRuntimeCapabilityStore({ nowMs: () => 0 });
    const legacyBinding = Object.fromEntries(
      Object.entries(binding()).filter(([key]) => key !== "audience"),
    ) as RuntimeCapabilityBinding;

    expect(store.issue(legacyBinding)).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("binds independent capabilities to closed audiences and rejects cross-audience use", () => {
    const values = [
      "gateway-capability-material-0000000001",
      "tool-capability-material-0000000002",
    ];
    const store = createInMemoryRuntimeCapabilityStore({
      nowMs: () => 0,
      newCapability: () => values.shift() ?? "unexpected-capability-material-0003",
    });
    const gateway = store.issue(audienceBinding("model-gateway"));
    const tool = store.issue(audienceBinding("tool-facade"));
    if (!gateway.ok || !tool.ok) throw new Error("expected audience capability issue");

    expect(gateway.capability).not.toBe(tool.capability);
    expect(
      store.resolve({
        capability: gateway.capability,
        ...audienceBinding("model-gateway"),
        nowMs: 1,
      }),
    ).toMatchObject({ ok: true, binding: { audience: "model-gateway" } });
    expect(
      store.resolve({
        capability: gateway.capability,
        ...audienceBinding("tool-facade"),
        nowMs: 1,
      }),
    ).toEqual({ ok: false, reason: "invalid" });
    expect(
      store.resolve({
        capability: tool.capability,
        ...audienceBinding("model-gateway"),
        nowMs: 1,
      }),
    ).toEqual({ ok: false, reason: "invalid" });
  });
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
