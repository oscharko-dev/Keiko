// The "next" corpus of the MemoriaViva lab (#4208): scenarios written for headroom, on which today's
// product is expected to fail for stated reasons. This proves the set as a set: it loads through the
// fail-closed loader, carries the families the plan names in both languages, and every scenario says
// which product limit it probes and what a failure of it means, so a red result can be classified.
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../testing/coding-workbench-lab/lab-common.mjs";
import { SCENARIO_CLASSES, loadScenarioDirectory } from "../testing/memory-lab/scenario.mjs";
import { scoreProbe } from "../testing/memory-lab/score.mjs";

const NEXT = join(REPO_ROOT, "scripts", "testing", "memory-lab", "scenarios-next");
// One scenario class per family; the two seeded demonstrations belong to the existing classes.
const FAMILY_CLASSES = Object.freeze({
  A: "long-horizon",
  B: "paraphrase",
  C: "scale-window",
  D: "two-memories",
  E: "earlier-value",
  F: "near-miss",
});
// The closed classification of what a failing scenario means (a baseline is reported per kind):
// `defect` the product does something wrong today, `capability` one that does not exist yet,
// `design` a design question, `control` expected to pass today. Five scenarios are being measured
// live and keep their text unchanged, so their kind is recorded here instead of in the description.
const KINDS = Object.freeze(["defect", "capability", "design", "control"]);
const KIND_OF_UNCHANGED = Object.freeze({
  "long-horizon-distractors-en": "defect",
  "scale-duplikat-en": "defect",
  "two-memories-batch-en": "capability",
  "two-memories-compare-en": "defect",
  "earlier-rueckkehr-de": "defect",
});
function kindOf(scenario) {
  const tagged = /Kind: (\w+)\./u.exec(scenario.description)?.[1];
  return tagged ?? KIND_OF_UNCHANGED[scenario.id];
}
const DEMONSTRATIONS = new Set(["seed-needs-two-en", "seed-earlier-value-en"]);

const scenarios = loadScenarioDirectory(NEXT);
const corpus = scenarios.filter((scenario) => !DEMONSTRATIONS.has(scenario.id));

describe("the next corpus", () => {
  it("keeps the two demonstrations and holds 26 scenarios of its own", () => {
    expect(scenarios).toHaveLength(28);
    expect(corpus).toHaveLength(26);
    for (const id of DEMONSTRATIONS) expect(scenarios.map((s) => s.id)).toContain(id);
  });

  it("is split between German and English, with the cross-language scenarios mixed", () => {
    const count = (language) => corpus.filter((scenario) => scenario.language === language).length;
    expect(count("de")).toBe(13);
    expect(count("en")).toBe(11);
    expect(count("mixed")).toBe(2);
    expect(count("de") + count("en") + count("mixed")).toBe(corpus.length);
  });

  it("carries every family, each under its own class, in both languages", () => {
    for (const [family, className] of Object.entries(FAMILY_CLASSES)) {
      expect(SCENARIO_CLASSES, `family ${family}`).toContain(className);
      const members = corpus.filter((scenario) => scenario.class === className);
      expect(members.length, `family ${family}`).toBeGreaterThanOrEqual(3);
      const languages = new Set(members.map((scenario) => scenario.language));
      expect(languages.has("de") || languages.has("mixed"), `family ${family} german`).toBe(true);
      expect(languages.has("en") || languages.has("mixed"), `family ${family} english`).toBe(true);
    }
    const classes = new Set(Object.values(FAMILY_CLASSES));
    expect(corpus.every((scenario) => classes.has(scenario.class))).toBe(true);
  });

  it("names, in every scenario, the product limit it probes, what a failure means and how to run maintenance", () => {
    for (const scenario of corpus) {
      expect(scenario.description, scenario.id).toMatch(/Limit: \S.{20,}/u);
      expect(scenario.description, scenario.id).toMatch(/Failure means: \S.{20,}/u);
      expect(scenario.description, scenario.id).toMatch(/Maintenance: \S.{20,}/u);
    }
  });

  it("classifies every scenario with one closed kind", () => {
    for (const scenario of corpus) expect(KINDS, scenario.id).toContain(kindOf(scenario));
    for (const id of Object.keys(KIND_OF_UNCHANGED))
      expect(
        scenarios.map((s) => s.id),
        id,
      ).toContain(id);
    // A kind named in the description is the only one it names.
    for (const scenario of corpus)
      expect(scenario.description.match(/Kind: /gu)?.length ?? 0, scenario.id).toBeLessThanOrEqual(
        1,
      );
  });

  it("gives every scenario a probe the scorer can decide and a seed or a turn to learn from", () => {
    for (const scenario of corpus) {
      expect(scenario.probes.length, scenario.id).toBeGreaterThan(0);
      expect(scenario.turns.length > 0 || scenario.seed !== undefined, scenario.id).toBe(true);
      for (const probe of scenario.probes) {
        const { kind } = probe.expect;
        if (kind === "answer")
          expect(
            probe.expect.terms !== undefined ||
              probe.expect.needs !== undefined ||
              probe.expect.earlier !== undefined,
            `${scenario.id}:${probe.id}`,
          ).toBe(true);
        // A mixed scenario carries the language of each probe, or an English probe is asked unmarked.
        if (scenario.language === "mixed") expect(probe.language, probe.id).toBeDefined();
      }
    }
  });

  it("uses each probe kind the families were written for", () => {
    const probes = corpus.flatMap((scenario) => scenario.probes.map((probe) => probe.expect));
    expect(probes.some((expect_) => expect_.needs !== undefined)).toBe(true);
    expect(probes.some((expect_) => expect_.earlier !== undefined)).toBe(true);
    expect(probes.some((expect_) => expect_.kind === "abstain")).toBe(true);
    expect(probes.some((expect_) => expect_.kind === "no-memory")).toBe(true);
  });

  it("seeds the history where the scale and long-horizon families need it", () => {
    for (const id of [
      "long-horizon-berichte-de",
      "scale-archiviert-de",
      "scale-duplikat-en",
      "scale-abgelaufen-de",
      "scale-vorschlaege-en",
    ]) {
      const scenario = scenarios.find((entry) => entry.id === id);
      expect(scenario.seed, id).toBeDefined();
    }
    const archived = scenarios.find((entry) => entry.id === "scale-archiviert-de").seed.filler;
    expect(archived.reduce((sum, group) => sum + group.count, 0)).toBeGreaterThan(500);
  });
});

