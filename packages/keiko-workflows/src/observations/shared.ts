// Shared, pure helpers for the tool-observation shapers (ADR-0054, PR3-W3). No IO, no clock, no
// randomness. Every untrusted free-text string is scrubbed via redact() from keiko-security BEFORE
// it is clamped or measured (the defense-in-depth boundary established by the PR2 compaction
// helpers). Injection detection is CONTENT-FREE by construction: detectPromptInjectionSignals
// returns only {code, severity, matchCount}; we store an aggregate count and a boolean and NEVER
// the matched text. No new package edge: contracts/security/workspace are already dependencies.

import {
  CONTEXT_ENGINEERING_SCHEMA_VERSION,
  estimateTokens,
  type ContextLaneId,
  type ContextToolRehydrationHandle,
} from "@oscharko-dev/keiko-contracts";
import { hashExcerptContent } from "@oscharko-dev/keiko-workspace";
import {
  detectPromptInjectionSignals,
  hasCriticalInjectionSignal,
  redact,
} from "@oscharko-dev/keiko-security";

// The lane every shaped tool observation belongs to (ADR-0052 taxonomy).
const TOOL_OBSERVATIONS_LANE: ContextLaneId = "tool-observations";

// Content-free injection summary: a non-negative aggregate match count and the critical flag. The
// matched text is never returned — only counts/boolean — so the observation cannot leak the cue.
export interface InjectionSummary {
  readonly count: number;
  readonly critical: boolean;
}

// Stable, reproducible observation id: SHA-256 hex of the seed (typically the toolCallId). Total —
// hashExcerptContent never throws; an empty seed yields the well-defined hash of zero bytes.
export function makeObservationId(seed: string): string {
  return hashExcerptContent(seed);
}

// CONTENT-FREE injection signal summary over untrusted text. Sums each signal's matchCount for the
// aggregate count and derives the critical flag from the authoritative severity helper. The matched
// text is never inspected by the caller — only the returned counts/boolean are persisted.
export function injectionSignalsFor(text: string): InjectionSummary {
  const signals = detectPromptInjectionSignals(text);
  let count = 0;
  for (const signal of signals) {
    count += signal.matchCount;
  }
  return { count, critical: hasCriticalInjectionSignal(signals) };
}

// Redact-then-clamp: redact() runs FIRST so a secret can never survive into the bounded excerpt,
// then the redacted text is clamped to maxBytes of UTF-8 without splitting a multibyte character
// (the repoSearch clampToBytes pattern: encode, subarray, lossy-decode, trim the replacement char).
export function boundExcerpt(text: string, maxBytes: number): string {
  const redacted = redact(text);
  if (maxBytes <= 0) {
    return "";
  }
  const encoded = new TextEncoder().encode(redacted);
  if (encoded.length <= maxBytes) {
    return redacted;
  }
  const buffer = encoded.subarray(0, maxBytes);
  return new TextDecoder("utf-8", { fatal: false }).decode(buffer).replace(/�+$/u, "");
}

// UTF-8 byte length of a string (the bytes field on a ShapedStreamExcerpt).
export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

export interface RehydrationHandleInput {
  readonly artifactSeed: string;
  readonly itemCount: number;
  readonly approxTokens: number;
  readonly notPersistedReason?: string | undefined;
}

export interface ToolResultArtifactWriter {
  readonly write: (artifactId: string, content: string) => void;
}

// Builds the content-free ContextToolRehydrationHandle. artifactId = hashExcerptContent(artifactSeed)
// — deterministic and stable. notPersistedReason is included only when supplied (exactOptional:
// conditional spread, never assigned undefined). approxTokens is passed through unchanged.
export function buildToolRehydrationHandle(
  input: RehydrationHandleInput,
): ContextToolRehydrationHandle {
  return {
    schemaVersion: CONTEXT_ENGINEERING_SCHEMA_VERSION,
    laneId: TOOL_OBSERVATIONS_LANE,
    kind: "tool-result",
    artifactId: makeObservationId(input.artifactSeed),
    itemCount: input.itemCount,
    approxTokens: input.approxTokens,
    ...(input.notPersistedReason !== undefined
      ? { notPersistedReason: input.notPersistedReason }
      : {}),
  };
}

export { estimateTokens };
