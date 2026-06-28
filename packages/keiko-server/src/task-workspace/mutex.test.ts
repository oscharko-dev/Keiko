// Unit coverage for the in-process keyed async mutex (Issue #449, ADR-0093 D1). Proves the serializer
// that closes the optimistic check-then-write TOCTOU window: same-key calls run one at a time, different
// keys run concurrently, errors are isolated (do not poison the key), multi-key acquisition serializes
// against any overlapping key, and the canonical key order makes deadlock structurally impossible.

import { describe, expect, it } from "vitest";
import {
  activePointerKey,
  createWorkspaceMutexRegistry,
  provisionKey,
  workspaceKey,
} from "./mutex.js";

// A controllable async task: resolves only when `release()` is called, recording enter/exit order.
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("createWorkspaceMutexRegistry", () => {
  it("serializes two runExclusive calls on the same key (no interleaving)", async () => {
    const mutex = createWorkspaceMutexRegistry();
    const order: string[] = [];
    const first = deferred();

    const a = mutex.runExclusive(["ws:x"], async () => {
      order.push("a:enter");
      await first.promise;
      order.push("a:exit");
    });
    const b = mutex.runExclusive(["ws:x"], () => {
      order.push("b:run");
    });

    // b must NOT have run yet — a holds the key and has not released.
    await Promise.resolve();
    expect(order).toEqual(["a:enter"]);
    first.resolve();
    await Promise.all([a, b]);
    expect(order).toEqual(["a:enter", "a:exit", "b:run"]);
  });

  it("runs calls on different keys concurrently", async () => {
    const mutex = createWorkspaceMutexRegistry();
    const order: string[] = [];
    const gateA = deferred();

    const a = mutex.runExclusive(["ws:a"], async () => {
      order.push("a:enter");
      await gateA.promise;
      order.push("a:exit");
    });
    const b = mutex.runExclusive(["ws:b"], () => {
      order.push("b:run");
    });

    // b runs immediately even while a is still holding ws:a (disjoint keys do not serialize).
    await b;
    expect(order).toContain("b:run");
    expect(order).not.toContain("a:exit");
    gateA.resolve();
    await a;
  });

  it("propagates the resolved value and the thrown error of fn", async () => {
    const mutex = createWorkspaceMutexRegistry();
    await expect(mutex.runExclusive(["ws:v"], () => 42)).resolves.toBe(42);
    await expect(
      mutex.runExclusive(["ws:v"], () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });

  it("isolates a thrown fn so the key is released for the next acquirer", async () => {
    const mutex = createWorkspaceMutexRegistry();
    const order: string[] = [];
    const failing = mutex
      .runExclusive(["ws:k"], () => {
        order.push("first");
        throw new Error("fail");
      })
      .catch(() => order.push("first:caught"));
    const next = mutex.runExclusive(["ws:k"], () => {
      order.push("second");
    });
    await Promise.all([failing, next]);
    expect(order).toEqual(["first", "first:caught", "second"]);
  });

  it("serializes a multi-key call against any overlapping single-key holder", async () => {
    const mutex = createWorkspaceMutexRegistry();
    const order: string[] = [];
    const gate = deferred();

    // Holder of ws:1 blocks; a multi-key [active:r, ws:1] call must wait for the overlap on ws:1.
    const holder = mutex.runExclusive(["ws:1"], async () => {
      order.push("holder:enter");
      await gate.promise;
      order.push("holder:exit");
    });
    const multi = mutex.runExclusive([activePointerKey("r"), workspaceKey("1")], () => {
      order.push("multi:run");
    });

    await Promise.resolve();
    expect(order).toEqual(["holder:enter"]);
    gate.resolve();
    await Promise.all([holder, multi]);
    expect(order).toEqual(["holder:enter", "holder:exit", "multi:run"]);
  });

  it("does not deadlock when two flows request the same two keys in opposite order", async () => {
    const mutex = createWorkspaceMutexRegistry();
    const order: string[] = [];
    // Both want active:r and ws:1; requested in opposite array order. The registry sorts into the
    // canonical order before chaining, so neither can hold one and wait on the other → no cycle.
    const flow1 = mutex.runExclusive([activePointerKey("r"), workspaceKey("1")], async () => {
      order.push("flow1");
      await Promise.resolve();
    });
    const flow2 = mutex.runExclusive([workspaceKey("1"), activePointerKey("r")], () => {
      order.push("flow2");
    });
    await Promise.all([flow1, flow2]);
    expect(order).toHaveLength(2);
    expect(new Set(order)).toEqual(new Set(["flow1", "flow2"]));
  });

  it("processes a queue of same-key calls strictly in submission order", async () => {
    const mutex = createWorkspaceMutexRegistry();
    const seen: number[] = [];
    const calls = Array.from({ length: 25 }, (_unused, i) =>
      mutex.runExclusive(["ws:q"], async () => {
        await Promise.resolve();
        seen.push(i);
      }),
    );
    await Promise.all(calls);
    expect(seen).toEqual(Array.from({ length: 25 }, (_unused, i) => i));
  });

  it("exposes content-free key builders for the three lock scopes", () => {
    expect(workspaceKey("ws-abc")).toBe("ws:ws-abc");
    expect(provisionKey("repo-1", "task-2")).toBe("prov:repo-1:task-2");
    expect(activePointerKey("repo-1")).toBe("active:repo-1");
  });
});
