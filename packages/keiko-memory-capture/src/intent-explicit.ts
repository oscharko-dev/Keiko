// Explicit-intent extractors for keiko-memory-capture (Epic #204 child #207).
//
// Each `tryExtract*` is a pure function that returns either a CaptureOutcome (one of: candidate,
// update, forget, supersession, rejected) or `null` for "this text is not this intent kind".
// The top-level capture function in capture.ts probes them in a fixed order — first non-null
// wins. Regex patterns are intentionally narrow: ambiguous matches return null so the next
// extractor (or the no-intent fallthrough) gets a chance.
//
// Pure: no clock, no randomness, no IO. All time and IDs come from CaptureContext.

import {
  MEMORY_FORGET_REASON_EXPLICIT_USER_REQUEST,
  type MemoryId,
  type MemoryScope,
} from "@oscharko-dev/keiko-contracts/memory";

import { buildForget, buildProposal, buildUpdate } from "./_envelopes.js";
import { applyPolicy } from "./policy.js";
import { inferScopeFromContext } from "./scope-inference.js";
import { scanForSecrets } from "./secret-patterns.js";
import type { CaptureContext, CaptureOutcome, CapturePolicyOptions } from "./types.js";

// ─── Regex catalogue (narrow, anchored, single-quantifier) ────────────────────
// All patterns are anchored and use a single open or bounded quantifier. The phrase trailing
// the imperative is captured greedily ON A SINGLE LINE (no `s` flag) so embedded newlines
// terminate the match — this prevents a multi-line paste from being absorbed into one body.
//
// REMEMBER_RE / REMEMBER_ABOUT_RE / FORGET_RE are intentionally *prefix-only*: they match the
// imperative keyword plus its optional inner clauses ("that", "bitte", "dass", "about this
// project:", …) and the mandatory separator before the body, but capture nothing and place no
// constraint after their own final quantifier. An earlier revision chained a `\S`-anchored
// capture group directly onto these alternations (`...)\s+(\S(?:.*\S)?)\s*$`), which reintroduced
// backtracking: because the inner keyword clauses are *optional*, the engine can retreat one out
// of the prefix — as long as some leftover whitespace still lets the mandatory `\s+` separator
// match — and then reinterpret the keyword's own text as the captured body, whenever the true
// trailing content is whitespace-only. Concretely, that shape made "remember that   " capture
// body="that" and "forget about   " capture target="about" (the keyword itself), instead of
// correctly recognizing there is no body/target at all. A prefix pattern with nothing after its
// final quantifier has exactly one possible parse for a given input — greedy match of the full
// optional chain, or no match — so there is nothing left for the engine to backtrack into.
// `bodyAfterPrefix` (below) derives the body by slicing off the matched prefix and trimming,
// which is a plain linear-time string operation with no adjacent overlapping quantifiers, and
// correctly returns `null` (not this intent) when nothing but whitespace remains.
//
// The other patterns (UPDATE_RE, ACTUALLY_RE, CORRECTION_LABEL_RE, THATS_WRONG_RE) keep the
// single-regex `(\S(?:.*\S)?)\s*$` capture style: their prefixes have no optional inner clause
// immediately adjacent to the mandatory separator, so they aren't subject to the same ambiguity.
// `\S` and `\s` are disjoint, so `(\S(?:.*\S)?)` has exactly one way to split the input: the body
// is forced to end on its own last non-whitespace character, with no ambiguity to backtrack over
// (O(n) instead of the O(n^2) that `(.+?)\s*$` had — SonarCloud S8786). The two-target patterns
// (UPDATE_RE, THATS_WRONG_RE) apply the analogous fix to the leading group:
// `(\S+(?:\s+\S+)*?)` tokenizes on the disjoint `\S`/`\s` boundary instead of scanning
// character-by-character with `.+?`, which removes the same overlap against the separator's
// `\s+`.
const REMEMBER_RE =
  /^\s*(?:remember(?:\s+that)?|(?:merk|merke)\s+dir(?:\s+bitte)?(?:,?\s+dass)?|speicher(?:e)?(?:\s+bitte)?(?:,?\s+dass)?|notier(?:e)?(?:\s+bitte)?(?:,?\s+dass)?)\s+/iu;
