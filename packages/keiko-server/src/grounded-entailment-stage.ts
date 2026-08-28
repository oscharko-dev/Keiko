// Grounded entailment STAGE (Knowledge M1.2 / Issue #2563).
//
// The composition point that turns the pure leaf logic (grounded-faithfulness.ts) + the gateway
// judge (grounded-entailment-judge.ts) into an optional, policy-gated, fail-closed post-answer stage
// that the three ConnectedContextPack grounded topologies (single folder / multi folder / hybrid)
// share. It is INJECTED: constructed once per grounded ask from the full deps + chat scope, then run
// after membership reconciliation at each topology's marker-attachment site.
//
// Inertness (byte-identical to pre-#2563 behavior — the AC2 regression pin) holds whenever:
//   * no compatible structured-output judge model is configured (createGatewayEntailmentJudge ⇒
//     undefined), or
//   * the scope carries a knowledge capsule whose resolved model-use policy DENIES `answerSynthesis`
//     (a pod that denies answer synthesis has no synthesized answer to verify — the stage is inert
//     there by construction, sealed-local pods included).
// When active, the stage NEVER blocks or empties the answer: every failure degrades to an
// `entailment-unavailable` WARN marker plus a body-free operator diagnostic (correlation id + counts
// + failure class — never claim text, excerpt text, or file content).

import { randomUUID } from "node:crypto";
import { isScopeModelUseOperationAllowed } from "@oscharko-dev/keiko-local-knowledge";
import type {
  ConnectedContextPack,
  KnowledgeCapsule,
  UncertaintyMarker,
} from "@oscharko-dev/keiko-contracts";
import {
  DEFAULT_ENTAILMENT_OPTIONS,
  buildPackCitationIndex,
  buildPackExcerptTextResolver,
  entailmentUnavailableMarker,
  reconcileClaimEntailment,
  reconcileNumericClaimEntailment,
  reconcileInlineCitations,
  unsupportedClaimMarker,
  type EntailmentJudge,
  type NumericEntailmentEvidence,
  type EntailmentOptions,
  type EntailmentReconciliation,
} from "./grounded-faithfulness.js";
import {
  createGatewayEntailmentJudge,
  entailmentJudgeUnavailableReason,
} from "./grounded-entailment-judge.js";
import {
  contentFreeErrorClass,
  type ServerDiagnosticSink,
  type ServerDiagnosticSummary,
} from "./diagnostics-log.js";
import type { UiHandlerDeps } from "./deps.js";

export interface EntailmentStage {
  // Judge the answer's citations for support against their in-pack excerpts and return the resulting
  // uncertainty markers (possibly empty). Never throws; never mutates the answer text.
  readonly evaluate: (
    answerText: string,
    packs: readonly ConnectedContextPack[],
    nowMs: number,
  ) => Promise<readonly UncertaintyMarker[]>;
  // Numeric connector citations use the same judge, budget, warning vocabulary, and diagnostics
  // as path-and-line citations. Evidence is supplied only from the prompt-selected rendering.
  readonly evaluateNumeric: (
    answerText: string,
    selectedEvidence: readonly NumericEntailmentEvidence[],
    nowMs: number,
  ) => Promise<readonly UncertaintyMarker[]>;
}

export interface EntailmentStageObservability {
  readonly diagnostics?: ServerDiagnosticSink | undefined;
  readonly correlationId?: string | undefined;
}

// The stage's own observability once the correlation id has been settled. Keeping `correlationId`
// required here is what stops a caller that supplies only a sink from silently losing its
// diagnostics — the failure mode #2670 found in all three production call sites.
interface CorrelatedEntailmentObservability {
  readonly diagnostics?: ServerDiagnosticSink | undefined;
  readonly correlationId: string;
}

function recordDiagnostic(
  observability: CorrelatedEntailmentObservability,
  nowMs: number,
  errorClass: string,
  message: ServerDiagnosticSummary,
  code?: string,
): void {
  const sink = observability.diagnostics;
  if (sink === undefined) {
    return;
  }
  // Observability must never break the path it observes. Before this guard, a throwing sink
  // propagated out of createEntailmentStage's inert branch, so an unhealthy diagnostics backend
  // could fail a grounded request that would otherwise have degraded safely to "no entailment".
  try {
    sink.record({
      correlationId: observability.correlationId,
      timestamp: new Date(nowMs).toISOString(),
      operation: "grounded.entailment",
      source: "grounded.entailment-stage",
      errorClass,
      message,
      ...(code === undefined ? {} : { code }),
    });
  } catch {
    // A diagnostics failure is never allowed to escalate into a failed grounded ask.
  }
}

function markersFor(
  result: EntailmentReconciliation,
  nowMs: number,
  observability: CorrelatedEntailmentObservability,
): readonly UncertaintyMarker[] {
  const markers: UncertaintyMarker[] = [];
  const unsupported = unsupportedClaimMarker(result.unentailed, nowMs);
  if (unsupported !== undefined) {
    markers.push(unsupported);
  }
  if (result.unavailableClaims > 0) {
    markers.push(entailmentUnavailableMarker(nowMs));
    // Body-free: counts + failure class only, no claim/excerpt text. Issue #3245: `message` is
    // now the fixed condition label; the two counts (unbounded per-invocation data) move to
    // `code` as a compact machine-readable string instead of being embedded in `message`.
    recordDiagnostic(
      observability,
      nowMs,
      "EntailmentJudgeUnavailable",
      "entailment-claim-judging-incomplete",
      `unavailable=${String(result.unavailableClaims)}:judged=${String(result.judgedClaims)}`,
    );
  }
  return markers;
}

