// Body-free, model-separated analysis of the existing native continuity laboratory's ledgers.
import { isDeepStrictEqual } from "node:util";
import { continuityCampaignQualified } from "./chat-continuity-campaign.mjs";

export const CONTINUITY_LAB_MODELS = Object.freeze(["gemma-4-31b-it", "qwen3.6-35b-a3b-8bit"]);
const KINDS = ["plain", "grounded"];
const DIGEST = /^[a-f0-9]{64}$/u;

function requireCount(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("invalid-lab-count");
  return value;
}

function validateScore(score, expected) {
  if (typeof score?.validJson !== "boolean" || score.total !== expected)
    throw new TypeError("invalid-lab-score");
  if (requireCount(score.correct) > expected) throw new TypeError("invalid-lab-score");
  if (!score.validJson && score.correct !== 0) throw new TypeError("invalid-lab-score");
}

function validateProbes(probes, expected) {
  if (!Array.isArray(probes)) throw new TypeError("invalid-lab-probes");
  for (const probe of probes) {
    if (!new Set(["control", "cycle", "restart"]).has(probe.phase))
      throw new TypeError("invalid-lab-phase");
    validateScore(probe.score, expected);
  }
}

function validateCorpus(run) {
  if (!Array.isArray(run.corpus?.criticalFields) || run.corpus.criticalFields.length === 0)
    throw new TypeError("missing-lab-corpus");
  if (new Set(run.corpus.criticalFields).size !== run.corpus.criticalFields.length)
    throw new TypeError("duplicate-lab-critical-field");
  for (const key of ["initialDigest", "correctionDigest", "questionDigest", "oracleDigest"])
    if (!DIGEST.test(run.corpus[key])) throw new TypeError("invalid-lab-corpus-digest");
}

function validateEnvironment(run) {
  if (!DIGEST.test(run.configurationDigest)) throw new TypeError("invalid-lab-config-digest");
  if (typeof run.policy !== "string" || run.policy.length === 0)
    throw new TypeError("missing-lab-policy");
  if (typeof run.hardware?.arch !== "string" || typeof run.hardware?.platform !== "string")
    throw new TypeError("missing-lab-hardware");
  if (requireCount(run.hardware.memoryBytes) === 0 || requireCount(run.hardware.cpus) === 0)
    throw new TypeError("invalid-lab-hardware");
}

function validateRun(run) {
  validateCorpus(run);
  validateEnvironment(run);
  if (!new Set(["running", "terminated", "failed", "completed", "incomplete"]).has(run.status))
    throw new TypeError("invalid-lab-status");
  for (const key of ["requiredCycles", "requiredDuration", "repetitions"]) requireCount(run[key]);
  if (!Array.isArray(run.campaign) || !Array.isArray(run.ledger))
    throw new TypeError("missing-lab-campaign");
  if (!Number.isFinite(Date.parse(run.updatedAt))) throw new TypeError("invalid-lab-clock");
}

function recall(probes) {
  const correct = probes.reduce((sum, { score }) => sum + score.correct, 0);
  const total = probes.reduce((sum, { score }) => sum + score.total, 0);
  return {
    answers: probes.length,
    correct,
    questions: total,
    observedScore0to10: total === 0 ? null : Number(((10 * correct) / total).toFixed(4)),
  };
}

function campaign(run, model, kind) {
  const matches = run.campaign.filter((state) => state.model === model && state.kind === kind);
  if (matches.length > 1) throw new TypeError("duplicate-lab-campaign");
  const state = matches[0];
  if (state === undefined) return undefined;
  requireCount(state.cycles);
  requireCount(state.failures);
  if (!Number.isSafeInteger(state.startedAt)) throw new TypeError("invalid-lab-start");
  validateProbes(state.probes, run.corpus.criticalFields.length);
  return state;
}

function lane(run, model, kind) {
  const state = campaign(run, model, kind);
  const probes = state?.probes ?? [];
  const cycles = probes.filter(({ phase }) => phase === "cycle");
  const qualified =
    state !== undefined && continuityCampaignQualified(state, run, Date.parse(run.updatedAt));
  return {
    model,
    kind,
    present: state !== undefined,
    cycles: state?.cycles ?? null,
    executionFailures: state?.failures ?? null,
    control: recall(probes.filter(({ phase }) => phase === "control")),
    postCompaction: recall(cycles),
    lastPostCompaction: recall(cycles.slice(-1)),
    restart: recall(probes.filter(({ phase }) => phase === "restart")),
    criticalFixtureQualified: qualified,
  };
}

