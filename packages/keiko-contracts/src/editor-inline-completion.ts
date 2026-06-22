// Editor inline-completion (ghost-text) WIRE contract (Issue #1200, Epic #1189, ADR-0042 D5/D6).
// These are the request/response shapes the `POST /api/editor/inline-completion` BFF route consumes
// and emits. The route is the governed seam between the browser-tier `@oscharko-dev/keiko-editor`
// Monaco inline-completion provider (which renders ghost text only) and the server-owned, gated
// model-assisted infilling source: an aligned ("instruct"/"edit-tuned") suffix-aware (FIM) model
// elected by the completion-model selection (#1210) and enriched with governed coding context
// (#1211, `purpose: "inline"`). Inline completion is model-only: unlike the #1199 completion gateway
// there is no deterministic ghost-text tier — when no governed FIM model is usable (or policy
// disables the feature) the route returns zero items and the editor falls back to the deterministic
// language-service completion gateway (#1199), never a silent ungoverned model (ADR-0042 D5).
//
// Content boundary: the REQUEST necessarily carries the in-editor buffer text (the overlay the model
// infills, prefix + suffix around the cursor), exactly like the language-service (#1198) and
// completion (#1199) requests — it is the user's own buffer travelling over the loopback BFF, never
// logged. The RESPONSE is content-free apart from `insertText`, which is the reviewable ghost-text
// continuation the user explicitly accepts into their own buffer: no raw prompt, no raw model
// reasoning, no retrieved excerpt, no secret. Provenance carries only ids, hashes, enum literals, and
// counts (EU AI Act Reg. (EU) 2024/1689 Art. 12 record-keeping). The acceptance/rejection telemetry
// report is purely counts — no buffer text, no insert text, no prompt.
//
// Leaf-package rules (ADR-0019): pure types and frozen const tables plus throw-free validators only.
// No filesystem, no clock, no crypto, no randomness, and no imports of other `@oscharko-dev/keiko-*`
// packages. Geometry, the document-overlay shape, the coding-context selectors, and the completion
// source/mode/degrade vocabularies are reused from the sibling editor contracts so the inline tier
// shares one stable, content-free provenance model with the completion gateway.

import {
  isLanguageDocumentOverlay,
  isLanguagePosition,
  type LanguageDocumentOverlay,
  type LanguagePosition,
  type LanguageRange,
} from "./language-service.js";
import type {
  EditorCompletionContextSelectors,
  EditorCompletionSource,
} from "./editor-completion.js";
import type { CompletionDegradeReason, CompletionInteractionMode, CostClass } from "./gateway.js";

// Schema version for the inline-completion envelope. Bump as a new string member when the shape
// changes incompatibly; consumers pin against the literal to detect skew.
export const EDITOR_INLINE_COMPLETION_SCHEMA_VERSION = "1" as const;

// How the editor asked for an inline suggestion, aligned with Monaco's `InlineCompletionTriggerKind`:
//   - "automatic" — debounced as-you-type request issued while editing (Monaco `Automatic`).
//   - "explicit"  — the user explicitly invoked an inline suggestion (Monaco `Explicit`).
// The route gates the as-you-type ("automatic") tier on a FAST aligned FIM model; an "explicit"
// request may additionally run on a slower aligned FIM model (manual-invoke), mirroring ADR-0042 D5.
export type EditorInlineCompletionWireTriggerKind = "automatic" | "explicit";

export const EDITOR_INLINE_COMPLETION_WIRE_TRIGGER_KINDS: readonly EditorInlineCompletionWireTriggerKind[] =
  ["automatic", "explicit"] as const;

// A single ghost-text continuation. `insertText` is the reviewable code the user accepts; `range`,
// when present, is the document span the continuation replaces (defaults to an insertion at the
// request cursor when omitted, the common ghost-text case).
export interface EditorInlineCompletionWireItem {
  readonly insertText: string;
  readonly range?: LanguageRange;
}