async function evaluateEntailment(
  answerText: string,
  packs: readonly ConnectedContextPack[],
  nowMs: number,
  judge: EntailmentJudge,
  options: EntailmentOptions,
  observability: CorrelatedEntailmentObservability,
  signal: AbortSignal | undefined,
): Promise<readonly UncertaintyMarker[]> {
  try {
    const membership = reconcileInlineCitations(answerText, buildPackCitationIndex(packs));
    const resolveExcerptText = buildPackExcerptTextResolver(packs);
    const result = await reconcileClaimEntailment(
      answerText,
      membership,
      resolveExcerptText,
      judge,
      options,
      signal,
    );
    return markersFor(result, nowMs, observability);
  } catch (error) {
    // Fail-closed: the stage must never block or empty the answer. Surface a WARN + a body-free
    // operator diagnostic (bounded, content-free class — instance `name`/`constructor` are
    // hostile-writable) and continue.
    recordDiagnostic(
      observability,
      nowMs,
      contentFreeErrorClass(error),
      "entailment stage failed; degraded to WARN",
    );
    return [entailmentUnavailableMarker(nowMs)];
  }
}

async function evaluateNumericEntailment(
  answerText: string,
  selectedEvidence: readonly NumericEntailmentEvidence[],
  nowMs: number,
  judge: EntailmentJudge,
  options: EntailmentOptions,
  observability: CorrelatedEntailmentObservability,
  signal: AbortSignal | undefined,
): Promise<readonly UncertaintyMarker[]> {
  try {
    const result = await reconcileNumericClaimEntailment(
      answerText,
      selectedEvidence,
      judge,
      options,
      signal,
    );
    return markersFor(result, nowMs, observability);
  } catch (error) {
    recordDiagnostic(
      observability,
      nowMs,
      contentFreeErrorClass(error),
      "entailment stage failed; degraded to WARN",
    );
    return [entailmentUnavailableMarker(nowMs)];
  }
}

/**
 * Build the entailment stage for a grounded ask, or `undefined` when it must stay inert (no judge
 * model configured, or a capsule policy denies answer synthesis). `modelId` is the model that
 * synthesized the answer — entailment verification is a second pass over that answer, so it reuses
 * the same configured model (no hardcoded judge model).
 */
export function createEntailmentStage(
  deps: UiHandlerDeps,
  capsules: readonly KnowledgeCapsule[],
  modelId: string,
  observability: EntailmentStageObservability = {},
  signal?: AbortSignal,
  options: EntailmentOptions = DEFAULT_ENTAILMENT_OPTIONS,
): EntailmentStage | undefined {
  if (capsules.length > 0 && !isScopeModelUseOperationAllowed(capsules, "answerSynthesis")) {
    return undefined;
  }
  // Every production call site hands down a diagnostics sink but has no upstream correlation token
  // to pair with it (the folder orchestrator never sees an answer id), which silently disabled the
  // operator diagnostic this stage promises. Mint one per stage — the stage's lifetime is exactly
  // one grounded ask — matching the workspace-index provider's convention for the same situation.
  const correlated: CorrelatedEntailmentObservability = {
    ...observability,
    correlationId: observability.correlationId ?? randomUUID(),
  };
  const judge = createGatewayEntailmentJudge(deps, modelId, correlated.correlationId);
  if (judge === undefined) {
    // KEIKO-0359: report WHY the stage is inert. Going inert used to be completely silent, so a
    // model whose capability metadata Gateway Setup never enriched looked identical to a model
    // that genuinely cannot do structured output — and the stage stayed off indefinitely with
    // nothing an operator could act on. Body-free: the reason code only, no capability payload.
    const reason = entailmentJudgeUnavailableReason(deps, modelId);
    if (reason !== undefined) {
      recordDiagnostic(correlated, Date.now(), "EntailmentStageInert", reason);
    }
    return undefined;
  }
  // The request signal is baked in here (the stage's lifetime is the grounded ask's): a client
  // cancellation stops the remaining sequential judge calls early, and the per-answer wall-clock
  // budget in reconcileClaimEntailment bounds the worst case even when the request never cancels.
  return {
    evaluate: (
      answerText: string,
      packs: readonly ConnectedContextPack[],
      nowMs: number,
    ): Promise<readonly UncertaintyMarker[]> =>
      evaluateEntailment(answerText, packs, nowMs, judge, options, correlated, signal),
    evaluateNumeric: (
      answerText: string,
      selectedEvidence: readonly NumericEntailmentEvidence[],
      nowMs: number,
    ): Promise<readonly UncertaintyMarker[]> =>
      evaluateNumericEntailment(
        answerText,
        selectedEvidence,
        nowMs,
        judge,
        options,
        correlated,
        signal,
      ),
  };
}
