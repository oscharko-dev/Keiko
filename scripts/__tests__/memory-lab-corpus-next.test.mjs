// The "next" corpus of the MemoriaViva lab (#4208): scenarios written for headroom, on which today's
// product is expected to fail for stated reasons. This proves the set as a set: it loads through the
// fail-closed loader, carries the families the plan names in both languages, and every scenario says
// which product limit it probes and what a failure of it means, so a red result can be classified.
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../testing/coding-workbench-lab/lab-common.mjs";
import { SCENARIO_CLASSES, loadScenarioDirectory } from "../testing/memory-lab/scenario.mjs";

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
