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
// pass prunes). We still apply the full secret-rejection net and clamp confidence into a band
// that stays retrievable (>0.3 stale floor) but below the 1.0 reserved for explicit user intent.

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
} from "./types.js";
import type { MemoryType } from "@oscharko-dev/keiko-contracts/memory";

// Confidence band: floor 0.4 keeps salience candidates above the 0.3 stale-suppression floor so
// they remain retrievable; ceiling 0.9 keeps them below the 1.0 reserved for explicit user intent.
const CONFIDENCE_MIN = 0.4;
const CONFIDENCE_MAX = 0.9;
// Hard cap on accepted candidates per turn — over-capture is bounded.
const MAX_CANDIDATES = 6;
// Jaccard char-bigram similarity at/above which a candidate is treated as a near-duplicate.
const DEDUP_THRESHOLD = 0.8;
// Provenance string surfaced in the Memory Center detail view (decision 2). Salience reuses the
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
  readonly tags: readonly string[];
}

// ─── Verbatim extraction prompt ──────────────────────────────────────────────
export const SALIENCE_SYSTEM_PROMPT = `You extract durable memories from a chat turn so an assistant can remember the user across future conversations.

Return ONLY a JSON array (no prose, no markdown fences). Each element:
{ "body": string, "type": string, "confidence": number, "scope": string, "tags": string[] }

Capture ONLY facts the USER asserted about THEMSELVES or THEIR work that are durable and worth remembering: identity, stable preferences, project and technology facts, decisions, constraints, goals, environment, team, and recurring workflow lessons. Write each "body" as a concise, self-contained, third-person statement (e.g. "The user is building a fintech app called Atlas in Rust with PostgreSQL"). Identity statements should be canonicalised the same way every time, for example "My name is Paul." / "Hallo Keiko, ich bin Paul." -> "The user's name is Paul.".

Capture LIBERALLY — the bar is low; when in doubt, include it.

EXCLUDE: questions; one-off ephemeral task requests; anything the ASSISTANT said or suggested (the assistant message is context only, never a source of user facts); general world knowledge; and anything secret or credential-like (passwords, API keys, tokens, private keys).

"type" is one of: identity, preference, fact, decision, constraint, goal, lesson, procedural. "scope" is one of: user (personal facts/preferences), project (project-specific facts), workspace. "confidence" is 0..1. "tags" is a short list of lowercase keywords.

If there is nothing durable to capture, return [].`;

function buildUserPrompt(userText: string, assistantText: string | undefined): string {
  const assistantBlock =
    assistantText !== undefined && assistantText.trim().length > 0
      ? `\n\nAssistant said (CONTEXT ONLY — never a source of user facts):\n${assistantText}`
      : "";
  return `User said:\n${userText}${assistantBlock}`;
}

// ─── Defensive JSON parsing (never throws) ───────────────────────────────────
function stripCodeFences(raw: string): string {
  return raw.replace(/```[a-zA-Z]*\n?/g, "").replace(/```/g, "");
}

// Locate the first balanced top-level JSON array. Returns the substring or null. Scans for the
// first "[" then walks to its matching "]" tracking string literals and escapes so a bracket
// inside a string value does not close the array early.
function firstBalancedArray(text: string): string | null {
  const start = text.indexOf("[");
  if (start === -1) {
    return null;
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (ch === "[") {
      depth += 1;
    } else if (ch === "]") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
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

function mapType(loose: string): MemoryType {
  return TYPE_MAP[loose.trim().toLowerCase()] ?? "semantic-fact";
}

function mapScopeKind(loose: string): MemoryScopeKindHint {
  const normalized = loose.trim().toLowerCase();
  if (normalized === "project" || normalized === "workspace") {
    return normalized;
  }
  return "user";
}

function clampConfidence(value: number): number {
  if (Number.isNaN(value)) {
    return CONFIDENCE_MIN;
  }
  return Math.min(CONFIDENCE_MAX, Math.max(CONFIDENCE_MIN, value));
}

// ─── Dedup (pure, char-bigram Jaccard) ───────────────────────────────────────
function normalizeForDedup(body: string): string {
  return body
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
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

// Turns one validated raw item into a candidate outcome, or null when it must be dropped (secret,
// empty/oversize body, or unresolvable scope). Pure given the effective context.
function buildCandidate(
  item: RawSalienceItem,
  context: CaptureContext,
  policy: CapturePolicyOptions,
): CaptureOutcome | null {
  const body = item.body.trim();
  const max = policy.maxBodyChars ?? MEMORY_BODY_MAX_CHARS_DEFAULT;
  if (body.length === 0 || body.length > max) {
    return null;
  }
  if (scanForSecrets(body, policy.customerIdentifierMatchers ?? []) !== null) {
    return null;
  }
  const scope = inferScopeFromContext(context, {
    scopeKind: mapScopeKind(item.scope),
    ...(policy.allowGlobalScope !== undefined && { allowGlobalScope: policy.allowGlobalScope }),
  });
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
      type: mapType(item.type),
      sensitivity: decision.sensitivity,
      sourceKind: "system-default",
      captureRationale: SALIENCE_RATIONALE,
    },
    clampConfidence(item.confidence),
  );
  return {
    kind: "candidate",
    proposal: { ...proposal, tags: [...item.tags] },
    requiresApproval: decision.requiresApproval,
  };
}

// ─── Public entry point ──────────────────────────────────────────────────────
export async function extractSalientMemories(
  input: SalienceInput,
  deps: SalienceDeps,
): Promise<readonly CaptureOutcome[]> {
  if (input.userText.trim().length === 0) {
    return [];
  }
  const raw = await deps.callModel(
    SALIENCE_SYSTEM_PROMPT,
    buildUserPrompt(input.userText, input.assistantText),
  );
  const items = parseSalienceItems(raw);
  const context = effectiveContext(input, deps);
  const policy = input.policy ?? {};
  const seen: ReadonlySet<string>[] = input.existingBodies.map((body) =>
    charBigrams(normalizeForDedup(body)),
  );
  const accepted: CaptureOutcome[] = [];
  for (const item of items) {
    if (accepted.length >= MAX_CANDIDATES) {
      break;
    }
    const candidate = buildCandidate(item, context, policy);
    if (candidate === null) {
      continue;
    }
    const bigrams = charBigrams(normalizeForDedup(item.body));
    if (isNearDuplicate(bigrams, seen)) {
      continue;
    }
    seen.push(bigrams);
    accepted.push(candidate);
  }
  return accepted;
}
