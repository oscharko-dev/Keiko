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
import { memoryTextSecretEgressRejectionReason } from "./capture-safety.js";
import type { CaptureContext, CaptureOutcome, CapturePolicyOptions } from "./types.js";

// ─── Regex catalogue (narrow, anchored, single-quantifier) ────────────────────
// All patterns are anchored and use a single open or bounded quantifier. The phrase trailing
// the imperative is captured greedily ON A SINGLE LINE (no `s` flag) so embedded newlines
// terminate the match — this prevents a multi-line paste from being absorbed into one body.
//
// REMEMBER_PATTERNS / REMEMBER_ABOUT_PATTERNS / FORGET_PATTERNS are intentionally *prefix-only*:
// they match the imperative keyword plus its optional inner clauses ("that", "bitte", "dass",
// "about this project:", …) and the mandatory separator before the body, but capture nothing and
// place no constraint after their own final quantifier. An earlier revision chained a `\S`-anchored
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
// The other patterns (ACTUALLY_RE, CORRECTION_LABEL_RE) keep the single-regex
// `(\S(?:.*\S)?)\s*$` capture style: their prefixes have no optional inner clause immediately
// adjacent to the mandatory separator, so they aren't subject to the same ambiguity. `\S` and
// `\s` are disjoint, so `(\S(?:.*\S)?)` has exactly one way to split the input: the body is
// forced to end on its own last non-whitespace character, with no ambiguity to backtrack over
// (O(n) instead of the O(n^2) that `(.+?)\s*$` had — SonarCloud S8786). The two-target patterns
// (UPDATE_BODY_RE, THATS_WRONG_BODY_RE) apply the analogous fix to the leading group:
// `(\S+(?:\s+\S+)*?)` tokenizes on the disjoint `\S`/`\s` boundary instead of scanning
// character-by-character with `.+?`, which removes the same overlap against the separator's
// `\s+`.
//
// Every prefix keyword used to live as one branch of a single top-level alternation (e.g.
// `remember(?:\s+that)?|merk(e)?\s+dir...|speicher...|notier...`). SonarCloud S5843 flags that
// shape once enough keyword/language variants pile into one regex literal: structural complexity
// (nesting x alternation branches) crosses the rule's threshold even though each branch alone is
// simple. The fix below splits each mega-alternation into one small regex per keyword/variant,
// tried in order via `execFirst`. This is behaviourally identical to the original alternation:
// the keywords are mutually exclusive prefixes (different first letters / distinct literal
// words), so trying them one at a time in the same order the alternation would have tried its
// branches yields the same first match. UPDATE_KEYWORD_PATTERNS/THATS_WRONG_KEYWORD_PATTERNS
// split the same way; each keyword's own trailing `\s+` prefix-match is then handed to a
// *separate* body regex (UPDATE_BODY_RE / THATS_WRONG_BODY_RE) applied to the remainder, which
// keeps the O(n) backtracking-safety documented above intact — neither half changes internally,
// only where the split between them falls.
function execFirst(patterns: readonly RegExp[], text: string): RegExpExecArray | null {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match !== null) {
      return match;
    }
  }
  return null;
}

