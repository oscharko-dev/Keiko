// Editor completion-gateway WIRE contract (Issue #1199, Epic #1189, ADR-0042 D4/D5/D6). These are
// the request/response shapes the `POST /api/editor/completion` BFF route consumes and emits. The
// route is the governed seam between the browser-tier `@oscharko-dev/keiko-editor` Monaco completion
// provider (which renders only) and the server-owned completion sources: the deterministic
// language service (#1198), governed coding-context retrieval (#1211), and — only when an aligned,
// in-budget infilling model is configured (#1210) — model-assisted completion routed through the
// Model Gateway.
//
// Content boundary: the REQUEST necessarily carries the in-editor buffer text (the overlay the
// language service analyses), exactly like the language-service request (#1198) — it is the user's
// own buffer travelling over the loopback BFF, never logged. The RESPONSE is content-free apart from
// `insertText`, which is the reviewable code artifact the user accepts into their own buffer: no raw
// prompt, no raw model reasoning, no retrieved excerpt, no secret. Provenance carries only ids,
// hashes, enum literals, and counts (EU AI Act Reg. (EU) 2024/1689 Art. 12 record-keeping).
//
// Leaf-package rules (ADR-0019): pure types and frozen const tables plus throw-free validators only.
// No filesystem, no clock, no crypto, no randomness, and no imports of other `@oscharko-dev/keiko-*`
// packages. The item-kind set is reused from the language-service contract so the editor renders one
// stable icon set across deterministic and model-assisted items.

import {
  isLanguageDocumentOverlay,
  isLanguagePosition,
  type LanguageCompletionItemKind,
  type LanguageDocumentOverlay,
  type LanguagePosition,
} from "./language-service.js";
import type { CompletionDegradeReason, CompletionInteractionMode, CostClass } from "./gateway.js";

// Schema version for the completion-gateway envelope. Bump as a new string member when the shape
// changes incompatibly; consumers pin against the literal to detect skew.
export const EDITOR_COMPLETION_SCHEMA_VERSION = "1" as const;

// How the editor asked for completion, aligned with LSP 3.17 completion-trigger semantics:
//   - "invoked"           — explicit manual invocation (Ctrl+Space or platform equivalent).
//   - "trigger-character" — typing a registered trigger character (for example `.`).
//   - "incomplete"        — re-query because the previous list was marked incomplete.
export type EditorCompletionWireTriggerKind = "invoked" | "trigger-character" | "incomplete";

export const EDITOR_COMPLETION_WIRE_TRIGGER_KINDS: readonly EditorCompletionWireTriggerKind[] = [
  "invoked",
  "trigger-character",
  "incomplete",
] as const;

// Which governed completion tier produced an item. Deterministic items come from the model-free
// language service (#1198); model-assisted items come from an aligned infilling model via the Model
// Gateway (#1210). This is the per-item discriminator the editor maps onto its content-free
// `EditorOutputProvenance`.
export type EditorCompletionItemOrigin = "deterministic" | "model-assisted";

export const EDITOR_COMPLETION_ITEM_ORIGINS: readonly EditorCompletionItemOrigin[] = [
  "deterministic",
  "model-assisted",
] as const;

// A single suggestion-widget item. `insertText` is the reviewable code the user accepts; every other
// field is presentation metadata or the content-free origin discriminator.
export interface EditorCompletionWireItem {
  readonly label: string;
  readonly kind: LanguageCompletionItemKind;
  readonly insertText: string;
  readonly detail?: string;
  readonly sortText?: string;
  readonly origin: EditorCompletionItemOrigin;
}

// The governed sources that contributed to a completion response (Acceptance Criterion 7). This is
// content-free: it names the *kind* of source, never the retrieved text. `deterministic-language-service`
// and `model-assisted` describe the producing tier; the remaining members describe coding-context
// providers (#1211) that fed the model-assisted prompt.
export type EditorCompletionSource =
  | "deterministic-language-service"
  | "model-assisted"
  | "repository-context"
  | "local-knowledge"
  | "memory"
  | "connected-context";

export const EDITOR_COMPLETION_SOURCES: readonly EditorCompletionSource[] = [
  "deterministic-language-service",
  "model-assisted",
  "repository-context",
  "local-knowledge",
  "memory",
  "connected-context",
] as const;

// Content-free provenance summary for one completion response. `modelMode` echoes the Model Gateway
// completion-model selection (#1210); `degradeReason` is present only when model-assisted completion
// was not produced. `modelId`/`gatewayPolicyVersion`/`promptHash` are present only when model-assisted
// items were produced and are opaque ids/hashes — never the prompt, never customer content.
export interface EditorCompletionWireProvenance {
  readonly sources: readonly EditorCompletionSource[];
  readonly modelMode: CompletionInteractionMode;
  readonly modelId?: string;
  readonly latencyClass?: string;
  readonly degradeReason?: CompletionDegradeReason;
  readonly gatewayPolicyVersion?: string;
  // SHA-256 hex of the assembled model prompt, for audit correlation only (never the prompt itself).
  readonly promptHash?: string;
}

