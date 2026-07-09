// Agent editor action governance, policy, and bounded audit (Issue #1395, ADR-0062).
//
// This leaf adds two things on top of the frozen editor-agent control-plane contract
// (`editor-agent.ts`): a deterministic policy classifier that marks each action allowed,
// review-required, or denied (AC2), and a content-free audit record shape + pure builder for the
// bounded audit metadata every mutating action produces (AC1, AC3).
//
// Leaf-package rule (ADR-0019 direction 1): no `@oscharko-dev/keiko-*` imports. The classifier is a
// pure function over its inputs; workspace-sensitivity (`isDenied`) is a `keiko-workspace` concern,
// so the server computes that boolean and passes it in. Workspace containment reuses the existing
// `isContainedAgentPath` guard, which already lives in this package.
//
// Audit invariant (mirrors `MemoryAuditEvent` and `patchApplyEvidence`): the record NEVER carries
// raw source text, edit bodies, patch bodies, or secrets. The builder input type has no field that
// could hold raw content — only enums, counts, identifiers, a workspace-relative path, and a bounded
// summary — so a content leak is impossible by construction. The server additionally runs every
// record through the `keiko-security` redactor (defense in depth) before it is stored or served.

import {
  isContainedAgentPath,
  type EditorAgentActionStatus,
  type EditorAgentActionType,
  type EditorAgentConflictCode,
  type EditorAgentFailureCode,
} from "./editor-agent.js";
import type { CodingWorkbenchPolicyEffect } from "./coding-workbench.js";

// ─── Schema version ───────────────────────────────────────────────────────────
// Pinned to "1". A breaking change introduces a NEW literal rather than mutating "1", the same
// evolution rule as `EDITOR_AGENT_SCHEMA_VERSION` and the other audit surfaces.
export const EDITOR_AGENT_AUDIT_SCHEMA_VERSION = "1" as const;

// Maximum length for the bounded, redacted `summary`. Audit summaries are dense one-line rationales,
// never bodies; the bound keeps a long target path or reason string from growing the record.
export const EDITOR_AGENT_AUDIT_SUMMARY_MAX_CHARS = 200;

// ─── Effect-class taxonomy ────────────────────────────────────────────────────
// Every action type maps to exactly one effect class. The class drives both the policy disposition
// and whether the action is audited. `external-effect` is defined for the future Git/command action
// types named in the issue scope ("when available"); it has NO members in the current action
// contract. The `Record<EditorAgentActionType, …>` makes the table exhaustive at compile time, so a
// future action type cannot be added to the union without being given a class here.
export type EditorAgentActionEffectClass =
  "navigation" | "layout" | "content-mutation" | "external-effect";

export const EDITOR_AGENT_ACTION_EFFECT_CLASS: Readonly<
  Record<EditorAgentActionType, EditorAgentActionEffectClass>
> = {
  openFile: "navigation",
  focusTab: "navigation",
  setSelection: "navigation",
  moveTab: "layout",
  splitPane: "layout",
  format: "content-mutation",
  save: "content-mutation",
  applyTextEdits: "content-mutation",
  applyPatch: "content-mutation",
  applyChangeset: "content-mutation",
};

// The mutating action set — the classes that change buffer/file content or have an external effect.
// AC1: every mutating action produces a bounded audit record. Today this resolves to the four write
// action types; the predicate keeps that derived from the effect-class table rather than re-listed.
export function isMutatingEditorAgentAction(type: EditorAgentActionType): boolean {
  const effectClass = EDITOR_AGENT_ACTION_EFFECT_CLASS[type];
  return effectClass === "content-mutation" || effectClass === "external-effect";
}

// ─── Disposition taxonomy (AC2) ───────────────────────────────────────────────
export type EditorAgentActionDisposition = "allowed" | "review-required" | "denied";

export const EDITOR_AGENT_ACTION_DISPOSITIONS: readonly EditorAgentActionDisposition[] = [
  "allowed",
  "review-required",
  "denied",
] as const;

