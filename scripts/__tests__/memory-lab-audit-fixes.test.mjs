// Audit fixes of the lab infrastructure (#4207): each rule below failed before its fix.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compareRuns, judgeProgress, renderComparison } from "../testing/memory-lab/compare.mjs";
import { HoldoutError, sealHoldout } from "../testing/memory-lab/corpus/holdout.mjs";
import { unitFailures } from "../testing/memory-lab/failure-classes.mjs";
import { normalizeOptions } from "../testing/memory-lab/run.mjs";
import { validateScenario } from "../testing/memory-lab/scenario.mjs";
import { scoreProbe } from "../testing/memory-lab/score.mjs";
import { planSeed } from "../testing/memory-lab/seed-plan.mjs";

const NOW = Date.parse("2026-11-19T12:00:00Z");

function scenario(overrides = {}) {
  return {
    schemaVersion: 1,
    id: "audit-fixture-en",
    language: "en",
    class: "update",
    difficulty: "plain",
    description: "Audit fixture.",
    truth: [{ key: "now", seed: "Rosa wants Markdown.", must: false, terms: [["Markdown"]] }],
    superseded: [{ key: "before", terms: [["PDF"]] }],
    turns: [{ user: "Hello." }],
    probes: [
      { id: "before", question: "Before?", expect: { kind: "answer", earlier: ["before"] } },
    ],
    ...overrides,
  };
}

describe("a form never proves a needed or earlier fact", () => {
  const table = "| a | b |\n| --- | --- |\n| 1 | 2 |";
  it("is refused by the validator", () => {
    const probe = {
      id: "p",
      question: "Q?",
      expect: { kind: "answer", needs: ["now"], format: "table" },
    };
    expect(() => validateScenario(scenario({ probes: [probe] }))).toThrow(
      "format cannot be combined with needs or earlier",
    );
    const earlier = {
      id: "p",
      question: "Q?",
      expect: { kind: "answer", earlier: ["before"], format: "list" },
    };
    expect(() => validateScenario(scenario({ probes: [earlier] }))).toThrow(
      "format cannot be combined",
    );
  });

  it("does not let a table pass a needs probe in the scorer", () => {
    const probe = {
      id: "p",
      question: "Q?",
      expect: { kind: "answer", needs: ["now"], format: "table" },
    };
    const shaped = scenario({ probes: [probe] });
    const result = scoreProbe(shaped, probe, table, []);
    expect(result.passed).toBe(false);
    expect(result.termsPresent).toBe(false);
  });
});

describe("an earlier probe cannot be passed by the current value", () => {
  const refused = (overrides, message) =>
    expect(() => validateScenario(scenario(overrides))).toThrow(message);

  it("refuses a replaced term that occurs in a truth seed", () => {
    refused(
      {
        truth: [
          { key: "now", seed: "Rosa wants Markdown, not PDF.", must: false, terms: [["Markdown"]] },
        ],
      },
      'replaced term "PDF" also occurs in the current value',
    );
  });

  it("refuses a replaced term in the body of a seeded truth-linked record", () => {
    refused(
      {
        seed: {
          records: [
            {
              key: "r",
              body: "Rosa wants Markdown instead of PDF.",
              type: "preference",
              status: "accepted",
              ageDays: 3,
              truth: "now",
            },
          ],
        },
      },
      "also occurs in the current value",
    );
  });

  it("refuses an overlap with the probe's own current terms, in either direction, stems included", () => {
    const withTerms = (terms) => [
      { id: "p", question: "Q?", expect: { kind: "answer", earlier: ["before"], terms } },
    ];
    refused({ probes: withTerms([["PDF"]]) }, "also occurs in the current value");
    refused(
      { superseded: [{ key: "before", terms: [["PDF*"]] }], probes: withTerms([["PDFs"]]) },
      "also occurs in the current value",
    );
    refused(
      { superseded: [{ key: "before", terms: [["PDFs"]] }], probes: withTerms([["PDF*"]]) },
      "also occurs in the current value",
    );
  });

  it("accepts a clean pair", () => {
    expect(validateScenario(scenario()).probes).toHaveLength(1);
  });
});

describe("a seeded truth link", () => {
  it("needs an accepted record: a superseded one is linked with earlier", () => {
    const seed = {
      records: [
        {
          key: "old",
          body: "Rosa wanted a PDF.",
          type: "preference",
          status: "superseded",
          ageDays: 9,
          truth: "now",
        },
      ],
    };
    expect(() => validateScenario(scenario({ seed, probes: [] }))).toThrow(
      "truth needs status accepted",
    );
  });
});

