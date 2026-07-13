// Model-assisted salience capture for keiko-memory-capture.
//
// The regex intent extractors (intent-explicit.ts) only fire on imperative phrases ("remember
// that X"). This module captures DURABLE, salient facts the user asserts in NATURAL conversation
// ("I'm building a fintech app called Atlas in Rust") that the regex path misses entirely.
//
// It is the one extractor that needs the model, so it is async — but the boundary stays thin:
// exactly one `callModel` await, defensive JSON parsing that can NEVER throw (malformed prose →
// []), then the same deterministic envelope/secret/scope/policy pipeline the regex path uses.
//
// Product intent: the capture bar is LOW (over-capture is acceptable; a later decay/consolidation
// pass prunes). We still apply the full secret-rejection net and clamp confidence below the 1.0
// reserved for explicit user intent. Low model confidence stays low; retrieval suppression can then
// keep weak candidates out until a governed acceptance/edit strengthens them.

import { MEMORY_BODY_MAX_CHARS_DEFAULT } from "./_constants.js";
import { buildProposal } from "./_envelopes.js";
import { applyPolicy } from "./policy.js";
import { inferScopeFromContext } from "./scope-inference.js";
import { scanForSecrets } from "./secret-patterns.js";
import type {
  CaptureContext,
  CaptureOutcome,
  CapturePolicyOptions,
  MemoryScopeKindHint,
  SalienceDeps,
  SalienceInput,
  SalienceModelMessage,
} from "./types.js";
import type { MemoryType } from "@oscharko-dev/keiko-contracts/memory";

// Confidence band: ceiling 0.9 keeps salience below the 1.0 reserved for explicit user intent.
// Floor 0.2 intentionally stays below the retrieval stale floor (0.3), so uncertain inferred facts
// do not become retrievable just because the model returned a tiny confidence.
const CONFIDENCE_MIN = 0.2;
const CONFIDENCE_MAX = 0.9;
// Hard cap on accepted candidates per turn — over-capture is bounded.
const MAX_CANDIDATES = 6;
const MAX_TAGS = 8;
const MAX_TAG_CHARS = 32;
// Jaccard char-bigram similarity at/above which a candidate is treated as a near-duplicate.
const DEDUP_THRESHOLD = 0.8;
// Provenance string surfaced in the MemoriaViva detail view (decision 2). Salience reuses the
// "system-default" source kind (no dedicated conversation-inferred kind exists yet), so this
// rationale is the explainability signal that the memory was inferred, not user-instructed.
const SALIENCE_RATIONALE = "Automatically inferred from conversation (salience capture)";

// Raw item shape the model is instructed to emit. Every field is validated before use; nothing
// here is trusted as a contract type.
interface RawSalienceItem {
  readonly body: string;
  readonly type: string;
  readonly confidence: number;
  readonly scope: string;
  readonly source: string;
  readonly tags: readonly string[];
}

type ModelDropReason = "non-user-source" | "unknown-type" | "unknown-scope";

interface CandidateMetadata {
  readonly type: MemoryType;
  readonly scopeKind: MemoryScopeKindHint;
}

// ─── Verbatim extraction prompt ──────────────────────────────────────────────
export const SALIENCE_SYSTEM_PROMPT = `You extract durable memories from a chat turn so an assistant can remember the user across future conversations.

Return ONLY a JSON array (no prose, no markdown fences). Each element:
{ "body": string, "type": string, "confidence": number, "scope": string, "source": "user", "tags": string[] }

Capture ONLY facts the USER asserted about THEMSELVES or THEIR work that are durable and worth remembering: identity, stable preferences, project and technology facts, decisions, constraints, goals, environment, team, and recurring workflow lessons. Write each "body" as a concise, self-contained, third-person statement in the same language as the user's fact or the conversation. Do not translate German or multilingual facts into English.

Examples:
- "My name is Paul." -> "The user's name is Paul."
- "Hallo Keiko, ich bin Paul." -> "Der Nutzer heißt Paul."
- "Wir bauen Atlas in Rust mit PostgreSQL." -> "Der Nutzer baut Atlas in Rust mit PostgreSQL."

Capture LIBERALLY — the bar is low; when in doubt, include it.

EXCLUDE: questions; one-off ephemeral task requests; anything the ASSISTANT said or suggested (the assistant message is context only, never a source of user facts); general world knowledge; and anything secret or credential-like (passwords, API keys, tokens, private keys).

"type" is one of: identity, preference, fact, decision, constraint, goal, lesson, procedural. "scope" is one of: user (personal facts/preferences), project (project-specific facts), workspace. "source" MUST be "user"; never emit assistant-sourced facts. "confidence" is 0..1. "tags" is a short list of lowercase keywords.

If there is nothing durable to capture, return [].`;

