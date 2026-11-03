// The offline lab against the real product: a forked BFF and Gateway per run, the scripted model on
// loopback, no network. This proves the harness, not the product: the run completes, two runs
// serialize byte-identically, and a deliberately broken learner turns a store red. Product scores
// are evidence in the written summary, never assertions here.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REPO_ROOT } from "../testing/coding-workbench-lab/lab-common.mjs";
import { DEFAULT_SCENARIO_DIR, normalizeOptions, runLab } from "../testing/memory-lab/run.mjs";

const RUN_TIMEOUT_MS = 180_000;
const SCENARIOS = ["preference-tables-de", "reversal-spaces-en"];

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
    "memory-mode": "governed-assist",
    ceiling: "governed-assist",
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

describe("memory lab offline run", () => {
  let root;
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
      expect(lines.at(-1)).toMatch(
        /^PASS memory-lab runs=2 hard-counters=\S+ oracle-counters=\S+ oracle=ok$/u,
      );
      expect(existsSync(join(root, "first", "summary.md"))).toBe(true);
      expect(existsSync(join(root, "first", "state"))).toBe(false);
      await runLab(options(root, "second", scenarios), () => undefined);
      const one = readFileSync(join(root, "first", "scorecard.json"), "utf8");
      const two = readFileSync(join(root, "second", "scorecard.json"), "utf8");
      expect(two).toBe(one);
      const card = JSON.parse(one);
      expect(card.scenarios.map((entry) => entry.name)).toContain(
        "preference-tables-de:product:r0:probe:related",
      );
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "turns a store red when the learner stores the whole message",
    async () => {
      const scenarios = scenarioSet(join(root, "broken"), ["hypothetical-en"]);
      await runLab(
        options(root, "broken-run", scenarios, { "broken-learner": "whole-message" }),
        () => undefined,
      );
      const card = JSON.parse(readFileSync(join(root, "broken-run", "scorecard.json"), "utf8"));
      const store = card.scenarios.find(
        (entry) => entry.name === "hypothetical-en:product:r0:store",
      );
      expect(store).toBeDefined();
      expect(store.passed).toBe(false);
    },
    RUN_TIMEOUT_MS,
  );
});