// Content-free reason codes. A denied action carries exactly one deny reason; a review-required
// action carries exactly one review reason; an allowed action carries neither.
export type EditorAgentActionDenyReason =
  | "workspace-boundary-escape"
  | "denied-sensitive-path"
  | "authority-missing"
  | "authority-invalid"
  | "authority-expired"
  | "approval-reference-invalid"
  | "approval-reference-expired"
  | "approval-reference-consumed"
  | "unsupported-action"
  | "secret-exfiltration"
  | "platform-restricted";

export const EDITOR_AGENT_ACTION_DENY_REASONS: readonly EditorAgentActionDenyReason[] = [
  "workspace-boundary-escape",
  "denied-sensitive-path",
  "authority-missing",
  "authority-invalid",
  "authority-expired",
  "approval-reference-invalid",
  "approval-reference-expired",
  "approval-reference-consumed",
  "unsupported-action",
  "secret-exfiltration",
  "platform-restricted",
] as const;

export type EditorAgentActionReviewReason =
  | "content-mutation-requires-review"
  | "external-effect-requires-review"
  | "mode-approval-required"
  | "deterministic-risk-approval-required"
  | "delivery-human-approval-required";

export const EDITOR_AGENT_ACTION_REVIEW_REASONS: readonly EditorAgentActionReviewReason[] = [
  "content-mutation-requires-review",
  "external-effect-requires-review",
  "mode-approval-required",
  "deterministic-risk-approval-required",
  "delivery-human-approval-required",
] as const;

export const EDITOR_AGENT_DISPOSITION_BY_POLICY_EFFECT: Readonly<
  Record<CodingWorkbenchPolicyEffect, EditorAgentActionDisposition>
> = {
  allowed: "allowed",
  "approval-required": "review-required",
  denied: "denied",
} as const;

export function editorAgentDispositionForPolicyEffect(
  effect: CodingWorkbenchPolicyEffect,
): EditorAgentActionDisposition {
  return EDITOR_AGENT_DISPOSITION_BY_POLICY_EFFECT[effect];
}

export interface EditorAgentActionPolicyDecision {
  readonly disposition: EditorAgentActionDisposition;
  readonly effectClass: EditorAgentActionEffectClass;
  readonly denyReason?: EditorAgentActionDenyReason | undefined;
  readonly reviewReason?: EditorAgentActionReviewReason | undefined;
}

export interface EditorAgentActionPolicyContext {
  // The resolved workspace-relative target path, or null when the action has no file target.
  readonly targetPath: string | null;
  // Server-computed: the target matches the always-on `keiko-workspace` deny-list (`.env`, `.ssh`,
  // `.keiko`, credentials, …). The leaf cannot import `keiko-workspace`, so the caller supplies it.
  readonly targetSensitive: boolean;
}

const ALLOWED: EditorAgentActionPolicyDecision = {
  disposition: "allowed",
  effectClass: "navigation",
};

function denyDecision(
  effectClass: EditorAgentActionEffectClass,
  denyReason: EditorAgentActionDenyReason,
): EditorAgentActionPolicyDecision {
  return { disposition: "denied", effectClass, denyReason };
}

function reviewDecision(
  effectClass: EditorAgentActionEffectClass,
  reviewReason: EditorAgentActionReviewReason,
): EditorAgentActionPolicyDecision {
  return { disposition: "review-required", effectClass, reviewReason };
}

// A content mutation is denied when its target escapes the workspace root or matches the deny-list,
// otherwise it requires human review (the existing #1394 browser diff-review is the review gate).
function classifyContentMutation(
  context: EditorAgentActionPolicyContext,
): EditorAgentActionPolicyDecision {
  if (context.targetPath !== null && !isContainedAgentPath(context.targetPath)) {
    return denyDecision("content-mutation", "workspace-boundary-escape");
  }
  if (context.targetSensitive) {
    return denyDecision("content-mutation", "denied-sensitive-path");
  }
  return reviewDecision("content-mutation", "content-mutation-requires-review");
}

