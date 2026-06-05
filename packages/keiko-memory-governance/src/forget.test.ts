import { describe, expect, it } from "vitest";

import type { ConversationId } from "@oscharko-dev/keiko-contracts/memory";
import { validateMemoryForget } from "@oscharko-dev/keiko-contracts/memory";

import { buildForgetOperations, selectMemoriesForForget } from "./forget.js";
import { GovernanceError } from "./errors.js";
import { ctx, FIXED_NOW_MS, makeRecord, must, projectScope, userScope } from "./_support.js";

describe("selectMemoriesForForget — by-id", () => {
  it("selects only the matching id", () => {
    const a = makeRecord({ id: "m-a" });
    const b = makeRecord({ id: "m-b" });
    const got = selectMemoriesForForget(
      [a, b],
      { kind: "by-id", memoryId: a.id },
      { nowMs: FIXED_NOW_MS },
    );
    expect(got).toEqual([a]);
  });
});

describe("selectMemoriesForForget — by-scope", () => {
  it("selects every record at the exact scope coordinate", () => {
    const u1 = makeRecord({ id: "m-1", scope: userScope("u-1") });
    const u2 = makeRecord({ id: "m-2", scope: userScope("u-1") });
    const u3 = makeRecord({ id: "m-3", scope: userScope("u-2") });
    const p = makeRecord({ id: "m-4", scope: projectScope("p-1") });
    const got = selectMemoriesForForget(
      [u1, u2, u3, p],
      { kind: "by-scope", scope: userScope("u-1") },
      { nowMs: FIXED_NOW_MS },
    );
    expect(got.map((r) => r.id).sort()).toEqual(["m-1", "m-2"]);
  });

  it("treats two scopes of different kinds as non-equal even with the same coordinate string", () => {
    const u = makeRecord({ id: "m-u", scope: userScope("x") });
    const got = selectMemoriesForForget(
      [u],
      { kind: "by-scope", scope: projectScope("x") },
      { nowMs: FIXED_NOW_MS },
    );
    expect(got).toEqual([]);
  });
});

describe("selectMemoriesForForget — by-type", () => {
  it("selects only records matching BOTH scope and type", () => {
    const a = makeRecord({ id: "m-a", scope: userScope("u-1"), type: "preference" });
    const b = makeRecord({ id: "m-b", scope: userScope("u-1"), type: "decision" });
    const c = makeRecord({ id: "m-c", scope: userScope("u-2"), type: "preference" });
    const got = selectMemoriesForForget(
      [a, b, c],
      { kind: "by-type", scope: userScope("u-1"), type: "preference" },
      { nowMs: FIXED_NOW_MS },
    );
    expect(got).toEqual([a]);
  });
});

describe("selectMemoriesForForget — by-source-conversation", () => {
  it("selects only records whose provenance.sourceConversationId matches", () => {
    const a = makeRecord({ id: "m-a", scope: userScope("u-1"), sourceConversationId: "c-1" });
    const b = makeRecord({ id: "m-b", scope: userScope("u-1"), sourceConversationId: "c-2" });
    const c = makeRecord({ id: "m-c", scope: userScope("u-1") }); // no source conv
    const got = selectMemoriesForForget(
      [a, b, c],
      {
        kind: "by-source-conversation",
        scope: userScope("u-1"),
        sourceConversationId: "c-1" as ConversationId,
      },
      { nowMs: FIXED_NOW_MS },
    );
    expect(got).toEqual([a]);
  });
});