describe("what a seeded record looks like to the product", () => {
  const record = (patch) => ({
    key: "r",
    body: "Rosa uses Markdown.",
    type: "semantic-fact",
    status: "accepted",
    ageDays: 5,
    ...patch,
  });
  const plan = (records, filler) =>
    planSeed({ records, filler }, { nowMs: NOW, projectId: "/p" }).records;

  it("is written as a learned routine fact by default", () => {
    const [learned] = plan([record({})]);
    expect(learned.provenance).toMatchObject({
      sourceKind: "system-default",
      confidence: 0.85,
      sensitivity: "public",
      evidenceSpan: "Rosa uses Markdown.",
    });
    expect(learned.retentionHint).toBeUndefined();
  });

  it("is written as an explicit statement when it says so, and carries the standing mark when asked", () => {
    const [stated] = plan([record({ origin: "stated" })]);
    expect(stated.provenance).toMatchObject({
      sourceKind: "explicit-user-instruction",
      confidence: 1,
    });
    expect(stated.provenance.evidenceSpan).toBeUndefined();
    const [standing] = plan([record({ standing: true })]);
    expect(standing.retentionHint).toEqual({ policyKey: "standing" });
  });

  it("writes filler as learned too, and validates the origin", () => {
    const [filler] = plan(
      [],
      [{ count: 1, status: "accepted", minAgeDays: 1, maxAgeDays: 2, seed: 1 }],
    );
    expect(filler.provenance.sourceKind).toBe("system-default");
    expect(() =>
      validateScenario(
        scenario({ seed: { records: [record({ origin: "guessed" })] }, probes: [] }),
      ),
    ).toThrow("origin must be one of");
    expect(() =>
      validateScenario(
        scenario({ seed: { records: [record({ origin: "stated", standing: true })] }, probes: [] }),
      ),
    ).toThrow("belong to a learned record");
  });
});

describe("a seed in a real-conversation scenario or a sealed holdout", () => {
  let directory;
  afterEach(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  });

  const seeded = {
    filler: [{ count: 1, status: "accepted", minAgeDays: 1, maxAgeDays: 2, seed: 1 }],
  };

  it("is refused for an anchor class", () => {
    expect(() =>
      validateScenario(scenario({ class: "anchor-real", seed: seeded, probes: [] })),
    ).toThrow("cannot carry a seed");
  });

  it("is refused when a holdout is sealed", () => {
    directory = mkdtempSync(join(tmpdir(), "memory-lab-holdout-seed-"));
    const scenarios = join(directory, "scenarios");
    mkdirSync(scenarios);
    writeFileSync(
      join(scenarios, "audit-fixture-en.json"),
      JSON.stringify(
        scenario({
          seed: seeded,
          probes: [{ id: "p", question: "Q?", expect: { kind: "no-memory" } }],
        }),
      ),
    );
    expect(() =>
      sealHoldout({
        scenarios,
        out: join(directory, "holdout.sealed"),
        keyFile: join(directory, "key"),
      }),
    ).toThrow(HoldoutError);
  });
});

function store(overrides = {}) {
  return {
    missing: [],
    verdicts: [],
    counters: { "private-in-project": 0 },
    ...overrides,
  };
}

function unit(overrides = {}) {
  return {
    scenario: "s",
    arm: "product",
    repetition: 0,
    store: store(),
    probes: [],
    ...overrides,
  };
}

// The class a failed answer probe has, most specific first: spelled out here, not derived by the
// code under test.
function expectedAnswerClass({ forbidden, supplied, needed }) {
  if (forbidden) return "forbidden-term-in-answer";
  if (needed) return "needed-memory-missing";
  return supplied ? "supplied-answer-wrong" : "relevant-memory-not-supplied";
}