// Deterministic, fail-closed policy classifier (AC2). Pure: same (type, context) always yields the
// same decision, which is required for replay-safe audit and for idempotent action handling. The
// classifier governs policy posture only; it does NOT re-check the #1394 structural preconditions
// (version/hash/overlap), which remain upstream gates.
export function classifyEditorAgentAction(
  type: EditorAgentActionType,
  context: EditorAgentActionPolicyContext,
): EditorAgentActionPolicyDecision {
  const effectClass = EDITOR_AGENT_ACTION_EFFECT_CLASS[type];
  switch (effectClass) {
    case "navigation":
    case "layout":
      return { ...ALLOWED, effectClass };
    case "content-mutation":
      return classifyContentMutation(context);
    case "external-effect":
      return reviewDecision("external-effect", "external-effect-requires-review");
  }
}

// ─── Bounded audit record (AC1, AC3) ──────────────────────────────────────────
// Content-free by construction: enums, counts, identifiers, a workspace-relative path, and a bounded
// summary. No field can hold raw source text, edit bodies, or patch bodies.
export interface EditorAgentActionAuditRecord {
  readonly schemaVersion: typeof EDITOR_AGENT_AUDIT_SCHEMA_VERSION;
  readonly auditId: string;
  readonly occurredAt: number;
  readonly sessionId: string;
  readonly actionId: string;
  readonly actionType: EditorAgentActionType;
  readonly effectClass: EditorAgentActionEffectClass;
  readonly mutating: boolean;
  readonly disposition: EditorAgentActionDisposition;
  readonly denyReason?: EditorAgentActionDenyReason | undefined;
  readonly reviewReason?: EditorAgentActionReviewReason | undefined;
  readonly outcome: EditorAgentActionStatus;
  readonly conflictCode?: EditorAgentConflictCode | undefined;
  readonly failureCode?: EditorAgentFailureCode | undefined;
  // Workspace-relative target path (never an absolute or escaping path). Redacted server-side as
  // defense in depth before storage; a path is metadata, not source content.
  readonly targetPath?: string | undefined;
  // Content-free counts. `editCount` is the number of text edits, never their content.
  readonly editCount?: number | undefined;
  readonly patchByteLength?: number | undefined;
  // Bounded (≤ EDITOR_AGENT_AUDIT_SUMMARY_MAX_CHARS), redacted, content-free one-line rationale.
  readonly summary: string;
}

// The builder's only input. It deliberately has NO field for `textEdits`, edit `newText`, or a patch
// body — the record cannot carry raw content because the builder is never handed any.
export interface EditorAgentActionAuditInput {
  readonly auditId: string;
  readonly occurredAt: number;
  readonly sessionId: string;
  readonly actionId: string;
  readonly actionType: EditorAgentActionType;
  readonly decision: EditorAgentActionPolicyDecision;
  readonly outcome: EditorAgentActionStatus;
  readonly conflictCode?: EditorAgentConflictCode | undefined;
  readonly failureCode?: EditorAgentFailureCode | undefined;
  readonly targetPath?: string | null | undefined;
  readonly editCount?: number | undefined;
  readonly patchByteLength?: number | undefined;
}

function boundedSummary(text: string): string {
  return text.length <= EDITOR_AGENT_AUDIT_SUMMARY_MAX_CHARS
    ? text
    : text.slice(0, EDITOR_AGENT_AUDIT_SUMMARY_MAX_CHARS);
}

function buildAuditSummary(input: EditorAgentActionAuditInput): string {
  const parts: string[] = [
    input.actionType,
    input.decision.disposition,
    `outcome=${input.outcome}`,
  ];
  if (typeof input.targetPath === "string" && input.targetPath.length > 0) {
    parts.push(`file=${input.targetPath}`);
  }
  if (input.decision.denyReason !== undefined) parts.push(`deny=${input.decision.denyReason}`);
  if (input.decision.reviewReason !== undefined) {
    parts.push(`review=${input.decision.reviewReason}`);
  }
  if (input.conflictCode !== undefined) parts.push(`conflict=${input.conflictCode}`);
  return boundedSummary(parts.join(" "));
}

