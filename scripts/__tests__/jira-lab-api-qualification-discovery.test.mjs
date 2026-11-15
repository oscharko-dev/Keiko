// The discover -> describe -> dispatch proof of the API qualification (#4357 AC2): pure over a fake
// dispatcher, so every refusal of the proof is shown without a Jira.
import { describe, expect, it } from "vitest";
import {
  DISCOVERY_QUERIES,
  proveDiscovery,
} from "../testing/jira-chat-lab/api-qualification-discovery.mjs";

const SPEC = { tool: "jira.priorities", identity: "GET /rest/api/2/priority" };
const hit = (identity) => ({ identity, tool: "jira.x", description: "d" });

/** A fake product: discover returns `pages` of items, describe returns what `describeAs` says. */
function product({ pages, describeAs } = {}) {
  const calls = [];
  const call = async (name, args) => {
    calls.push([name, args]);
    if (name === "jira.discover") {
      const startAt = args.startAt ?? 0;
      const page = pages[startAt === 0 ? 0 : startAt];
      return {
        outcome: "succeeded",
        items: page.items,
        ...(page.next === undefined ? {} : { nextStartAt: page.next }),
      };
    }
    return (
      describeAs ?? { outcome: "succeeded", selectedFor: "next-round", items: [hit(SPEC.identity)] }
    );
  };
  return { call, calls };
}

describe("the discovery proof", () => {
  it("asks in plain operation words, describes by the identity discover returned and records its rank", async () => {
    const { call, calls } = product({
      pages: { 0: { items: [hit("GET /other"), hit(SPEC.identity)] } },
    });
    const proof = await proveDiscovery(SPEC, call);
    expect(proof).toMatchObject({
      tool: "jira.priorities",
      query: "priorities",
      discoveredAtRank: 2,
      describedBy: "identity",
      selectedFor: "next-round",
    });
    expect(calls.map(([name]) => name)).toEqual(["jira.discover", "jira.describe"]);
    expect(calls[1][1]).toEqual({ identities: [SPEC.identity] });
    // The query is words, never a tool name or a path.
    expect(calls[0][1].query).not.toMatch(/[./_]/u);
  });

  it("pages on when the operation is not on the first page, and stops after the bound", async () => {
    const paged = product({
      pages: { 0: { items: [hit("GET /a")], next: 1 }, 1: { items: [hit(SPEC.identity)] } },
    });
    expect((await proveDiscovery(SPEC, paged.call)).discoveredAtRank).toBe(2);
    const never = product({
      pages: {
        0: { items: [hit("GET /a")], next: 1 },
        1: { items: [hit("GET /b")], next: 2 },
        2: { items: [hit("GET /c")], next: 3 },
        3: { items: [hit(SPEC.identity)] },
      },
    });
    await expect(proveDiscovery(SPEC, never.call)).rejects.toThrow("did not list jira.priorities");
  });

  it("refuses an operation discover does not list, a failed describe and a replaced selection", async () => {
    await expect(
      proveDiscovery(SPEC, product({ pages: { 0: { items: [hit("GET /a")] } } }).call),
    ).rejects.toThrow("did not list");
    const listed = { 0: { items: [hit(SPEC.identity)] } };
    await expect(
      proveDiscovery(SPEC, product({ pages: listed, describeAs: { outcome: "failed" } }).call),
    ).rejects.toThrow("describe did not succeed");
    await expect(
      proveDiscovery(
        SPEC,
        product({
          pages: listed,
          describeAs: {
            outcome: "succeeded",
            selectedFor: "next-round",
            items: [hit(SPEC.identity)],
            deselected: [hit("GET /x")],
          },
        }).call,
      ),
    ).rejects.toThrow("replaced an earlier selection");
    await expect(
      proveDiscovery(
        SPEC,
        product({
          pages: listed,
          describeAs: { outcome: "succeeded", selectedFor: "next-round", items: [] },
        }).call,
      ),
    ).rejects.toThrow("did not select");
  });

  it("holds a plain-word query for each of the eleven everyday operations and refuses an undeclared one", async () => {
    expect(Object.keys(DISCOVERY_QUERIES)).toHaveLength(11);
    for (const query of Object.values(DISCOVERY_QUERIES)) expect(query).toMatch(/^[a-z ]+$/iu);
    await expect(
      proveDiscovery({ tool: "jira.delete-everything", identity: "x" }, async () => ({})),
    ).rejects.toThrow("No discovery query is declared");
  });
});