export interface EditorCompletionWireResponse {
  readonly schemaVersion: typeof EDITOR_COMPLETION_SCHEMA_VERSION;
  readonly items: readonly EditorCompletionWireItem[];
  // True when the list is not exhaustive for the position (the editor re-queries on the next edit).
  readonly isIncomplete: boolean;
  // True when items were dropped to honour the result cap.
  readonly truncated: boolean;
  readonly provenance: EditorCompletionWireProvenance;
}

// Optional coding-context selectors forwarded to the governed retrieval service (#1211). The route
// runs repository search by default; Local Knowledge and retained memory are queried only when a
// capsule/capsule-set is selected and the purpose budget permits embedding providers. `queryText` is
// an explicit retrieval query the host may supply; it is part of the (content-bearing) request and
// never echoed back on the response.
export interface EditorCompletionContextSelectors {
  readonly queryText?: string;
  readonly symbol?: string;
  readonly changedFiles?: readonly string[];
  readonly capsuleId?: string;
  readonly capsuleSetId?: string;
}

export interface EditorCompletionWireRequest {
  readonly schemaVersion: typeof EDITOR_COMPLETION_SCHEMA_VERSION;
  readonly root: string;
  readonly document: LanguageDocumentOverlay;
  readonly position: LanguagePosition;
  readonly triggerKind: EditorCompletionWireTriggerKind;
  readonly triggerCharacter?: string;
  // Advisory budget (bytes) the host suggests for assembled coding context; the route clamps it to
  // the server-owned purpose budget. A non-negative integer.
  readonly contextBudgetBytes: number;
  readonly context?: EditorCompletionContextSelectors;
  // Cost ceiling for electing a model-assisted infilling model (#1206). Absent = no ceiling.
  readonly maxCostClass?: CostClass;
}

// ─── Pure validation (trust-boundary edge: the BFF validates a client-supplied request) ───────────
// Result envelope follows the package convention: a discriminated `{ ok: true; value } | { ok: false;
// errors }` so branches stay throw-free and the error strings are deterministic.

export interface EditorCompletionParseOk {
  readonly ok: true;
  readonly value: EditorCompletionWireRequest;
}
export interface EditorCompletionParseFail {
  readonly ok: false;
  readonly errors: readonly string[];
}
export type EditorCompletionParse = EditorCompletionParseOk | EditorCompletionParseFail;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isWireTriggerKind(value: unknown): value is EditorCompletionWireTriggerKind {
  return (
    typeof value === "string" &&
    (EDITOR_COMPLETION_WIRE_TRIGGER_KINDS as readonly string[]).includes(value)
  );
}

function isCostClass(value: unknown): value is CostClass {
  return value === "low" || value === "medium" || value === "high";
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

// Collects the optional, content-bearing context selectors. Unknown-typed fields are rejected so a
// malformed selector cannot silently widen retrieval; an absent `context` is valid (deterministic +
// repo-search only).
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
    errors.push(`triggerKind must be one of: ${EDITOR_COMPLETION_WIRE_TRIGGER_KINDS.join(", ")}`);
  }
  if (value.triggerCharacter !== undefined && typeof value.triggerCharacter !== "string") {
    errors.push("triggerCharacter must be a string when provided");
  }
  if (!isNonNegativeInteger(value.contextBudgetBytes)) {
    errors.push("contextBudgetBytes must be a non-negative integer");
  }
  if (value.maxCostClass !== undefined && !isCostClass(value.maxCostClass)) {
    errors.push("maxCostClass must be one of: low, medium, high");
  }
  collectContextErrors(value.context, errors);
  return errors;
}

// Validates an `unknown` payload into an EditorCompletionWireRequest, reporting one error per failed
// invariant. The BFF uses this to reject a malformed request with 400 INVALID_REQUEST.
export function parseEditorCompletionRequest(value: unknown): EditorCompletionParse {
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
      schemaVersion: EDITOR_COMPLETION_SCHEMA_VERSION,
      root: value.root as string,
      document: value.document as LanguageDocumentOverlay,
      position: value.position as LanguagePosition,
      triggerKind: value.triggerKind as EditorCompletionWireTriggerKind,
      ...(typeof value.triggerCharacter === "string"
        ? { triggerCharacter: value.triggerCharacter }
        : {}),
      contextBudgetBytes: value.contextBudgetBytes as number,
      ...(context !== undefined && Object.keys(context).length > 0 ? { context } : {}),
      ...(isCostClass(value.maxCostClass) ? { maxCostClass: value.maxCostClass } : {}),
    },
  };
}