function buildLegacyUserPrompt(messages: readonly SalienceModelMessage[]): string {
  return messages
    .filter((message) => message.role !== "system")
    .map((message) => message.content)
    .join("\n\n");
}

export function buildSalienceMessages(
  userText: string,
  assistantText: string | undefined,
): readonly SalienceModelMessage[] {
  const messages: SalienceModelMessage[] = [{ role: "system", content: SALIENCE_SYSTEM_PROMPT }];
  const trimmedAssistantText = assistantText?.trim();
  if (trimmedAssistantText !== undefined && trimmedAssistantText.length > 0) {
    messages.push({
      role: "assistant",
      content: `Assistant said (CONTEXT ONLY — never a source of user facts):\n${trimmedAssistantText}`,
    });
  }
  messages.push({ role: "user", content: `User said:\n${userText}` });
  return messages;
}

async function callSalienceModel(input: SalienceInput, deps: SalienceDeps): Promise<string> {
  const messages = buildSalienceMessages(input.userText, input.assistantText);
  if (deps.callModelMessages !== undefined) {
    return deps.callModelMessages(messages);
  }
  return deps.callModel(SALIENCE_SYSTEM_PROMPT, buildLegacyUserPrompt(messages));
}

// ─── Defensive JSON parsing (never throws) ───────────────────────────────────
function stripCodeFences(raw: string): string {
  return raw.replace(/```[a-zA-Z]*\n?/g, "").replace(/```/g, "");
}

// Scan state for firstBalancedArray: bracket nesting depth plus the string/escape tracking that
// keeps brackets inside string values from being mistaken for structural array brackets.
interface ArrayScanState {
  depth: number;
  inString: boolean;
  escaped: boolean;
}

// Applies string-literal and backslash-escape tracking for one character. Returns true when the
// character was consumed by that tracking (i.e. the caller must not also treat it as a bracket).
function consumeStringOrEscape(ch: string | undefined, state: ArrayScanState): boolean {
  if (state.escaped) {
    state.escaped = false;
    return true;
  }
  if (ch === "\\") {
    state.escaped = true;
    return true;
  }
  if (ch === '"') {
    state.inString = !state.inString;
    return true;
  }
  return state.inString;
}

// Updates bracket depth for one non-string, non-escape character. Returns the index at which the
// top-level array closes, or null if scanning should continue.
function trackBracketDepth(
  ch: string | undefined,
  index: number,
  state: ArrayScanState,
): number | null {
  if (ch === "[") {
    state.depth += 1;
    return null;
  }
  if (ch === "]") {
    state.depth -= 1;
    if (state.depth === 0) {
      return index;
    }
  }
  return null;
}

// Locate the first balanced top-level JSON array. Returns the substring or null. Scans for the
// first "[" then walks to its matching "]" tracking string literals and escapes so a bracket
// inside a string value does not close the array early.
function firstBalancedArray(text: string): string | null {
  const start = text.indexOf("[");
  if (start === -1) {
    return null;
  }
  const state: ArrayScanState = { depth: 0, inString: false, escaped: false };
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (consumeStringOrEscape(ch, state)) {
      continue;
    }
    const closingIndex = trackBracketDepth(ch, i, state);
    if (closingIndex !== null) {
      return text.slice(start, closingIndex + 1);
    }
  }
  return null;
}

function isRawSalienceItem(value: unknown): value is RawSalienceItem {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const item = value as Record<string, unknown>;
  return (
    typeof item.body === "string" &&
    typeof item.type === "string" &&
    typeof item.confidence === "number" &&
    typeof item.scope === "string" &&
    typeof item.source === "string" &&
    Array.isArray(item.tags) &&
    item.tags.every((tag) => typeof tag === "string")
  );
}

