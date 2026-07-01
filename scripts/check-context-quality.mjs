// Deterministic, OFFLINE context-quality gate (ADR-0052/ADR-0053, context-engineering PR1+PR2). It
// evaluates the keiko-workflows lane allocator over a fixed corpus of long agentic-coding-session
// SCENARIOS and gates CI on a set of HARD context-quality invariants (critical-fact preservation,
// budget non-overflow, prompt-injection isolation, redaction correctness, line-reference accuracy,
// path-free summaries, determinism) plus the PR2 LOAD-BEARING compaction/rehydration metrics and a
// SOFT assembly-latency ceiling.
//
// House pattern (mirrors scripts/check-retrieval-quality.mjs + check-retrieval-latency.mjs): pure
// exported helpers (unit-tested in scripts/__tests__/) + a runContextQualityCheck runner reading a
// co-located *.budget.json + process.exit(1) ONLY inside the direct-invocation guard. The corpus
// (scripts/lib/context-quality-corpus.mjs) inlines the same buildFixtureFs WorkspaceFs builder the
// retrieval gate uses; _memfs is not importable. The summary printed to stdout is path-free and
// secret-free; the harness writes NO report file into the repo tree.
//
// HONESTY (no silent caps): PR2 promotes rehydrationReadiness + compactionPreservation from
// scaffolded to MEASURED + load-bearing — both run the REAL buildCompactionRecords +
// rehydrateProvenanceRef (readExcerpt) round-trip over EXCLUDED meta-backed repo-evidence items, and
// a NON-VACUOUS GUARD fails the gate if the excluded-repo-file denominator drops below the floor so
// the metrics can never silently become vacuous again. invalidationDetected is a measured
// hard-boolean (mutated-fs probe). PR3 promotes toolObservationShapingFidelity from scaffolded to
// MEASURED + load-bearing: evaluateToolObservationShapingFidelity runs the REAL keiko-workflows
// shapers (command/test/search) over deterministic fixtures and scores a fixed set of fidelity
// checks (signal preservation, redaction, injection flagging, byte-cap, validator round-trip), with
// two hard-boolean sub-invariants (shapingRedactionClean, shapingInjectionFlagged) gated as required.
// HONEST LIMITATION: per-test failingTestNames/counts are NOT asserted — the live VerificationResult
// carries no per-test data (those live step-level on VerificationReport), so that sub-dimension is
// out of scope until a richer test-result producer exists. No metric remains scaffolded.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { TextEncoder } from "node:util";

import { redact, detectPromptInjectionSignals } from "@oscharko-dev/keiko-security";
import {
  conversationForGateway,
  conversationForGatewayWithCompaction,
  usableGatewayMessages,
} from "@oscharko-dev/keiko-server";
import {
  allocateContext,
  buildCompactionRecords,
  rehydrateProvenanceRef,
  shapeCommandObservation,
  shapeTestObservation,
  shapeSearchObservation,
  DEFAULT_CONTEXT_BUDGET,
} from "@oscharko-dev/keiko-workflows";
import { fileContentHash } from "@oscharko-dev/keiko-workspace";
import {
  DEFAULT_CONTEXT_PROFILE,
  MAX_OBSERVATION_EXCERPT_BYTES,
  MAX_TOP_RANGES,
  validateContextCompactionRecord,
  validateContextToolObservation,
} from "@oscharko-dev/keiko-contracts";

import {
  buildScenarioCorpus,
  buildChatHistoryFixtures,
  buildRepoFs,
  buildToolObservationFixtures,
  corpusAbsolutePath,
} from "./lib/context-quality-corpus.mjs";

// The minimum number of EXCLUDED meta-backed repo-evidence items the corpus must produce. Below
// this the rehydrationReadiness denominator would be vacuous (the silent-cap regression PR2 closes),
// so the harness FAILS hard rather than reporting a meaningless 100%.
const MIN_EVICTED_REPO_FILES = 2;

// Deterministic logical clock handed to the compaction builder (NEVER Date.now()).
const FIXED_ORDERED_AT = 1_700_000_000;

// Deterministic mutated body used ONLY for the invalidation-detection probe, applied to a SECOND fs
// snapshot so the fresh-read checks see the unmodified corpus.
const MUTATED_FILE_BODY = "// MUTATED corpus file body for invalidation detection probe\n";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_BUDGET_PATH = resolve(HERE, "check-context-quality.budget.json");
const LATENCY_ITERATIONS = 200;
const LATENCY_WARMUP = 20;
const CHAT_LATENCY_ITERATIONS = 120;
const CHAT_LATENCY_WARMUP = 20;

// ─── Pure helpers ─────────────────────────────────────────────────────────────

