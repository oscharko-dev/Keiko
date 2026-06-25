// Spoken Action Intent governance contract (Epic #491, Issue #503, ADR-0066). Voice is an UNTRUSTED
// input source: a committed spoken transcript may PROPOSE an action but can never EXECUTE one or bypass
// any existing gate. This leaf module DEFINES the deterministic, fail-closed normalization +
// confirmation layer that sits IN FRONT OF the existing governance (the workflow-handoff request, its
// user approval gate, `validateWorkflowHandoffRequest`, and `checkPatchAgainstScope`). It ADDS
// preconditions; it removes none.
//
// It is pure data + pure functions only — nothing performs IO, crypto, clock reads, randomness, or audio
// processing. The audit record (`SpokenActionAuditRecord`) has NO raw text and NO audio field: it carries
// only closed enums, bools, ints, and a content-free one-way digest computed downstream. The proposal
// (`SpokenActionProposal`) carries `committedText` ONLY transiently inside `confirmationInput` for the
// downstream digest derivation (Artifact 2); that seed is never persisted into evidence.
//
// Classification is a GUARDRAIL, not a semantic engine. `classifySpokenActionEffect` is deterministic,
// local (no NLU, no model call), and fail-closed: text it does not recognize as read-only-only resolves
// to `unknown`, which requires confirmation. Its accuracy is NOT load-bearing for safety, because (a) the
// default is fail-closed and (b) a proposal never authorizes anything — the existing approval gate and
// handoff gates still independently apply downstream. Keeping classification on-host and content-free is
// the strongest posture for the banking / insurer audience.
//
// `VOICE_ACTION_INTENT_SCHEMA_VERSION` follows the sibling evolution rule (ADR-0010 D2): a breaking
// change introduces a NEW literal rather than mutating "1", and it is INDEPENDENT of every other schema
// version. Leaf-package rule (ADR-0019 direction 1): no cross-package workspace import may appear here;
// siblings are reached by relative path only.

import type { VoiceProfile } from "./gateway.js";
import type {
  CommittedVoiceTranscriptProjection,
  VoiceTranscriptSource,
} from "./voice-transcript.js";
import { isVoiceTranscriptSource, voiceTranscriptCaptureAllowed } from "./voice-transcript.js";

// ─── Schema version ───────────────────────────────────────────────────────────
export const VOICE_ACTION_INTENT_SCHEMA_VERSION = "1" as const;

export function isVoiceActionIntentSchemaVersionSupported(version: unknown): boolean {
  return version === VOICE_ACTION_INTENT_SCHEMA_VERSION;
}

// ─── Effect taxonomy (the NEW safety classification) ─────────────────────────────
// `read-only`       — observes state without changing it; the only class that needs no confirmation.
// `mutating`        — changes persistent state (edit / write / update).
// `destructive`     — irreversibly removes state (delete / drop / purge).
// `external-effect` — reaches outside the host (send / deploy / pay / call an external system).
// `unknown`         — the fail-closed default: the text did not match a recognized read-only-only shape.
export type SpokenActionEffectClass =
  | "read-only"
  | "mutating"
  | "destructive"
  | "external-effect"
  | "unknown";

export const SPOKEN_ACTION_EFFECT_CLASSES: readonly SpokenActionEffectClass[] = [
  "read-only",
  "mutating",
  "destructive",
  "external-effect",
  "unknown",
] as const;

export function isSpokenActionEffectClass(value: unknown): value is SpokenActionEffectClass {
  return (
    typeof value === "string" && (SPOKEN_ACTION_EFFECT_CLASSES as readonly string[]).includes(value)
  );
}

export function assertNeverSpokenActionEffectClass(value: never): never {
  throw new TypeError(`Unhandled SpokenActionEffectClass: ${JSON.stringify(value)}`);
}

// Fail-closed confirmation table: every class except `read-only` requires explicit confirmation. Keyed
// by class for totality (a new class without an entry is a compile error).
export const SPOKEN_ACTION_EFFECT_REQUIRES_CONFIRMATION: Readonly<
  Record<SpokenActionEffectClass, boolean>