// Content-free provenance summary for one inline-completion response (Acceptance Criterion 5/7),
// reusing the completion gateway's source/mode/degrade vocabulary. `modelMode` echoes the Model
// Gateway completion-model selection (#1210) and is always present; `degradeReason` is present only
// when `modelMode === "deterministic"` (no governed FIM model usable). `modelId`/`latencyClass`/
// `gatewayPolicyVersion`/`promptHash` are present only when a ghost-text item was actually produced —
// they identify the model that produced this response's item and are opaque ids/hashes, never the
// prompt, the buffer, or any retrieved excerpt.
export interface EditorInlineCompletionWireProvenance {
  readonly sources: readonly EditorCompletionSource[];
  readonly modelMode: CompletionInteractionMode;
  readonly modelId?: string;
  readonly latencyClass?: string;
  readonly degradeReason?: CompletionDegradeReason;
  readonly gatewayPolicyVersion?: string;
  // SHA-256 hex of the assembled infilling prompt, for audit correlation only (never the prompt).
  readonly promptHash?: string;
}

export interface EditorInlineCompletionWireResponse {
  readonly schemaVersion: typeof EDITOR_INLINE_COMPLETION_SCHEMA_VERSION;
  readonly items: readonly EditorInlineCompletionWireItem[];
  readonly provenance: EditorInlineCompletionWireProvenance;
}

export interface EditorInlineCompletionWireRequest {
  readonly schemaVersion: typeof EDITOR_INLINE_COMPLETION_SCHEMA_VERSION;
  readonly root: string;
  readonly document: LanguageDocumentOverlay;
  readonly position: LanguagePosition;
  readonly triggerKind: EditorInlineCompletionWireTriggerKind;
  // Advisory budget (bytes) the host suggests for assembled coding context; the route clamps it to
  // the server-owned `inline` purpose budget. A non-negative integer.
  readonly contextBudgetBytes: number;
  // Optional coding-context selectors forwarded to the governed retrieval service (#1211); reused
  // verbatim from the completion gateway. For the `inline` purpose the route runs repository search
  // only (embedding-cost providers are excluded as keystroke-sensitive).
  readonly context?: EditorCompletionContextSelectors;
  // Optional client-side cost ceiling for electing a model-assisted infilling model (#1206). The BFF
  // also applies a server-owned ceiling and uses the stricter value; absent means "use server policy".
  readonly maxCostClass?: CostClass;
  // Advisory upper bound on generated ghost-text length (output tokens). The route additionally
  // clamps the returned `insertText` to a hard server-owned character cap. A positive integer.
  readonly maxOutputTokens?: number;
}

// ─── Content-free acceptance/rejection telemetry (Acceptance Criterion 6) ──────────────────────────
// The browser-tier inline-completion bridge accumulates these counts from Monaco's content-free
// lifecycle callbacks (shown / partial-accept / end-of-lifetime accepted|rejected|ignored) plus
// request latency aggregates, and the host posts a cumulative snapshot to
// `POST /api/editor/inline-completion/telemetry`, which records it as content-free evidence. There is
// NO code content here — only counts, latency numbers, and the workspace root.

export const EDITOR_INLINE_COMPLETION_TELEMETRY_SCHEMA_VERSION = "1" as const;

export interface EditorInlineCompletionTelemetryReport {
  readonly schemaVersion: typeof EDITOR_INLINE_COMPLETION_TELEMETRY_SCHEMA_VERSION;
  readonly root: string;
  // Times an inline request produced a candidate the editor could render.
  readonly offered: number;
  // Times a ghost-text item was actually shown to the user.
  readonly shown: number;
  // Times the user explicitly accepted a ghost-text item (Tab / accept action).
  readonly accepted: number;
  // Times a shown item was dismissed by an explicit gesture.
  readonly rejected: number;
  // Times a shown item fell out of use without an explicit accept/reject (superseded, typed past).
  readonly ignored: number;
  // Times the user accepted part of an item (word/line partial accept).
  readonly partiallyAccepted: number;
  // Count of inline-completion resolver requests observed by the editor bridge.
  readonly requestCount: number;
  // Content-free nearest-rank p50 resolver latency, in milliseconds.
  readonly requestLatencyMsP50: number;
  // Content-free nearest-rank p95 resolver latency, in milliseconds.
  readonly requestLatencyMsP95: number;
}

// ─── Pure validation (trust-boundary edge: the BFF validates a client-supplied request) ───────────
// Result envelope follows the package convention: a discriminated `{ ok: true; value } | { ok: false;
// errors }` so branches stay throw-free and the error strings are deterministic.