const REMEMBER_PATTERNS: readonly RegExp[] = [
  /^\s*remember(?:\s+that)?\s+/iu,
  /^\s*(?:merk|merke)\s+dir(?:\s+bitte)?(?:,?\s+dass)?\s+/iu,
  /^\s*speicher(?:e)?(?:\s+bitte)?(?:,?\s+dass)?\s+/iu,
  /^\s*notier(?:e)?(?:\s+bitte)?(?:,?\s+dass)?\s+/iu,
];
// Each branch carries its own copy of the trailing "this project/workspace:" scope hint (rather
// than factoring it into a second matching stage) so a single execFirst pass still yields the
// complete prefix length bodyAfterPrefix needs — matching the original REMEMBER_ABOUT_RE shape.
// The (project|workspace) alternation is now a CAPTURING group (audit KEIKO-0336): tryExtractRemember
// reads the captured noun and threads it into scopeOrReject as an explicit scopeKind, so
// "remember about this workspace: X" produces workspace-scoped output even when projectId is set
// (pickImplicitScopeKind's project-first precedence would otherwise silently override the user's
// stated intent). When the "about this project|workspace" fragment is absent (i.e. the plain
// "remember about X" form) the capture is undefined and scope inference falls back to context
// precedence exactly as before.
const REMEMBER_ABOUT_PATTERNS: readonly RegExp[] = [
  /^\s*remember\s+about\s+(?:this\s+(project|workspace)[:,\s]+)?/iu,
  /^\s*merk(?:e)?\s+dir\s+(?:zu|über|ueber)\s+(?:this\s+(project|workspace)[:,\s]+)?/iu,
  /^\s*speicher(?:e)?\s+(?:zu|über|ueber)\s+(?:this\s+(project|workspace)[:,\s]+)?/iu,
];
const FORGET_PATTERNS: readonly RegExp[] = [
  /^\s*forget(?:\s+about)?\s+/iu,
  /^\s*vergiss(?:\s+bitte)?(?:\s+(?:alles\s+)?(?:über|ueber|zu|an))?\s+/iu,
  /^\s*lösche(?:\s+bitte)?(?:\s+die\s+erinnerung\s+(?:an|zu|über|ueber))?\s+/iu,
];
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
const UPDATE_KEYWORD_PATTERNS: readonly RegExp[] = [
  /^\s*update\s+(?:memory|the\s+memory)\s+about\s+/iu,
  /^\s*aktualisiere(?:\s+bitte)?\s+(?:die\s+)?(?:erinnerung|speicher(?:eintrag)?)\s+(?:zu|zum|zur|über|ueber)\s+/iu,
];
const UPDATE_BODY_RE = /^(\S+(?:\s+\S+)*?)\s+(?:to\s+be|with|auf|mit|zu|:)\s+(\S(?:.*\S)?)\s*$/iu;
const ACTUALLY_RE = /^\s*(?:actually|eigentlich),?\s+(\S(?:.*\S)?)\s*$/iu;
const CORRECTION_LABEL_RE = /^\s*(?:correction|korrektur):\s*(\S(?:.*\S)?)\s*$/iu;
const THATS_WRONG_KEYWORD_PATTERNS: readonly RegExp[] = [
  /^\s*that(?:'s|\s+is)\s+wrong[,.]?\s+/iu,
  /^\s*das\s+stimmt\s+nicht[,.]?\s+/iu,
  /^\s*falsch[,.]?\s+/iu,
];
// Split from one 6-branch-verb regex into two 3-branch ones (typescript:S5843 — the combined form
// was still over the complexity threshold even after the earlier keyword-prefix split). The
// original's lazy subject group `(?:\s+\S+)*?` always expands to the FIRST position (leftmost)
// where any of the 6 verb alternatives matches, regardless of language — trying one pattern before
// the other (Gitar review finding) is NOT behavior-identical for mixed EN/DE text, since the
// tried-first pattern can match a later verb of its own language while ignoring an earlier verb of
// the other. execThatsWrongBody below runs both independently and keeps whichever has the shorter
// (earlier-ending) subject capture, replicating the original's leftmost-wins selection exactly.
const THATS_WRONG_BODY_EN_RE = /^(\S+(?:\s+\S+)*?)\s+(is|are|should\s+be)\s+(\S(?:.*\S)?)\s*$/iu;
const THATS_WRONG_BODY_DE_RE =
  /^(\S+(?:\s+\S+)*?)\s+(ist|sind|sollte\s+sein)\s+(\S(?:.*\S)?)\s*$/iu;

function execThatsWrongBody(text: string): RegExpExecArray | null {
  const en = THATS_WRONG_BODY_EN_RE.exec(text);
  const de = THATS_WRONG_BODY_DE_RE.exec(text);
  if (en === null) return de;
  if (de === null) return en;
  return (en[1]?.length ?? 0) <= (de[1]?.length ?? 0) ? en : de;
}
// Helper: secret scan + reject the body if it fires. Length enforcement happens in capture.ts
// preflight before the explicit extractors run.
function rejectIfUnsafe(body: string, policy: CapturePolicyOptions): CaptureOutcome | null {
  const reason = memoryTextSecretEgressRejectionReason(body, policy);
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

// Explicit scope hint captured from "about this <project|workspace>:" text. Alias exists so
// the surrounding helpers and the extractor's own signature share one type name instead of
// re-stating the string union in every position.
type ExplicitScopeKind = "project" | "workspace";

// Fail-closed conflict check: when the caller has already supplied an authority-constraint
// scopeKind AND the "about this <noun>:" fragment names a DIFFERENT scope, reject the capture.
// This closes the trust-boundary hole where user-controlled text could widen a project-scoped
// policy to workspace scope by writing "about this workspace" (PR-review follow-up on KEIKO-0336).
function rejectOnScopeConflict(
  policy: CapturePolicyOptions,
  explicitScopeKind: ExplicitScopeKind | undefined,
  _context: CaptureContext,
): CaptureOutcome | null {
  if (policy.scopeKind === undefined || explicitScopeKind === undefined) return null;
  if (policy.scopeKind === explicitScopeKind) return null;
  return { kind: "rejected", reason: "scope-not-resolvable" };
}

function mergePolicyScopeKind(
  policy: CapturePolicyOptions,
  explicitScopeKind: ExplicitScopeKind | undefined,
): CapturePolicyOptions {
  if (explicitScopeKind === undefined) return policy;
  if (policy.scopeKind !== undefined) return policy;
  return { ...policy, scopeKind: explicitScopeKind };
}

// Reads the capturing group added to REMEMBER_ABOUT_PATTERNS. Returns undefined when the "about
// this <noun>:" fragment was absent (plain "remember about X"), so the caller preserves whatever
// policy.scopeKind (if any) was already provided by the surrounding capture pipeline. Audit
// KEIKO-0336.
function explicitScopeKindFromAboutMatch(
  aboutPrefixMatch: RegExpExecArray | null,
): ExplicitScopeKind | undefined {
  const captured = aboutPrefixMatch?.[1];
  if (captured === undefined) {
    return undefined;
  }
  const normalized = captured.toLowerCase();
  if (normalized === "project" || normalized === "workspace") {
    return normalized;
  }
  return undefined;
}

// ─── tryExtractRemember ──────────────────────────────────────────────────────
// "remember about this project: X" → project scope hint. "remember about this workspace: X" →
// workspace scope hint. "remember that X" / "remember X" → implicit scope from context. Emits a
// preference-type proposal — explicit user instructions are the canonical preference source per
// #205 source-kind taxonomy.
export function tryExtractRemember(
  text: string,
  context: CaptureContext,
  policy: CapturePolicyOptions = {},
): CaptureOutcome | null {
  // "about" is tried first and, if its prefix matches at all (even with an unusable body), wins
  // outright — falling back to the plain prefix on a matched-but-empty "about" body would let
  // the plain pattern reinterpret the word "about" itself as body text (the same class of bug
  // this file's regex catalogue comment documents).
  const aboutPrefixMatch = execFirst(REMEMBER_ABOUT_PATTERNS, text);
  const plainPrefixMatch = aboutPrefixMatch === null ? execFirst(REMEMBER_PATTERNS, text) : null;
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
  // The REMEMBER_ABOUT_PATTERNS capture the noun ("project" or "workspace") when the user wrote
  // "about this <noun>:". Thread it through scopeOrReject as an explicit scopeKind only when
  // the CALLER has not already set one (audit KEIKO-0336). PR-review follow-up: never let
  // user-controlled text override an authority-constraint scopeKind supplied by the pipeline
  // — that would let "remember about this workspace" widen a project-scoped policy from an
  // agent turn. On conflict (policy asks for one scope, text names the other) fail closed by
  // rejecting the capture, mirroring how scope-missing already rejects.
  const explicitScopeKind = explicitScopeKindFromAboutMatch(aboutPrefixMatch);
  const conflictOutcome = rejectOnScopeConflict(policy, explicitScopeKind, context);
  if (conflictOutcome !== null) return conflictOutcome;
  const effectivePolicy = mergePolicyScopeKind(policy, explicitScopeKind);
  const scopeResolution = scopeOrReject(context, effectivePolicy);
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
  const prefixMatch = execFirst(FORGET_PATTERNS, text);
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
  const prefixMatch = execFirst(UPDATE_KEYWORD_PATTERNS, text);
  if (prefixMatch === null) {
    return null;
  }
  const match = UPDATE_BODY_RE.exec(text.slice(prefixMatch[0].length));
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
  const wrongPrefixMatch = execFirst(THATS_WRONG_KEYWORD_PATTERNS, text);
  if (wrongPrefixMatch !== null) {
    const wrongMatch = execThatsWrongBody(text.slice(wrongPrefixMatch[0].length));
    if (
      wrongMatch?.[1] !== undefined &&
      wrongMatch[2] !== undefined &&
      wrongMatch[3] !== undefined
    ) {
      return `${wrongMatch[1]} ${wrongMatch[2]} ${wrongMatch[3]}`;
    }
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