// Parse the model output into validated raw items. ANY failure (no array, bad JSON, wrong element
// shapes) yields [] — capture must never throw into the chat path.
export function parseSalienceItems(raw: string): readonly RawSalienceItem[] {
  const arrayText = firstBalancedArray(stripCodeFences(raw));
  if (arrayText === null) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(arrayText);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.filter(isRawSalienceItem);
}

// ─── Loose-label → contract mapping ──────────────────────────────────────────
const TYPE_MAP: Readonly<Record<string, MemoryType>> = {
  identity: "semantic-fact",
  fact: "semantic-fact",
  constraint: "semantic-fact",
  goal: "semantic-fact",
  environment: "semantic-fact",
  team: "semantic-fact",
  preference: "preference",
  decision: "decision",
  lesson: "procedural",
  procedural: "procedural",
  workflow: "procedural",
};

function mapType(loose: string): MemoryType | null {
  return TYPE_MAP[loose.trim().toLowerCase()] ?? null;
}

function mapScopeKind(loose: string): MemoryScopeKindHint | null {
  const normalized = loose.trim().toLowerCase();
  if (normalized === "project" || normalized === "workspace") {
    return normalized;
  }
  if (normalized === "user") {
    return "user";
  }
  return null;
}

function clampConfidence(value: number): number {
  if (Number.isNaN(value)) {
    return CONFIDENCE_MIN;
  }
  return Math.min(CONFIDENCE_MAX, Math.max(CONFIDENCE_MIN, value));
}

function normalizeTag(tag: string): string | null {
  const normalized = tag
    .normalize("NFKC")
    .toLocaleLowerCase("und")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  const bounded = normalized.slice(0, MAX_TAG_CHARS).replace(/^-+|-+$/gu, "");
  return bounded.length === 0 ? null : bounded;
}

