import { describe, expect, it } from "vitest";
import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security";
import {
  createJiraDraftStore,
  jiraDraftDigest,
  type JiraDraftSourceBinding,
} from "./jira-draft-store.js";

const ITEM = {
  ref: "source",
  fields: { summary: "A", description: "Source revision A", labels: ["source-a"] },
};
const BINDING = { ref: "source", sourceDigest: "a".repeat(64) };

describe("staged Jira source bindings", () => {
  it("commits the full private revision even when the rendered items stay equal", () => {
    const store = createJiraDraftStore();
    const first = store.append("owner", undefined, "connection", [ITEM], [BINDING]);
    const revised = { ...BINDING, sourceDigest: "b".repeat(64) };
    const second = store.append("owner", undefined, "connection", [ITEM], [revised]);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error("expected staged drafts");
    expect(first.draft.digest).toBe(
      sha256Hex(canonicalise({ items: [ITEM], sourceBindings: [BINDING] })),
    );
    expect(first.draft.digest).not.toBe(second.draft.digest);
  });

  it("retains the legacy digest when no source binding is present", () => {
    const expected = sha256Hex(canonicalise({ items: [ITEM] }));
    expect(jiraDraftDigest([ITEM])).toBe(expected);
    expect(jiraDraftDigest([ITEM], [])).toBe(expected);
  });

  it("clones and deeply freezes both staged payload and private binding", () => {
    const item = structuredClone(ITEM);
    const binding = { ...BINDING };
    const staged = createJiraDraftStore().append(
      "owner",
      undefined,
      "connection",
      [item],
      [binding],
    );
    if (!staged.ok) throw new Error("expected staged draft");
    item.fields.description = "Changed outside the store";
    item.fields.labels.push("changed");
    binding.sourceDigest = "b".repeat(64);
    expect(staged.draft.items).toEqual([ITEM]);
    expect(staged.draft.sourceBindings).toEqual([BINDING]);
    expect(Object.isFrozen(staged.draft.items[0]?.fields)).toBe(true);
    expect(Object.isFrozen(staged.draft.sourceBindings?.[0])).toBe(true);
  });

  it("includes source binding bytes in the existing draft limit", () => {
    const store = createJiraDraftStore({ maxDraftBytes: Buffer.byteLength(canonicalise(ITEM)) });
    expect(store.append("owner", undefined, "connection", [ITEM]).ok).toBe(true);
    expect(store.append("owner", undefined, "connection", [ITEM], [BINDING])).toEqual({
      ok: false,
      refusal: "too-large",
    });
  });

  it.each([
    [{ ref: "unknown", sourceDigest: "a".repeat(64) }],
    [{ ...BINDING, sourceDigest: "short" }],
    [{ ...BINDING, unexpected: "value" }],
    [BINDING, BINDING],
  ])("rejects malformed or unowned binding %j without changing the store", (...bindings) => {
    const store = createJiraDraftStore();
    expect(
      store.append("owner", undefined, "connection", [ITEM], bindings as JiraDraftSourceBinding[]),
    ).toEqual({ ok: false, refusal: "invalid-input" });
    expect(store.size()).toBe(0);
  });

  it("retains earlier page bindings and binds every appended page", () => {
    const store = createJiraDraftStore();
    const first = store.append("owner", undefined, "connection", [ITEM], [BINDING]);
    if (!first.ok) throw new Error("expected staged draft");
    const nextItem = { ...ITEM, ref: "next" };
    const nextBinding = { ref: "next", sourceDigest: "b".repeat(64) };
    const second = store.append("owner", first.draft.id, "connection", [nextItem], [nextBinding]);
    if (!second.ok) throw new Error("expected appended draft");
    expect(second.draft.sourceBindings).toEqual([BINDING, nextBinding]);
    expect(second.draft.digest).toBe(
      sha256Hex(canonicalise({ items: [ITEM, nextItem], sourceBindings: [BINDING, nextBinding] })),
    );
    expect(first.draft.items).toEqual([ITEM]);
  });
});

const item = (ref: string): Record<string, unknown> => ({ ref, summary: `Item ${ref}` });

describe("the owner's latest draft", () => {
  it("names the owner's most recently used draft without renewing it", () => {
    let clock = 1_000;
    let next = 0;
    const store = createJiraDraftStore({
      now: () => clock,
      newId: () => `draft-${String((next += 1))}`,
      idleTtlMs: 100,
    });
    expect(store.latest("chat-1")).toBeUndefined();
    store.append("chat-1", undefined, "fp", [item("a")]);
    clock += 10;
    store.append("chat-1", undefined, "fp", [item("b")]);
    clock += 10;
    store.append("chat-2", undefined, "fp", [item("c")]);

    expect(store.latest("chat-1")?.id).toBe("draft-2");
    expect(store.latest("chat-2")?.id).toBe("draft-3");
    clock += 10;
    store.get("draft-1", "chat-1");
    expect(store.latest("chat-1")?.id).toBe("draft-1");

    // Naming a draft is no use of it: it still expires when nobody uses it.
    const usedAt = clock;
    clock = usedAt + 90;
    expect(store.latest("chat-1")?.lastUsedAt).toBe(usedAt);
    clock = usedAt + 101;
    expect(store.latest("chat-1")).toBeUndefined();
  });

  it("stops naming a draft whose committed revision settled, until it changes again", () => {
    let clock = 1_000;
    let next = 0;
    const store = createJiraDraftStore({
      now: () => clock,
      newId: () => `draft-${String((next += 1))}`,
    });
    store.append("chat-1", undefined, "fp", [item("a")]);
    clock += 10;
    const second = store.append("chat-1", undefined, "fp", [item("b")]);
    if (!second.ok) throw new TypeError("Expected the second draft");

    store.complete("draft-2", "chat-1", "0".repeat(64));
    store.complete("draft-2", "chat-2", second.draft.digest);
    expect(store.latest("chat-1")?.id).toBe("draft-2");

    store.complete("draft-2", "chat-1", second.draft.digest);
    expect(store.latest("chat-1")?.id).toBe("draft-1");
    // The finished draft itself stays readable for a rerun that only reconciles it.
    expect(store.get("draft-2", "chat-1")?.digest).toBe(second.draft.digest);

    clock += 10;
    const grown = store.append("chat-1", "draft-2", "fp", [item("c")]);
    if (!grown.ok) throw new TypeError("Expected the grown draft");
    expect(store.latest("chat-1")?.id).toBe("draft-2");
  });
});