const REMEMBER_ABOUT_RE =
  /^\s*(?:remember\s+about|merk(?:e)?\s+dir\s+(?:zu|über|ueber)|speicher(?:e)?\s+(?:zu|über|ueber))\s+(?:this\s+(?:project|workspace)[:,\s]+)?/iu;
const FORGET_RE =
  /^\s*(?:forget(?:\s+about)?|vergiss(?:\s+bitte)?(?:\s+(?:alles\s+)?(?:über|ueber|zu|an))?|lösche(?:\s+bitte)?(?:\s+die\s+erinnerung\s+(?:an|zu|über|ueber))?)\s+/iu;
// Any of the four ECMAScript line-terminator code points. `.` (used by the single-regex-capture
// patterns above) never matches these without the `s`/dotAll flag, so a trimmed body/target
// containing one means the real content spans more than one line — treated as "not this intent",
// mirroring the multi-line-paste guard those patterns get from `.` alone.
const LINE_TERMINATOR_RE = /[\n\r\u2028\u2029]/;

// Derives the body/target for the prefix-only patterns above: slice off the matched prefix, trim
// surrounding whitespace, and reject (null) an empty or genuinely multi-line remainder. Plain
// linear-time string ops — no regex, no backtracking.
function bodyAfterPrefix(prefixMatch: RegExpExecArray, text: string): string | null {
  const rest = text.slice(prefixMatch[0].length);
  const trimmed = rest.trim();
  if (trimmed === "" || LINE_TERMINATOR_RE.test(trimmed)) {
    return null;
  }
  return trimmed;
}
const UPDATE_RE =
  /^\s*(?:update\s+(?:memory|the\s+memory)\s+about|aktualisiere(?:\s+bitte)?\s+(?:die\s+)?(?:erinnerung|speicher(?:eintrag)?)\s+(?:zu|zum|zur|über|ueber))\s+(\S+(?:\s+\S+)*?)\s+(?:to\s+be|with|auf|mit|zu|:)\s+(\S(?:.*\S)?)\s*$/iu;