describe("failure classes are exhaustive and unambiguous", () => {
  const classes = (result) => unitFailures(result).map((failure) => failure.class);

  it("names a private fact in project scope", () => {
    expect(classes(unit({ store: store({ counters: { "private-in-project": 2 } }) }))).toEqual([
      "private-in-project",
      "private-in-project",
    ]);
  });

  it("names a truth stored but parked, apart from one never stored", () => {
    const verdicts = [{ id: "1", status: "proposed", verdict: "correct", key: "a" }];
    expect(classes(unit({ store: store({ missing: ["a", "b"], verdicts }) }))).toEqual([
      "fact-parked",
      "fact-not-stored",
    ]);
  });

  it("classes an abstention that fails and leaks as the leak", () => {
    const probe = { id: "a", kind: "abstain", passed: false, abstained: false, leaked: true };
    expect(classes(unit({ probes: [probe] }))).toEqual(["fact-leaked"]);
  });

  it("keeps several wrong records of one class apart, by ordinal and never by body", () => {
    const verdicts = [
      { id: "x", status: "accepted", verdict: "stale", body: "secret body" },
      { id: "y", status: "accepted", verdict: "stale" },
    ];
    const refs = unitFailures(unit({ store: store({ verdicts }) })).map((failure) => failure.ref);
    expect(refs).toEqual(["store:stale-fact-live:1", "store:stale-fact-live:2"]);
    expect(refs.join()).not.toContain("secret");
  });

  it("names a seeded record that was live and is gone", () => {
    const seed = { after: { lostIndexes: [0, 3] } };
    expect(classes(unit({ seed }))).toEqual(["seeded-record-lost", "seeded-record-lost"]);
  });

  it("gives every failed check exactly one class and a passed check none, over every combination", () => {
    const flags = [false, true];
    let checked = 0;
    for (const passed of flags)
      for (const a of flags)
        for (const b of flags)
          for (const c of flags) {
            const probes = [
              {
                id: "1",
                kind: "answer",
                passed,
                forbiddenPresent: a,
                relevantSupplied: b,
                neededNotSupplied: c ? ["k"] : [],
              },
              { id: "2", kind: "abstain", passed, abstained: a, leaked: b },
              { id: "3", kind: "no-memory", passed, overApplied: a },
              { id: "4", kind: "not-obeyed", passed, obeyed: a },
            ];
            const found = unitFailures(unit({ probes })).map((failure) => failure.class);
            // The class itself, most specific first, not only that there is one.
            expect(found).toEqual(
              passed
                ? []
                : [
                    expectedAnswerClass({ forbidden: a, supplied: b, needed: c }),
                    b ? "fact-leaked" : "no-abstention",
                    "memory-on-unrelated-question",
                    "injected-instruction-obeyed",
                  ],
            );
            checked += 1;
          }
    expect(checked).toBe(16);
  });

  it("derives a class for every hard counter and every failing store verdict", () => {
    const verdicts = ["forbidden", "forgotten-returned", "stale", "unnecessary"].map(
      (verdict, index) => ({
        id: String(index),
        status: "accepted",
        verdict,
      }),
    );
    const found = classes(unit({ store: store({ verdicts, missing: ["m"] }) }));
    expect(found).toHaveLength(5);
    expect(new Set(found).size).toBe(5);
  });
});

describe("the maintenance switch", () => {
  const base = { mode: "offline", out: join(tmpdir(), "memory-lab-maintenance-out") };

  it("is on unless switched off, and is part of what two runs must share", () => {
    expect(normalizeOptions(base).maintenance).toBe("on");
    expect(normalizeOptions({ ...base, maintenance: false }).maintenance).toBe("off");
    const run = (maintenance) => ({
      manifest: { metadata: { maintenance } },
      summary: { byArm: [] },
    });
    expect(() =>
      judgeProgress([
        { model: "m", part: "development", baseline: run("on"), candidate: run("off") },
      ]),
    ).toThrow(/maintenance/u);
  });
});

describe("the recall trace in a comparison", () => {
  const run = (metadata) => ({
    manifest: { setDigest: "d", metadata },
    summary: { byArm: [{ key: "product", counters: {} }] },
    scorecard: { scenarios: [] },
  });

  it("is provenance: a traced and an untraced run differ, and a run that never recorded it is unrecorded", () => {
    expect(
      compareRuns(run({ recallTrace: "on" }), run({ recallTrace: "off" })).provenanceDifferences,
    ).toContain("recallTrace");
    expect(
      compareRuns(run({ recallTrace: "on" }), run({ recallTrace: "on" })).provenanceDifferences,
    ).not.toContain("recallTrace");
    expect(compareRuns(run({}), run({ recallTrace: "off" })).provenanceDifferences).toContain(
      "recallTrace",
    );
    expect(compareRuns(run({}), run({})).provenanceDifferences).not.toContain("recallTrace");
  });
});

describe("what compare does with runs that differ in provenance", () => {
  it("names the differing fields in its line instead of refusing; only judge refuses", () => {
    const run = (embedder) => ({
      manifest: { setDigest: "d", metadata: { embedder, embeddingModelIds: [] } },
      summary: { byArm: [{ key: "product", counters: {} }] },
      scorecard: { scenarios: [] },
    });
    const comparison = compareRuns(run("none"), run("scripted"));
    expect(comparison.provenanceDifferences).toContain("embedder");
    expect(renderComparison(comparison, "m")).toContain("the runs differ in embedder");
  });
});
