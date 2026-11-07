import { describe, expect, it } from "vitest";
import { createJiraDraftStore } from "./jira-draft-store.js";

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
});