function repetitionResults(run, model) {
  return run.ledger.filter((row) => row.model === model && row.id?.endsWith(":repetition-result"));
}

function repeatQualified(row, expected) {
  if (row.kind !== "plain") throw new TypeError("invalid-lab-repetition-mode");
  requireCount(row.cycles);
  requireCount(row.failures);
  requireCount(row.elapsedMs);
  validateProbes(row.probes, expected);
  return continuityCampaignQualified(
    { ...row, startedAt: 0 },
    { requiredCycles: 1, requiredDuration: 0, requireRestart: false },
    row.elapsedMs,
  );
}

function repetitions(run, model) {
  const rows = repetitionResults(run, model);
  const trials = new Set();
  let passed = 0;
  for (const row of rows) {
    const trial = requireCount(row.repetition);
    if (trial >= run.repetitions || trials.has(trial))
      throw new TypeError("duplicate-or-out-of-range-lab-repetition");
    trials.add(trial);
    if (repeatQualified(row, run.corpus.criticalFields.length)) passed++;
  }
  return { model, planned: run.repetitions, observed: rows.length, passed };
}

export function summarizeContinuityRun(run) {
  validateRun(run);
  const models = CONTINUITY_LAB_MODELS;
  const configuredRosterMatches = isDeepStrictEqual(new Set(run.models), new Set(models));
  const lanes = models.flatMap((model) => KINDS.map((kind) => lane(run, model, kind)));
  const repeats = models.map((model) => repetitions(run, model));
  const fullBounds =
    run.requiredCycles >= 10 && run.requiredDuration >= 7200000 && run.repetitions >= 5;
  const qualified =
    configuredRosterMatches &&
    fullBounds &&
    run.status === "completed" &&
    lanes.every((entry) => entry.criticalFixtureQualified) &&
    repeats.every((entry) => entry.passed === entry.planned);
  return {
    schemaVersion: 1,
    scope: "critical-conversation-recall-fixture-only",
    globalSystemScore: null,
    sourceStatus: run.status,
    configuredRosterMatches,
    fixtureQualification: qualified ? "passed" : "incomplete",
    lanes,
    repetitions: repeats,
  };
}

function requireComparable(baseline, candidate) {
  const keys = [
    "configurationDigest",
    "models",
    "hardware",
    "policy",
    "requiredCycles",
    "requiredDuration",
    "repetitions",
  ];
  if (keys.some((key) => !isDeepStrictEqual(baseline[key], candidate[key])))
    throw new TypeError("lab-environment-or-schedule-mismatch");
  for (const key of ["initialDigest", "correctionDigest", "questionDigest", "oracleDigest"])
    if (baseline.corpus[key] !== candidate.corpus[key])
      throw new TypeError("lab-corpus-or-oracle-mismatch-rescore-required");
}

function laneDelta(before, after) {
  const sameCoverage =
    before.present &&
    after.present &&
    before.cycles === after.cycles &&
    before.postCompaction.answers === after.postCompaction.answers &&
    before.control.answers === after.control.answers &&
    before.restart.answers === after.restart.answers;
  const a = before.postCompaction.observedScore0to10;
  const b = after.postCompaction.observedScore0to10;
  return {
    model: before.model,
    kind: before.kind,
    coverage: sameCoverage ? "matched" : "different-or-missing",
    before: a,
    after: b,
    observedScoreDelta:
      sameCoverage && a !== null && b !== null ? Number((b - a).toFixed(4)) : null,
    failuresBefore: before.executionFailures,
    failuresAfter: after.executionFailures,
  };
}

export function compareContinuityRuns(baseline, candidate) {
  const before = summarizeContinuityRun(baseline);
  const after = summarizeContinuityRun(candidate);
  requireComparable(baseline, candidate);
  return {
    schemaVersion: 1,
    scope: before.scope,
    globalSystemScore: null,
    baselineQualification: before.fixtureQualification,
    candidateQualification: after.fixtureQualification,
    lanes: before.lanes.map((entry, index) => laneDelta(entry, after.lanes[index])),
    latencyCausality: "not-established-by-recall-ledgers",
  };
}
