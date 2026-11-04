// Hermetic tests of the anchor labelling tool (#4208): a lab run over real conversations becomes a
// sheet for a person to label, and the labels come back as aggregates only. All text is invented.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { REPO_ROOT } from "../testing/coding-workbench-lab/lab-common.mjs";
import {
  LABELS,
  aggregateLabels,
  buildLabelSheet,
  cohensKappa,
  exportLabelSheet,
  exportReviewSample,
  locateSourceTurn,
  main,
  measureAgreement,
  renderAgreement,
  renderLabelSummary,
  summarizeLabels,
} from "../testing/memory-lab/anchor/label.mjs";
import { validateScenario } from "../testing/memory-lab/scenario.mjs";

const DE_ID = "wildchat-de-aaaaaaaaaaaa";
const EN_ID = "wildchat-en-bbbbbbbbbbbb";
const DE_TURNS = [
  "Ich arbeite lieber mit Tabellen.",
  "Meine Chefin Anna mag keine Listen.",
  "Danke für die Hilfe!",
];
const EN_TURNS = ["I prefer short answers.", "What about sorting?"];

function scenarioFile(id, language, turns) {
  return {
    schemaVersion: 1,
    id,
    language,
    class: "anchor-real",
    difficulty: "noisy",
    description: "Real conversation, redacted copy.",
    truth: [],
    turns: turns.map((user) => ({ user })),
    probes: [{ id: "unrelated", question: "?", expect: { kind: "no-memory" } }],
  };
}

function memory(id, body, status = "accepted", type = "preference") {
  return { id, status, type, scope: "private", ...(body === undefined ? {} : { body }) };
}

function runResult(scenario, language, arm, memories, repetition = 0) {
  return {
    scenario,
    language,
    class: "anchor-real",
    difficulty: "noisy",
    arm,
    repetition,
    store: { stored: memories.length, memories },
  };
}

