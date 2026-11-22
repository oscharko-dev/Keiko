import { describe, expect, it } from "vitest";
import type { ServerDiagnosticRecord, ServerDiagnosticSink } from "../diagnostics-log.js";
import {
  base64Cores,
  RelayCapabilityStore,
  relayCredentialSpellings,
  type RelayStoreTarget,
} from "./relayCapabilityStore.js";

interface Target extends RelayStoreTarget {
  readonly label: string;
}

function store(
  onRevoke?: (target: Target) => void,
  maxBindings?: number,
  diagnostics?: ServerDiagnosticSink,
): RelayCapabilityStore<Target> {
  return new RelayCapabilityStore<Target>({
    ...(diagnostics === undefined ? {} : { diagnostics }),
    freeze: (target) => Object.freeze({ ...target }),
    ...(onRevoke === undefined ? {} : { onRevoke }),
    ...(maxBindings === undefined ? {} : { maxBindings }),
  });
}

function bound(
  relay: RelayCapabilityStore<Target>,
  runId: string,
  label: string,
  signal?: AbortSignal,
): { readonly relayId: string; readonly capability: string } {
  const binding = relay.bind({ runId, label, ...(signal === undefined ? {} : { signal }) });
  if (binding === undefined) throw new Error("fixture-bind-failed");
  return binding;
}

describe("RelayCapabilityStore", () => {
  it("scopes a capability to its own binding", () => {
    const relay = store();
    const first = bound(relay, "run-1", "a");
    const second = bound(relay, "run-1", "b");
    expect(relay.authenticate(first.relayId, first.capability)?.target.label).toBe("a");
    expect(relay.authenticate(second.relayId, second.capability)?.target.label).toBe("b");
    expect(relay.authenticate(first.relayId, second.capability)).toBeUndefined();
    expect(relay.authenticate(first.relayId, undefined)).toBeUndefined();
    expect(relay.authenticate(first.relayId, `${first.capability}x`)).toBeUndefined();
    expect(relay.authenticate("../../etc", first.capability)).toBeUndefined();
    expect(relay.authenticate("short", first.capability)).toBeUndefined();
  });

  it("holds the capability only as a digest", () => {
    const relay = store();
    const { relayId, capability } = bound(relay, "run-1", "a");
    const admitted = relay.authenticate(relayId, capability);
    expect(JSON.stringify(admitted?.target)).not.toContain(capability);
    expect(capability).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(relayId).toMatch(/^[A-Za-z0-9_-]{22}$/u);
  });

  it("revokes every binding of a released run, once, and remembers why it was refused", () => {
    const revoked: string[] = [];
    const relay = store((target) => revoked.push(target.label));
    const first = bound(relay, "run-1", "a");
    const other = bound(relay, "run-2", "b");
    const signal = relay.authenticate(first.relayId, first.capability)?.signal;
    relay.releaseRun("run-1");
    relay.releaseRun("run-1");
    expect(revoked).toEqual(["a"]);
    expect(signal?.aborted).toBe(true);
    expect(relay.authenticate(first.relayId, first.capability)).toBeUndefined();
    expect(relay.wasRevoked(first.relayId, first.capability)).toBe(true);
    expect(relay.wasRevoked(first.relayId, other.capability)).toBe(false);
    expect(relay.wasRevoked(first.relayId, undefined)).toBe(false);
    expect(relay.wasRevoked(other.relayId, other.capability)).toBe(false);
    expect(relay.authenticate(other.relayId, other.capability)).toBeDefined();
  });

  it("revokes every binding of a run before a throwing callback is reported, and reports each", () => {
    const records: ServerDiagnosticRecord[] = [];
    const seen: string[] = [];
    const relay = store(
      (target) => {
        seen.push(target.label);
        throw new TypeError("callback failed");
      },
      undefined,
      { record: (record) => records.push(record) },
    );
    const first = bound(relay, "run-0001-aaaa", "a");
    const second = bound(relay, "run-0001-aaaa", "b");
    const other = bound(relay, "run-0002-bbbb", "c");
    expect(() => {
      relay.releaseRun("run-0001-aaaa");
    }).not.toThrow();
    // Both bindings of the run are revoked although the first callback threw.
    expect(relay.authenticate(first.relayId, first.capability)).toBeUndefined();
    expect(relay.authenticate(second.relayId, second.capability)).toBeUndefined();
    expect(relay.wasRevoked(second.relayId, second.capability)).toBe(true);
    expect(relay.authenticate(other.relayId, other.capability)).toBeDefined();
    expect(seen).toEqual(["a", "b"]);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      correlationId: "run-0001-aaaa",
      operation: "relay.binding.revoke",
      source: "relay.relayCapabilityStore",
      errorClass: "TypeError",
    });
    expect(records[0]?.frames).toBeDefined();
    expect(JSON.stringify(records)).not.toContain("callback failed");
  });

  it("isolates a throwing callback of a binding revoked by its own signal", () => {
    const records: ServerDiagnosticRecord[] = [];
    const relay = store(
      () => {
        throw new Error("callback failed");
      },
      undefined,
      { record: (record) => records.push(record) },
    );
    const controller = new AbortController();
    const binding = bound(relay, "run-1", "a", controller.signal);
    expect(() => {
      controller.abort();
    }).not.toThrow();
    expect(relay.wasRevoked(binding.relayId, binding.capability)).toBe(true);
    expect(records).toHaveLength(1);
  });

  it("revokes a binding whose own signal aborts, and refuses one already aborted", () => {
    const revoked: string[] = [];
    const relay = store((target) => revoked.push(target.label));
    const controller = new AbortController();
    const binding = bound(relay, "run-1", "a", controller.signal);
    controller.abort();
    expect(relay.authenticate(binding.relayId, binding.capability)).toBeUndefined();
    expect(relay.wasRevoked(binding.relayId, binding.capability)).toBe(true);
    expect(revoked).toEqual(["a"]);
    expect(relay.bind({ runId: "run-1", label: "b", signal: controller.signal })).toBeUndefined();
  });

  it("refuses a binding beyond its maximum and frees room when one is revoked", () => {
    const relay = store(undefined, 2);
    bound(relay, "run-1", "a");
    bound(relay, "run-2", "b");
    expect(relay.bind({ runId: "run-3", label: "c" })).toBeUndefined();
    relay.releaseRun("run-1");
    expect(relay.bind({ runId: "run-3", label: "c" })).toBeDefined();
  });

  it("bounds the memory of revoked capabilities", () => {
    const relay = store(undefined, 4000);
    const first = bound(relay, "run-0", "first");
    relay.releaseRun("run-0");
    for (let index = 1; index <= 1100; index += 1) {
      bound(relay, `run-${String(index)}`, "x");
      relay.releaseRun(`run-${String(index)}`);
    }
    // The oldest memory was dropped: the late request is refused as unknown, not as revoked.
    expect(relay.wasRevoked(first.relayId, first.capability)).toBe(false);
  });
});

describe("relayCredentialSpellings", () => {
  it("adds the base64 and base64url cores of each credential at every alignment", () => {
    const secret = "credential-value-0123456789";
    const spellings = relayCredentialSpellings([secret]);
    expect(spellings).toContain(secret);
    for (const offset of [0, 1, 2]) {
      const encoded = Buffer.concat([Buffer.alloc(offset), Buffer.from(secret)]).toString("base64");
      expect(spellings.some((core) => core.length > 0 && encoded.includes(core))).toBe(true);
    }
    expect(base64Cores(secret).every((core) => core.length >= 20)).toBe(true);
  });
});
