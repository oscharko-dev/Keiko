import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Linter } from "eslint";

const baseline = "c8fb7e2d78720a8ba51d3d3ae7dd0e82f2df7add";
const producer = "docs/design-system/evidence/sonarcloud-2026-10-24/context-loop-preservation.mjs";
const output = producer.replace(/\.mjs$/u, ".json");
const gate = "scripts/check-context-quality.mjs";
const corpus = "scripts/lib/context-quality-corpus.mjs";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function original(file) {
  return execFileSync("/usr/bin/git", ["show", `${baseline}:${file}`], { encoding: "utf8" });
}

function productSnapshot() {
  const files = execFileSync("/usr/bin/git", ["ls-files", "-z", "--", "packages", "src"], {
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);
  const hashes = files.map((file) => [file, sha256(readFileSync(file))]);
  return { fileCount: files.length, sha256: sha256(JSON.stringify(hashes)) };
}

function loopFindings(file, source) {
  const messages = new Linter().verify(source, {
    languageOptions: { ecmaVersion: "latest", sourceType: "module" },
    rules: { "no-await-in-loop": "error" },
  });
  assert.ok(messages.every((message) => message.ruleId === "no-await-in-loop"));
  return messages.map(({ line, column }) => ({ file, line, column }));
}

async function collect(gateFile, corpusFile) {
  const gateModule = await import(pathToFileURL(gateFile));
  const corpusModule = await import(pathToFileURL(corpusFile));
  const failures = [];
  const result = await gateModule.runContextQualityCheck({
    log: () => {},
    fail: (message) => failures.push(message),
  });
  assert.deepEqual(failures, []);
  assert.equal(result.budgetResult.ok, true);
  assert.equal(result.vacuity.ok, true);
  const { latency, chatLatency, ...stableSummary } = result.summary;
  assert.ok(Number.isFinite(latency.p95Ms));
  assert.ok(Number.isFinite(chatLatency.p95Ms));
  const scenarios = await corpusModule.buildScenarioCorpus();
  return {
    scenarioCount: scenarios.length,
    corpusSha256: sha256(JSON.stringify(scenarios)),
    stableSummary,
    budgetResult: result.budgetResult,
    vacuity: result.vacuity,
  };
}

async function compare() {
  const id = randomUUID();
  const originalGate = `scripts/.sonar-loop-${id}.mjs`;
  const originalCorpus = `scripts/lib/.sonar-loop-${id}.mjs`;
  const corpusImport = '"./lib/context-quality-corpus.mjs"';
  const originalGateSource = original(gate);
  assert.equal(originalGateSource.split(corpusImport).length, 2);
  const productBefore = productSnapshot();
  try {
    writeFileSync(originalCorpus, original(corpus), { flag: "wx" });
    writeFileSync(
      originalGate,
      originalGateSource.replace(corpusImport, `"./lib/.sonar-loop-${id}.mjs"`),
      { flag: "wx" },
    );
    const before = await collect(originalGate, originalCorpus);
    const after = await collect(gate, corpus);
    assert.deepEqual(after, before);
    assert.deepEqual(productSnapshot(), productBefore);
    return { before, productSnapshot: productBefore };
  } finally {
    rmSync(originalGate, { force: true });
    rmSync(originalCorpus, { force: true });
  }
}

const result = await compare();
const originalFindings = [gate, corpus].flatMap((file) => loopFindings(file, original(file)));
const currentFindings = [gate, corpus].flatMap((file) =>
  loopFindings(file, readFileSync(file, "utf8")),
);
assert.equal(originalFindings.length, 4);
assert.deepEqual(currentFindings, []);
writeFileSync(
  output,
  `${JSON.stringify(
    {
      baseline,
      producer,
      producerSha256: sha256(readFileSync(producer)),
      sources: Object.fromEntries([gate, corpus].map((file) => [file, sha256(readFileSync(file))])),
      comparison: result,
      targetedEslintRule: { rule: "no-await-in-loop", originalFindings, currentFindings },
      corpusAndNonTimingMetricsIdentical: true,
      bothTimingBudgetsPassed: true,
      limitations: [
        "Compares the complete deterministic fixture corpus and all non-timing summary fields.",
        "Wall-clock latency samples differ by nature; both original and current budgets must pass.",
        "The product snapshot checks that executing the producer does not change tracked product files.",
        "This is a targeted QA-fixture equivalence check, not proof of complete product correctness.",
        "The targeted ESLint rule supplements local Sonar; it does not substitute for a Cloud analysis.",
      ],
    },
    null,
    2,
  )}\n`,
);
console.log(
  "context-loop-preservation: corpus and non-timing metrics identical; both budgets pass",
);
