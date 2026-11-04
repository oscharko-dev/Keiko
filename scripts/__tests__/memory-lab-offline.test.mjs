// The offline lab against the real product: a forked BFF and Gateway per run, the scripted model on
// loopback, no network. This proves the harness, not the product: the run completes, two runs
// serialize byte-identically, and a deliberately broken learner turns a store red where the correct
// learner of the same scenario turns it green (a pair: a proof that cannot fail proves nothing).
// Both are measured in Full access, the configuration in which a learned fact is stored at all; in
// Ask for approval every fact is parked as proposed, recall is zero for any learner, and "the broken
// learner turns the store red" would hold for a correct learner too. Product scores beyond the pair
// are evidence in the written summary, never assertions here.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REPO_ROOT } from "../testing/coding-workbench-lab/lab-common.mjs";
import { DEFAULT_SCENARIO_DIR, normalizeOptions, runLab } from "../testing/memory-lab/run.mjs";

const RUN_TIMEOUT_MS = 180_000;
const SCENARIOS = ["preference-tables-de", "reversal-spaces-en", "hypothetical-en"];

function requireBuiltServer() {
  const built = join(REPO_ROOT, "packages", "keiko-server", "dist", "index.js");
  if (!existsSync(built))
    throw new Error(`memory lab needs built packages (${built}); run npm run build:packages`);
}

function scenarioSet(root, ids) {
  const directory = join(root, "scenarios");
  mkdirSync(directory, { recursive: true });
  for (const id of ids)
    copyFileSync(join(DEFAULT_SCENARIO_DIR, `${id}.json`), join(directory, `${id}.json`));
  return directory;
}

function options(root, name, scenarios, extra = {}) {
  return normalizeOptions({
    mode: "offline",
    out: join(root, name),
    scenarios,
    arms: "product",
    repetitions: "1",
    "memory-mode": "autonomous-delivery",
    ceiling: "autonomous-delivery",
    "budget-tokens": "1200",
    keep: false,
    "generated-at": "0",
    "retain-bodies": true,
    "quiet-ms": "400",
    "max-wait-ms": "30000",
    "turn-timeout-ms": "60000",
    ...extra,
  });
}

function metric(entry, name) {
  return entry.metrics.find((item) => item.name === name)?.value;
}

// The other half of the pair: the scenarios a wrong learner turns red below are green, with the
// related question answered, when the learner is right.
function assertCorrectLearnerIsGreen(entries) {
  for (const id of ["preference-tables-de", "hypothetical-en"]) {
    const store = entries.find((entry) => entry.name === `${id}:product:r0:store`);
    expect(store, id).toBeDefined();
    expect(store.passed, `${id} ${store.evidence}`).toBe(true);
    expect(metric(store, "precision")).toBe(1);
    expect(metric(store, "recall")).toBe(1);
    const related = entries.find((entry) => entry.name === `${id}:product:r0:probe:related`);
    expect(related.passed, `${id} ${related.evidence}`).toBe(true);
  }
}

describe("memory lab offline run", () => {
  let root;
  const scorecardEntries = (name) =>
    JSON.parse(readFileSync(join(root, name, "scorecard.json"), "utf8")).scenarios;
  beforeAll(() => {
    requireBuiltServer();
    root = mkdtempSync(join(tmpdir(), "memory-lab-offline-"));
  });
  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it(
    "completes against the real product and serializes byte-identically across two runs",
    async () => {
      const scenarios = scenarioSet(root, SCENARIOS);
      const lines = [];
      const first = await runLab(options(root, "first", scenarios), (line) => lines.push(line));
      expect(first.runs).toBe(SCENARIOS.length);
      expect(first.failedUnits).toBe(0);
      expect(lines.at(-1)).toMatch(
        /^PASS memory-lab runs=3 hard-counters=\S+ oracle-counters=\S+ oracle=not-run$/u,
      );
      expect(existsSync(join(root, "first", "summary.md"))).toBe(true);
      expect(existsSync(join(root, "first", "state"))).toBe(false);
      // What a run proves about itself: nothing it sent is in the Activity Log, and its evidence
      // names neither this machine nor anything else that is not synthetic.
      expect(first.logTextLeaks).toBe(0);
      expect(first.evidenceFindings).toBe(0);
      const scan = JSON.parse(readFileSync(join(root, "first", "evidence-scan.json"), "utf8"));
      expect(scan.filesScanned).toBeGreaterThan(SCENARIOS.length);
      expect(scan.findings).toEqual([]);
      await runLab(options(root, "second", scenarios), () => undefined);
      const one = readFileSync(join(root, "first", "scorecard.json"), "utf8");
      const two = readFileSync(join(root, "second", "scorecard.json"), "utf8");
      expect(two).toBe(one);
      const card = JSON.parse(one);
      expect(card.scenarios.map((entry) => entry.name)).toContain(
        "preference-tables-de:product:r0:probe:related",
      );
      assertCorrectLearnerIsGreen(card.scenarios);
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "turns the same store red when the learner stores the whole message",
    async () => {
      const scenarios = scenarioSet(join(root, "broken"), ["hypothetical-en"]);
      await runLab(
        options(root, "broken-run", scenarios, { "broken-learner": "whole-message" }),
        () => undefined,
      );
      const store = scorecardEntries("broken-run").find(
        (entry) => entry.name === "hypothetical-en:product:r0:store",
      );
      expect(store).toBeDefined();
      expect(store.passed).toBe(false);
      // The whole message was stored and it is not the fact: nothing stored is right.
      expect(metric(store, "live")).toBe(1);
      expect(metric(store, "precision")).toBe(0);
      expect(store.evidence).toContain("correct=0");
    },
    RUN_TIMEOUT_MS,
  );
});