describe("the near-miss abstain probes", () => {
  // The answers the audit executed through the scorer (F2): each applies the stored fact to the
  // foreign object while carrying a negation, which is all an abstain probe used to ask for.
  const CASES = [
    {
      id: "near-miss-kollege-en",
      probe: "colleague",
      wrong: [
        "Dana prefers morning meetings, not afternoon.",
        "Your colleague prefers morning meetings.",
      ],
      right: [
        "I don't know what Dana prefers.",
        "I have nothing about your colleague. You told me you prefer morning meetings.",
      ],
    },
    {
      id: "near-miss-berichte-de",
      probe: "sales",
      wrong: [
        "Für Berichte an den Vertrieb nutzt du Tabellen, nicht Fließtext.",
        "Berichte an den Vertrieb bekommst du als Tabelle, nicht anders.",
      ],
      right: [
        "Dazu habe ich keine Vorgabe für den Vertrieb.",
        "Für den Vertrieb weiss ich nichts. Für Projektstatus bevorzugst du Tabellen.",
      ],
    },
    {
      id: "near-miss-grenze-de",
      probe: "other-object",
      wrong: [
        "Für Kreditanträge gilt eine Grenze von 5.000 Euro, nicht mehr.",
        "Die Genehmigungsgrenze für Kreditanträge beträgt 5000 Euro, nicht weniger.",
      ],
      right: [
        "Für Kreditanträge ist mir keine Grenze genannt worden.",
        "Zu Kreditanträgen weiss ich nichts. Für Überweisungen nanntest du 5.000 Euro.",
      ],
    },
    {
      id: "near-miss-projekt-de",
      probe: "other-project",
      wrong: [
        "Im Projekt Borealis habt ihr euch für PostgreSQL entschieden, nicht für MySQL.",
        "Borealis nutzt Postgres, nicht etwas anderes.",
      ],
      right: [
        "Zu Borealis habe ich keine Entscheidung gespeichert.",
        "Über Borealis weiss ich nichts. Für Atlas habt ihr PostgreSQL gewählt.",
      ],
    },
  ];

  it.each(CASES)(
    "$id: fails the answer it exists to catch, passes a correct abstention",
    (spec) => {
      const scenario = scenarios.find((entry) => entry.id === spec.id);
      const probe = scenario.probes.find((entry) => entry.id === spec.probe);
      // The seeded memory reached the model, as it does when recall admits it on a shared word.
      const supplied = scenario.seed.records.map((record, index) => ({
        memoryId: `m${String(index)}`,
        bodyExcerpt: record.body,
      }));
      for (const answer of spec.wrong)
        expect(scoreProbe(scenario, probe, answer, supplied).passed, answer).toBe(false);
      // The probe asks for no value, so the assertion fails it with no memory supplied as well.
      expect(scoreProbe(scenario, probe, spec.wrong[0], []).passed).toBe(false);
      for (const answer of spec.right)
        expect(scoreProbe(scenario, probe, answer, supplied).passed, answer).toBe(true);
    },
  );

  it("says in its description what the two probes measure", () => {
    for (const { id } of CASES) {
      const description = scenarios.find((entry) => entry.id === id).description;
      expect(description, id).not.toMatch(/usually fail together/u);
      expect(description, id).toMatch(/measure different things and can fail apart/u);
    }
  });
});