// Pure builder for the bounded audit record. The summary is bounded here; secret redaction of the
// summary and path happens at the server boundary (the leaf cannot import the redactor).
export function buildEditorAgentActionAuditRecord(
  input: EditorAgentActionAuditInput,
): EditorAgentActionAuditRecord {
  const targetPath =
    typeof input.targetPath === "string" && input.targetPath.length > 0
      ? input.targetPath
      : undefined;
  return {
    schemaVersion: EDITOR_AGENT_AUDIT_SCHEMA_VERSION,
    auditId: input.auditId,
    occurredAt: input.occurredAt,
    sessionId: input.sessionId,
    actionId: input.actionId,
    actionType: input.actionType,
    effectClass: input.decision.effectClass,
    mutating: isMutatingEditorAgentAction(input.actionType),
    disposition: input.decision.disposition,
    ...(input.decision.denyReason === undefined ? {} : { denyReason: input.decision.denyReason }),
    ...(input.decision.reviewReason === undefined
      ? {}
      : { reviewReason: input.decision.reviewReason }),
    outcome: input.outcome,
    ...(input.conflictCode === undefined ? {} : { conflictCode: input.conflictCode }),
    ...(input.failureCode === undefined ? {} : { failureCode: input.failureCode }),
    ...(targetPath === undefined ? {} : { targetPath }),
    ...(input.editCount === undefined ? {} : { editCount: input.editCount }),
    ...(input.patchByteLength === undefined ? {} : { patchByteLength: input.patchByteLength }),
    summary: buildAuditSummary(input),
  };
}

// ─── Read response shape (AC4) ─────────────────────────────────────────────────
export interface EditorAgentAuditResponse {
  readonly records: readonly EditorAgentActionAuditRecord[];
}

// ─── Guards ────────────────────────────────────────────────────────────────────
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isEditorAgentActionDisposition(
  value: unknown,
): value is EditorAgentActionDisposition {
  return (
    typeof value === "string" &&
    EDITOR_AGENT_ACTION_DISPOSITIONS.includes(value as EditorAgentActionDisposition)
  );
}

export function isEditorAgentActionEffectClass(
  value: unknown,
): value is EditorAgentActionEffectClass {
  return (
    value === "navigation" ||
    value === "layout" ||
    value === "content-mutation" ||
    value === "external-effect"
  );
}

// Structural guard over a persisted/served audit record. Validates the schema version, required
// identifiers, the enum members, and the bounded summary. It does not attempt secret detection — the
// content-free input type plus server-side redaction already guarantee that — it guards shape so a
// consumer reading the audit feed off the wire cannot be handed a malformed record.
export function isEditorAgentActionAuditRecord(
  value: unknown,
): value is EditorAgentActionAuditRecord {
  if (!isRecord(value)) return false;
  return [
    value.schemaVersion === EDITOR_AGENT_AUDIT_SCHEMA_VERSION,
    typeof value.auditId === "string" && value.auditId.length > 0,
    typeof value.occurredAt === "number" && Number.isFinite(value.occurredAt),
    typeof value.sessionId === "string" && value.sessionId.length > 0,
    typeof value.actionId === "string" && value.actionId.length > 0,
    isEditorAgentActionEffectClass(value.effectClass),
    typeof value.mutating === "boolean",
    isEditorAgentActionDisposition(value.disposition),
    typeof value.outcome === "string" && value.outcome.length > 0,
    typeof value.summary === "string" &&
      value.summary.length <= EDITOR_AGENT_AUDIT_SUMMARY_MAX_CHARS,
  ].every(Boolean);
}