> = {
  "read-only": false,
  mutating: true,
  destructive: true,
  "external-effect": true,
  unknown: true,
} as const;

export function spokenActionRequiresConfirmation(effectClass: SpokenActionEffectClass): boolean {
  return SPOKEN_ACTION_EFFECT_REQUIRES_CONFIRMATION[effectClass];
}

// ─── Deterministic effect classification ─────────────────────────────────────────
// Small, auditable, content-free fixed marker lexicon per class. The markers are matched against a
// locally normalized copy of the committed text (lowercase + trim + collapse whitespace); the text is
// never stored or echoed. Trojan-source / unsafe-format stripping is a downstream text-safety concern
// (this leaf cannot import keiko-security); classification only matches these ASCII markers.
export interface SpokenActionEffectMarkers {
  readonly destructive: readonly string[];
  readonly externalEffect: readonly string[];
  readonly mutating: readonly string[];
  readonly readOnly: readonly string[];
}

export const SPOKEN_ACTION_EFFECT_MARKERS: SpokenActionEffectMarkers = {
  destructive: ["delete", "remove", "drop", "purge", "erase", "destroy", "wipe", "truncate"],
  externalEffect: [
    "send",
    "deploy",
    "publish",
    "email",
    "pay",
    "transfer",
    "call",
    "post",
    "merge",
  ],
  mutating: [
    "create",
    "add",
    "update",
    "edit",
    "rename",
    "move",
    "write",
    "set",
    "change",
    "modify",
  ],
  readOnly: [
    "show",
    "list",
    "read",
    "view",
    "display",
    "find",
    "search",
    "open",
    "get",
    "describe",
  ],
} as const;

// Strip characters that could smuggle an invisible or compatibility-form verb past the ASCII
// lexicon: C0/C1 controls (\u0000-\u0008, \u000E-\u001F, \u007F-\u009F),
// zero-width chars (\u200B-\u200D, \uFEFF), and bidi-override controls
// (\u202A-\u202E, \u2066-\u2069). The standard whitespace controls (\u0009-\u000D:
// tab/LF/VT/FF/CR) are deliberately EXCLUDED so the later \s+ collapse turns them into a single
// space and word boundaries survive; stripping them would join adjacent words and silently lose the
// marker. Without this strip, a destructive verb interrupted by a zero-width char would dodge the
// marker, misclassify as read-only, and skip confirmation.
/* eslint-disable no-control-regex -- C0/C1 control ranges are intentional here */
const UNSAFE_FORMAT_CHARS =
  /[\u0000-\u0008\u000E-\u001F\u007F-\u009F\u200B-\u200D\uFEFF\u202A-\u202E\u2066-\u2069]/g;
/* eslint-enable no-control-regex */

