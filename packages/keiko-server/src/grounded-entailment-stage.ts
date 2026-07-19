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
  reconcileInlineCitations,
  unsupportedClaimMarker,
  type EntailmentJudge,
  type EntailmentOptions,
  type EntailmentReconciliation,
} from "./grounded-faithfulness.js";
import { createGatewayEntailmentJudge } from "./grounded-entailment-judge.js";
import type { ServerDiagnosticSink } from "./diagnostics-log.js";
import type { UiHandlerDeps } from "./deps.js";

export interface EntailmentStage {
  // Judge the answer's citations for support against their in-pack excerpts and return the resulting
  // uncertainty markers (possibly empty). Never throws; never mutates the answer text.
  readonly evaluate: (
    answerText: string,
    packs: readonly ConnectedContextPack[],
    nowMs: number,
  ) => Promise<readonly UncertaintyMarker[]>;
}

export interface EntailmentStageObservability {
  readonly diagnostics?: ServerDiagnosticSink | undefined;
  readonly correlationId?: string | undefined;
}

function recordDiagnostic(
  observability: EntailmentStageObservability,
  nowMs: number,
  errorClass: string,
  message: string,
): void {
  const sink = observability.diagnostics;
  if (sink === undefined || observability.correlationId === undefined) {
    return;
  }
  sink.record({
    correlationId: observability.correlationId,
    timestamp: new Date(nowMs).toISOString(),
    operation: "grounded.entailment",
    source: "grounded.entailment-stage",
    errorClass,
    message,
  });
}

function markersFor(
  result: EntailmentReconciliation,
  nowMs: number,
  observability: EntailmentStageObservability,
): readonly UncertaintyMarker[] {
  const markers: UncertaintyMarker[] = [];
  const unsupported = unsupportedClaimMarker(result.unentailed, nowMs);
  if (unsupported !== undefined) {
    markers.push(unsupported);
  }
  if (result.unavailableClaims > 0) {
    markers.push(entailmentUnavailableMarker(nowMs));
    // Body-free: counts + failure class only, no claim/excerpt text.
    recordDiagnostic(
      observability,
      nowMs,
      "EntailmentJudgeUnavailable",
      `entailment judge unavailable for ${String(result.unavailableClaims)} of ` +
        `${String(result.judgedClaims)} judged claims`,
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
  observability: EntailmentStageObservability,
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
    // operator diagnostic and continue.
    recordDiagnostic(
      observability,
      nowMs,
      error instanceof Error ? error.constructor.name : "EntailmentStageError",
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
  const judge = createGatewayEntailmentJudge(deps, modelId);
  if (judge === undefined) {
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
      evaluateEntailment(answerText, packs, nowMs, judge, options, observability, signal),
  };
}
