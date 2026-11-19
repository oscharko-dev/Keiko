// The new scenario abilities against the real product, offline (#4207): a store seeded before the
// first turn, probes that need two memories or ask for an earlier value, and the same scenarios
// measured lexical-only and with the scripted embedding model. This proves the harness: the seeded
// records reach the product's own recall, are never scored as something it learned, and a failure
// names the class it belongs to. What the product answers beyond that is evidence, not assertion.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REPO_ROOT } from "../testing/coding-workbench-lab/lab-common.mjs";
import { provenanceDifferences, readRun } from "../testing/memory-lab/compare.mjs";
import { runScenario } from "../testing/memory-lab/driver.mjs";
import { startLabInstance } from "../testing/memory-lab/instance.mjs";
import { normalizeOptions, runLab } from "../testing/memory-lab/run.mjs";
import { loadScenarioDirectory } from "../testing/memory-lab/scenario.mjs";
import { startScriptedModelServer } from "../testing/memory-lab/scripted-model.mjs";

const RUN_TIMEOUT_MS = 300_000;
const NEXT = join(REPO_ROOT, "scripts", "testing", "memory-lab", "scenarios-next");
// The directory also holds the larger corpus (memory-lab-corpus-next.test.mjs checks it); this
// proof runs only the two small demonstrations, copied to a directory of their own.
const DEMOS = ["seed-needs-two-en.json", "seed-earlier-value-en.json"];

