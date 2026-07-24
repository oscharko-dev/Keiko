import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createInMemoryUiStore, type UiStore } from "./index.js";

// Exercises the workspace-trust row helpers through the UiStore port (the real seam). The store is
// deliberately dumb: it round-trips opaque rows, upserts in place at a higher revision, and prunes
// deterministically to the most-recently-updated rows. No trust semantics live here.
describe("workspace trust store rows", () => {
  let clock: number;
  let store: UiStore;

  beforeEach(() => {
    clock = 1_000;
    store = createInMemoryUiStore({ now: (): number => clock++ });
  });

  afterEach(() => {
    store.close();
  });

  it("returns undefined for an absent root reference", () => {
    expect(store.readWorkspaceTrustRecord("root-absent")).toBeUndefined();
  });

  it("writes then reads a row back with a stamped updated_at", () => {
    store.writeWorkspaceTrustRecord({
      rootRef: "root-a",
      revision: 0,
      trust: "trusted",
      recordJson: '{"v":0}',
    });
    expect(store.readWorkspaceTrustRecord("root-a")).toEqual({
      rootRef: "root-a",
      revision: 0,
      trust: "trusted",
      recordJson: '{"v":0}',
      updatedAt: 1_000,
    });
  });

  it("upserts in place at a higher revision, overwriting the prior record", () => {
    store.writeWorkspaceTrustRecord({
      rootRef: "root-a",
      revision: 0,
      trust: "trusted",
      recordJson: '{"v":0}',
    });
    store.writeWorkspaceTrustRecord({
      rootRef: "root-a",
      revision: 1,
      trust: "restricted",
      recordJson: '{"v":1}',
    });
    expect(store.readWorkspaceTrustRecord("root-a")).toMatchObject({
      revision: 1,
      trust: "restricted",
      recordJson: '{"v":1}',
    });
  });

  it("prunes to the most-recently-updated rows and keeps the newest", () => {
    for (let index = 0; index < 5; index += 1) {
      store.writeWorkspaceTrustRecord({
        rootRef: `root-${String(index)}`,
        revision: 0,
        trust: "restricted",
        recordJson: "{}",
      });
    }
    store.pruneWorkspaceTrustRecords(3);
    expect(store.readWorkspaceTrustRecord("root-0")).toBeUndefined();
    expect(store.readWorkspaceTrustRecord("root-1")).toBeUndefined();
    expect(store.readWorkspaceTrustRecord("root-2")).toBeDefined();
    expect(store.readWorkspaceTrustRecord("root-4")).toBeDefined();
  });

  it("treats a non-positive prune bound as evict-all", () => {
    store.writeWorkspaceTrustRecord({
      rootRef: "root-a",
      revision: 0,
      trust: "trusted",
      recordJson: "{}",
    });
    store.pruneWorkspaceTrustRecords(0);
    expect(store.readWorkspaceTrustRecord("root-a")).toBeUndefined();
  });

  it("ignores a stale write at an equal or lower revision (monotonic guard)", () => {
    store.writeWorkspaceTrustRecord({
      rootRef: "root-a",
      revision: 1,
      trust: "restricted",
      recordJson: '{"kept":true}',
    });
    // A lower revision must be rejected.
    store.writeWorkspaceTrustRecord({
      rootRef: "root-a",
      revision: 0,
      trust: "trusted",
      recordJson: '{"lower":true}',
    });
    // An equal revision must be rejected too.
    store.writeWorkspaceTrustRecord({
      rootRef: "root-a",
      revision: 1,
      trust: "trusted",
      recordJson: '{"equal":true}',
    });
    expect(store.readWorkspaceTrustRecord("root-a")).toMatchObject({
      revision: 1,
      trust: "restricted",
      recordJson: '{"kept":true}',
    });
  });
});