export interface EditorInlineCompletionParseOk {
  readonly ok: true;
  readonly value: EditorInlineCompletionWireRequest;
}
export interface EditorInlineCompletionParseFail {
  readonly ok: false;
  readonly errors: readonly string[];
}
export type EditorInlineCompletionParse =
  | EditorInlineCompletionParseOk
  | EditorInlineCompletionParseFail;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isWireTriggerKind(value: unknown): value is EditorInlineCompletionWireTriggerKind {
  return (
    typeof value === "string" &&
    (EDITOR_INLINE_COMPLETION_WIRE_TRIGGER_KINDS as readonly string[]).includes(value)
  );
}

function isCostClass(value: unknown): value is CostClass {
  return value === "low" || value === "medium" || value === "high";
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

// Collects the optional, content-bearing context selectors (identical invariants to the completion
// gateway). Unknown-typed fields are rejected so a malformed selector cannot silently widen
// retrieval; an absent `context` is valid (repository search only for the `inline` purpose).
function collectContextErrors(context: unknown, errors: string[]): void {
  if (context === undefined) {
    return;
  }
  if (!isRecord(context)) {
    errors.push("context must be an object when provided");
    return;
  }
  for (const field of ["queryText", "symbol", "capsuleId", "capsuleSetId"] as const) {
    if (context[field] !== undefined && typeof context[field] !== "string") {
      errors.push(`context.${field} must be a string when provided`);
    }
  }
  if (context.changedFiles !== undefined && !isStringArray(context.changedFiles)) {
    errors.push("context.changedFiles must be an array of strings when provided");
  }
  if (context.capsuleId !== undefined && context.capsuleSetId !== undefined) {
    errors.push("context must not set both capsuleId and capsuleSetId");
  }
}

function buildContextSelectors(context: Record<string, unknown>): EditorCompletionContextSelectors {
  return {
    ...(typeof context.queryText === "string" ? { queryText: context.queryText } : {}),
    ...(typeof context.symbol === "string" ? { symbol: context.symbol } : {}),
    ...(isStringArray(context.changedFiles) ? { changedFiles: context.changedFiles } : {}),
    ...(typeof context.capsuleId === "string" ? { capsuleId: context.capsuleId } : {}),
    ...(typeof context.capsuleSetId === "string" ? { capsuleSetId: context.capsuleSetId } : {}),
  };
}

// Collects every field-level invariant error in fixed order (kept separate from the assembly step so
// the parser entry point stays low-complexity).
function collectRequestErrors(value: Record<string, unknown>): string[] {
  const errors: string[] = [];
  if (!isNonEmptyString(value.root)) {
    errors.push("root must be a non-empty string");
  }
  if (!isLanguageDocumentOverlay(value.document)) {
    errors.push("document must be { path, languageId, text }");
  }
  if (!isLanguagePosition(value.position)) {
    errors.push("position must be { line, character }");
  }
  if (!isWireTriggerKind(value.triggerKind)) {
    errors.push(
      `triggerKind must be one of: ${EDITOR_INLINE_COMPLETION_WIRE_TRIGGER_KINDS.join(", ")}`,
    );
  }
  if (!isNonNegativeInteger(value.contextBudgetBytes)) {
    errors.push("contextBudgetBytes must be a non-negative integer");
  }
  if (value.maxCostClass !== undefined && !isCostClass(value.maxCostClass)) {
    errors.push("maxCostClass must be one of: low, medium, high");
  }
  if (value.maxOutputTokens !== undefined && !isPositiveInteger(value.maxOutputTokens)) {
    errors.push("maxOutputTokens must be a positive integer when provided");
  }
  collectContextErrors(value.context, errors);
  return errors;
}

// Validates an `unknown` payload into an EditorInlineCompletionWireRequest, reporting one error per
// failed invariant. The BFF uses this to reject a malformed request with 400 INVALID_REQUEST.
export function parseEditorInlineCompletionRequest(value: unknown): EditorInlineCompletionParse {
  if (!isRecord(value)) {
    return { ok: false, errors: ["request must be an object"] };
  }
  const errors = collectRequestErrors(value);
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  const context = isRecord(value.context) ? buildContextSelectors(value.context) : undefined;
  return {
    ok: true,
    value: {
      schemaVersion: EDITOR_INLINE_COMPLETION_SCHEMA_VERSION,
      root: value.root as string,
      document: value.document as LanguageDocumentOverlay,
      position: value.position as LanguagePosition,
      triggerKind: value.triggerKind as EditorInlineCompletionWireTriggerKind,
      contextBudgetBytes: value.contextBudgetBytes as number,
      ...(context !== undefined && Object.keys(context).length > 0 ? { context } : {}),
      ...(isCostClass(value.maxCostClass) ? { maxCostClass: value.maxCostClass } : {}),
      ...(isPositiveInteger(value.maxOutputTokens)
        ? { maxOutputTokens: value.maxOutputTokens }
        : {}),
    },
  };
}

export interface EditorInlineCompletionTelemetryParseOk {
  readonly ok: true;
  readonly value: EditorInlineCompletionTelemetryReport;
}
export interface EditorInlineCompletionTelemetryParseFail {
  readonly ok: false;
  readonly errors: readonly string[];
}
export type EditorInlineCompletionTelemetryParse =
  | EditorInlineCompletionTelemetryParseOk
  | EditorInlineCompletionTelemetryParseFail;

const TELEMETRY_COUNT_FIELDS = [
  "offered",
  "shown",
  "accepted",
  "rejected",
  "ignored",
  "partiallyAccepted",
] as const;
const TELEMETRY_LATENCY_FIELDS = [
  "requestCount",
  "requestLatencyMsP50",
  "requestLatencyMsP95",
] as const;

function collectTelemetryErrors(value: Record<string, unknown>): string[] {
  const errors: string[] = [];
  if (!isNonEmptyString(value.root)) {
    errors.push("root must be a non-empty string");
  }
  for (const field of TELEMETRY_COUNT_FIELDS) {
    if (!isNonNegativeInteger(value[field])) {
      errors.push(`${field} must be a non-negative integer`);
    }
  }
  for (const field of TELEMETRY_LATENCY_FIELDS) {
    if (value[field] !== undefined && !isNonNegativeInteger(value[field])) {
      errors.push(`${field} must be a non-negative integer when provided`);
    }
  }
  if (
    isNonNegativeInteger(value.requestLatencyMsP50) &&
    isNonNegativeInteger(value.requestLatencyMsP95) &&
    value.requestLatencyMsP95 < value.requestLatencyMsP50
  ) {
    errors.push("requestLatencyMsP95 must be greater than or equal to requestLatencyMsP50");
  }
  return errors;
}

function telemetryMetric(value: Record<string, unknown>, field: string): number {
  const metric = value[field];
  return isNonNegativeInteger(metric) ? metric : 0;
}

function buildTelemetryReport(value: Record<string, unknown>): EditorInlineCompletionTelemetryReport {
  return {
    schemaVersion: EDITOR_INLINE_COMPLETION_TELEMETRY_SCHEMA_VERSION,
    root: value.root as string,
    offered: value.offered as number,
    shown: value.shown as number,
    accepted: value.accepted as number,
    rejected: value.rejected as number,
    ignored: value.ignored as number,
    partiallyAccepted: value.partiallyAccepted as number,
    requestCount: telemetryMetric(value, "requestCount"),
    requestLatencyMsP50: telemetryMetric(value, "requestLatencyMsP50"),
    requestLatencyMsP95: telemetryMetric(value, "requestLatencyMsP95"),
  };
}

// Validates an `unknown` payload into a content-free EditorInlineCompletionTelemetryReport. Every
// metric must be a non-negative integer; the report carries only counts, latency aggregates, and the
// workspace root. Latency fields default to 0 so older cumulative telemetry snapshots do not break
// during rollout; current clients always emit them.
export function parseEditorInlineCompletionTelemetry(
  value: unknown,
): EditorInlineCompletionTelemetryParse {
  if (!isRecord(value)) {
    return { ok: false, errors: ["telemetry report must be an object"] };
  }
  const errors = collectTelemetryErrors(value);
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, value: buildTelemetryReport(value) };
}