function options(root, name, extra = {}) {
  return normalizeOptions({
    mode: "offline",
    out: join(root, name),
    scenarios: join(root, "demo-scenarios"),
    arms: "product,oracle",
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

function unit(root, run, scenario, arm) {
  return JSON.parse(readFileSync(join(root, run, "runs", `${scenario}.${arm}.r0.json`), "utf8"));
}

describe("the seeded demonstration scenarios", () => {
  let root;
  beforeAll(() => {
    if (!existsSync(join(REPO_ROOT, "packages", "keiko-server", "dist", "index.js")))
      throw new Error("memory lab needs built packages; run npm run build:packages");
    root = mkdtempSync(join(tmpdir(), "memory-lab-seed-offline-"));
    mkdirSync(join(root, "demo-scenarios"));
    for (const name of DEMOS) copyFileSync(join(NEXT, name), join(root, "demo-scenarios", name));
  });
  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it(
    "seeds the store, answers a two-memory question, names why an earlier value is missing, and scores no seeded record as learned",
    async () => {
      const summary = await runLab(options(root, "lexical"), () => undefined);
      expect(summary.runs).toBe(4);
      expect(summary.failedUnits).toBe(0);
      expect(summary.evidenceFindings).toBe(0);

      const needs = unit(root, "lexical", "seed-needs-two-en", "product");
      // 42 records were seeded and none of them is something the product stored.
      expect(needs.seed).toMatchObject({
        total: 42,
        explicit: 2,
        filler: 40,
        embedded: 0,
      });
      expect(needs.store.stored).toBe(0);
      expect(needs.store.verdicts).toEqual([]);
      const both = needs.probes.find((probe) => probe.id === "both");
      expect(both).toMatchObject({
        passed: true,
        neededMissing: [],
        neededNotSupplied: [],
      });
      expect(needs.probes.find((probe) => probe.id === "unrelated").passed).toBe(true);

      // The earlier value cannot be recalled: the failure says it never reached the model.
      const earlier = unit(root, "lexical", "seed-earlier-value-en", "product");
      expect(earlier.probes.find((probe) => probe.id === "now").passed).toBe(true);
      const before = earlier.probes.find((probe) => probe.id === "before");
      expect(before.passed).toBe(false);
      expect(before.neededMissing).toEqual(["earlier:format-before"]);
      expect(before.neededNotSupplied).toEqual(["earlier:format-before"]);
      // The earlier value is still in the store: maintenance keeps a superseded record as history
      // (#4223). Recall does not supply history yet, which is the reason the probe fails.
      expect(earlier.seed.after).toMatchObject({ gone: 0, supersededRemoved: 0 });
      expect(earlier.seed.after.byStatus.superseded).toBe(1);
      expect(summary.seedInformation.supersededRemoved).toBe(0);
      const classes = summary.failureClasses.byArm.product;
      expect(classes.total["needed-memory-missing"]).toBe(1);
      // Faded filler is information, never a failure class.
      expect(classes.total["seeded-record-lost"]).toBeUndefined();
      expect(summary.seedInformation.fillerArchived).toBeGreaterThan(0);
      expect(classes.keys["needed-memory-missing"]).toEqual([
        "seed-earlier-value-en:product:r0:probe:before",
      ]);

      // The oracle arm adds no truth the seed already placed, and its precondition still holds.
      const oracle = unit(root, "lexical", "seed-needs-two-en", "oracle");
      expect(oracle.oracle).toMatchObject({
        preconditionMet: true,
        extras: 0,
        mismatches: [],
      });
      expect(oracle.oracle.seeded).toEqual([]);

      const manifest = JSON.parse(readFileSync(join(root, "lexical", "manifest.json"), "utf8"));
      expect(manifest.metadata).toMatchObject({
        embedder: "none",
        embeddingModelIds: [],
      });
      expect(readFileSync(join(root, "lexical", "summary.md"), "utf8")).toContain(
        "Embedding model: none.",
      );
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "embeds the accepted seeded records when the run has the scripted embedding model, and the two runs cannot be compared",
    async () => {
      await runLab(options(root, "embedded", { embedder: true }), () => undefined);
      const needs = unit(root, "embedded", "seed-needs-two-en", "product");
      // 32 accepted records (2 explicit and 30 filler) are embedded; the 10 archived are not.
      expect(needs.seed).toMatchObject({ total: 42, embedded: 32 });
      expect(needs.store.stored).toBe(0);
      expect(needs.probes.find((probe) => probe.id === "both").passed).toBe(true);
      const manifest = JSON.parse(readFileSync(join(root, "embedded", "manifest.json"), "utf8"));
      expect(manifest.metadata).toMatchObject({
        embedder: "scripted",
        embeddingModelIds: ["memory-lab-embedder"],
      });
      const differences = provenanceDifferences(
        readRun(join(root, "lexical")),
        readRun(join(root, "embedded")),
      );
      expect(differences).toEqual(["embedder", "embeddingModelIds"]);
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "asks the embedding model for each question too: the semantic path is in use, not only seeded",
    async () => {
      const scenario = loadScenarioDirectory(NEXT).find(
        (entry) => entry.id === "seed-needs-two-en",
      );
      const dir = mkdtempSync(join(root, "instance-"));
      const fixture = await startScriptedModelServer({ embedder: true });
      const instance = await startLabInstance({
        dir,
        fixture,
        ceiling: "autonomous-delivery",
        seed: scenario.seed,
        embedder: "scripted",
      });
      try {
        // Seeding embedded the 32 accepted records; the server's own start asks for a few more.
        const afterStart = fixture.embeddingCalls();
        expect(afterStart).toBeGreaterThanOrEqual(32);
        expect(instance.seed.report.embedded).toBe(32);
        const context = {
          arm: "product",
          memoryMode: "autonomous-delivery",
          budgetTokens: 1200,
          confirmForget: true,
          retainBodies: true,
          turnTimeoutMs: 60_000,
          learning: { quietMs: 400, maxMs: 30_000, graceMs: 3000 },
          fixture,
        };
        await runScenario(scenario, instance, context);
        expect(fixture.embeddingCalls()).toBeGreaterThan(afterStart);
      } finally {
        await instance.close();
      }
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "keeps the seeded store whole with the product's maintenance switched off, and records that",
    async () => {
      const summary = await runLab(
        options(root, "no-maintenance", { arms: "product", maintenance: false }),
        () => undefined,
      );
      const manifest = JSON.parse(
        readFileSync(join(root, "no-maintenance", "manifest.json"), "utf8"),
      );
      expect(manifest.metadata.maintenance).toBe("off");
      const needs = unit(root, "no-maintenance", "seed-needs-two-en", "product");
      expect(needs.seed.after.lostIndexes).toEqual([]);
      expect(needs.seed.after.byStatus).toEqual({ accepted: 32, archived: 10 });
      const earlier = unit(root, "no-maintenance", "seed-earlier-value-en", "product");
      expect(earlier.seed.after).toMatchObject({ gone: 0, supersededRemoved: 0 });
      expect(summary.failureClasses.byArm.product.total).toEqual({ "needed-memory-missing": 1 });
    },
    RUN_TIMEOUT_MS,
  );
});
