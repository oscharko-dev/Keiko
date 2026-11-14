// The no-model rehearsal of the Composer lane (#4369): every journey runs with an empty model turn,
// the rehearsal is green only when none stopped on a lab error, leftovers are removed also after a
// failure, and the flag cannot be combined with a model.
import { describe, expect, it, vi } from "vitest";
import {
  EMPTY_TURN,
  NOT_EXERCISED,
  rehearsalContext,
  rehearsalSummary,
  rehearseGroup,
  rehearseJourneys,
  rehearseLane,
} from "../testing/jira-chat-lab/requirements/composer-rehearsal.mjs";
import { COMPOSER_JOURNEY_IDS } from "../testing/jira-chat-lab/requirements/composer.mjs";

describe("the rehearsal's context replaces only the model", () => {
  it("answers every turn with nothing and creates Chats that need no product", async () => {
    const base = { origin: "http://127.0.0.1:1", http: "kept" };
    const ctx = rehearsalContext(base, { types: ["task"] });
    expect(await ctx.turn({}, "Hallo", undefined)).toBe(EMPTY_TURN);
    expect(EMPTY_TURN).toMatchObject({ answer: "", toolExchanges: [], toolCalls: 0 });
    expect(EMPTY_TURN.approvals.writes).toBe(0);
    expect(await ctx.freshChat("governed-assist")).toEqual({
      id: "rehearsal-1",
      mode: "governed-assist",
    });
    expect((await ctx.freshChat("supervised-coding")).id).toBe("rehearsal-2");
    expect(ctx.composerSelection).toEqual({ types: ["task"] });
    // Chats that exist nowhere cannot be read back: no stored message, no read failure.
    expect(await ctx.storedAnswer({ id: "rehearsal-1" })).toBeUndefined();
    expect(await ctx.readStoredConversation({ id: "rehearsal-1" })).toHaveLength(2);
    expect(await ctx.readStoredMessages({ id: "rehearsal-1" })).toEqual([]);
    expect(ctx.http).toBe("kept");
  });
});

describe("running the journeys", () => {
  it("counts a journey that returns as exercised whatever its verdict, and one that throws as failed", async () => {
    const journeys = {
      C01: async () => ({ status: "red" }),
      C02: async () => {
        throw new TypeError("A required field of REQ cannot be filled natively: reporter");
      },
      C03: async () => ({ status: "unverified" }),
    };
    expect(await rehearseJourneys({ ctx: {}, ids: ["C01", "C02", "C03"], journeys })).toEqual([
      { id: "C01", ok: true },
      expect.objectContaining({ id: "C02", ok: false, error: expect.stringContaining("reporter") }),
      { id: "C03", ok: true },
    ]);
  });

  it("covers every Composer journey by default", () => {
    expect(COMPOSER_JOURNEY_IDS).toEqual([
      "C01",
      "C02",
      "C03",
      "C04",
      "C05",
      "C06",
      "C07",
      "C08",
      "C09",
      "C10",
    ]);
  });
});

describe("one product start", () => {
  const live = { origin: "o", cookie: "c" };
  const baseCtx = (found) => ({ search: vi.fn(async () => found) });

  it("keeps the issues that existed, removes the rest and reports how many", async () => {
    const ctx = baseCtx([{ key: "REQ-1" }]);
    const removeLeftovers = vi.fn(async (_session, _ctx, known) => (known.has("REQ-1") ? 3 : -1));
    const outcome = await rehearseGroup({
      session: {},
      ids: ["C01"],
      truth: {},
      ports: {
        withProduct: async ({ run }) => run(live),
        context: () => ctx,
        removeLeftovers,
        journeys: { C01: async () => ({}) },
      },
    });
    expect(outcome).toEqual({ results: [{ id: "C01", ok: true }], removed: 3 });
  });

  it("removes the leftovers also when a journey stopped on a lab error", async () => {
    const removeLeftovers = vi.fn(async () => 2);
    const outcome = await rehearseGroup({
      session: {},
      ids: ["C01"],
      truth: {},
      ports: {
        withProduct: async ({ run }) => run(live),
        context: () => baseCtx([]),
        removeLeftovers,
        journeys: {
          C01: async () => {
            throw new TypeError("template could not be prepared");
          },
        },
      },
    });
    expect(removeLeftovers).toHaveBeenCalledTimes(1);
    expect(outcome.results[0]).toMatchObject({ id: "C01", ok: false });
    expect(outcome.removed).toBe(2);
  });

  it("fails closed when the product never ran its journeys", async () => {
    await expect(
      rehearseGroup({
        session: {},
        ids: ["C01"],
        truth: {},
        ports: { withProduct: async () => undefined },
      }),
    ).rejects.toThrow("never ran");
  });
});

describe("the summary", () => {
  const group = (results, removed = 0) => ({ results, removed });

  it("is green only when every selected journey was exercised and none failed", () => {
    const ok = rehearsalSummary(
      [
        group(
          [
            { id: "C01", ok: true },
            { id: "C02", ok: true },
          ],
          4,
        ),
      ],
      ["C01", "C02"],
    );
    expect(ok).toMatchObject({ passed: true, exercised: ["C01", "C02"], removedLeftovers: 4 });
    const failed = rehearsalSummary([group([{ id: "C01", ok: false, error: "x" }])], ["C01"]);
    expect(failed.passed).toBe(false);
    expect(failed.failed).toEqual([{ id: "C01", error: "x" }]);
    // A journey that never ran at all is not a pass.
    expect(rehearsalSummary([group([{ id: "C01", ok: true }])], ["C01", "C02"]).passed).toBe(false);
  });

  it("always states what it could not exercise", () => {
    const summary = rehearsalSummary([group([])], []);
    expect(summary.notExercised).toBe(NOT_EXERCISED);
    expect(NOT_EXERCISED.join(" ")).toContain("model turn");
  });
});

describe("the whole rehearsal groups like a real run", () => {
  it("starts C03 and C04 in a product without the baseline set and the others with it", async () => {
    const baselineAtStart = [];
    const env = {};
    const summary = await rehearseLane({
      session: {},
      ids: ["C01", "C03", "C07"],
      truth: {
        projects: { work: "REQ", report: "RPT" },
        fieldIds: { epicName: "a", epicLink: "b", storyPoints: "c" },
      },
      ports: {
        env,
        withProduct: async ({ run }) => {
          baselineAtStart.push(env.KEIKO_JIRA_LAB_BASELINE_TEMPLATES ?? "default");
          return run({});
        },
        context: (_live, _session, truth) => ({
          truth,
          search: async () => [],
        }),
        removeLeftovers: async () => 0,
        journeys: { C01: async () => ({}), C03: async () => ({}), C07: async () => ({}) },
      },
    });
    expect(baselineAtStart).toEqual(["default", "off"]);
    expect(summary).toMatchObject({ passed: true, exercised: ["C01", "C07", "C03"] });
    expect(env.KEIKO_JIRA_LAB_BASELINE_TEMPLATES).toBeUndefined();
  });
});