const ACTUALLY_RE = /^\s*(?:actually|eigentlich),?\s+(\S(?:.*\S)?)\s*$/iu;
const CORRECTION_LABEL_RE = /^\s*(?:correction|korrektur):\s*(\S(?:.*\S)?)\s*$/iu;
const THATS_WRONG_RE =
  /^\s*(?:that(?:'s|\s+is)\s+wrong|das\s+stimmt\s+nicht|falsch)[,.]?\s+(\S+(?:\s+\S+)*?)\s+(is|are|should\s+be|ist|sind|sollte\s+sein)\s+(\S(?:.*\S)?)\s*$/iu;
// Helper: secret scan + reject the body if it fires. Length enforcement happens in capture.ts
// preflight before the explicit extractors run.
function rejectIfUnsafe(body: string, policy: CapturePolicyOptions): CaptureOutcome | null {
  const reason = scanForSecrets(body, policy.customerIdentifierMatchers ?? []);
  if (reason !== null) {
    return { kind: "rejected", reason };
  }
  return null;
}

// Helper: scope inference + null-rejection wrapper. Returns a discriminated union so the
// happy-path `scope` is non-nullable at the call site (no non-null-assertions needed).
type ScopeResolution =
  | { readonly ok: true; readonly scope: MemoryScope }
  | { readonly ok: false; readonly outcome: CaptureOutcome };

function scopeOrReject(context: CaptureContext, policy: CapturePolicyOptions): ScopeResolution {
  const scope = inferScopeFromContext(context, {
    ...(policy.scopeKind !== undefined && { scopeKind: policy.scopeKind }),
    ...(policy.allowGlobalScope !== undefined && { allowGlobalScope: policy.allowGlobalScope }),
  });
  if (scope === null) {
    return { ok: false, outcome: { kind: "rejected", reason: "scope-not-resolvable" } };
  }
  return { ok: true, scope };
}

// Helper: pick the first resolver-match by id with a defined-narrowed type. Returns the typed
// id or null when the array is empty or its first slot is somehow undefined (defensive narrow
// for noUncheckedIndexedAccess; the resolver contract is `readonly MemoryId[]`, not sparse).
function firstResolvedId(matches: readonly MemoryId[]): MemoryId | null {
  const head = matches[0];
  return head ?? null;
}

// Helper: run the caller-supplied resolver for forget/update, branching on cardinality and
// returning a typed `Resolution`. The discriminator collapses the four downstream cases
// (no resolver / no matches / ambiguous / unique) so the caller stays under the complexity cap.
type ResolverOutcome =
  | { readonly kind: "none" }
  | { readonly kind: "ambiguous" }
  | { readonly kind: "unique"; readonly memoryId: MemoryId };

function resolveTarget(
  policy: CapturePolicyOptions,
  target: string,
  scope: MemoryScope,
): ResolverOutcome {
  const resolver = policy.resolver;
  if (resolver === undefined) {
    return { kind: "none" };
  }
  const matches = resolver(target, scope);
  if (matches.length === 0) {
    return { kind: "none" };
  }
  if (matches.length > 1) {
    return { kind: "ambiguous" };
  }
  const head = firstResolvedId(matches);
  return head === null ? { kind: "none" } : { kind: "unique", memoryId: head };
}

// ─── tryExtractRemember ──────────────────────────────────────────────────────
// "remember about this project: X" → project scope hint. "remember that X" / "remember X" →
// implicit scope from context. Emits a preference-type proposal — explicit user instructions
// are the canonical preference source per #205 source-kind taxonomy.
export function tryExtractRemember(
  text: string,
  context: CaptureContext,
  policy: CapturePolicyOptions = {},
): CaptureOutcome | null {
  // "about" is tried first and, if its prefix matches at all (even with an unusable body), wins
  // outright — falling back to the plain prefix on a matched-but-empty "about" body would let
  // the plain pattern reinterpret the word "about" itself as body text (the same class of bug
  // this file's regex catalogue comment documents).
  const aboutPrefixMatch = REMEMBER_ABOUT_RE.exec(text);
  const plainPrefixMatch = aboutPrefixMatch === null ? REMEMBER_RE.exec(text) : null;
  const prefixMatch = aboutPrefixMatch ?? plainPrefixMatch;
  if (prefixMatch === null) {
    return null;
  }
  const body = bodyAfterPrefix(prefixMatch, text);
  if (body === null) {
    return null;
  }
  const rejection = rejectIfUnsafe(body, policy);
  if (rejection !== null) {
    return rejection;
  }
  const scopeResolution = scopeOrReject(context, policy);
  if (!scopeResolution.ok) {
    return scopeResolution.outcome;
  }
  const decision = applyPolicy(body, {
    ...(policy.defaultSensitivity !== undefined && {
      defaultSensitivity: policy.defaultSensitivity,
    }),
  });
  const proposal = buildProposal(
    {
      context,
      scope: scopeResolution.scope,
      body,
      type: "preference",
      sensitivity: decision.sensitivity,
      sourceKind: "explicit-user-instruction",
    },
    1.0,
  );
  return { kind: "candidate", proposal, requiresApproval: decision.requiresApproval };
}

// ─── tryExtractForget ────────────────────────────────────────────────────────
export function tryExtractForget(
  text: string,
  context: CaptureContext,
  policy: CapturePolicyOptions = {},
): CaptureOutcome | null {
  const prefixMatch = FORGET_RE.exec(text);
  if (prefixMatch === null) {
    return null;
  }
  const target = bodyAfterPrefix(prefixMatch, text);
  if (target === null) {
    return null;
  }
  const scopeResolution = scopeOrReject(context, policy);
  if (!scopeResolution.ok) {
    return scopeResolution.outcome;
  }
  const resolved = resolveTarget(policy, target, scopeResolution.scope);
  if (resolved.kind === "none") {
    return null;
  }
  if (resolved.kind === "ambiguous") {
    return { kind: "rejected", reason: "ambiguous-forget" };
  }
  const operation = buildForget({
    context,
    memoryId: resolved.memoryId,
    reason: MEMORY_FORGET_REASON_EXPLICIT_USER_REQUEST,
  });
  return { kind: "forget", operation, requiresConfirmation: true };
}

// ─── tryExtractUpdate ────────────────────────────────────────────────────────
export function tryExtractUpdate(
  text: string,
  context: CaptureContext,
  policy: CapturePolicyOptions = {},
): CaptureOutcome | null {
  const match = UPDATE_RE.exec(text);
  if (match === null) {
    return null;
  }
  const target = match[1];
  const newValue = match[2];
  if (target === undefined || newValue === undefined) {
    return null;
  }
  const rejection = rejectIfUnsafe(newValue, policy);
  if (rejection !== null) {
    return rejection;
  }
  const scopeResolution = scopeOrReject(context, policy);
  if (!scopeResolution.ok) {
    return scopeResolution.outcome;
  }
  const resolved = resolveTarget(policy, target, scopeResolution.scope);
  if (resolved.kind === "none") {
    return null;
  }
  if (resolved.kind === "ambiguous") {
    return { kind: "rejected", reason: "ambiguous-update" };
  }
  const operation = buildUpdate({
    context,
    memoryId: resolved.memoryId,
    bodyPatch: newValue,
  });
  return { kind: "update", operation };
}

// ─── tryExtractCorrection ─────────────────────────────────────────────────────
// Emits a correction-type proposal. We do NOT emit a MemorySupersession envelope here:
// supersession requires knowing the OLD memory id, which requires a resolver lookup analogous
// to update/forget. A correction proposal is the lowest-friction default — the acceptance
// layer (#212) can elevate it to a supersession when it knows the prior fact.
function extractCorrectionBody(text: string): string | null {
  const actuallyMatch = ACTUALLY_RE.exec(text);
  if (actuallyMatch?.[1] !== undefined) {
    return actuallyMatch[1];
  }
  const labelMatch = CORRECTION_LABEL_RE.exec(text);
  if (labelMatch?.[1] !== undefined) {
    return labelMatch[1];
  }
  const wrongMatch = THATS_WRONG_RE.exec(text);
  if (wrongMatch?.[1] !== undefined && wrongMatch[2] !== undefined && wrongMatch[3] !== undefined) {
    return `${wrongMatch[1]} ${wrongMatch[2]} ${wrongMatch[3]}`;
  }
  return null;
}

export function tryExtractCorrection(
  text: string,
  context: CaptureContext,
  policy: CapturePolicyOptions = {},
): CaptureOutcome | null {
  const body = extractCorrectionBody(text);
  if (body === null) {
    return null;
  }
  const rejection = rejectIfUnsafe(body, policy);
  if (rejection !== null) {
    return rejection;
  }
  const scopeResolution = scopeOrReject(context, policy);
  if (!scopeResolution.ok) {
    return scopeResolution.outcome;
  }
  const decision = applyPolicy(body, {
    ...(policy.defaultSensitivity !== undefined && {
      defaultSensitivity: policy.defaultSensitivity,
    }),
  });
  const proposal = buildProposal(
    {
      context,
      scope: scopeResolution.scope,
      body,
      type: "correction",
      sensitivity: decision.sensitivity,
      sourceKind: "accepted-correction",
    },
    1.0,
  );
  return { kind: "candidate", proposal, requiresApproval: decision.requiresApproval };
}