describe("memory lab anchor labelling", () => {
  const directories = [];
  function scratch() {
    const directory = mkdtempSync(join(tmpdir(), "anchor-label-"));
    directories.push(directory);
    return directory;
  }
  afterEach(() => {
    for (const directory of directories.splice(0))
      rmSync(directory, { recursive: true, force: true });
  });

  // A lab run directory and the scenario directory it ran, as a live anchor run leaves them.
  function fixture({ results } = {}) {
    const root = scratch();
    const scenarios = join(root, "scenarios");
    const run = join(root, "run");
    mkdirSync(scenarios);
    mkdirSync(join(run, "runs"), { recursive: true });
    writeFileSync(
      join(scenarios, `${DE_ID}.json`),
      JSON.stringify(scenarioFile(DE_ID, "de", DE_TURNS)),
    );
    writeFileSync(
      join(scenarios, `${EN_ID}.json`),
      JSON.stringify(scenarioFile(EN_ID, "en", EN_TURNS)),
    );
    const all = results ?? [
      runResult(DE_ID, "de", "product", [
        memory("mem-1", "Ich arbeite lieber mit Tabellen."),
        memory("mem-2", "meine chefin anna mag keine listen", "accepted", "semantic-fact"),
        memory("mem-3", "Der Nutzer mag Tabellen", "proposed"),
      ]),
      runResult(DE_ID, "de", "oracle", [memory("mem-oracle", "Oracle seed body")]),
      runResult(EN_ID, "en", "product", [
        memory("mem-5", "I prefer short answers."),
        memory("mem-6", "Sorting", "proposed", "semantic-fact"),
      ]),
    ];
    for (const result of all)
      writeFileSync(
        join(run, "runs", `${result.scenario}.${result.arm}.r${String(result.repetition)}.json`),
        JSON.stringify(result),
      );
    return { root, scenarios, run, sheet: join(root, "labels", "sheet.json") };
  }

  function exportSheet(files, extra = {}) {
    return exportLabelSheet({
      run: files.run,
      scenarios: files.scenarios,
      out: files.sheet,
      ...extra,
    });
  }

  describe("locating the source turn", () => {
    const scenario = validateScenario(scenarioFile(DE_ID, "de", DE_TURNS));

    it("finds an exact substring first", () => {
      expect(locateSourceTurn("Ich arbeite lieber mit Tabellen.", scenario)).toEqual({
        index: 0,
        match: "exact",
        text: "Ich arbeite lieber mit Tabellen.",
      });
      expect(locateSourceTurn("Anna mag", scenario)).toMatchObject({ index: 1, match: "exact" });
    });

    it("falls back to the lab's normalization: case, diacritics and spacing", () => {
      expect(locateSourceTurn("DANKE  FUR die hilfe", scenario)).toMatchObject({
        index: 2,
        match: "normalized",
        text: "Danke für die Hilfe!",
      });
    });

    it("returns null for a paraphrase, an empty body or a missing scenario", () => {
      expect(locateSourceTurn("Der Nutzer bevorzugt Tabellen", scenario)).toBeNull();
      expect(locateSourceTurn("   ", scenario)).toBeNull();
      expect(locateSourceTurn(undefined, scenario)).toBeNull();
      expect(locateSourceTurn("Ich arbeite", undefined)).toBeNull();
    });

    it("takes the first turn that contains the body", () => {
      const twice = validateScenario(
        scenarioFile("twice-xxxx", "de", ["Hallo Welt", "noch Hallo Welt"]),
      );
      expect(locateSourceTurn("Hallo Welt", twice).index).toBe(0);
    });
  });

  describe("export", () => {
    it("writes one entry per stored memory of the product arm with the source turn", () => {
      const files = fixture();
      const exported = exportSheet(files);
      expect(exported).toMatchObject({
        out: files.sheet,
        entries: 5,
        counts: { runs: 2, memories: 5, withoutBody: 0, withoutSourceTurn: 1 },
      });
      const sheet = JSON.parse(readFileSync(files.sheet, "utf8"));
      expect(sheet).toMatchObject({
        schemaVersion: 1,
        kind: "memory-lab-anchor-label-sheet",
        labels: LABELS,
        arms: ["product"],
      });
      expect(sheet.entries.map((entry) => entry.memoryId)).toEqual([
        "mem-1",
        "mem-2",
        "mem-3",
        "mem-5",
        "mem-6",
      ]);
      expect(sheet.entries[0]).toEqual({
        runFile: `${DE_ID}.product.r0.json`,
        memoryId: "mem-1",
        scenario: DE_ID,
        class: "anchor-real",
        language: "de",
        arm: "product",
        repetition: 0,
        status: "accepted",
        type: "preference",
        body: "Ich arbeite lieber mit Tabellen.",
        sourceTurn: { index: 0, match: "exact", text: "Ich arbeite lieber mit Tabellen." },
        label: null,
      });
      expect(sheet.entries[1].sourceTurn).toMatchObject({ index: 1, match: "normalized" });
      expect(sheet.entries[2].sourceTurn).toBeNull();
      expect(sheet.entries[2].status).toBe("proposed");
      expect(sheet.entries.every((entry) => entry.arm === "product" && entry.label === null)).toBe(
        true,
      );
    });

    it("includes the oracle arm only when asked", () => {
      const files = fixture();
      exportSheet(files, { arms: ["product", "oracle"] });
      const sheet = JSON.parse(readFileSync(files.sheet, "utf8"));
      expect(sheet.entries.map((entry) => entry.memoryId)).toContain("mem-oracle");
      expect(sheet.arms).toEqual(["product", "oracle"]);
    });

    it("lists entries in a stable order whatever the order of the run files", () => {
      const files = fixture();
      const first = buildLabelSheet({
        runDir: files.run,
        scenarioDir: files.scenarios,
        arms: ["product"],
      });
      const second = buildLabelSheet({
        runDir: files.run,
        scenarioDir: files.scenarios,
        arms: ["product"],
      });
      expect(second).toEqual(first);
      expect(first.entries.map((entry) => entry.runFile)).toEqual(
        first.entries.map((entry) => entry.runFile).toSorted(),
      );
    });

    it("counts memories without a body and memories without a scenario file", () => {
      const files = fixture({
        results: [
          runResult(DE_ID, "de", "product", [memory("mem-1", "Ich arbeite"), memory("mem-gone")]),
          runResult("unknown-scenario-cccc", "de", "product", [memory("mem-9", "Etwas anderes")]),
        ],
      });
      const exported = exportSheet(files);
      expect(exported.counts).toMatchObject({ memories: 3, withoutBody: 1, withoutSourceTurn: 1 });
      expect(exported.entries).toBe(2);
    });

    it("names an arm the run has no result for", () => {
      const files = fixture();
      expect(() => exportSheet(files, { arms: ["prodcut"] })).toThrow(
        /the run holds no result of the arm\(s\) prodcut/u,
      );
    });

    it("refuses a run that kept no memory bodies, and one that stored nothing", () => {
      const noBodies = fixture({
        results: [runResult(DE_ID, "de", "product", [memory("mem-1"), memory("mem-2")])],
      });
      expect(() => exportSheet(noBodies)).toThrow(/kept no memory bodies/u);
      const empty = fixture({ results: [runResult(DE_ID, "de", "product", [])] });
      expect(() => exportSheet(empty)).toThrow(/stored no memory/u);
      expect(existsSync(noBodies.sheet)).toBe(false);
    });

    it("refuses a run directory without runs", () => {
      const files = fixture();
      expect(() => exportSheet({ ...files, run: files.scenarios })).toThrow(
        /holds no runs\/ directory/u,
      );
    });

    it.skipIf(process.platform === "win32")("writes the sheet owner-private", () => {
      const files = fixture();
      exportSheet(files);
      expect(statSync(files.sheet).mode & 0o077).toBe(0);
    });

    it("refuses a sheet, a run or a scenario directory inside the checkout", () => {
      const files = fixture();
      const inside = join(REPO_ROOT, "anchor-label-refusal-test.json");
      expect(() => exportSheet(files, { out: inside })).toThrow(
        /--out must lie outside the checkout/u,
      );
      expect(existsSync(inside)).toBe(false);
      expect(() => exportSheet(files, { run: join(REPO_ROOT, "runs-here") })).toThrow(
        /--run must lie outside the checkout/u,
      );
      expect(() => exportSheet(files, { scenarios: join(REPO_ROOT, "scenarios-here") })).toThrow(
        /--scenarios must lie outside the checkout/u,
      );
    });

    it("never overwrites a sheet, so labels are never lost", () => {
      const files = fixture();
      exportSheet(files);
      writeFileSync(files.sheet, "HUMAN LABELS");
      expect(() => exportSheet(files)).toThrow(/refusing to overwrite an existing sheet/u);
      expect(readFileSync(files.sheet, "utf8")).toBe("HUMAN LABELS");
    });
  });

  describe("summary", () => {
    function labelledSheet(files, labels) {
      exportSheet(files);
      const sheet = JSON.parse(readFileSync(files.sheet, "utf8"));
      for (const entry of sheet.entries) entry.label = labels[entry.memoryId] ?? null;
      const labelled = join(files.root, "labelled.json");
      writeFileSync(labelled, JSON.stringify(sheet));
      return labelled;
    }

    const LABELLED = {
      "mem-1": "correct",
      "mem-2": "correct",
      "mem-3": "unnecessary",
      "mem-5": "correct",
      "mem-6": "forbidden",
    };

    it("aggregates a filled-in sheet per class and language, with precision on the labelled subset", () => {
      const files = fixture();
      const summary = summarizeLabels({ labelsPath: labelledSheet(files, LABELLED) });
      expect(summary).toMatchObject({ entries: 5, labelled: 5, unlabelled: 0 });
      expect(summary.groups).toEqual([
        {
          key: "anchor-real/de",
          labelled: 3,
          counts: { correct: 2, unnecessary: 1, forbidden: 0, "third-party": 0 },
          precision: 0.6667,
        },
        {
          key: "anchor-real/en",
          labelled: 2,
          counts: { correct: 1, unnecessary: 0, forbidden: 1, "third-party": 0 },
          precision: 0.5,
        },
      ]);
      expect(summary.overall).toMatchObject({ key: "all", labelled: 5, precision: 0.6 });
      expect(summary.hardZero).toEqual({ forbidden: 1, "third-party": 0 });
    });

    it("reads a flat {memoryId: label} file against its sheet and counts the unlabelled", () => {
      const files = fixture();
      exportSheet(files);
      const flat = join(files.root, "flat.json");
      writeFileSync(flat, JSON.stringify({ "mem-1": "correct", "mem-3": "third-party" }));
      const summary = summarizeLabels({ labelsPath: flat, sheetPath: files.sheet });
      expect(summary).toMatchObject({ entries: 5, labelled: 2, unlabelled: 3 });
      expect(summary.overall.precision).toBe(0.5);
      expect(summary.hardZero).toEqual({ forbidden: 0, "third-party": 1 });
    });

    it("leaves precision empty when nothing is labelled", () => {
      const files = fixture();
      const summary = summarizeLabels({ labelsPath: labelledSheet(files, {}) });
      expect(summary.labelled).toBe(0);
      expect(summary.groups).toEqual([]);
      expect(summary.overall.precision).toBeNull();
      expect(renderLabelSummary(summary)).toContain("| all | 0 | 0 | 0 | 0 | 0 | n/a |");
    });

    it("filters by memory status", () => {
      const files = fixture();
      const summary = summarizeLabels({
        labelsPath: labelledSheet(files, LABELLED),
        statuses: ["accepted"],
      });
      expect(summary).toMatchObject({ entries: 3, labelled: 3, statuses: ["accepted"] });
      expect(summary.overall.counts).toMatchObject({ correct: 3, unnecessary: 0, forbidden: 0 });
      expect(summary.overall.precision).toBe(1);
      expect(renderLabelSummary(summary)).toContain(
        "Only memories with status accepted are counted.",
      );
    });

    it("fails closed on a label that is not one of the four", () => {
      const files = fixture();
      expect(() =>
        summarizeLabels({ labelsPath: labelledSheet(files, { "mem-1": "great" }) }),
      ).toThrow(/a label is not one of correct\|unnecessary\|forbidden\|third-party/u);
    });

    it("fails closed on a flat file that names a memory outside the sheet or has no sheet", () => {
      const files = fixture();
      exportSheet(files);
      const flat = join(files.root, "flat.json");
      writeFileSync(flat, JSON.stringify({ "mem-1": "correct", "mem-404": "correct" }));
      expect(() => summarizeLabels({ labelsPath: flat, sheetPath: files.sheet })).toThrow(
        /1 label\(s\) name memories that are not in the sheet/u,
      );
      expect(() => summarizeLabels({ labelsPath: flat })).toThrow(/needs --sheet/u);
    });

    it("refuses --sheet next to a filled-in sheet, and a labels file of the wrong shape", () => {
      const files = fixture();
      const labelled = labelledSheet(files, LABELLED);
      expect(() => summarizeLabels({ labelsPath: labelled, sheetPath: files.sheet })).toThrow(
        /--sheet is only for a flat/u,
      );
      const list = join(files.root, "list.json");
      writeFileSync(list, "[]");
      expect(() => summarizeLabels({ labelsPath: list })).toThrow(/neither a sheet nor/u);
    });

    it("refuses a flat file when the sheet repeats a memory id", () => {
      const files = fixture({
        results: [
          runResult(DE_ID, "de", "product", [memory("dup", "Ich arbeite lieber mit Tabellen.")]),
          runResult(EN_ID, "en", "product", [memory("dup", "I prefer short answers.")]),
        ],
      });
      exportSheet(files);
      const flat = join(files.root, "flat.json");
      writeFileSync(flat, JSON.stringify({ dup: "correct" }));
      expect(() => summarizeLabels({ labelsPath: flat, sheetPath: files.sheet })).toThrow(
        /ambiguous/u,
      );
    });

    it("refuses labels or a sheet inside the checkout", () => {
      expect(() => summarizeLabels({ labelsPath: join(REPO_ROOT, "labels.json") })).toThrow(
        /--labels must lie outside the checkout/u,
      );
      const files = fixture();
      expect(() =>
        summarizeLabels({ labelsPath: files.sheet, sheetPath: join(REPO_ROOT, "sheet.json") }),
      ).toThrow(/--sheet must lie outside the checkout/u);
    });

    it("renders counts only: no body, source turn or scenario id", () => {
      const files = fixture();
      const text = renderLabelSummary(
        summarizeLabels({ labelsPath: labelledSheet(files, LABELLED) }),
      );
      for (const secret of [...DE_TURNS, ...EN_TURNS, "Tabellen", "Sorting", DE_ID, EN_ID, "mem-1"])
        expect(text).not.toContain(secret);
      expect(text).toContain("Labelled 5 of 5 stored memories (0 unlabelled).");
      expect(text).toContain("| anchor-real/de | 3 | 2 | 1 | 0 | 0 | 0.6667 |");
      expect(text).toContain("| all | 5 | 3 | 1 | 1 | 0 | 0.6 |");
      expect(text).toContain("Hard-zero labels: forbidden=1.");
    });

    it("says so when no hard-zero label was given", () => {
      const summary = aggregateLabels([
        { class: "anchor-real", language: "de", status: "accepted", label: "correct" },
      ]);
      expect(renderLabelSummary(summary)).toContain("Hard-zero labels: none.");
    });
  });

  describe("human spot check", () => {
    const AGENT = {
      "mem-1": "correct",
      "mem-2": "correct",
      "mem-3": "unnecessary",
      "mem-5": "correct",
      "mem-6": "forbidden",
    };

    function agentFiles(files) {
      exportSheet(files);
      const labels = join(files.root, "agent.json");
      writeFileSync(labels, JSON.stringify(AGENT));
      return labels;
    }

    function draw(files, labels, name, options = {}) {
      const out = join(files.root, name);
      const sampled = exportReviewSample({
        labelsPath: labels,
        sheetPath: files.sheet,
        out,
        ...options,
      });
      return { out, sampled, sheet: JSON.parse(readFileSync(out, "utf8")) };
    }

    function review(path, sheet, verdicts) {
      for (const entry of sheet.entries) entry.label = verdicts[entry.memoryId] ?? null;
      writeFileSync(path, JSON.stringify(sheet));
    }

    it("shows the person what was stored, never what the agent said", () => {
      const files = fixture();
      const labels = agentFiles(files);
      const { sheet, sampled } = draw(files, labels, "review.json");
      expect(sampled.drawn).toBe(Object.keys(AGENT).length);
      expect(sheet.entries.every((entry) => entry.label === null)).toBe(true);
      expect(sheet.entries.every((entry) => typeof entry.body === "string")).toBe(true);
      expect(sheet.entries.every((entry) => !("agentLabel" in entry))).toBe(true);
    });

    it("draws the same subset for a seed, another for another seed, and only what is labelled", () => {
      const files = fixture();
      const labels = agentFiles(files);
      const ids = ({ sheet }) => sheet.entries.map((entry) => entry.memoryId);
      const first = draw(files, labels, "a.json", { size: 3, seed: 7 });
      expect(first.sheet.sample).toEqual({ seed: 7, requested: 3, drawn: 3, population: 5 });
      expect(ids(draw(files, labels, "b.json", { size: 3, seed: 7 }))).toEqual(ids(first));
      const others = [8, 9, 10, 11].map((seed) =>
        ids(draw(files, labels, `s${String(seed)}.json`, { size: 3, seed })).join(),
      );
      expect(others.some((other) => other !== ids(first).join())).toBe(true);
      expect(ids(first).every((id) => id in AGENT)).toBe(true);
    });

    it("refuses an empty labels file, a bad size, an overwrite and a path in the checkout", () => {
      const files = fixture();
      const labels = agentFiles(files);
      const empty = join(files.root, "empty.json");
      writeFileSync(empty, "{}");
      const out = join(files.root, "r.json");
      const base = { labelsPath: labels, sheetPath: files.sheet, out };
      expect(() => exportReviewSample({ ...base, labelsPath: empty })).toThrow(
        /nothing to spot-check/u,
      );
      expect(() => exportReviewSample({ ...base, size: 0 })).toThrow(/positive integer/u);
      exportReviewSample(base);
      expect(() => exportReviewSample(base)).toThrow(/overwrite/u);
      expect(() => exportReviewSample({ ...base, out: join(REPO_ROOT, "review.json") })).toThrow();
    });

    it("measures agreement and kappa, and reports where the two differ, in counts only", () => {
      const files = fixture();
      const labels = agentFiles(files);
      const { out, sheet } = draw(files, labels, "review.json");
      review(out, sheet, { ...AGENT, "mem-3": "correct", "mem-6": "third-party" });
      const result = measureAgreement({
        reviewPath: out,
        labelsPath: labels,
        sheetPath: files.sheet,
      });
      expect(result).toMatchObject({ sampled: 5, compared: 5, agreed: 3, agreement: 0.6 });
      expect(result.confusion.correct).toMatchObject({ correct: 3, unnecessary: 1 });
      expect(result.confusion["third-party"].forbidden).toBe(1);
      const text = renderAgreement(result);
      expect(text).toContain("agreed on 3");
      for (const entry of sheet.entries) {
        expect(text).not.toContain(entry.body);
        expect(text).not.toContain(entry.scenario);
      }
    });

    it("compares only what the person labelled, and refuses a review with no label", () => {
      const files = fixture();
      const labels = agentFiles(files);
      const { out, sheet } = draw(files, labels, "review.json");
      review(out, sheet, {});
      const args = { reviewPath: out, labelsPath: labels, sheetPath: files.sheet };
      expect(() => measureAgreement(args)).toThrow(/no label yet/u);
      review(out, sheet, { "mem-1": "correct" });
      expect(measureAgreement(args)).toMatchObject({ sampled: 5, compared: 1, agreed: 1 });
    });

    it("refuses a review of a memory the agent never judged", () => {
      const files = fixture();
      const labels = agentFiles(files);
      const { out, sheet } = draw(files, labels, "review.json");
      review(out, sheet, { "mem-1": "correct" });
      writeFileSync(labels, JSON.stringify({ "mem-2": "correct" }));
      const args = { reviewPath: out, labelsPath: labels, sheetPath: files.sheet };
      expect(() => measureAgreement(args)).toThrow(/left open/u);
      const renamed = {
        ...sheet,
        entries: sheet.entries.map((e) => ({ ...e, runFile: "other.json" })),
      };
      writeFileSync(out, JSON.stringify(renamed));
      expect(() => measureAgreement(args)).toThrow(/do not cover/u);
    });

    it("computes kappa from the two label distributions", () => {
      const pair = (human, agent) => ({ human, agent });
      expect(cohensKappa([])).toBeNull();
      // One label on both sides: chance explains everything, so there is no kappa to report.
      expect(cohensKappa([pair("correct", "correct"), pair("correct", "correct")])).toBeNull();
      // Perfect agreement over two labels.
      expect(cohensKappa([pair("correct", "correct"), pair("forbidden", "forbidden")])).toBe(1);
      // Two raters who always disagree over two evenly used labels: observed 0, chance 0.5.
      expect(cohensKappa([pair("correct", "forbidden"), pair("forbidden", "correct")])).toBe(-1);
      // Agreeing because one side always says "correct" is what chance alone reaches: observed and
      // chance are both 0.75, so kappa is 0 however high the raw agreement looks.
      const mixed = [
        pair("correct", "correct"),
        pair("correct", "correct"),
        pair("correct", "correct"),
        pair("forbidden", "correct"),
      ];
      expect(cohensKappa(mixed)).toBe(0);
    });

    it("runs through the command line", async () => {
      const files = fixture();
      const labels = agentFiles(files);
      const out = join(files.root, "cli-review.json");
      const lines = [];
      const log = (line) => lines.push(line);
      const base = ["--labels", labels, "--sheet", files.sheet];
      expect(await main(["sample", ...base, "--out", out, "--size", "2", "--seed", "3"], log)).toBe(
        0,
      );
      expect(lines.join("\n")).toContain("PASS anchor-label sample drawn=2 population=5");
      const sheet = JSON.parse(readFileSync(out, "utf8"));
      review(
        out,
        sheet,
        Object.fromEntries(sheet.entries.map((e) => [e.memoryId, AGENT[e.memoryId]])),
      );
      lines.length = 0;
      expect(await main(["agreement", "--review", out, ...base], log)).toBe(0);
      expect(lines.join("\n")).toContain("agreed on 2");
      await expect(main(["sample", ...base, "--out", out, "--size", "x"], log)).rejects.toThrow(
        /whole/u,
      );
    });
  });

  describe("command line", () => {
    it("exports a sheet and summarizes its labels", async () => {
      const files = fixture();
      const lines = [];
      const log = (line) => lines.push(line);
      expect(
        await main(
          [
            "export",
            "--run",
            files.run,
            "--scenarios",
            files.scenarios,
            "--out",
            files.sheet,
            "--arm",
            "product",
          ],
          log,
        ),
      ).toBe(0);
      expect(lines).toEqual([
        `sheet: ${files.sheet}`,
        "entries=5 withoutBody=0 withoutSourceTurn=1",
        "PASS anchor-label export entries=5",
      ]);
      const sheet = JSON.parse(readFileSync(files.sheet, "utf8"));
      const flat = join(files.root, "flat.json");
      writeFileSync(
        flat,
        JSON.stringify(
          Object.fromEntries(sheet.entries.map((entry) => [entry.memoryId, "correct"])),
        ),
      );
      lines.length = 0;
      expect(
        await main(
          ["summarize", "--labels", flat, "--sheet", files.sheet, "--status", "accepted"],
          log,
        ),
      ).toBe(0);
      expect(lines.join("\n")).toContain("Labelled 3 of 3 stored memories (0 unlabelled).");
      expect(lines.join("\n")).not.toContain("Tabellen");
    });

    it("accepts several arms, comma-separated, spaced or repeated", async () => {
      const files = fixture();
      await main(
        [
          "export",
          "--run",
          files.run,
          "--scenarios",
          files.scenarios,
          "--out",
          files.sheet,
          "--arm",
          "product, oracle",
        ],
        () => undefined,
      );
      expect(JSON.parse(readFileSync(files.sheet, "utf8")).arms).toEqual(["product", "oracle"]);
    });

    it("prints usage for --help or no command and refuses anything unknown", async () => {
      const lines = [];
      expect(await main(["--help"], (line) => lines.push(line))).toBe(0);
      expect(await main([], (line) => lines.push(line))).toBe(2);
      expect(lines.join("\n")).toContain(
        "usage: node scripts/testing/memory-lab/anchor/label.mjs export",
      );
      await expect(main(["frobnicate"], () => undefined)).rejects.toThrow(/unknown command/u);
      await expect(main(["export", "extra"], () => undefined)).rejects.toThrow(/unknown command/u);
      await expect(main(["export", "--nope"], () => undefined)).rejects.toThrow(/nope/u);
      await expect(main(["export"], () => undefined)).rejects.toThrow(/--run is required/u);
      await expect(main(["summarize"], () => undefined)).rejects.toThrow(/--labels is required/u);
    });
  });
});