function normalizeTags(tags: readonly string[]): readonly string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const tag of tags) {
    const normalized = normalizeTag(tag);
    if (normalized === null || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

// ─── Dedup (pure, char-bigram Jaccard) ───────────────────────────────────────
export function normalizeForDedup(body: string): string {
  return body
    .normalize("NFKC")
    .toLocaleLowerCase("und")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function charBigrams(normalized: string): ReadonlySet<string> {
  const bigrams = new Set<string>();
  for (let i = 0; i < normalized.length - 1; i += 1) {
    bigrams.add(normalized.slice(i, i + 2));
  }
  return bigrams;
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) {
    return 1;
  }
  let intersection = 0;
  for (const bigram of a) {
    if (b.has(bigram)) {
      intersection += 1;
    }
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function isNearDuplicate(
  candidate: ReadonlySet<string>,
  seen: readonly ReadonlySet<string>[],
): boolean {
  for (const existing of seen) {
    if (jaccard(candidate, existing) >= DEDUP_THRESHOLD) {
      return true;
    }
  }
  return false;
}

// ─── Candidate construction ──────────────────────────────────────────────────
// Effective context overlays deps-supplied clock/id factories onto the caller context so the
// scripted test (and the audit ledger) deterministically controls time and ids (decision 3).
function effectiveContext(input: SalienceInput, deps: SalienceDeps): CaptureContext {
  return {
    ...input.context,
    nowMs: deps.now(),
    newMemoryId: deps.newMemoryId,
    newProposalId: deps.newProposalId,
  };
}

function candidateMetadata(
  item: RawSalienceItem,
  onDrop: (reason: ModelDropReason) => void,
): CandidateMetadata | null {
  if (item.source.trim().toLowerCase() !== "user") {
    onDrop("non-user-source");
    return null;
  }
  const type = mapType(item.type);
  if (type === null) {
    onDrop("unknown-type");
    return null;
  }
  const scopeKind = mapScopeKind(item.scope);
  if (scopeKind === null) {
    onDrop("unknown-scope");
    return null;
  }
  return { type, scopeKind };
}

function candidateBody(item: RawSalienceItem, policy: CapturePolicyOptions): string | null {
  const body = item.body.trim();
  const max = policy.maxBodyChars ?? MEMORY_BODY_MAX_CHARS_DEFAULT;
  if (body.length === 0 || body.length > max) return null;
  return scanForSecrets(body, policy.customerIdentifierMatchers ?? []) === null ? body : null;
}

function candidateScope(
  scopeKind: MemoryScopeKindHint,
  context: CaptureContext,
  policy: CapturePolicyOptions,
): ReturnType<typeof inferScopeFromContext> {
  return inferScopeFromContext(context, {
    scopeKind,
    ...(policy.allowGlobalScope !== undefined && { allowGlobalScope: policy.allowGlobalScope }),
  });
}

// Turns one validated raw item into a candidate outcome, or null when it must be dropped (secret,
// empty/oversize body, or unresolvable scope). Pure given the effective context.
function buildCandidate(
  item: RawSalienceItem,
  context: CaptureContext,
  policy: CapturePolicyOptions,
  onDrop: (reason: ModelDropReason) => void,
): CaptureOutcome | null {
  const metadata = candidateMetadata(item, onDrop);
  if (metadata === null) return null;
  const body = candidateBody(item, policy);
  if (body === null) return null;
  const scope = candidateScope(metadata.scopeKind, context, policy);
  if (scope === null) {
    return null;
  }
  const decision = applyPolicy(body, {
    ...(policy.defaultSensitivity !== undefined && {
      defaultSensitivity: policy.defaultSensitivity,
    }),
  });
  const proposal = buildProposal(
    {
      context,
      scope,
      body,
      type: metadata.type,
      sensitivity: decision.sensitivity,
      sourceKind: "system-default",
      captureRationale: SALIENCE_RATIONALE,
    },
    clampConfidence(item.confidence),
  );
  return {
    kind: "candidate",
    proposal: { ...proposal, tags: normalizeTags(item.tags) },
    requiresApproval: decision.requiresApproval,
  };
}

function collectAcceptedCandidates(
  items: readonly RawSalienceItem[],
  context: CaptureContext,
  policy: CapturePolicyOptions,
  seen: ReadonlySet<string>[],
  onDrop: (reason: ModelDropReason) => void,
): CaptureOutcome[] {
  const accepted: CaptureOutcome[] = [];
  for (const item of items) {
    if (accepted.length >= MAX_CANDIDATES) break;
    const candidate = buildCandidate(item, context, policy, onDrop);
    if (candidate === null) continue;
    const bigrams = charBigrams(normalizeForDedup(item.body));
    if (isNearDuplicate(bigrams, seen)) continue;
    seen.push(bigrams);
    accepted.push(candidate);
  }
  return accepted;
}

function emitExtractionDiagnostics(
  deps: SalienceDeps,
  items: readonly RawSalienceItem[],
  acceptedCount: number,
  droppedByReason: ReadonlyMap<ModelDropReason, number>,
): void {
  if (items.length === 0) {
    deps.onDiagnostic?.({ kind: "parse-or-empty-output", rawItemCount: 0 });
  }
  for (const [reason, count] of droppedByReason) {
    deps.onDiagnostic?.({ kind: "dropped-model-items", reason, count });
  }
  if (items.length > 0 && acceptedCount === 0) {
    deps.onDiagnostic?.({
      kind: "zero-candidates-after-filter",
      rawItemCount: items.length,
      acceptedCount: 0,
    });
  }
}

// ─── Public entry point ──────────────────────────────────────────────────────
export async function extractSalientMemories(
  input: SalienceInput,
  deps: SalienceDeps,
): Promise<readonly CaptureOutcome[]> {
  if (input.userText.trim().length === 0) {
    return [];
  }
  const raw = await callSalienceModel(input, deps);
  const items = parseSalienceItems(raw);
  const context = effectiveContext(input, deps);
  const policy = input.policy ?? {};
  const seen: ReadonlySet<string>[] = input.existingBodies.map((body) =>
    charBigrams(normalizeForDedup(body)),
  );
  const droppedByReason = new Map<ModelDropReason, number>();
  const recordDrop = (reason: ModelDropReason): void => {
    droppedByReason.set(reason, (droppedByReason.get(reason) ?? 0) + 1);
  };
  const accepted = collectAcceptedCandidates(items, context, policy, seen, recordDrop);
  emitExtractionDiagnostics(deps, items, accepted.length, droppedByReason);
  return accepted;
}
