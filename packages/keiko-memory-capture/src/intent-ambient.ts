// Narrow ambient extractors for natural-chat identity statements.
//
// These patterns intentionally cover only high-precision self-identification phrases such as
// "my name is Paul" or "Hallo Keiko, ich bin Paul". They still emit `proposed` candidates, so
// governance remains unchanged: nothing is auto-accepted, but common identity facts no longer
// depend on a model-side salience pass to become reviewable.

import type { MemoryScope } from "@oscharko-dev/keiko-contracts/memory";

import { buildProposal } from "./_envelopes.js";
import { applyPolicy } from "./policy.js";
import { scanForSecrets } from "./secret-patterns.js";
import type { CaptureContext, CaptureOutcome, CapturePolicyOptions } from "./types.js";

const IDENTITY_CAPTURE_RATIONALE = "Automatically inferred from conversation (identity statement)";
const MAX_NAME_TOKENS = 4;
const NAME_TOKEN_RE = /^\p{L}[\p{L}'’.-]*$/u;
const TRAILING_PUNCTUATION_RE = /[.!?]+$/u;
const STRONG_IDENTITY_RE =
  /^(?:(?:hello|hi|hey|hallo)\s+keiko\s*[,!.\-:]?\s*)?(?:my\s+name\s+is|call\s+me|ich\s+hei(?:ß|ss)e|mein\s+name\s+ist)\s+(.+?)\s*[.!?]*$/iu;
const WEAK_IDENTITY_RE =
  /^(?:(?:hello|hi|hey|hallo)\s+keiko\s*[,!.\-:]?\s*)?(?:i\s+am|i(?:'|’)m|ich\s+bin)\s+(.+?)\s*[.!?]*$/iu;
const DISALLOWED_NAME_TOKENS = new Set([
  "and",
  "are",
  "as",
  "at",
  "aus",
  "based",
  "bin",
  "building",
  "for",
  "from",
  "here",
  "in",
  "ist",
  "mit",
  "on",
  "the",
  "und",
  "using",
  "with",
  "working",
]);

function userScope(context: CaptureContext): MemoryScope {
  return { kind: "user", userId: context.userId };
}

function normalizeCandidateName(raw: string): string | null {
  const trimmed = raw.trim().replace(TRAILING_PUNCTUATION_RE, "");
  if (trimmed.length === 0) {
    return null;
  }
  const tokens = trimmed.split(/\s+/u);
  if (tokens.length === 0 || tokens.length > MAX_NAME_TOKENS) {
    return null;
  }
  const normalized: string[] = [];
  for (const token of tokens) {
    if (!NAME_TOKEN_RE.test(token)) {
      return null;
    }
    if (DISALLOWED_NAME_TOKENS.has(token.toLowerCase())) {
      return null;
    }
    normalized.push(token);
  }
  return normalized.join(" ");
}

function isStrictIdentityName(name: string): boolean {
  return name.split(/\s+/u).every((token) => /^\p{Lu}/u.test(token));
}

function buildIdentityCandidate(
  name: string,
  context: CaptureContext,
  policy: CapturePolicyOptions,
): CaptureOutcome {
  const body = `The user's name is ${name}.`;
  const rejection = scanForSecrets(body, policy.customerIdentifierMatchers ?? []);
  if (rejection !== null) {
    return { kind: "rejected", reason: rejection };
  }
  const decision = applyPolicy(body, {
    ...(policy.defaultSensitivity !== undefined && {
      defaultSensitivity: policy.defaultSensitivity,
    }),
  });
  const proposal = buildProposal(
    {
      context,
      scope: userScope(context),
      body,
      type: "semantic-fact",
      sensitivity: decision.sensitivity,
      sourceKind: "system-default",
      captureRationale: IDENTITY_CAPTURE_RATIONALE,
    },
    0.9,
  );
  return { kind: "candidate", proposal, requiresApproval: decision.requiresApproval };
}

function extractIdentityName(text: string, requireStrictName: boolean): string | null {
  const match = (requireStrictName ? WEAK_IDENTITY_RE : STRONG_IDENTITY_RE).exec(text);
  const rawName = match?.[1];
  if (rawName === undefined) {
    return null;
  }
  const name = normalizeCandidateName(rawName);
  if (name === null) {
    return null;
  }
  if (requireStrictName && !isStrictIdentityName(name)) {
    return null;
  }
  return name;
}

export function tryExtractAmbientIdentity(
  text: string,
  context: CaptureContext,
  policy: CapturePolicyOptions = {},
): CaptureOutcome | null {
  const strongName = extractIdentityName(text, false);
  if (strongName !== null) {
    return buildIdentityCandidate(strongName, context, policy);
  }
  const weakName = extractIdentityName(text, true);
  if (weakName !== null) {
    return buildIdentityCandidate(weakName, context, policy);
  }
  return null;
}
