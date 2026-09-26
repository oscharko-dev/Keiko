// Unit coverage for the in-process keyed async mutex (Issue #449, ADR-0093 D1). Proves the serializer
// that closes the optimistic check-then-write TOCTOU window: same-key calls run one at a time, different
// keys run concurrently, errors are isolated (do not poison the key), multi-key acquisition serializes
// against any overlapping key, and the canonical key order makes deadlock structurally impossible.

import { mkdtempSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  fileWriteKeys,
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

// Two saves serialize iff their key SETS overlap — `runExclusive` queues on any shared key — so
// every assertion here is about overlap, not about the arrays being equal.
function serializesWith(a: readonly string[], b: readonly string[]): boolean {
  const other = new Set(b);
  return a.some((key) => other.has(key));
}

describe("fileWriteKeys identity (#3200 review)", () => {
  // The key must not change when the write replaces the target: an inode-based key would shift on
  // every save, letting a request that resolves mid-rename derive a different key and enter the
  // critical section concurrently.
  //
  // This used to be asserted as `fileWriteKeys(p) === fileWriteKeys(p)` — `f(x) === f(x)`, true for
  // every pure implementation including the inode-based one it names, so it could not fail for the
  // design it forbids. The invariant is RELOCATED to two places where it can be falsified.
  //
  // Not a signature assertion: `Parameters<>` constrains only what CALLERS pass, and
  // `fileWriteKeys(realPath: string)` could still call `statSync(realPath)` internally while keeping
  // exactly `[string]`. Observed instead — a path that does not exist still yields keys, and the
  // same path yields the same keys once the file appears. A filesystem-dependent implementation
  // would throw ENOENT on the first call or answer differently on the second.
  it("derives the key without consulting the filesystem, so a missing path still yields keys", () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-mutex-absent-"));
    try {
      const absent = join(root, "never-created.ts");
      const whileAbsent = fileWriteKeys(absent);
      expect(whileAbsent).toHaveLength(2);

      writeFileSync(absent, "now it exists", "utf8");
      expect(fileWriteKeys(absent)).toEqual(whileAbsent);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps a real file's saves serialized across the atomic rename a save performs", () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-mutex-rename-"));
    try {
      const target = join(root, "app.ts");
      const replacement = join(root, "app.ts.tmp");
      writeFileSync(target, "before", "utf8");
      writeFileSync(replacement, "after", "utf8");
      // Prove the fixture rather than assume it: the two objects really are distinct while both
      // exist, so the rename below genuinely changes which one answers to `target`. Asserting a
      // nonzero inode instead would check only the survivor, and would impose a product requirement
      // on filesystems that report no usable 64-bit file id.
      const original = statSync(target, { bigint: true });
      const incoming = statSync(replacement, { bigint: true });
      expect([incoming.dev, incoming.ino]).not.toEqual([original.dev, original.ino]);

      const before = fileWriteKeys(target);
      renameSync(replacement, target);

      // The invariant is that the two saves still SERIALIZE — `runExclusive` queues on any shared
      // key, as `serializesWith` states. Demanding identical arrays would reject a safe
      // strengthening that keeps the stable path key and adds a generation-scoped alias beside it.
      expect(serializesWith(before, fileWriteKeys(target))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("folds case- and normalization-equivalent spellings on every platform", () => {
    const upper = fileWriteKeys("/tmp/project/Foo.ts");
    const lower = fileWriteKeys("/tmp/project/foo.ts");
    const nfc = fileWriteKeys("/tmp/project/caf\u00e9.ts");
    const nfd = fileWriteKeys("/tmp/project/cafe\u0301.ts");
    // Portable: the alias key is taken on every platform, so this contract does not depend on the
    // host. A byte-exact filesystem merely serializes two saves it did not have to.
    expect(serializesWith(upper, lower)).toBe(true);
    expect(serializesWith(nfc, nfd)).toBe(true);
  });

  // The residual the #3200 review named: comparablePath lowercases, and lowercasing SPLITS the
  // Greek sigma alias class that a case-insensitive filesystem merges — "\u03c2".toLowerCase() and
  // "\u03a3".toLowerCase() differ, so the exact key alone would let both saves into the section.
  // The uppercase alias key exists for exactly this and must overlap.
  it.each([
    ["final sigma vs capital sigma", "\u03c2", "\u03a3"],
    ["eszett vs capital eszett (JS toUpperCase splits this class)", "\u00df", "\u1e9e"],
    ["eszett vs SS uppercase", "\u00df", "SS"],
    ["capital eszett vs SS", "\u1e9e", "SS"],
    ["ligature fi vs fi", "\ufb01", "fi"],

    ["final sigma vs small sigma", "\u03c2", "\u03c3"],
    ["dotless i vs capital I", "\u0131", "I"],
  ])("serializes the %s alias class the exact key splits", (_label, left, right) => {
    const a = fileWriteKeys(`/tmp/project/${left}.ts`);
    const b = fileWriteKeys(`/tmp/project/${right}.ts`);
    expect(serializesWith(a, b)).toBe(true);
  });

  it("separates genuinely different files", () => {
    expect(serializesWith(fileWriteKeys("/tmp/a.ts"), fileWriteKeys("/tmp/b.ts"))).toBe(false);
  });

  it("keeps every key in one tier so a file save cannot deadlock", () => {
    // All keys a save takes must sort into the same tier; the registry acquires them in one
    // canonical order, so a multi-key save can never hold-and-wait against another save.
    const keys = fileWriteKeys("/tmp/project/app.ts");
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every((key) => key.startsWith("file:") || key.startsWith("file-alias:"))).toBe(
      true,
    );
  });
});