describe("selectMemoriesForForget — by-time-window", () => {
  it("selects records older than the window boundary (inclusive)", () => {
    const old1 = makeRecord({ id: "m-old", createdAt: FIXED_NOW_MS - 60_000 });
    const exactly = makeRecord({ id: "m-edge", createdAt: FIXED_NOW_MS - 30_000 });
    const recent = makeRecord({ id: "m-new", createdAt: FIXED_NOW_MS - 1 });
    const got = selectMemoriesForForget(
      [old1, exactly, recent],
      { kind: "by-time-window", scope: userScope("u-1"), olderThanMs: 30_000 },
      { nowMs: FIXED_NOW_MS },
    );
    expect(got.map((r) => r.id).sort()).toEqual(["m-edge", "m-old"]);
  });

  it("rejects a negative olderThanMs", () => {
    expect(() =>
      selectMemoriesForForget(
        [],
        { kind: "by-time-window", scope: userScope("u-1"), olderThanMs: -1 },
        { nowMs: FIXED_NOW_MS },
      ),
    ).toThrow(GovernanceError);
  });

  it("rejects a non-finite olderThanMs", () => {
    expect(() =>
      selectMemoriesForForget(
        [],
        { kind: "by-time-window", scope: userScope("u-1"), olderThanMs: Number.POSITIVE_INFINITY },
        { nowMs: FIXED_NOW_MS },
      ),
    ).toThrow(GovernanceError);
  });
});

describe("selectMemoriesForForget — pin protection", () => {
  it("excludes pinned memories by default", () => {
    const pinned = makeRecord({ id: "m-p", pinned: true });
    const normal = makeRecord({ id: "m-n", pinned: false });
    const got = selectMemoriesForForget(
      [pinned, normal],
      { kind: "by-scope", scope: userScope("u-1") },
      { nowMs: FIXED_NOW_MS },
    );
    expect(got).toEqual([normal]);
  });

  it("includes pinned memories when protectPinned is explicitly false", () => {
    const pinned = makeRecord({ id: "m-p", pinned: true });
    const normal = makeRecord({ id: "m-n", pinned: false });
    const got = selectMemoriesForForget(
      [pinned, normal],
      { kind: "by-scope", scope: userScope("u-1") },
      { nowMs: FIXED_NOW_MS, protectPinned: false },
    );
    expect(got.map((r) => r.id).sort()).toEqual(["m-n", "m-p"]);
  });
});

describe("selectMemoriesForForget — archived/forgotten protection", () => {
  it("includes archived memories by default", () => {
    const archived = makeRecord({ id: "m-a", status: "archived" });
    const got = selectMemoriesForForget(
      [archived],
      { kind: "by-scope", scope: userScope("u-1") },
      { nowMs: FIXED_NOW_MS },
    );
    expect(got).toEqual([archived]);
  });

  it("excludes archived memories when protectArchived is true", () => {
    const archived = makeRecord({ id: "m-a", status: "archived" });
    const got = selectMemoriesForForget(
      [archived],
      { kind: "by-scope", scope: userScope("u-1") },
      { nowMs: FIXED_NOW_MS, protectArchived: true },
    );
    expect(got).toEqual([]);
  });

  it("always excludes already-forgotten memories regardless of options", () => {
    const forgotten = makeRecord({ id: "m-f", status: "forgotten" });
    const got = selectMemoriesForForget(
      [forgotten],
      { kind: "by-scope", scope: userScope("u-1") },
      { nowMs: FIXED_NOW_MS, protectPinned: false, protectArchived: false },
    );
    expect(got).toEqual([]);
  });
});

describe("buildForgetOperations", () => {
  it("maps each selected record to a validated MemoryForget envelope", () => {
    const a = makeRecord({ id: "m-a" });
    const b = makeRecord({ id: "m-b" });
    const envelopes = buildForgetOperations([a, b], ctx(), { writeTombstone: true });
    expect(envelopes).toHaveLength(2);
    for (const env of envelopes) {
      expect(validateMemoryForget(env).ok).toBe(true);
      expect(env.userAcknowledgedDestructive).toBe(true);
      expect(env.schemaVersion).toBe("1");
    }
    expect(must(envelopes[0]).memoryId).toBe(a.id);
    expect(must(envelopes[1]).memoryId).toBe(b.id);
  });

  it("threads the caller-supplied reason onto every envelope", () => {
    const a = makeRecord({ id: "m-a" });
    const envelopes = buildForgetOperations([a], ctx(), {
      writeTombstone: true,
      reason: "GDPR erasure request",
    });
    expect(must(envelopes[0]).reason).toBe("GDPR erasure request");
  });

  it("returns the empty array when given the empty selection", () => {
    expect(buildForgetOperations([], ctx(), { writeTombstone: true })).toEqual([]);
  });
});
