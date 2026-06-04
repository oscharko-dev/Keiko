// Explicit-intent extractors for keiko-memory-capture (Epic #204 child #207).
//
// Each `tryExtract*` is a pure function that returns either a CaptureOutcome (one of: candidate,
// update, forget, supersession, rejected) or `null` for "this text is not this intent kind".
// The top-level capture function in capture.ts probes them in a fixed order — first non-null
// wins. Regex patterns are intentionally narrow: ambiguous matches return null so the next
// extractor (or the no-intent fallthrough) gets a chance.
//
// Pure: no clock, no randomness, no IO. All time and IDs come from CaptureContext.

import type { MemoryId, MemoryScope } from "@oscharko-dev/keiko-contracts/memory";

import { buildForget, buildProposal, buildUpdate } from "./_envelopes.js";
import { applyPolicy } from "./policy.js";
import { inferScopeFromContext } from "./scope-inference.js";
import { scanForSecrets } from "./secret-patterns.js";
import type { CaptureContext, CaptureOutcome, CapturePolicyOptions } from "./types.js";

// ─── Regex catalogue (narrow, anchored, single-quantifier) ────────────────────
// All patterns are anchored and use a single open or bounded quantifier. The phrase trailing
// the imperative is captured greedily ON A SINGLE LINE (no `s` flag) so embedded newlines
// terminate the match — this prevents a multi-line paste from being absorbed into one body.
const REMEMBER_RE = /^\s*remember(?:\s+that)?\s+(.+?)\s*$/i;
const REMEMBER_ABOUT_RE =
  /^\s*remember\s+about\s+(?:this\s+(?:project|workspace)[:,\s]+)?(.+?)\s*$/i;
const FORGET_RE = /^\s*forget(?:\s+about)?\s+(.+?)\s*$/i;
const UPDATE_RE =
  /^\s*update\s+(?:memory|the\s+memory)\s+about\s+(.+?)\s+(?:to\s+be|with|:)\s+(.+?)\s*$/i;
const ACTUALLY_RE = /^\s*actually,?\s+(.+?)\s*$/i;
const CORRECTION_LABEL_RE = /^\s*correction:\s*(.+?)\s*$/i;
const THATS_WRONG_RE =
  /^\s*that(?:'s|\s+is)\s+wrong[,.]?\s+(.+?)\s+(?:is|are|should\s+be)\s+(.+?)\s*$/i;

// Helper: secret scan + length scan + reject the body if either fires. Returns either a
// rejection outcome (caller should return it) or null when the body is safe to embed.
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
  const aboutMatch = REMEMBER_ABOUT_RE.exec(text);
  const plainMatch = aboutMatch === null ? REMEMBER_RE.exec(text) : null;
  const body = aboutMatch?.[1] ?? plainMatch?.[1];
  if (body === undefined) {
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
  const match = FORGET_RE.exec(text);
  if (match === null) {
    return null;
  }
  const target = match[1];
  if (target === undefined) {
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
  const operation = buildForget({ context, memoryId: resolved.memoryId, reason: target });
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
  if (wrongMatch?.[1] !== undefined && wrongMatch[2] !== undefined) {
    return `${wrongMatch[1]} is ${wrongMatch[2]}`;
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
