import { describe, expect, it, vi } from "vitest";

// The response part of a minted call id is random; fixing it here makes the collision branch
// reachable: a provider id that equals the id Keiko would mint must keep its own id.
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, randomBytes: (size: number): Buffer => Buffer.alloc(size, 0xab) };
});

const { parseNormalizedToolCalls } = await import("./normalize.js");

describe("minted call id collisions", () => {
  const call = (id: unknown): unknown => ({
    id,
    type: "function",
    function: { name: "read", arguments: "{}" },
  });

  it("gives a minted id a suffix when a sibling's provider id already holds it", () => {
    const ids = parseNormalizedToolCalls([call(""), call("keiko-call-abababababab-0")]).map(
      (entry) => entry.id,
    );
    expect(ids).toEqual(["keiko-call-abababababab-0-1", "keiko-call-abababababab-0"]);
  });
});
