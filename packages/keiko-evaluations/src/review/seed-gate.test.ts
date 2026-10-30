// AC4 (Issue #4132): the seed gate fails when any required seed is missed or stale, reports each
// seed's outcome, counts false alarms on clean controls separately, and passes with a scripted
// model that finds every required seed. The scripted model is the package's own offline provider.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { ReviewSeedFixture } from "@oscharko-dev/keiko-contracts";

import { KEIKO_CONSUMER_SEEDS, type ReviewConsumerSeed } from "./consumer-seeds.js";
import { renderReviewSeedGate } from "./render.js";
import {
  assertConsumerSeeds,
  plantConsumerSeed,
  ReviewSeedDefinitionError,
  runReviewSeedGate,
  type ReviewSeedGateOptions,
} from "./seed-gate.js";
import { finding, reviewResponse, scriptedSeedPort } from "./_support.js";

const REPOSITORY_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../..");

const defect: ReviewSeedFixture = {
  seed: {
    id: "defect",
    seedClass: "security",
    required: true,
    cleanControl: false,
    expected: { file: "src/a.ts", startLine: 3, endLine: 4 },
  },
  scope: "repository",
  baseFiles: { "src/a.ts": "a\n" },
  headFiles: { "src/a.ts": "b\n" },
};

const advisory: ReviewSeedFixture = {
  ...defect,
  seed: { ...defect.seed, id: "advisory", required: false },
};

const control: ReviewSeedFixture = {
  seed: { id: "control", seedClass: "maintainability", required: false, cleanControl: true },
  scope: "repository",
  baseFiles: { "src/c.ts": "x\n" },
  headFiles: { "src/c.ts": "y\n" },
};

const consumerFile = "lib/guard.ts";
const consumerContent =
  "export function allowed(user) {\n  if (!user.admin) return false;\n  return true;\n}\n";
const consumerSeed: ReviewConsumerSeed = {
  id: "consumer-guard",
  tier: 1,
  measurement: false,
  required: true,
  seedClass: "security",
  file: consumerFile,
  find: "  if (!user.admin) return false;\n",
  replace: "  if (user.admin) return false;\n",
  rationale: "Inverts the admin check.",
};

const atDefect = finding({ file: "src/a.ts", startLine: 4, endLine: 4 });
const atConsumer = finding({ file: consumerFile, startLine: 2, endLine: 2 });

function options(
  answers: Readonly<Record<string, ReturnType<typeof finding>[]>>,
  overrides: Partial<ReviewSeedGateOptions> = {},
): ReviewSeedGateOptions {
  return {
    fixtures: [defect, advisory, control],
    consumerSeeds: {
      seeds: [consumerSeed],
      readFile: (path) => (path === consumerFile ? consumerContent : undefined),
    },
    port: scriptedSeedPort(),
    model: {
      mode: "offline",
      modelId: "scripted-reviewer",
      transcripts: new Map(
        ["defect", "advisory", "control", "consumer-guard"].map((id) => [
          id,
          [reviewResponse(answers[id] ?? [])],
        ]),
      ),
    },
    now: () => 0,
    ...overrides,
  };
}

const findsEverything = { defect: [atDefect], "consumer-guard": [atConsumer] };

describe("runReviewSeedGate", () => {
  it("passes with a scripted model that finds every required seed", async () => {
    const report = await runReviewSeedGate(options(findsEverything));
    expect(report.verdict).toBe("pass");
    expect(report.score).toMatchObject({ requiredCount: 2, requiredFound: 2, falseAlarms: 0 });
    expect(report.cases.map((entry) => [entry.id, entry.outcome])).toEqual([
      ["defect", "found"],
      ["advisory", "missed"],
      ["control", "clean"],
      ["consumer-guard", "found"],
    ]);
  });

  it("fails when a required seed is missed and names it", async () => {
    const report = await runReviewSeedGate(options({ "consumer-guard": [atConsumer] }));
    expect(report.verdict).toBe("fail");
    expect(report.requiredFailures).toEqual(["defect"]);
    expect(report.reasons).toContain("required seed defect was missed");
  });

  it("fails when a consumer seed is stale because its find text no longer matches", async () => {
    const report = await runReviewSeedGate(
      options(findsEverything, {
        consumerSeeds: {
          seeds: [consumerSeed],
          readFile: () => consumerContent.replace("!user.admin", "!user.isAdmin"),
        },
      }),
    );
    expect(report.verdict).toBe("fail");
    expect(report.staleSeeds).toEqual(["consumer-guard"]);
    expect(report.cases.find((entry) => entry.id === "consumer-guard")).toMatchObject({
      outcome: "stale-seed",
      staleReason: "find-missing",
    });
    expect(report.reasons).toContain("seed consumer-guard is stale and must be recalibrated");
  });

  it("blocks on a stale advisory seed too — a stale seed is never skipped", async () => {
    const report = await runReviewSeedGate(
      options(findsEverything, {
        consumerSeeds: {
          seeds: [
            consumerSeed,
            {
              ...consumerSeed,
              id: "measured",
              tier: 2,
              measurement: true,
              required: false,
              find: "absent",
            },
          ],
          readFile: () => consumerContent,
        },
      }),
    );
    expect(report.verdict).toBe("fail");
    expect(report.staleSeeds).toEqual(["measured"]);
  });

  it("fails a required seed whose run went stale on a moved head", async () => {
    const report = await runReviewSeedGate(
      options(findsEverything, { port: scriptedSeedPort({ headMoved: true }) }),
    );
    expect(report.verdict).toBe("fail");
    expect(report.cases.find((entry) => entry.id === "defect")?.outcome).toBe("stale-run");
  });

  it("never counts a finding from an incomplete run as found", async () => {
    const report = await runReviewSeedGate(
      options(findsEverything, { port: scriptedSeedPort({ settlement: "incomplete" }) }),
    );
    expect(report.verdict).toBe("fail");
    expect(report.cases.find((entry) => entry.id === "defect")?.outcome).toBe("incomplete");
  });

  it("counts false alarms on clean controls separately from the recall verdict", async () => {
    const report = await runReviewSeedGate(
      options({
        ...findsEverything,
        control: [
          finding({ file: "src/c.ts", startLine: 1, endLine: 1 }),
          finding({ file: "src/c.ts", startLine: 1, endLine: 1 }),
        ],
      }),
    );
    expect(report.verdict).toBe("pass");
    expect(report.cleanControlFalseAlarms).toBe(2);
    expect(report.cases.find((entry) => entry.id === "control")).toMatchObject({
      outcome: "false-alarm",
      falseAlarms: 2,
    });
  });

  it("is unmeasured when no required seed ran", async () => {
    const report = await runReviewSeedGate(
      options({}, { fixtures: [control], consumerSeeds: undefined }),
    );
    expect(report.verdict).toBe("unmeasured");
  });

  it("meters each seed's cost from the scripted model", async () => {
    const report = await runReviewSeedGate(options(findsEverything));
    expect(report.cases[0]?.cost).toEqual({
      modelCalls: 1,
      inputTokens: 100,
      outputTokens: 20,
      wallTimeMs: 0,
    });
  });

  it("renders every seed's outcome", async () => {
    const text = renderReviewSeedGate(await runReviewSeedGate(options(findsEverything)));
    expect(text).toContain("- Verdict: pass");
    expect(text).toContain("| consumer-guard | required | found | 1 | 0 |");
    expect(text).toContain("| control | clean control | clean | 0 | 0 |");
    expect(text).toContain("| advisory | advisory | missed | 0 | 0 |");
  });
});