// Inline minimal normalization — leaf cannot import keiko-security. Apply Unicode NFKC FIRST so
// compatibility forms fold to ASCII (a fullwidth destructive verb folds to its ASCII spelling);
// otherwise such forms evade the ASCII marker lexicon and a destructive request would misclassify
// as read-only and skip confirmation. Then strip zero-width / bidi / control chars, lowercase, trim,
// and collapse internal whitespace runs to single spaces so word-boundary matching is stable. On
// plain ASCII input NFKC and the strip are the identity, so existing ASCII classification is unchanged.
function normalizeForClassification(text: string): string {
  return text
    .normalize("NFKC")
    .replace(UNSAFE_FORMAT_CHARS, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

// Whole-word membership test: wraps both sides in spaces so `set` does not match inside `settlement`.
function containsMarker(paddedText: string, markers: readonly string[]): boolean {
  return markers.some((marker) => paddedText.includes(` ${marker} `));
}

// Conservative, ordered precedence: destructive > external-effect > mutating > read-only. Empty /
// whitespace-only text → `unknown`. Text that matches no recognized marker → `unknown` (fail-closed).
export function classifySpokenActionEffect(committedText: string): SpokenActionEffectClass {
  const normalized = normalizeForClassification(committedText);
  if (normalized.length === 0) {
    return "unknown";
  }
  const padded = ` ${normalized} `;
  if (containsMarker(padded, SPOKEN_ACTION_EFFECT_MARKERS.destructive)) {
    return "destructive";
  }
  if (containsMarker(padded, SPOKEN_ACTION_EFFECT_MARKERS.externalEffect)) {
    return "external-effect";
  }
  if (containsMarker(padded, SPOKEN_ACTION_EFFECT_MARKERS.mutating)) {
    return "mutating";
  }
  if (containsMarker(padded, SPOKEN_ACTION_EFFECT_MARKERS.readOnly)) {
    return "read-only";
  }
  return "unknown";
}

// ─── Lifecycle state machine (confirmation + cancellation semantics) ──────────────
// `proposed`             — normalized; a read-only action may route directly from here.
// `awaiting-confirmation`— a confirmation-requiring action is waiting for the explicit confirm step.
// `confirmed`            — the user explicitly confirmed; bound to the current content digest (AC4).
// `routed`               — handed to the existing governance (the only gate that authorizes).
// `completed`            — the routed action finished. Terminal.
// `cancelled`            — the user cancelled. Terminal.
// `superseded`           — a correction changed the committed content; the prior intent is void. Terminal.
// `interrupted`          — a barge-in / disconnect interrupted the turn. Terminal.
// `expired`              — the turn advanced past the proposal. Terminal.
export type SpokenActionState =
  | "proposed"
  | "awaiting-confirmation"
  | "confirmed"
  | "routed"
  | "completed"
  | "cancelled"
  | "superseded"
  | "interrupted"
  | "expired";

export const SPOKEN_ACTION_STATES: readonly SpokenActionState[] = [
  "proposed",
  "awaiting-confirmation",
  "confirmed",
  "routed",
  "completed",
  "cancelled",
  "superseded",
  "interrupted",
  "expired",
] as const;

export const SPOKEN_ACTION_TERMINAL_STATES: readonly SpokenActionState[] = [
  "completed",
  "cancelled",
  "superseded",
  "interrupted",
  "expired",
] as const;

// The non-terminal invalidation targets every non-terminal state can reach (cancel / supersede /
// interrupt / expire). Shared so the transition table stays consistent.
const SPOKEN_ACTION_INVALIDATION_STATES: readonly SpokenActionState[] = [
  "cancelled",
  "superseded",
  "interrupted",
  "expired",
] as const;

// Legal state-changing transitions, keyed by state for totality.
//   read-only path:   proposed → routed → completed
//   confirm path:     proposed → awaiting-confirmation → confirmed → routed → completed
//   any non-terminal: → cancelled | superseded | interrupted | expired
export const SPOKEN_ACTION_STATE_TRANSITIONS: Readonly<
  Record<SpokenActionState, readonly SpokenActionState[]>
> = {
  proposed: ["awaiting-confirmation", "routed", ...SPOKEN_ACTION_INVALIDATION_STATES],
  "awaiting-confirmation": ["confirmed", ...SPOKEN_ACTION_INVALIDATION_STATES],
  confirmed: ["routed", ...SPOKEN_ACTION_INVALIDATION_STATES],
  routed: ["completed", ...SPOKEN_ACTION_INVALIDATION_STATES],
  completed: [],
  cancelled: [],
  superseded: [],
  interrupted: [],
  expired: [],
} as const;

export function isSpokenActionState(value: unknown): value is SpokenActionState {
  return typeof value === "string" && (SPOKEN_ACTION_STATES as readonly string[]).includes(value);
}

export function canTransitionSpokenAction(from: SpokenActionState, to: SpokenActionState): boolean {
  return SPOKEN_ACTION_STATE_TRANSITIONS[from].includes(to);
}

export function isTerminalSpokenActionState(state: SpokenActionState): boolean {
  return (SPOKEN_ACTION_TERMINAL_STATES as readonly string[]).includes(state);
}

export function assertNeverSpokenActionState(value: never): never {
  throw new TypeError(`Unhandled SpokenActionState: ${JSON.stringify(value)}`);
}

// ─── Capability gating (AC1 / AC2) ───────────────────────────────────────────────
// Derived from the voice transcript capability so it cannot drift: a spoken action can be proposed only
// where committed transcript capture is allowed (`speech-to-text` / `full-realtime`). `none` and
// `speech-output` (playback-only) make the whole layer dormant (AC1). The text path never calls this.
export function voiceCanProposeAction(profile: VoiceProfile): boolean {
  return voiceTranscriptCaptureAllowed(profile);
}

// ─── Outcomes (content-free) ──────────────────────────────────────────────────────
export type SpokenActionOutcome =
  | "routed"
  | "denied"
  | "cancelled"
  | "superseded"
  | "not-applicable";

export const SPOKEN_ACTION_OUTCOMES: readonly SpokenActionOutcome[] = [
  "routed",
  "denied",
  "cancelled",
  "superseded",
  "not-applicable",
] as const;

export function isSpokenActionOutcome(value: unknown): value is SpokenActionOutcome {
  return typeof value === "string" && (SPOKEN_ACTION_OUTCOMES as readonly string[]).includes(value);
}

// ─── Confirmation binding input (AC4) ─────────────────────────────────────────────
// The canonical seed the downstream digest is derived from (Artifact 2 computes sha256 of the
// canonical string). `committedText` is a TRANSIENT seed only: it lives in memory to derive the digest
// and is never persisted into evidence. Changing committedText, turnIndex, or effectClass produces a
// different canonical string → a different digest → any prior confirmation no longer matches (AC4).
export interface SpokenActionConfirmationInput {
  readonly schemaVersion: typeof VOICE_ACTION_INTENT_SCHEMA_VERSION;
  readonly committedText: string;
  readonly turnIndex: number;
  readonly effectClass: SpokenActionEffectClass;
  readonly source: VoiceTranscriptSource;
  readonly committedSegmentCount: number;
}

// Deterministic, stable field ordering with length-prefixed segments so no field's content can be
// confused with another's (a classic canonicalization ambiguity). Pure string; no crypto here.
export function canonicalizeSpokenActionConfirmation(input: SpokenActionConfirmationInput): string {
  const fields: readonly string[] = [
    `v=${input.schemaVersion}`,
    `turn=${String(input.turnIndex)}`,
    `effect=${input.effectClass}`,
    `source=${input.source}`,
    `segments=${String(input.committedSegmentCount)}`,
    `textlen=${String(input.committedText.length)}`,
    `text=${input.committedText}`,
  ];
  return fields.join("\n");
}

// ─── The normalized proposal (entry product) ─────────────────────────────────────
// Content-free EXCEPT `confirmationInput.committedText`, which stays in memory / UI only for digest
// derivation. `state` is `awaiting-confirmation` when confirmation is required, else `proposed`.
export interface SpokenActionProposal {
  readonly schemaVersion: typeof VOICE_ACTION_INTENT_SCHEMA_VERSION;
  readonly effectClass: SpokenActionEffectClass;
  readonly requiresConfirmation: boolean;
  readonly state: SpokenActionState;
  readonly source: VoiceTranscriptSource;
  readonly turnIndex: number;
  readonly committedSegmentCount: number;
  readonly committedChars: number;
  readonly confirmationInput: SpokenActionConfirmationInput;
}

// AC1/AC2 entry gate: returns `undefined` when the profile cannot propose actions (AC1) or the committed
// projection carries no text (AC2). Partial / stable / discarded / redacted / superseded segments can
// never appear in `projection.text` by construction (`selectCommittedVoiceTranscript`), so a non-empty
// projection text already means committed content only.
export function normalizeSpokenActionProposal(
  projection: CommittedVoiceTranscriptProjection,
  profile: VoiceProfile,
  turnIndex: number,
  source: VoiceTranscriptSource,
): SpokenActionProposal | undefined {
  if (!voiceCanProposeAction(profile)) {
    return undefined;
  }
  const committedText = projection.text;
  if (committedText.trim().length === 0) {
    return undefined;
  }
  const effectClass = classifySpokenActionEffect(committedText);
  const requiresConfirmation = spokenActionRequiresConfirmation(effectClass);
  const confirmationInput: SpokenActionConfirmationInput = {
    schemaVersion: VOICE_ACTION_INTENT_SCHEMA_VERSION,
    committedText,
    turnIndex,
    effectClass,
    source,
    committedSegmentCount: projection.segmentCount,
  };
  return {
    schemaVersion: VOICE_ACTION_INTENT_SCHEMA_VERSION,
    effectClass,
    requiresConfirmation,
    state: requiresConfirmation ? "awaiting-confirmation" : "proposed",
    source,
    turnIndex,
    committedSegmentCount: projection.segmentCount,
    committedChars: committedText.length,
    confirmationInput,
  };
}

// ─── Evidence-safe audit record (AC5) ─────────────────────────────────────────────
// Counts + length + enums + a content-free digest only. NO text and NO audio field exist here by design.
// `bindingDigest` is the downstream-computed one-way content digest (sha256 hex) or "" when none.
export interface SpokenActionAuditRecord {
  readonly schemaVersion: typeof VOICE_ACTION_INTENT_SCHEMA_VERSION;
  readonly effectClass: SpokenActionEffectClass;
  readonly state: SpokenActionState;
  readonly confirmationRequired: boolean;
  readonly confirmed: boolean;
  readonly outcome: SpokenActionOutcome;
  readonly source: VoiceTranscriptSource;
  readonly turnIndex: number;
  readonly committedSegmentCount: number;
  readonly committedChars: number;
  readonly bindingDigest: string;
}

// The input mirrors the record minus `schemaVersion` (the builder stamps it). All fields are content-free.
export interface SpokenActionAuditInput {
  readonly effectClass: SpokenActionEffectClass;
  readonly state: SpokenActionState;
  readonly confirmationRequired: boolean;
  readonly confirmed: boolean;
  readonly outcome: SpokenActionOutcome;
  readonly source: VoiceTranscriptSource;
  readonly turnIndex: number;
  readonly committedSegmentCount: number;
  readonly committedChars: number;
  readonly bindingDigest: string;
}

// Pure builder. Copies only the content-free fields; structurally cannot carry committed text because no
// text field exists on either the input or the record.
export function buildSpokenActionAuditRecord(
  input: SpokenActionAuditInput,
): SpokenActionAuditRecord {
  return {
    schemaVersion: VOICE_ACTION_INTENT_SCHEMA_VERSION,
    effectClass: input.effectClass,
    state: input.state,
    confirmationRequired: input.confirmationRequired,
    confirmed: input.confirmed,
    outcome: input.outcome,
    source: input.source,
    turnIndex: input.turnIndex,
    committedSegmentCount: input.committedSegmentCount,
    committedChars: input.committedChars,
    bindingDigest: input.bindingDigest,
  };
}

// ─── Validators (accumulating, never throw) ──────────────────────────────────────
export type SpokenActionValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reasons: readonly string[] };

function buildSpokenActionResult(reasons: readonly string[]): SpokenActionValidationResult {
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNonNegativeInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

// A binding digest is either the empty string (no confirmation bound) or a 64-char lowercase sha256 hex.
const BINDING_DIGEST_PATTERN = /^[0-9a-f]{64}$/;

function isValidBindingDigest(value: unknown): boolean {
  return value === "" || (typeof value === "string" && BINDING_DIGEST_PATTERN.test(value));
}

// Shared count-field check used by both record validators: turnIndex / committedSegmentCount /
// committedChars must each be non-negative integers. Extracting it keeps both validators under the
// complexity cap and keeps the reason strings identical across record shapes.
function validateCommittedCounts(value: Record<string, unknown>, reasons: string[]): void {
  if (!isNonNegativeInteger(value.turnIndex)) {
    reasons.push("turnIndex: must be a non-negative integer");
  }
  if (!isNonNegativeInteger(value.committedSegmentCount)) {
    reasons.push("committedSegmentCount: must be a non-negative integer");
  }
  if (!isNonNegativeInteger(value.committedChars)) {
    reasons.push("committedChars: must be a non-negative integer");
  }
}

function validateConfirmationInput(value: unknown, reasons: string[]): void {
  if (!isRecord(value)) {
    reasons.push("confirmationInput: must be an object");
    return;
  }
  if (!isVoiceActionIntentSchemaVersionSupported(value.schemaVersion)) {
    reasons.push("confirmationInput.schemaVersion: unsupported");
  }
  if (typeof value.committedText !== "string") {
    reasons.push("confirmationInput.committedText: must be a string");
  }
  if (!isNonNegativeInteger(value.turnIndex)) {
    reasons.push("confirmationInput.turnIndex: must be a non-negative integer");
  }
  if (!isSpokenActionEffectClass(value.effectClass)) {
    reasons.push("confirmationInput.effectClass: unknown effect class");
  }
  if (!isVoiceTranscriptSource(value.source)) {
    reasons.push("confirmationInput.source: unknown transcript source");
  }
  if (!isNonNegativeInteger(value.committedSegmentCount)) {
    reasons.push("confirmationInput.committedSegmentCount: must be a non-negative integer");
  }
}

export function validateSpokenActionProposal(value: unknown): SpokenActionValidationResult {
  if (!isRecord(value)) {
    return { ok: false, reasons: ["proposal: must be an object"] };
  }
  const reasons: string[] = [];
  if (!isVoiceActionIntentSchemaVersionSupported(value.schemaVersion)) {
    reasons.push("schemaVersion: unsupported");
  }
  if (!isSpokenActionEffectClass(value.effectClass)) {
    reasons.push("effectClass: unknown effect class");
  }
  if (typeof value.requiresConfirmation !== "boolean") {
    reasons.push("requiresConfirmation: must be a boolean");
  }
  if (!isSpokenActionState(value.state)) {
    reasons.push("state: unknown spoken action state");
  }
  if (!isVoiceTranscriptSource(value.source)) {
    reasons.push("source: unknown transcript source");
  }
  validateCommittedCounts(value, reasons);
  validateConfirmationInput(value.confirmationInput, reasons);
  return buildSpokenActionResult(reasons);
}

export function validateSpokenActionAuditRecord(value: unknown): SpokenActionValidationResult {
  if (!isRecord(value)) {
    return { ok: false, reasons: ["audit: must be an object"] };
  }
  const reasons: string[] = [];
  if (!isVoiceActionIntentSchemaVersionSupported(value.schemaVersion)) {
    reasons.push("schemaVersion: unsupported");
  }
  if (!isSpokenActionEffectClass(value.effectClass)) {
    reasons.push("effectClass: unknown effect class");
  }
  if (!isSpokenActionState(value.state)) {
    reasons.push("state: unknown spoken action state");
  }
  if (typeof value.confirmationRequired !== "boolean") {
    reasons.push("confirmationRequired: must be a boolean");
  }
  if (typeof value.confirmed !== "boolean") {
    reasons.push("confirmed: must be a boolean");
  }
  if (!isSpokenActionOutcome(value.outcome)) {
    reasons.push("outcome: unknown outcome");
  }
  if (!isVoiceTranscriptSource(value.source)) {
    reasons.push("source: unknown transcript source");
  }
  validateCommittedCounts(value, reasons);
  if (!isValidBindingDigest(value.bindingDigest)) {
    reasons.push("bindingDigest: must be empty or a 64-char lowercase sha256 hex");
  }
  return buildSpokenActionResult(reasons);
}
