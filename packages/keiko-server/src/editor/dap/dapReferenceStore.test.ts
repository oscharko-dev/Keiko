import { describe, expect, it } from "vitest";
import { createDebugReferenceStore, DEBUG_REFERENCE_CAP } from "./dapReferenceStore.js";

const scope = {
  sessionId: "session_a",
  workspacePartitionKey: "workspace_a",
  browserSessionBinding: "browser_a",
  pauseGeneration: 1,
};

function tokenFactory(): () => Buffer {
  let next = 0;
  return (): Buffer => {
    const bytes = Buffer.alloc(24);
    bytes.writeUInt32BE(next++);
    return bytes;
  };
}

describe("pause-bound DAP reference store", () => {
  it("mints opaque references and resolves only the exact expected target kind", () => {
    const store = createDebugReferenceStore({ token: tokenFactory() });
    store.activatePause(scope);
    const minted = store.mint(scope, { kind: "frame", frameId: 7 });
    expect(minted.ok).toBe(true);
    if (!minted.ok) throw new Error("invalid test fixture");
    expect(minted.reference).toMatch(/^[A-Za-z0-9_-]{32}$/u);
    expect(minted.reference).not.toContain("7");
    expect(store.resolve(scope, minted.reference, "frame")).toEqual({
      ok: true,
      target: { kind: "frame", frameId: 7 },
    });
    expect(store.resolve(scope, minted.reference, "scope")).toEqual({
      ok: false,
      reason: "kind_mismatch",
    });
  });

  it("rejects cross-workspace, cross-browser, cross-session, and stale-generation references", () => {
    const store = createDebugReferenceStore({ token: tokenFactory() });
    store.activatePause(scope);
    const minted = store.mint(scope, { kind: "scope", variablesReference: 8, depth: 0 });
    if (!minted.ok) throw new Error("invalid test fixture");

    for (const changed of [
      { ...scope, workspacePartitionKey: "workspace_b" },
      { ...scope, browserSessionBinding: "browser_b" },
      { ...scope, sessionId: "session_b" },
      { ...scope, pauseGeneration: 2 },
    ]) {
      expect(store.resolve(changed, minted.reference, "scope")).toEqual({
        ok: false,
        reason: "stale",
      });
    }
    store.activatePause({ ...scope, pauseGeneration: 2 });
    expect(store.resolve(scope, minted.reference, "scope")).toEqual({
      ok: false,
      reason: "stale",
    });
  });

  it("bounds each pause snapshot and rejects duplicate or malformed token sources", () => {
    const store = createDebugReferenceStore({ token: tokenFactory() });
    store.activatePause(scope);
    for (let index = 1; index <= DEBUG_REFERENCE_CAP; index += 1) {
      expect(store.mint(scope, { kind: "frame", frameId: index }).ok).toBe(true);
    }
    expect(store.mint(scope, { kind: "frame", frameId: 1 }).ok).toBe(true);
    expect(store.mint(scope, { kind: "frame", frameId: DEBUG_REFERENCE_CAP + 1 })).toEqual({
      ok: false,
      reason: "capacity",
    });

    const duplicate = createDebugReferenceStore({ token: () => Buffer.alloc(24, 1) });
    duplicate.activatePause(scope);
    expect(duplicate.mint(scope, { kind: "frame", frameId: 1 }).ok).toBe(true);
    expect(duplicate.mint(scope, { kind: "frame", frameId: 2 })).toEqual({
      ok: false,
      reason: "capacity",
    });
    const malformed = createDebugReferenceStore({ token: () => Buffer.alloc(23) });
    malformed.activatePause(scope);
    expect(malformed.mint(scope, { kind: "frame", frameId: 1 })).toEqual({
      ok: false,
      reason: "capacity",
    });
  });

  it("rejects unsafe raw references and clears all references when the session ends", () => {
    const store = createDebugReferenceStore({ token: tokenFactory() });
    store.activatePause(scope);
    for (const target of [
      { kind: "frame" as const, frameId: 0 },
      { kind: "scope" as const, variablesReference: -1, depth: 0 },
      {
        kind: "variable" as const,
        variablesReference: 1,
        parentVariablesReference: 2,
        depth: 1,
        name: "",
        settable: true,
      },
      {
        kind: "variable" as const,
        variablesReference: 1,
        parentVariablesReference: 2,
        depth: 1,
        name: "bad\u0000name",
        settable: true,
      },
      {
        kind: "variable" as const,
        variablesReference: 0,
        parentVariablesReference: 0,
        depth: 1,
        name: "primitive",
        settable: true,
      },
      { kind: "cursor" as const, startFrame: -1 },
    ]) {
      expect(store.mint(scope, target)).toEqual({ ok: false, reason: "inactive" });
    }
    const minted = store.mint(scope, { kind: "cursor", startFrame: 0 });
    if (!minted.ok) throw new Error("invalid test fixture");
    store.clearSession(scope.sessionId);
    expect(store.resolve(scope, minted.reference, "cursor")).toEqual({
      ok: false,
      reason: "stale",
    });
  });

  it("returns immutable target copies", () => {
    const store = createDebugReferenceStore({ token: tokenFactory() });
    store.activatePause(scope);
    const minted = store.mint(scope, {
      kind: "variable",
      variablesReference: 9,
      parentVariablesReference: 0,
      depth: 0,
      name: "counter",
      settable: false,
    });
    if (!minted.ok) throw new Error("invalid test fixture");
    const resolved = store.resolve(scope, minted.reference, "variable");
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error("invalid test fixture");
    expect(Object.isFrozen(resolved.target)).toBe(true);
    expect(resolved.target.settable).toBe(false);
    expect(store.projectionEpoch(scope)).toBe(0);
    store.resetPause(scope);
    expect(store.projectionEpoch(scope)).toBe(1);
    expect(store.resolve(scope, minted.reference, "variable")).toEqual({
      ok: false,
      reason: "missing",
    });
  });
});
