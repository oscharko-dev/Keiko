import type { CaptureMemoryResolver } from "@oscharko-dev/keiko-memory-capture";
import type { MemoryRecord, MemoryStatus } from "@oscharko-dev/keiko-contracts/memory";
import type { MemoryVaultStore } from "@oscharko-dev/keiko-memory-vault";

const TARGETABLE_STATUSES: readonly MemoryStatus[] = [
  "accepted",
  "archived",
  "conflicted",
  "expired",
  "superseded",
];

const STOP_WORDS = new Set([
  "a",
  "an",
  "about",
  "for",
  "i",
  "is",
  "it",
  "me",
  "memory",
  "my",
  "of",
  "please",
  "that",
  "the",
  "this",
  "to",
  "we",
]);

function normalizePhrase(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function stemToken(token: string): string {
  const strippedPossessive = token.endsWith("'s") ? token.slice(0, -2) : token;
  const suffixes = ["ence", "ance", "ing", "ers", "ies", "ied", "ed", "es", "s"];
  for (const suffix of suffixes) {
    if (strippedPossessive.length > suffix.length + 2 && strippedPossessive.endsWith(suffix)) {
      return strippedPossessive.slice(0, -suffix.length);
    }
  }
  return strippedPossessive;
}

function tokenize(value: string): readonly string[] {
  return normalizePhrase(value)
    .split(/\s+/)
    .map(stemToken)
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

function tokensMatch(targetTokens: readonly string[], bodyTokens: readonly string[]): boolean {
  if (targetTokens.length === 0) {
    return false;
  }
  return targetTokens.every((target) =>
    bodyTokens.some((body) => body === target || body.startsWith(target) || target.startsWith(body)),
  );
}

function matchesTarget(target: string, record: MemoryRecord): boolean {
  const haystack = `${record.body} ${record.tags.join(" ")}`;
  const normalizedTarget = normalizePhrase(target);
  const normalizedHaystack = normalizePhrase(haystack);
  if (
    normalizedTarget.length > 0 &&
    (normalizedHaystack.includes(normalizedTarget) || normalizedTarget.includes(normalizedHaystack))
  ) {
    return true;
  }
  return tokensMatch(tokenize(target), tokenize(haystack));
}

export function createMemoryTargetResolver(vault: MemoryVaultStore): CaptureMemoryResolver {
  return (target, scope) =>
    vault
      .listMemoriesByScope(scope, {
        status: TARGETABLE_STATUSES,
        includeExpired: true,
      })
      .filter((record) => matchesTarget(target, record))
      .map((record) => record.id);
}