describe("plantConsumerSeed", () => {
  it("plants the replacement and expects a finding on its lines", () => {
    const planted = plantConsumerSeed(consumerSeed, consumerContent);
    expect(planted).toMatchObject({
      kind: "planted",
      fixture: {
        scope: "overlay",
        seed: {
          id: "consumer-guard",
          required: true,
          expected: { file: consumerFile, startLine: 2, endLine: 2 },
        },
        baseFiles: { [consumerFile]: consumerContent },
        headFiles: { [consumerFile]: consumerContent.replace("!user.admin", "user.admin") },
      },
    });
  });

  it.each([
    [undefined, "file-missing"],
    ["unrelated\n", "find-missing"],
    [consumerContent + consumerContent, "find-ambiguous"],
  ])("reports a seed stale when the file content is %j", (content, reason) => {
    expect(plantConsumerSeed(consumerSeed, content)).toMatchObject({ kind: "stale", reason });
  });
});

describe("Keiko consumer seeds", () => {
  it("follow the tier rules", () => {
    expect(() => {
      assertConsumerSeeds(KEIKO_CONSUMER_SEEDS);
    }).not.toThrow();
    const required = KEIKO_CONSUMER_SEEDS.filter((seed) => seed.required);
    expect(required.some((seed) => seed.tier === 1)).toBe(true);
    expect(required.some((seed) => seed.tier === 2)).toBe(true);
    expect(KEIKO_CONSUMER_SEEDS.some((seed) => seed.measurement && !seed.required)).toBe(true);
  });

  // A refactor of a seeded Keiko file lands here first: recalibrate the seed's `find` in the same
  // change, deliberately, rather than letting the gate discover a stale seed later.
  it.each(KEIKO_CONSUMER_SEEDS.map((seed) => [seed.id, seed] as const))(
    "%s still plants into the current Keiko file",
    (_id, seed) => {
      const content = readFileSync(join(REPOSITORY_ROOT, seed.file), "utf8");
      expect(plantConsumerSeed(seed, content).kind).toBe("planted");
    },
  );

  it.each([
    [{ tier: 1, required: false }, "a tier-1 seed is required"],
    [{ tier: 1, demotion: { date: "2026-10-30", evidence: "run" } }, "a tier-1 seed is required"],
    [{ tier: 2, required: false }, "tier 2 needs a demotion to be advisory"],
    [
      { tier: 2, required: true, demotion: { date: "2026-10-30", evidence: "run" } },
      "a demoted seed is advisory",
    ],
    [{ tier: 2, required: false, demotion: { date: "30.10.2026", evidence: "run" } }, "YYYY-MM-DD"],
    [{ tier: 2, required: false, demotion: { date: "2026-10-30", evidence: " " } }, "YYYY-MM-DD"],
    [{ measurement: true, required: true }, "advisory by design"],
    [{ replace: consumerSeed.find }, "nothing is planted"],
    [{ rationale: "" }, "non-empty"],
  ] as const)("rejects the definition %j", (change, message) => {
    expect(() => {
      assertConsumerSeeds([{ ...consumerSeed, ...change }]);
    }).toThrow(message);
  });

  it("accepts a dated tier-2 demotion and rejects duplicate ids", () => {
    const demoted: ReviewConsumerSeed = {
      ...consumerSeed,
      tier: 2,
      required: false,
      demotion: { date: "2026-10-30", evidence: "seed-gate run 2026-10-30 missed it twice" },
    };
    expect(() => {
      assertConsumerSeeds([demoted]);
    }).not.toThrow();
    expect(() => {
      assertConsumerSeeds([consumerSeed, consumerSeed]);
    }).toThrow(ReviewSeedDefinitionError);
  });
});