// Nearest-rank percentile over a copy of `samples` (ascending). `p` is 0..100. Empty => 0.
export function percentile(samples, p) {
  if (samples.length === 0) {
    return 0;
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[index];
}

function fraction(hits, total) {
  return total === 0 ? 1 : hits / total;
}

// Applies redact() to every lane item (defense in depth) before allocation. Returns lanes with the
// same shape but redacted text. Pure (redact is pure).
export function redactLanes(lanes) {
  return lanes.map((lane) => ({
    laneId: lane.laneId,
    items: lane.items.map((item) => ({ ...item, text: redact(item.text) })),
  }));
}

// Collects the set of item ids that survived allocation (were included in any lane).
export function includedIdSet(result) {
  const ids = new Set();
  for (const lane of result.lanes) {
    for (const id of lane.includedItemIds) {
      ids.add(id);
    }
  }
  return ids;
}

// Maps each allocated lane id -> the set of included item ids, so isolation checks can ask "which
// lane did this id end up in".
export function laneOfIncludedIds(result) {
  const byLane = new Map();
  for (const lane of result.lanes) {
    byLane.set(lane.laneId, new Set(lane.includedItemIds));
  }
  return byLane;
}

// ─── Per-metric evaluators (pure, unit-tested individually) ─────────────────────

// criticalFactPreservationRecall over one scenario: fraction of oracle CRITICAL ids that survived.
export function evaluateCriticalRecall(included, oracle) {
  const ids = oracle.criticalItemIds;
  const survived = ids.filter((id) => included.has(id)).length;
  return fraction(survived, ids.length);
}

export function evaluateUserInstructionPreservation(included, oracle) {
  const ids = oracle.userInstructionItemIds;
  const survived = ids.filter((id) => included.has(id)).length;
  return fraction(survived, ids.length);
}

export function evaluateCurrentDiffPreservation(included, oracle) {
  const ids = oracle.currentDiffItemIds;
  const survived = ids.filter((id) => included.has(id)).length;
  return fraction(survived, ids.length);
}

export function evaluateFailingTestPreservation(included, oracle) {
  const ids = oracle.failingTestItemIds;
  const survived = ids.filter((id) => included.has(id)).length;
  return fraction(survived, ids.length);
}

// repoEvidenceLineRefAccuracy: fraction of repo-evidence metas whose readExcerpt anchor was re-found
// at the returned line range (computed in the corpus, surfaced here).
export function evaluateLineRefAccuracy(repoMetas) {
  const total = repoMetas.length;
  const hits = repoMetas.filter((m) => m.lineRefHit).length;
  return fraction(hits, total);
}

// budgetOverflow for one scenario: true when the included EVICTABLE tokens exceed the headroom
// (effectiveInputBudget minus the non-evictable reserved tokens). The allocator guarantees this is
// false; the metric proves it on the corpus. Non-evictable lanes (system-contract/user-task) are
// reserved off the top and excluded from the evictable sum.
const NON_EVICTABLE_LANES = new Set(["system-contract", "user-task"]);

export function evaluateBudgetOverflow(result, profile) {
  let reserved = 0;
  let evictable = 0;
  for (const lane of result.lanes) {
    if (NON_EVICTABLE_LANES.has(lane.laneId)) {
      reserved += lane.estimatedTokens;
    } else {
      evictable += lane.estimatedTokens;
    }
  }
  const headroom = profile.effectiveInputBudget - reserved;
  return evictable > headroom;
}

// promptInjectionIsolation for one scenario: every injection-bearing item must be (i) detected by
// detectPromptInjectionSignals on its raw text AND (ii) confined to an untrusted lane — never
// promoted into a protected lane (system-contract/user-task). Returns {ok, detectedRate, confinedRate}.
export function evaluateInjectionIsolation(scenario, byLaneIncluded) {
  const injectionIds = new Set(scenario.oracle.injectionItemIds);
  const protectedLanes = scenario.oracle.protectedLaneIds;
  let detected = 0;
  let confined = 0;
  let total = 0;
  for (const lane of scenario.lanes) {
    for (const item of lane.items) {
      if (!injectionIds.has(item.id)) {
        continue;
      }
      total += 1;
      if (detectPromptInjectionSignals(item.text).length > 0) {
        detected += 1;
      }
      const inProtected = protectedLanes.some((laneId) => byLaneIncluded.get(laneId)?.has(item.id));
      if (!inProtected) {
        confined += 1;
      }
    }
  }
  return {
    detectedRate: fraction(detected, total),
    confinedRate: fraction(confined, total),
    rate: Math.min(fraction(detected, total), fraction(confined, total)),
  };
}

// redactionCorrectness for one scenario: NO oracle secret string may survive into ANY allocated lane
// item text after redaction. We re-derive the redacted text the allocator saw and confirm the
// literal secret is gone. Returns 1 when clean, 0 when any secret leaked.
export function evaluateRedactionCorrectness(scenario, redactedLanes) {
  const secrets = scenario.oracle.secretStrings;
  if (secrets.length === 0) {
    return 1;
  }
  for (const lane of redactedLanes) {
    for (const item of lane.items) {
      for (const secret of secrets) {
        if (item.text.includes(secret)) {
          return 0;
        }
      }
    }
  }
  return 1;
}

// pathFreeCompliance: build a browser-style aggregate summary from diagnostics ONLY (counts +
// pressure + token totals) and assert it contains NO fixture path and NO secret string. Returns
// {ok, summary}. The aggregate is what a path-free browser/evidence projection would carry.
export function buildAggregateSummary(result) {
  const laneCounts = {};
  for (const lane of result.diagnostics.lanes) {
    laneCounts[lane.laneId] = {
      included: lane.includedItems,
      excluded: lane.excludedItems,
      estimatedTokens: lane.estimatedTokens,
    };
  }
  return {
    totalEstimatedTokens: result.diagnostics.totalEstimatedTokens,
    budgetPressure: result.diagnostics.budgetPressure,
    laneCounts,
  };
}

const PATH_LIKE = /\/corpus\/|services\/|src\/|app\/|docs\//u;

export function evaluatePathFree(aggregate, scenario) {
  const serialized = JSON.stringify(aggregate);
  if (PATH_LIKE.test(serialized)) {
    return 0;
  }
  for (const secret of scenario.oracle.secretStrings) {
    if (serialized.includes(secret)) {
      return 0;
    }
  }
  return 1;
}

// Collects the EXCLUDED repo-evidence items that carry a real rehydration handle (meta with
// scopePath + lineRange), i.e. the meta-backed items the allocator actually dropped. Pure.
export function excludedRepoFileMetas(result, repoMetas) {
  const metaById = new Map(repoMetas.map((m) => [m.id, m]));
  const out = [];
  for (const lane of result.lanes) {
    if (lane.laneId !== "repo-evidence") {
      continue;
    }
    for (const id of lane.excludedItemIds) {
      const meta = metaById.get(id);
      if (
        meta !== undefined &&
        typeof meta.scopePath === "string" &&
        meta.lineRange !== undefined
      ) {
        out.push(meta);
      }
    }
  }
  return out;
}

// rehydrationReadiness (MEASURED, load-bearing PR2): fraction of EXCLUDED repo-file items whose
// ContextProvenanceRef rehydrated via the REAL readExcerpt round-trip with resolved===true AND
// invalidated===false (a fresh read whose excerpt hash matches the compaction-time hash). The input
// is the array of RehydrationResult for the excluded repo-file refs; an empty set is NOT treated as
// a pass here — the non-vacuous guard rejects an empty denominator before this is gated.
export function evaluateRehydrationReadiness(roundTrips) {
  const total = roundTrips.length;
  if (total === 0) {
    return 1;
  }
  const fresh = roundTrips.filter((r) => r.resolved === true && r.invalidated === false).length;
  return fraction(fresh, total);
}

// compactionPreservation (MEASURED, load-bearing PR2): fraction of EXCLUDED repo-file items that
// (i) appear in some compaction record's sourceSpans (by stableId) AND (ii) have a matching
// ContextInvalidationKey by scopePath in that same record. Proves the eviction was captured with a
// rehydratable, invalidation-keyed provenance span. Pure over the builder output.
export function evaluateCompactionPreservation(excludedMetas, records) {
  const total = excludedMetas.length;
  if (total === 0) {
    return 1;
  }
  const preserved = excludedMetas.filter((meta) =>
    records.some((record) => {
      const inSpans = (record.sourceSpans ?? []).some((span) => span.stableId === meta.id);
      const keyed = (record.invalidationKeys ?? []).some((key) => key.scopePath === meta.scopePath);
      return inSpans && keyed;
    }),
  ).length;
  return fraction(preserved, total);
}

// invalidationDetected (MEASURED hard-boolean, load-bearing PR2): true when rehydrating ONE excluded
// repo-file ref against an fs whose file body has changed yields invalidated===true. The input is
// the single RehydrationResult of that mutated-fs probe.
export function evaluateInvalidationDetected(mutatedResult) {
  return mutatedResult.resolved === true && mutatedResult.invalidated === true;
}

// ─── Tool-observation shaping fidelity (MEASURED + LOAD-BEARING PR3) ────────────
// Runs the three REAL keiko-workflows shapers over the deterministic fixtures and scores a fixed set
// of pass/fail FIDELITY CHECKS. fidelity = passed/total. Only checks the LIVE types support are
// asserted; per-test failingTestNames/counts are intentionally NOT scored (see budget $comment) —
// the live VerificationResult exposes no per-test data.

// UTF-8 byte length helper (the shaped excerpt budget is measured in bytes).
function utf8Bytes(text) {
  return new TextEncoder().encode(text).length;
}

// True when `secret` appears in ANY field of the fully serialized observation. The serialization
// walks every nested excerpt/range/handle, so a leak in any shaped field is caught.
function observationContainsSecret(observation, secret) {
  return JSON.stringify(observation).includes(secret);
}

// command-shape fidelity checks against the truncated + clean fixtures. Returns an ordered list of
// {name, pass} so the aggregate can both score the fraction AND surface the two hard sub-invariants.
function commandChecks(truncatedRaw, truncatedObs, cleanRaw, cleanObs, secret) {
  const excerptsWithinCap = (obs) =>
    obs.excerpts.every((excerpt) => excerpt.bytes <= MAX_OBSERVATION_EXCERPT_BYTES) &&
    obs.excerpts.reduce((sum, excerpt) => sum + utf8Bytes(excerpt.text), 0) <=
      MAX_OBSERVATION_EXCERPT_BYTES;
  return [
    { name: "command.exitCode", pass: truncatedObs.exitCode === truncatedRaw.exitCode },
    { name: "command.durationMs", pass: truncatedObs.durationMs === truncatedRaw.durationMs },
    { name: "command.timedOut", pass: truncatedObs.timedOut === truncatedRaw.timedOut },
    { name: "command.truncated", pass: truncatedObs.truncated === truncatedRaw.truncated },
    {
      name: "command.omittedByteCount",
      pass: truncatedObs.omittedByteCount !== undefined && truncatedObs.omittedByteCount > 0,
    },
    {
      name: "command.redaction",
      pass:
        !observationContainsSecret(truncatedObs, secret) &&
        !observationContainsSecret(cleanObs, secret),
    },
    {
      name: "command.injectionFlagged",
      pass:
        truncatedObs.injectionSignalCount > 0 && truncatedObs.hasCriticalInjectionSignal === true,
    },
    {
      name: "command.cleanNoInjection",
      pass: cleanObs.injectionSignalCount === 0 && cleanObs.hasCriticalInjectionSignal === false,
    },
    {
      name: "command.excerptByteCap",
      pass: excerptsWithinCap(truncatedObs) && excerptsWithinCap(cleanObs),
    },
    {
      name: "command.valid",
      pass:
        validateContextToolObservation(truncatedObs).ok &&
        validateContextToolObservation(cleanObs).ok,
    },
  ];
}

// search-shape fidelity checks against the real-searchText fixture (candidateCount > MAX_TOP_RANGES).
function searchChecks(rawResult, obs) {
  const candidateCount = rawResult.atoms.length;
  const sortedDesc = obs.topRanges.every(
    (range, index) => index === 0 || obs.topRanges[index - 1].score >= range.score,
  );
  return [
    { name: "search.candidateCount", pass: obs.candidateCount === candidateCount },
    { name: "search.topRangesCap", pass: obs.topRanges.length <= MAX_TOP_RANGES },
    { name: "search.sortedDescending", pass: sortedDesc },
    {
      name: "search.omittedCount",
      pass: obs.omittedCount === candidateCount - obs.topRanges.length,
    },
    { name: "search.valid", pass: validateContextToolObservation(obs).ok },
  ];
}

// test-shape fidelity checks against the failing VerificationResult fixture.
function testChecks(raw, obs, secret) {
  return [
    { name: "test.status", pass: obs.status === raw.status },
    { name: "test.verificationKind", pass: obs.verificationKind === raw.kind },
    { name: "test.exitCode", pass: obs.exitCode === raw.exitCode },
    { name: "test.truncated", pass: obs.truncated === raw.truncated },
    { name: "test.outputSummaryRedacted", pass: !obs.outputSummary.includes(secret) },
    {
      name: "test.injectionFlagged",
      pass: obs.injectionSignalCount > 0 && obs.hasCriticalInjectionSignal === true,
    },
    { name: "test.valid", pass: validateContextToolObservation(obs).ok },
  ];
}

// Shapes all fixtures with the real shapers (fixed observationIds so the run is byte-stable) and
// returns the shaped observations alongside the raw inputs. Pure given the fixtures.
function shapeAllFixtures(fixtures) {
  return {
    truncatedCommand: shapeCommandObservation(fixtures.truncatedCommand, {
      observationId: "fixture-cmd-truncated",
    }),
    cleanCommand: shapeCommandObservation(fixtures.cleanCommand, {
      observationId: "fixture-cmd-clean",
    }),
    failingTest: shapeTestObservation(fixtures.failingTest, {
      observationId: "fixture-test-failing",
    }),
    search: shapeSearchObservation(fixtures.search.result, {
      observationId: "fixture-search",
      query: fixtures.search.query,
      searchKind: fixtures.search.searchKind,
    }),
  };
}

// evaluateToolObservationShapingFidelity (MEASURED, load-bearing PR3): runs the real shapers over the
// fixtures and scores every fidelity check. Returns the fraction passed plus the two hard-boolean
// sub-invariants (shapingRedactionClean, shapingInjectionFlagged) surfaced for separate gating.
export function evaluateToolObservationShapingFidelity(fixtures) {
  const shaped = shapeAllFixtures(fixtures);
  const checks = [
    ...commandChecks(
      fixtures.truncatedCommand,
      shaped.truncatedCommand,
      fixtures.cleanCommand,
      shaped.cleanCommand,
      fixtures.secret,
    ),
    ...searchChecks(fixtures.search.result, shaped.search),
    ...testChecks(fixtures.failingTest, shaped.failingTest, fixtures.secret),
  ];
  const passed = checks.filter((check) => check.pass).length;
  const allShaped = [
    shaped.truncatedCommand,
    shaped.cleanCommand,
    shaped.failingTest,
    shaped.search,
  ];
  const redactionClean = allShaped.every((obs) => !observationContainsSecret(obs, fixtures.secret));
  const injectionFlagged =
    shaped.truncatedCommand.injectionSignalCount > 0 &&
    shaped.truncatedCommand.hasCriticalInjectionSignal === true &&
    shaped.failingTest.injectionSignalCount > 0 &&
    shaped.failingTest.hasCriticalInjectionSignal === true;
  return {
    fidelity: fraction(passed, checks.length),
    shapingRedactionClean: redactionClean,
    shapingInjectionFlagged: injectionFlagged,
  };
}

// ─── Determinism: deep-equal of two allocations on identical input ──────────────
export function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ─── Chat history-compaction splice (MEASURED + LOAD-BEARING PR4-W4, ADR-0055) ──
// These evaluators drive the REAL keiko-server conversationForGatewayWithCompaction over the
// deterministic chat-history fixtures and gate the milestone headline AC — "long sessions compact
// WITHOUT losing current user instructions" — as hard booleans. They are pure given a precomputed
// splice outcome; the runner does the (deterministic) splicing once and feeds the outcome here so a
// single mutation in the shim (drop the latest turn, skip redaction, omit the summary) is caught.

// True when `needle` appears in ANY message content of a GatewayConversationMessage[].
function someContentIncludes(messages, needle) {
  return messages.some((message) => message.content.includes(needle));
}

function hasSystemThenSummary(messages) {
  return messages[0]?.role === "system" && messages[1]?.role === "user";
}

function hasExactLatestUserInstruction(messages, instruction) {
  const latest = messages.at(-1);
  return latest?.role === "user" && latest.content === instruction;
}

function hasNoLiteral(messages, literal) {
  return !someContentIncludes(messages, literal);
}

function hasValidCompactionRecord(compaction) {
  return compaction !== undefined && validateContextCompactionRecord(compaction).ok;
}

function buildFullGatewayProjection(messages) {
  const system = conversationForGateway(messages)[0];
  const filtered = usableGatewayMessages(messages);
  return system === undefined ? filtered : [system, ...filtered];
}

function retainedTailMatches(outcomeMessages, plainMessages, itemsBefore) {
  return deepEqual(outcomeMessages.slice(2), plainMessages.slice(1 + itemsBefore));
}

function evaluatePressureCompactionContent(outcome, plain, fixtures) {
  const { messages, compaction } = outcome;
  if (!hasValidCompactionRecord(compaction)) {
    return false;
  }
  if (!hasSystemThenSummary(messages)) {
    return false;
  }
  if (!retainedTailMatches(messages, plain, compaction.itemsBefore)) {
    return false;
  }
  if (!hasExactLatestUserInstruction(messages, fixtures.currentInstruction)) {
    return false;
  }
  if (!hasExactLatestUserInstruction(plain, fixtures.currentInstruction)) {
    return false;
  }
  if (!hasNoLiteral(messages, fixtures.earlySecret)) {
    return false;
  }
  return (
    hasNoLiteral(messages, fixtures.droppedDurableInstruction) &&
    hasNoLiteral(messages, fixtures.droppedDurableMarker)
  );
}

// chatLongSessionCompaction (required true): the full budget-pressure invariant set over the
// oversized fixture. (1) a validated ContextCompactionRecord is present; (2) messages[0] stays the
// system message and messages[1] is the role:"user" summary segment; (3) the LATEST user
// instruction survives VERBATIM; (4) the dropped early secret is NOT present verbatim; (5) the
// dropped durable instruction's raw text + distinctive marker are NOT present verbatim (digested).
// `plain` is conversationForGateway(pressureHistory) — the un-compacted projection used only to
// check the current instruction and redaction facts, not tail preservation.
export function evaluateLongSessionCompaction(outcome, plain, fixtures) {
  return evaluatePressureCompactionContent(outcome, plain, fixtures);
}

export function evaluateNoProfileOverflowCompaction(outcome, plain, fixtures) {
  return evaluatePressureCompactionContent(outcome, plain, fixtures);
}

// chatCurrentInstructionPreserved (required true): the milestone headline — the latest user message
// content appears UNCHANGED in the spliced output. Isolated from the broader compaction invariant so
// a regression that drops the current instruction fails THIS metric distinctly.
export function evaluateCurrentInstructionPreserved(outcome, fixtures) {
  const latest = outcome.messages.at(-1);
  return latest?.role === "user" && latest.content === fixtures.currentInstruction;
}

// chatShortSessionByteIdentical (required true): a session AT the threshold WITH a profile must be
// byte-identical to the plain projection and carry NO compaction record (fast path). `plain` is
// conversationForGateway(shortHistory).
export function evaluateShortSessionByteIdentical(outcome, plain) {
  return outcome.compaction === undefined && deepEqual(outcome.messages, plain);
}

// chatManyShortBudgetSafeUnchanged (required true): a session above MAX_CONTEXT_MESSAGES but still
// under the effective budget WITH a profile must stay byte-identical to the FULL usable gateway
// projection and carry NO compaction record. `expected` is the full filtered projection, not the
// legacy sliced conversationForGateway(manyShortHistory) result.
export function evaluateManyShortBudgetSafeUnchanged(outcome, plain) {
  return outcome.compaction === undefined && deepEqual(outcome.messages, plain);
}

// chatNoProfileUnchanged (required true): the 30-msg history with NO profile must use the fallback
// default budget path and stay byte-identical to the FULL usable gateway projection with no
// compaction record. `expected` is the full filtered projection, not the legacy slice.
export function evaluateNoProfileUnchanged(outcome, plain) {
  return outcome.compaction === undefined && deepEqual(outcome.messages, plain);
}

// Drives the REAL splice over the chat fixtures and returns the six measured hard booleans. The
// splice is deterministic (no clock/random), so this is reproducible. Internal message bodies (which
// carry the secret + markers) are never returned — only the boolean verdicts.
export function evaluateChatCompaction(fixtures) {
  const profile = { contextProfile: DEFAULT_CONTEXT_PROFILE };
  const pressureOutcome = conversationForGatewayWithCompaction(fixtures.pressure, {
    ...profile,
    redactionSecrets: [fixtures.earlySecret],
  });
  const noProfilePressureOutcome = conversationForGatewayWithCompaction(fixtures.pressure, {
    redactionSecrets: [fixtures.earlySecret],
  });
  const pressurePlain = conversationForGateway(fixtures.pressure);
  const longOutcome = conversationForGatewayWithCompaction(fixtures.long, profile);
  const longExpected = buildFullGatewayProjection(fixtures.long);
  const shortOutcome = conversationForGatewayWithCompaction(fixtures.short, profile);
  const shortPlain = conversationForGateway(fixtures.short);
  const noProfileOutcome = conversationForGatewayWithCompaction(fixtures.long);
  return {
    chatLongSessionCompaction: evaluateLongSessionCompaction(
      pressureOutcome,
      pressurePlain,
      fixtures,
    ),
    chatNoProfileOverflowCompaction: evaluateNoProfileOverflowCompaction(
      noProfilePressureOutcome,
      pressurePlain,
      fixtures,
    ),
    chatManyShortBudgetSafeUnchanged: evaluateManyShortBudgetSafeUnchanged(
      longOutcome,
      longExpected,
    ),
    chatCurrentInstructionPreserved: evaluateCurrentInstructionPreserved(pressureOutcome, fixtures),
    chatShortSessionByteIdentical: evaluateShortSessionByteIdentical(shortOutcome, shortPlain),
    chatNoProfileUnchanged: evaluateNoProfileUnchanged(noProfileOutcome, longExpected),
  };
}

function measureChatCompactionLatency(fixtures) {
  const profile = { contextProfile: DEFAULT_CONTEXT_PROFILE };
  for (let i = 0; i < CHAT_LATENCY_WARMUP; i += 1) {
    conversationForGatewayWithCompaction(fixtures.pressure, profile);
  }
  const samples = [];
  for (let i = 0; i < CHAT_LATENCY_ITERATIONS; i += 1) {
    const start = performance.now();
    conversationForGatewayWithCompaction(fixtures.pressure, profile);
    samples.push(performance.now() - start);
  }
  return samples;
}

// ─── Scenario evaluation ────────────────────────────────────────────────────────
function evaluateScenario(scenario) {
  const redacted = redactLanes(scenario.lanes);
  const input = {
    profile: DEFAULT_CONTEXT_PROFILE,
    budget: DEFAULT_CONTEXT_BUDGET,
    lanes: redacted,
  };
  const result = allocateContext(input);
  const resultAgain = allocateContext(input);
  const included = includedIdSet(result);
  const byLane = laneOfIncludedIds(result);
  const aggregate = buildAggregateSummary(result);
  const injection = evaluateInjectionIsolation(scenario, byLane);
  return {
    id: scenario.id,
    allocationDeterministic: deepEqual(result, resultAgain),
    criticalRecall: evaluateCriticalRecall(included, scenario.oracle),
    userInstructionPreservation: evaluateUserInstructionPreservation(included, scenario.oracle),
    currentDiffPreservation: evaluateCurrentDiffPreservation(included, scenario.oracle),
    failingTestPreservation: evaluateFailingTestPreservation(included, scenario.oracle),
    lineRefAccuracy: evaluateLineRefAccuracy(scenario.repoMetas),
    budgetOverflow: evaluateBudgetOverflow(result, DEFAULT_CONTEXT_PROFILE),
    injectionDetectedRate: injection.detectedRate,
    injectionConfinedRate: injection.confinedRate,
    injectionIsolationRate: injection.rate,
    redactionCorrectness: evaluateRedactionCorrectness(scenario, redacted),
    pathFree: evaluatePathFree(aggregate, scenario),
    estimatedTokensByLane: Object.fromEntries(
      result.lanes.map((lane) => [lane.laneId, lane.estimatedTokens]),
    ),
  };
}

// Builds the provenance map (excluded repo-file itemId -> ContextProvenanceRef) the compaction
// builder consumes. Pure: derives only stableId + scopePath + lineRange from the meta. The builder
// enriches each ref with the per-excerpt contentHash from the lane item text.
export function buildProvenanceMap(excludedMetas) {
  const map = new Map();
  for (const meta of excludedMetas) {
    map.set(meta.id, {
      kind: "repo-file",
      stableId: meta.id,
      scopePath: meta.scopePath,
      lineRange: meta.lineRange,
    });
  }
  return map;
}

// ─── Rehydration round-trip (the load-bearing PR2 phase) ────────────────────────
// For one scenario: allocate, find the EXCLUDED meta-backed repo-file items, build a provenance map
// + per-file content hashes (deny-gate is the caller's job — these synthetic in-corpus paths are
// never denied), build compaction records, then run the REAL readExcerpt round-trip per excluded
// repo-file ref against the fresh corpus fs (resolved + fresh) and ONE ref against a SECOND fs
// snapshot whose file body is mutated (invalidation detection). The provenance map + fileHashes are
// internal — never printed. Returns the data the pure metric evaluators score.
async function rehydrateScenario(scenario) {
  const redacted = redactLanes(scenario.lanes);
  const result = allocateContext({
    profile: DEFAULT_CONTEXT_PROFILE,
    budget: DEFAULT_CONTEXT_BUDGET,
    lanes: redacted,
  });
  const excludedMetas = excludedRepoFileMetas(result, scenario.repoMetas);
  const { fs, scope } = buildRepoFs();
  const provenance = buildProvenanceMap(excludedMetas);
  const fileHashes = new Map();
  for (const meta of excludedMetas) {
    fileHashes.set(meta.scopePath, await fileContentHash(fs, corpusAbsolutePath(meta.scopePath)));
  }
  const records = buildCompactionRecords({
    result,
    lanes: redacted,
    provenance,
    orderedAt: FIXED_ORDERED_AT,
    fileHashes,
  });
  const enrichedById = enrichedSpanIndex(records);
  const roundTrips = [];
  for (const meta of excludedMetas) {
    const ref = enrichedById.get(meta.id) ?? provenance.get(meta.id);
    roundTrips.push(await rehydrateProvenanceRef(ref, scope, fs));
  }
  const mutatedResult = await probeInvalidation(excludedMetas, enrichedById, provenance);
  return { id: scenario.id, excludedMetas, records, roundTrips, mutatedResult };
}

// Indexes the contentHash-enriched repo-file spans the builder emitted, by stableId, so the
// round-trip rehydrates with the EXACT compaction-time excerpt hash (a fresh read must match).
function enrichedSpanIndex(records) {
  const byId = new Map();
  for (const record of records) {
    for (const span of record.sourceSpans ?? []) {
      if (span.kind === "repo-file") {
        byId.set(span.stableId, span);
      }
    }
  }
  return byId;
}

// Rehydrates ONE excluded repo-file ref against a SECOND fs snapshot whose file body is changed, to
// prove a mutated source is flagged invalidated. Uses the fresh corpus fs nowhere — a separate
// buildRepoFs override — so the resolved+fresh checks are unaffected. Returns {resolved:false} when
// there is no excluded repo-file to probe (the non-vacuous guard rejects that case before gating).
async function probeInvalidation(excludedMetas, enrichedById, provenance) {
  const target = excludedMetas[0];
  if (target === undefined) {
    return { resolved: false };
  }
  const ref = enrichedById.get(target.id) ?? provenance.get(target.id);
  const mutated = buildRepoFs({ [target.scopePath]: MUTATED_FILE_BODY });
  return rehydrateProvenanceRef(ref, mutated.scope, mutated.fs);
}

function minOf(values) {
  return values.reduce((min, value) => Math.min(min, value), 1);
}

function aggregateScenarioMetrics(perScenario) {
  const overflowCount = perScenario.filter((s) => s.budgetOverflow).length;
  return {
    scenarios: perScenario.length,
    budgetOverflowRate: fraction(overflowCount, perScenario.length),
    criticalFactPreservationRecall: minOf(perScenario.map((s) => s.criticalRecall)),
    userInstructionPreservation: minOf(perScenario.map((s) => s.userInstructionPreservation)),
    currentDiffPreservation: minOf(perScenario.map((s) => s.currentDiffPreservation)),
    failingTestPreservation: minOf(perScenario.map((s) => s.failingTestPreservation)),
    repoEvidenceLineRefAccuracy: minOf(perScenario.map((s) => s.lineRefAccuracy)),
    promptInjectionIsolationRate: minOf(perScenario.map((s) => s.injectionIsolationRate)),
    redactionCorrectness: minOf(perScenario.map((s) => s.redactionCorrectness)),
    pathFreeComplianceRate: minOf(perScenario.map((s) => s.pathFree)),
  };
}

// Aggregates the load-bearing rehydration metrics across scenarios. rehydrationReadiness and
// compactionPreservation are the WORST (min) scenario value; invalidationDetected is the AND across
// scenarios that had something to probe; excludedRepoFiles is the TOTAL meta-backed repo-file
// eviction denominator (the non-vacuous signal).
export function aggregateRehydrationMetrics(rehydrations) {
  const excludedRepoFiles = rehydrations.reduce((sum, r) => sum + r.excludedMetas.length, 0);
  const probed = rehydrations.filter((r) => r.excludedMetas.length > 0);
  return {
    excludedRepoFiles,
    rehydrationReadiness: minOf(
      rehydrations.map((r) => evaluateRehydrationReadiness(r.roundTrips)),
    ),
    compactionPreservation: minOf(
      rehydrations.map((r) => evaluateCompactionPreservation(r.excludedMetas, r.records)),
    ),
    invalidationDetected:
      probed.length > 0 && probed.every((r) => evaluateInvalidationDetected(r.mutatedResult)),
  };
}

// ─── Latency (the ONLY nondeterministic measurement) ────────────────────────────
function measureAssemblyLatency(scenarios) {
  const inputs = scenarios.map((scenario) => ({
    profile: DEFAULT_CONTEXT_PROFILE,
    budget: DEFAULT_CONTEXT_BUDGET,
    lanes: redactLanes(scenario.lanes),
  }));
  for (let i = 0; i < LATENCY_WARMUP; i += 1) {
    for (const input of inputs) {
      allocateContext(input);
    }
  }
  const samples = [];
  for (let i = 0; i < LATENCY_ITERATIONS; i += 1) {
    const start = performance.now();
    for (const input of inputs) {
      allocateContext(input);
    }
    samples.push(performance.now() - start);
  }
  return samples;
}

// Determinism across the WHOLE summary (excluding latency numbers): run the scenario evaluation
// twice and confirm byte-stability. Pure given the corpus.
function evaluateSummaryDeterminism(scenarios) {
  const once = scenarios.map(evaluateScenario);
  const twice = scenarios.map(evaluateScenario);
  const perAllocation = once.every((s) => s.allocationDeterministic);
  return { perScenario: once, byteStable: deepEqual(once, twice) && perAllocation };
}

// ─── Summary assembly ───────────────────────────────────────────────────────────
export function buildSummary(
  scenarios,
  latencySamples,
  chatLatencySamples,
  rehydrations,
  shaping,
  chat,
) {
  const determinism = evaluateSummaryDeterminism(scenarios);
  const metrics = aggregateScenarioMetrics(determinism.perScenario);
  const rehydration = aggregateRehydrationMetrics(rehydrations);
  return {
    schemaVersion: "1",
    measured: buildMeasuredSummary(metrics, determinism.byteStable, rehydration, shaping, chat),
    latency: buildLatencySummary(latencySamples),
    chatLatency: buildChatLatencySummary(chatLatencySamples),
    perScenario: determinism.perScenario.map((s) => ({
      id: s.id,
      criticalRecall: s.criticalRecall,
      budgetOverflow: s.budgetOverflow,
      injectionIsolationRate: s.injectionIsolationRate,
      estimatedTokensByLane: s.estimatedTokensByLane,
    })),
  };
}

function buildMeasuredSummary(metrics, determinism, rehydration, shaping, chat) {
  return {
    ...metrics,
    determinism,
    rehydrationReadiness: rehydration.rehydrationReadiness,
    compactionPreservation: rehydration.compactionPreservation,
    invalidationDetected: rehydration.invalidationDetected,
    excludedRepoFiles: rehydration.excludedRepoFiles,
    toolObservationShapingFidelity: shaping.fidelity,
    shapingRedactionClean: shaping.shapingRedactionClean,
    shapingInjectionFlagged: shaping.shapingInjectionFlagged,
    chatLongSessionCompaction: chat.chatLongSessionCompaction,
    chatManyShortBudgetSafeUnchanged: chat.chatManyShortBudgetSafeUnchanged,
    chatCurrentInstructionPreserved: chat.chatCurrentInstructionPreserved,
    chatShortSessionByteIdentical: chat.chatShortSessionByteIdentical,
    chatNoProfileUnchanged: chat.chatNoProfileUnchanged,
    chatNoProfileOverflowCompaction: chat.chatNoProfileOverflowCompaction,
  };
}

function buildLatencySummary(latencySamples) {
  return {
    p50Ms: percentile(latencySamples, 50),
    p95Ms: percentile(latencySamples, 95),
    iterations: LATENCY_ITERATIONS,
    note: "the ONLY nondeterministic measurement; gated by a generous soft ceiling",
  };
}

function buildChatLatencySummary(chatLatencySamples) {
  return {
    p50Ms: percentile(chatLatencySamples, 50),
    p95Ms: percentile(chatLatencySamples, 95),
    iterations: CHAT_LATENCY_ITERATIONS,
    note: "real chat-compaction slow-path latency, measured separately from allocator latency",
  };
}

// ─── Budget evaluation ──────────────────────────────────────────────────────────
// Declarative spec: each row names the metric, how to read its observed value + threshold off the
// summary/budget, and the comparison direction ("min" => observed >= threshold; "max" => observed
// <= threshold; "flag" => threshold falsy OR observed === true). Keeps the evaluator a tight loop.
const BUDGET_CHECKS = [
  {
    metric: "budgetOverflowRate",
    observed: (s) => s.measured.budgetOverflowRate,
    threshold: (b) => b.maxBudgetOverflowRate,
    kind: "max",
  },
  {
    metric: "criticalFactPreservationRecall",
    observed: (s) => s.measured.criticalFactPreservationRecall,
    threshold: (b) => b.minCriticalFactPreservationRecall,
    kind: "min",
  },
  {
    metric: "userInstructionPreservation",
    observed: (s) => s.measured.userInstructionPreservation,
    threshold: (b) => b.minUserInstructionPreservation,
    kind: "min",
  },
  {
    metric: "currentDiffPreservation",
    observed: (s) => s.measured.currentDiffPreservation,
    threshold: (b) => b.minCurrentDiffPreservation,
    kind: "min",
  },
  {
    metric: "failingTestPreservation",
    observed: (s) => s.measured.failingTestPreservation,
    threshold: (b) => b.minFailingTestPreservation,
    kind: "min",
  },
  {
    metric: "repoEvidenceLineRefAccuracy",
    observed: (s) => s.measured.repoEvidenceLineRefAccuracy,
    threshold: (b) => b.minRepoEvidenceLineRefAccuracy,
    kind: "min",
  },
  {
    metric: "promptInjectionIsolationRate",
    observed: (s) => s.measured.promptInjectionIsolationRate,
    threshold: (b) => b.minPromptInjectionIsolationRate,
    kind: "min",
  },
  {
    metric: "redactionCorrectness",
    observed: (s) => s.measured.redactionCorrectness,
    threshold: (b) => b.minRedactionCorrectness,
    kind: "min",
  },
  {
    metric: "pathFreeComplianceRate",
    observed: (s) => s.measured.pathFreeComplianceRate,
    threshold: (b) => b.minPathFreeComplianceRate,
    kind: "min",
  },
  {
    metric: "determinism",
    observed: (s) => s.measured.determinism,
    threshold: (b) => b.determinismRequired,
    kind: "flag",
  },
  {
    metric: "rehydrationReadiness",
    observed: (s) => s.measured.rehydrationReadiness,
    threshold: (b) => b.minRehydrationReadiness,
    kind: "min",
  },
  {
    metric: "compactionPreservation",
    observed: (s) => s.measured.compactionPreservation,
    threshold: (b) => b.minCompactionPreservation,
    kind: "min",
  },
  {
    metric: "invalidationDetected",
    observed: (s) => s.measured.invalidationDetected,
    threshold: (b) => b.requireInvalidationDetected,
    kind: "flag",
  },
  {
    metric: "toolObservationShapingFidelity",
    observed: (s) => s.measured.toolObservationShapingFidelity,
    threshold: (b) => b.minToolObservationShapingFidelity,
    kind: "min",
  },
  {
    metric: "shapingRedactionClean",
    observed: (s) => s.measured.shapingRedactionClean,
    threshold: (b) => b.requireShapingRedactionClean,
    kind: "flag",
  },
  {
    metric: "shapingInjectionFlagged",
    observed: (s) => s.measured.shapingInjectionFlagged,
    threshold: (b) => b.requireShapingInjectionFlagged,
    kind: "flag",
  },
  {
    metric: "chatLongSessionCompaction",
    observed: (s) => s.measured.chatLongSessionCompaction,
    threshold: (b) => b.requireChatLongSessionCompaction,
    kind: "flag",
  },
  {
    metric: "chatManyShortBudgetSafeUnchanged",
    observed: (s) => s.measured.chatManyShortBudgetSafeUnchanged,
    threshold: (b) => b.requireChatManyShortBudgetSafeUnchanged,
    kind: "flag",
  },
  {
    metric: "chatCurrentInstructionPreserved",
    observed: (s) => s.measured.chatCurrentInstructionPreserved,
    threshold: (b) => b.requireChatCurrentInstructionPreserved,
    kind: "flag",
  },
  {
    metric: "chatShortSessionByteIdentical",
    observed: (s) => s.measured.chatShortSessionByteIdentical,
    threshold: (b) => b.requireChatShortSessionByteIdentical,
    kind: "flag",
  },
  {
    metric: "chatNoProfileUnchanged",
    observed: (s) => s.measured.chatNoProfileUnchanged,
    threshold: (b) => b.requireChatNoProfileUnchanged,
    kind: "flag",
  },
  {
    metric: "chatNoProfileOverflowCompaction",
    observed: (s) => s.measured.chatNoProfileOverflowCompaction,
    threshold: (b) => b.requireChatNoProfileOverflowCompaction,
    kind: "flag",
  },
  {
    metric: "chatCompactionLatencyP95Ms",
    observed: (s) => s.chatLatency.p95Ms,
    threshold: (b) => b.maxChatCompactionLatencyP95Ms,
    kind: "max",
  },
  {
    metric: "assemblyLatencyP95Ms",
    observed: (s) => s.latency.p95Ms,
    threshold: (b) => b.maxAssemblyLatencyP95Ms,
    kind: "max",
  },
];

function passesCheck(kind, observed, threshold) {
  if (kind === "min") return observed >= threshold;
  if (kind === "max") return observed <= threshold;
  return !threshold || observed === true;
}

export function evaluateContextQualityBudget(summary, budget) {
  const failures = [];
  for (const spec of BUDGET_CHECKS) {
    const observed = spec.observed(summary);
    const threshold = spec.threshold(budget);
    if (!passesCheck(spec.kind, observed, threshold)) {
      failures.push({ metric: spec.metric, observed, threshold });
    }
  }
  return { ok: failures.length === 0, failures };
}

function formatPct(value) {
  return `${(value * 100).toFixed(1)}%`;
}

// NON-VACUOUS GUARD: the rehydrationReadiness/compactionPreservation denominator is the count of
// EXCLUDED meta-backed repo-file items. If the corpus stopped actually evicting them, those metrics
// would silently revert to a meaningless 100% over an empty set. We FAIL hard below the floor so the
// gate can never become vacuous again. Pure: a boolean check over the measured count.
export function evaluateNonVacuousRehydration(summary, minExcluded = MIN_EVICTED_REPO_FILES) {
  const observed = summary.measured.excludedRepoFiles;
  return { ok: observed >= minExcluded, observed, required: minExcluded };
}

// ─── Runner ──────────────────────────────────────────────────────────────────────
// Path-free, secret-free one-line summaries (counts + percentages + booleans only).
function logSummary(onLog, summary, vacuity) {
  const m = summary.measured;
  onLog(
    `context-quality: scenarios=${String(m.scenarios)} critical-recall=${formatPct(
      m.criticalFactPreservationRecall,
    )} user-instr=${formatPct(m.userInstructionPreservation)} diff=${formatPct(
      m.currentDiffPreservation,
    )} failing-test=${formatPct(m.failingTestPreservation)} line-ref=${formatPct(
      m.repoEvidenceLineRefAccuracy,
    )} injection-isolation=${formatPct(m.promptInjectionIsolationRate)} redaction=${formatPct(
      m.redactionCorrectness,
    )} path-free=${formatPct(m.pathFreeComplianceRate)} overflow-rate=${formatPct(
      m.budgetOverflowRate,
    )} determinism=${String(m.determinism)} p50=${summary.latency.p50Ms.toFixed(
      2,
    )}ms p95=${summary.latency.p95Ms.toFixed(2)}ms chat-p95=${summary.chatLatency.p95Ms.toFixed(
      2,
    )}ms.`,
  );
  onLog(
    `context-quality measured (PR2 load-bearing): rehydration-readiness=${formatPct(
      m.rehydrationReadiness,
    )} compaction-preservation=${formatPct(m.compactionPreservation)} invalidation-detected=${String(
      m.invalidationDetected,
    )} excluded-repo-files=${String(m.excludedRepoFiles)} (non-vacuous floor ${String(
      vacuity.required,
    )}).`,
  );
  onLog(
    `context-quality measured (PR3 load-bearing): tool-shaping-fidelity=${formatPct(
      m.toolObservationShapingFidelity,
    )} shaping-redaction-clean=${String(
      m.shapingRedactionClean,
    )} shaping-injection-flagged=${String(m.shapingInjectionFlagged)}.`,
  );
  onLog(
    `context-quality measured (PR4 load-bearing chat-compaction splice): long-session-compaction=${String(
      m.chatLongSessionCompaction,
    )} many-short-budget-safe-unchanged=${String(
      m.chatManyShortBudgetSafeUnchanged,
    )} current-instruction-preserved=${String(
      m.chatCurrentInstructionPreserved,
    )} short-session-byte-identical=${String(
      m.chatShortSessionByteIdentical,
    )} no-profile-unchanged=${String(
      m.chatNoProfileUnchanged,
    )} no-profile-overflow-compaction=${String(m.chatNoProfileOverflowCompaction)}.`,
  );
}

function reportFailures(onFail, vacuity, budgetResult) {
  if (!vacuity.ok) {
    onFail(
      `context-quality non-vacuous guard failed: excludedRepoFiles(observed=${String(
        vacuity.observed,
      )}, required>=${String(vacuity.required)}) — the corpus must evict >= ${String(
        vacuity.required,
      )} meta-backed repo-evidence items or rehydrationReadiness is meaningless.`,
    );
  }
  if (!budgetResult.ok) {
    const detail = budgetResult.failures
      .map((f) => `${f.metric}(observed=${String(f.observed)}, threshold=${String(f.threshold)})`)
      .join(", ");
    onFail(`context-quality budget failed: ${detail}`);
  }
}

async function rehydrateScenarios(scenarios) {
  const rehydrations = [];
  for (const scenario of scenarios) {
    rehydrations.push(await rehydrateScenario(scenario));
  }
  return rehydrations;
}

export async function runContextQualityCheck({ budgetPath = DEFAULT_BUDGET_PATH, log, fail } = {}) {
  const onLog = log ?? ((message) => console.log(message));
  const onFail =
    fail ??
    ((message) => {
      console.error(`context-quality check failed: ${message}`);
      process.exit(1);
    });
  const budget = JSON.parse(readFileSync(budgetPath, "utf8"));
  const scenarios = await buildScenarioCorpus();
  const latencySamples = measureAssemblyLatency(scenarios);
  const chatFixtures = buildChatHistoryFixtures();
  const chatLatencySamples = measureChatCompactionLatency(chatFixtures);
  const rehydrations = await rehydrateScenarios(scenarios);
  const shaping = evaluateToolObservationShapingFidelity(await buildToolObservationFixtures());
  const chat = evaluateChatCompaction(chatFixtures);
  const summary = buildSummary(
    scenarios,
    latencySamples,
    chatLatencySamples,
    rehydrations,
    shaping,
    chat,
  );
  const vacuity = evaluateNonVacuousRehydration(summary);
  const budgetResult = evaluateContextQualityBudget(summary, budget);
  logSummary(onLog, summary, vacuity);
  reportFailures(onFail, vacuity, budgetResult);
  return { summary, budgetResult, vacuity };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runContextQualityCheck();
}
