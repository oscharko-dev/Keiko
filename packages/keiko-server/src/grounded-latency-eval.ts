// Audit KEIKO-0053 — grounded retrieval + entailment LATENCY eval.
//
// `check:grounded-retrieval-quality` drives the real semantic + RRF + reranker path but records no
// timing (re-grepped for `performance.`/`Date.now`/`elapsed`: zero matches), and
// `check:retrieval-latency` times only lexical `searchText` over a synthetic fixture — it never
// touches embeddings, ANN, reranking, or the entailment stage ADR-0144 layered onto the same
// request. A regression that meaningfully slows any of those could land, pass every retrieval and
// context-quality gate, and surface only as users waiting on grounded answers.
//
// This module is the measurement half of that gate; `scripts/check-grounded-retrieval-latency.mjs`
// is the runner. It deliberately reuses `runGroundedRetrievalQualityEval` rather than building a
// second corpus: the QUALITY gate's distractor-dense fixture and real provider wiring are exactly
// the path a latency gate must time, and one fixture cannot drift from itself.
//
// Determinism: the retrieval side uses the quality eval's scripted embedding/rerank ports (no live
// provider), and the entailment side uses the fixed judge below (no live LLM). The gate therefore
// measures CODE-PATH cost, never model variance — a live judge would flake the gate on serving
// latency instead of catching regressions. `DEFAULT_ENTAILMENT_OPTIONS.maxTotalMs` (20s) is a
// per-request safety ceiling, not a performance target, and is deliberately not the budget.

import type { ConnectedContextPack, ContextExcerpt } from "@oscharko-dev/keiko-contracts";
import { CONNECTED_CONTEXT_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts/runtime/connected-context";

import {
  DEFAULT_ENTAILMENT_OPTIONS,
  buildPackCitationIndex,
  buildPackExcerptTextResolver,
  reconcileClaimEntailment,
  reconcileInlineCitations,
  type EntailmentJudge,
} from "./grounded-faithfulness.js";
import { runGroundedRetrievalQualityEval } from "./grounded-retrieval-eval.js";

const FIXTURE_NOW_MS = 1_700_000_000_000;

/**
 * A cited answer whose claim count sits at the stage's `maxClaims` ceiling, so the measurement
 * covers the full bounded parallel judge fan-out rather than a single call. Exported because the
 * suite asserts every cited claim reaches the judge: hard-coding the count there would
 * restate a number this module owns, and would silently weaken the moment the fixture changed.
 */
export const FIXTURE_ANSWER_CLAIMS = 8;

export interface GroundedLatencySample {
  /** Real semantic + RRF + model-rerank path over the distractor-dense eval corpus. */
  readonly retrievalMs: number;
  /** Real citation reconciliation + claim-entailment pass over the answer the model returned. */
  readonly entailmentMs: number;
  /** Claims actually submitted to the judge; guards against a vacuous fixture. */
  readonly judgedClaims: number;
  readonly totalMs: number;
}

export interface GroundedLatencyEvalOptions {
  /**
   * Milliseconds of artificial delay added to every judge call. Exists only so the gate can prove
   * it is not tautological: an injected regression MUST push the observed percentile past the
   * budget. Production measurement passes 0.
   */
  readonly injectedJudgeDelayMs?: number | undefined;
}

function excerptFor(scopePath: string, startLine: number, endLine: number): ContextExcerpt {
  return {
    atom: {
      schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
      stableId: `${scopePath}:${String(startLine)}`,
      scopePath,
      lineRange: { startLine, endLine },
      score: 1,
      provenance: { kind: "lexical-search", tool: "repo.searchText", queryFingerprint: "fp" },
      redactionState: "redacted",
      emittedAtMs: FIXTURE_NOW_MS,
      ledgerRef: undefined,
    },
    // Substantial, but deliberately UNDER `maxExcerptChars` (900). `verdictForClaim` short-circuits
    // a truncated excerpt to `unavailable` WITHOUT calling the judge — an over-long fixture would
    // make every claim skip the judge and the gate would time an entailment pass that never ran.
    content:
      `evidence body for ${scopePath} lines ${String(startLine)}-${String(endLine)}. `.repeat(12),
    contentBytes: 640,
  };
}

function claimPath(index: number): string {
  return `src/module${String(index)}/handler.ts`;
}

function latencyFixtureScope(): ConnectedContextPack["scope"] {
  return {
    schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
    scopeId: "grounded-latency-scope",
    workspaceRoot: "/repo",
    kind: "directory",
    relativePaths: ["src"],
    conversationId: "grounded-latency",
    connectedAtMs: FIXTURE_NOW_MS,
  };
}

function latencyFixtureBudget(): ConnectedContextPack["budget"] {
  return {
    searchCallsMax: 1,
    filesReadMax: 16,
    excerptBytesMax: 65_536,
    modelInputTokensMax: 8000,
    modelOutputTokensMax: 2000,
    elapsedMsMax: 30_000,
    rerankCallsMax: 1,
  };
}

function latencyFixtureUsage(fileCount: number): ConnectedContextPack["usage"] {
  return {
    searchCalls: 1,
    filesRead: fileCount,
    excerptBytes: 1024 * fileCount,
    modelInputTokens: 0,
    modelOutputTokens: 0,
    elapsedMs: 1,
    rerankCalls: 1,
  };
}

function latencyFixturePack(): ConnectedContextPack {
  const files = Array.from({ length: FIXTURE_ANSWER_CLAIMS }, (_unused, index) => ({
    scopePath: claimPath(index),
    role: "read-only" as const,
    selectionReason: "ranked",
    excerpts: [excerptFor(claimPath(index), 1, 40)],
  }));
  return {
    schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
    stableId: "grounded-latency-pack",
    scope: latencyFixtureScope(),
    query: {
      kind: "natural-language",
      text: "how does the request handler validate its input?",
      caseSensitive: false,
      maxResults: 50,
      emittedAtMs: FIXTURE_NOW_MS,
    },
    budget: latencyFixtureBudget(),
    usage: latencyFixtureUsage(files.length),
    files,
    omitted: [],
    uncertainty: [],
    emittedAtMs: FIXTURE_NOW_MS,
    ledgerRef: undefined,
  };
}

function latencyFixtureAnswer(): string {
  return Array.from(
    { length: FIXTURE_ANSWER_CLAIMS },
    (_unused, index) =>
      `The handler in module ${String(index)} validates its input before dispatch ` +
      `[${claimPath(index)}:1-40].`,
  ).join(" ");
}

// A fixed judge: no network, no model, constant verdict. `injectedJudgeDelayMs` is the regression
// probe's only lever, so a failing gate run means the measured code path got slower, not that a
// provider did.
function fixedJudge(injectedJudgeDelayMs: number, onJudge: () => void): EntailmentJudge {
  return {
    judge: async (): Promise<"supported"> => {
      onJudge();
      if (injectedJudgeDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, injectedJudgeDelayMs));
      }
      return "supported";
    },
  };
}

