// Observed connector actions — the audit/consent/metrics hook points (Epic #750, Issue #760).
//
// PURELY ADDITIVE over #751/#753/#758/#759: this module does NOT change the connector, snapshot
// builder, re-snapshot, or token-store behaviour. It composes them with the three governance
// concerns so the future route tier (#756) calls ONE function per action and gets:
//   - consent gating before the FIRST fetch (connect / snapshot / resnapshot),
//   - an audit entry on success AND on a coded failure (re-raising the original error),
//   - operational metrics on a successful snapshot / re-snapshot.
//
// The scopeRef is derived from the connector's token-free provenance, so no board id / link ever
// reaches the audit or metrics. The actual board fetch is delegated to the injected action; this
// wrapper only observes it.

import { FigmaConnectorError } from "./figmaConnectorErrors.js";
import {
  appendFigmaConnectorAudit,
  type FigmaConnectorAction,
  type FigmaConnectorAuditCounts,
} from "./figmaConnectorAudit.js";
import { assertReadOnlyConsent } from "./figmaConsent.js";
import {
  computeFigmaConnectorMetrics,
  type FigmaAugmentationTally,
  type FigmaConnectorMetrics,
  type FigmaConnectorMetricsExtras,
} from "./figmaConnectorMetrics.js";
import { deriveFigmaScopeRef, type FigmaScopeRef } from "./figmaScopeRef.js";
import type { FigmaProvenance } from "./figmaConnector.js";
import type { FigmaSnapshot } from "./figmaSnapshotTypes.js";
import type { QualityIntelligenceFigma } from "@oscharko-dev/keiko-quality-intelligence";

export interface ObservedActionContext {
  readonly evidenceDir: string;
  readonly now: string;
}

const auditFailureAndRethrow = (
  ctx: ObservedActionContext,
  scopeRef: FigmaScopeRef,
  action: FigmaConnectorAction,
  error: unknown,
): never => {
  const errorCode = error instanceof FigmaConnectorError ? error.code : ("FIGMA_INTERNAL" as const);
  appendFigmaConnectorAudit({
    scopeRef,
    evidenceDir: ctx.evidenceDir,
    action,
    outcome: "error",
    errorCode,
    now: ctx.now,
  });
  throw error;
};

const countsOf = (
  ir: QualityIntelligenceFigma.ScreenIrResult,
  snapshot: FigmaSnapshot,
): FigmaConnectorAuditCounts => ({
  screens: ir.screens.length,
  renders: snapshot.screens.length,
  skipped: snapshot.skippedScreens.length,
  designTokens:
    ir.tokens.colors.length +
    ir.tokens.typography.length +
    ir.tokens.spacing.length +
    ir.tokens.radius.length,
  ...(ir.links.length > 0 ? { navTransitions: ir.links.length } : {}),
});

export interface ObservedSnapshotInput {
  readonly ctx: ObservedActionContext;
  /** Token-free provenance from the connector fetch — the scopeRef source. */
  readonly provenance: FigmaProvenance;
  readonly ir: QualityIntelligenceFigma.ScreenIrResult;
  readonly augmentation: FigmaAugmentationTally;
  readonly extras?: FigmaConnectorMetricsExtras;
  /** `true` for a re-snapshot action, `false`/omitted for an initial snapshot. */
  readonly isResnapshot?: boolean;
  /** Performs the actual render + assembly (delegates to buildFigmaSnapshot / resnapshotFigma). */
  readonly run: () => Promise<FigmaSnapshot>;
}

export interface ObservedSnapshotResult {
  readonly snapshot: FigmaSnapshot;
  readonly metrics: FigmaConnectorMetrics;
  readonly scopeRef: FigmaScopeRef;
}

/**
 * Observe a snapshot or re-snapshot: gate on consent, run the build, then audit (with counts) and
 * compute metrics on success, or audit the coded failure and re-raise. The build itself is injected
 * so no #753/#759 behaviour changes.
 */
export const observeFigmaSnapshot = async (
  input: ObservedSnapshotInput,
): Promise<ObservedSnapshotResult> => {
  const scopeRef = deriveFigmaScopeRef(input.provenance.fileKey, input.provenance.nodeId);
  const action: FigmaConnectorAction = input.isResnapshot === true ? "resnapshot" : "snapshot";
  // Consent is a precondition checked BEFORE the action starts, so a consent-denied attempt throws
  // here and produces no audit entry: it is a refused precondition, not a connector-action outcome.
  assertReadOnlyConsent(scopeRef, input.ctx.evidenceDir);

  let snapshot: FigmaSnapshot;
  try {
    snapshot = await input.run();
  } catch (error) {
    return auditFailureAndRethrow(input.ctx, scopeRef, action, error);
  }

  const metrics = computeFigmaConnectorMetrics(
    input.ir,
    snapshot,
    input.augmentation,
    input.extras ?? {},
  );
  appendFigmaConnectorAudit({
    scopeRef,
    evidenceDir: input.ctx.evidenceDir,
    action,
    outcome: "ok",
    counts: countsOf(input.ir, snapshot),
    now: input.ctx.now,
  });
  return { snapshot, metrics, scopeRef };
};

export interface ObservedRevokeInput {
  readonly ctx: ObservedActionContext;
  readonly scopeRef: FigmaScopeRef;
  /** Performs the actual key removal (delegates to FigmaTokenStore.revoke). */
  readonly run: () => void;
}

/**
 * Observe a revoke (key removal): run it, then audit the action. Revoke needs no consent gate — it
 * removes access — and produces no metrics. A failure is audited then re-raised.
 */
export const observeFigmaRevoke = (input: ObservedRevokeInput): void => {
  try {
    input.run();
  } catch (error) {
    auditFailureAndRethrow(input.ctx, input.scopeRef, "revoke", error);
  }
  appendFigmaConnectorAudit({
    scopeRef: input.scopeRef,
    evidenceDir: input.ctx.evidenceDir,
    action: "revoke",
    outcome: "ok",
    now: input.ctx.now,
  });
};
