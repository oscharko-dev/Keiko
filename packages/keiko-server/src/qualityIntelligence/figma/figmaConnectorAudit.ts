// Connector-activity audit ledger for the Figma connector (Epic #750, Issue #760).
//
// Reuses the SAME Evidence audit seam the QI inline-edit audit uses (`appendEditAudit` in
// ../reviewStore.ts → `createNodeContainedJsonArtifactStore` in keiko-evidence): an append-only,
// contained, atomically-written JSON artifact under `<evidenceDir>/qi/`. This module does NOT build
// a parallel store — it records connector actions through that one seam under a distinct suffix.
//
// GOVERNANCE (load-bearing, #760): an audit entry carries ONLY
//   - the action (connect | snapshot | resnapshot | revoke),
//   - the opaque, non-reversible `scopeRef` (never the file key / node id / board link),
//   - the outcome (ok | error) and, on error, a coded `errorCode`,
//   - small INTEGER counts (screens, renders, skipped, design tokens, optional nav transitions),
//   - a wall-clock `at`.
// It carries NO token, NO PII, NO board id / link / name, and NO design content (no screen names,
// no text). Counts are the only board-derived data and they are pure cardinalities.

import {
  createNodeContainedJsonArtifactStore,
  type ContainedJsonArtifactStore,
} from "@oscharko-dev/keiko-evidence";
import type { FigmaConnectorErrorCode } from "./figmaConnectorErrors.js";
import type { FigmaScopeRef } from "./figmaScopeRef.js";

export const FIGMA_AUDIT_SCHEMA_VERSION = 1 as const;
const FIGMA_AUDIT_SUFFIX = ".figma-audit.json";

export type FigmaConnectorAction = "connect" | "snapshot" | "resnapshot" | "revoke";
export type FigmaConnectorOutcome = "ok" | "error";

/** Pure cardinalities only — never names, ids, links, or design content. */
export interface FigmaConnectorAuditCounts {
  readonly screens: number;
  readonly renders: number;
  readonly skipped: number;
  readonly designTokens: number;
  /** Inter-screen transitions; present only when the IR carried links (nav graph #811 is additive). */
  readonly navTransitions?: number;
}

export interface FigmaConnectorAuditEntry {
  readonly at: string;
  readonly action: FigmaConnectorAction;
  readonly outcome: FigmaConnectorOutcome;
  /** Present only when `outcome === "error"`. A coded, safe error from the connector taxonomy. */
  readonly errorCode?: FigmaConnectorErrorCode;
  /** Present only on a successful action that produced board cardinalities. */
  readonly counts?: FigmaConnectorAuditCounts;
}

export interface FigmaConnectorAuditArtifact {
  readonly figmaAuditSchemaVersion: typeof FIGMA_AUDIT_SCHEMA_VERSION;
  readonly scopeRef: FigmaScopeRef;
  readonly auditLog: readonly FigmaConnectorAuditEntry[];
  readonly lastUpdatedAt: string;
}

const parseArtifact = (value: unknown): FigmaConnectorAuditArtifact | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (record.figmaAuditSchemaVersion !== FIGMA_AUDIT_SCHEMA_VERSION) return undefined;
  if (typeof record.scopeRef !== "string" || !Array.isArray(record.auditLog)) return undefined;
  return value as FigmaConnectorAuditArtifact;
};

const storeFor = (evidenceDir: string): ContainedJsonArtifactStore<FigmaConnectorAuditArtifact> =>
  createNodeContainedJsonArtifactStore(evidenceDir, FIGMA_AUDIT_SUFFIX, { parse: parseArtifact });

const emptyArtifact = (scopeRef: FigmaScopeRef, now: string): FigmaConnectorAuditArtifact => ({
  figmaAuditSchemaVersion: FIGMA_AUDIT_SCHEMA_VERSION,
  scopeRef,
  auditLog: [],
  lastUpdatedAt: now,
});

export const loadFigmaConnectorAudit = (
  scopeRef: FigmaScopeRef,
  evidenceDir: string,
): FigmaConnectorAuditArtifact | undefined => storeFor(evidenceDir).load(scopeRef);

export interface AppendFigmaConnectorAuditInput {
  readonly scopeRef: FigmaScopeRef;
  readonly evidenceDir: string;
  readonly action: FigmaConnectorAction;
  readonly outcome: FigmaConnectorOutcome;
  readonly now: string;
  readonly errorCode?: FigmaConnectorErrorCode;
  readonly counts?: FigmaConnectorAuditCounts;
}

// Builds the entry with only the governance-permitted fields present. `errorCode` is attached only
// for an error outcome; `counts` only when supplied. No other field is ever spread in, so customer
// content cannot reach the entry even if the caller passed extra data.
const buildEntry = (input: AppendFigmaConnectorAuditInput): FigmaConnectorAuditEntry => ({
  at: input.now,
  action: input.action,
  outcome: input.outcome,
  ...(input.outcome === "error" && input.errorCode !== undefined
    ? { errorCode: input.errorCode }
    : {}),
  ...(input.counts !== undefined ? { counts: input.counts } : {}),
});

/**
 * Append an append-only connector-action audit entry through the reused Evidence audit seam.
 * Creates the artifact on first use. Returns the updated artifact. The caller authorises the action.
 */
export const appendFigmaConnectorAudit = (
  input: AppendFigmaConnectorAuditInput,
): FigmaConnectorAuditArtifact => {
  const current =
    loadFigmaConnectorAudit(input.scopeRef, input.evidenceDir) ??
    emptyArtifact(input.scopeRef, input.now);
  const next: FigmaConnectorAuditArtifact = {
    ...current,
    auditLog: [...current.auditLog, buildEntry(input)],
    lastUpdatedAt: input.now,
  };
  storeFor(input.evidenceDir).record(input.scopeRef, next);
  return next;
};
