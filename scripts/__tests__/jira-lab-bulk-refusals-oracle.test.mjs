// gradeBulkRefusals grades a bulk Jira run from native state only (#4287, #4321).
import { describe, expect, it } from "vitest";
import { gradeBulkRefusals } from "../testing/jira-chat-lab/rules-knowledge-oracles.mjs";

const IDS = ["LH-001", "LH-002", "LH-003", "LH-004"];
const TRUTH = { requirements: IDS.map((id) => ({ id })) };
const issue = (id, n) => ({
  id: String(n),
  key: `LIM1-${n}`,
  fields: { summary: `[${id}] Title` },
});

function context(createdIds, overrides = {}) {
  return {
    projectKey: "LIM1",
    truth: TRUTH,
    search: async () => createdIds.map((id, index) => issue(id, index + 1)),
    ...overrides,
  };
}

const SEEDED = [
  { requirementId: "LH-002", ruleId: "summary-pattern" },
  { requirementId: "LH-004", ruleId: "section-missing" },
];

describe("gradeBulkRefusals", () => {
  it("is green when every seeded requirement is refused and all others exist", async () => {
    const result = await gradeBulkRefusals(context(["LH-001", "LH-003"]), { seeded: SEEDED });
    expect(result).toMatchObject({
      step: "ac1-bulk-refusals",
      status: "green",
      counts: {
        seededCount: 2,
        refusedCount: 2,
        wronglyCreatedCount: 0,
        wronglyRefusedCount: 0,
      },
    });
  });

  it("is red when a seeded requirement was created", async () => {
    const result = await gradeBulkRefusals(context(["LH-001", "LH-002", "LH-003"]), {
      seeded: SEEDED,
    });
    expect(result.status).toBe("red");
    expect(result.counts).toMatchObject({ refusedCount: 1, wronglyCreatedCount: 1 });
  });

  it("is red when a non-seeded requirement is missing", async () => {
    const result = await gradeBulkRefusals(context(["LH-001"]), { seeded: SEEDED });
    expect(result.status).toBe("red");
    expect(result.counts).toMatchObject({ wronglyRefusedCount: 1, wronglyCreatedCount: 0 });
  });

  it("is unverified when native state cannot be read", async () => {
    const ctx = context([], {
      search: async () => {
        throw new Error("unreachable");
      },
    });
    const result = await gradeBulkRefusals(ctx, { seeded: SEEDED });
    expect(result.status).toBe("unverified");
    expect(result.counts.seededCount).toBe(2);
  });

  it("is unverified when the native answer is not a list", async () => {
    const result = await gradeBulkRefusals(context([], { search: async () => ({}) }), {
      seeded: SEEDED,
    });
    expect(result.status).toBe("unverified");
  });

  it("never passes an empty seeded list", async () => {
    expect((await gradeBulkRefusals(context(IDS), { seeded: [] })).status).toBe("unverified");
  });

  it.each([
    ["undefined", undefined],
    ["not an array", { requirementId: "LH-002", ruleId: "x" }],
    ["unknown requirement", [{ requirementId: "LH-999", ruleId: "summary-pattern" }]],
    ["missing rule", [{ requirementId: "LH-002" }]],
    [
      "duplicate requirement",
      [
        { requirementId: "LH-002", ruleId: "a" },
        { requirementId: "LH-002", ruleId: "b" },
      ],
    ],
    ["null entry", [null]],
  ])("is unverified for malformed input: %s", async (_name, seeded) => {
    const result = await gradeBulkRefusals(context(["LH-001", "LH-003"]), { seeded });
    expect(result.status).toBe("unverified");
  });

  it("ignores issues that do not claim a known requirement and carries no text", async () => {
    const ctx = context([], {
      search: async () => [
        { id: "1", fields: { summary: "[LH-001] A", description: "secret body" } },
        { id: "2", fields: { summary: "[LH-003] B" } },
        { id: "3", fields: { summary: "Unrelated" } },
        { id: "4", fields: { summary: "[ZZ-9] Foreign" } },
      ],
    });
    const result = await gradeBulkRefusals(ctx, { seeded: SEEDED });
    expect(result.status).toBe("green");
    expect(JSON.stringify(result)).not.toContain("secret body");
  });
});