async function measureEntailment(
  injectedJudgeDelayMs: number,
): Promise<{ readonly entailmentMs: number; readonly judgedClaims: number }> {
  const packs = [latencyFixturePack()];
  const answerText = latencyFixtureAnswer();
  let judgedClaims = 0;
  const started = performance.now();
  const membership = reconcileInlineCitations(answerText, buildPackCitationIndex(packs));
  await reconcileClaimEntailment(
    answerText,
    membership,
    buildPackExcerptTextResolver(packs),
    fixedJudge(injectedJudgeDelayMs, () => {
      judgedClaims += 1;
    }),
    DEFAULT_ENTAILMENT_OPTIONS,
  );
  return { entailmentMs: performance.now() - started, judgedClaims };
}

/**
 * One end-to-end sample of the grounded answer path's measurable cost: the real retrieval stack
 * (embedding + RRF fusion + model rerank over the eval corpus) followed by the real citation
 * reconciliation and claim-entailment pass.
 */
export async function runGroundedRetrievalLatencyEval(
  options: GroundedLatencyEvalOptions = {},
): Promise<GroundedLatencySample> {
  const retrievalStarted = performance.now();
  await runGroundedRetrievalQualityEval("baseline");
  const retrievalMs = performance.now() - retrievalStarted;
  const { entailmentMs, judgedClaims } = await measureEntailment(options.injectedJudgeDelayMs ?? 0);
  return { retrievalMs, entailmentMs, judgedClaims, totalMs: retrievalMs + entailmentMs };
}
