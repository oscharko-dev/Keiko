// Shared fail-closed scan for untrusted published metadata; authoritative issue linkage is
// composed separately from the frozen issue binding, never inferred from this text.

const CLOSING_WORDS = new Set([
  "close",
  "closes",
  "closed",
  "fix",
  "fixes",
  "fixed",
  "resolve",
  "resolves",
  "resolved",
]);

export function hasIssueClosingDirective(message: string): boolean {
  for (const word of message.matchAll(/[A-Za-z]+/gu)) {
    if (!CLOSING_WORDS.has(word[0].toLowerCase())) continue;
    let target = message.slice(word.index + word[0].length).trimStart();
    if (target.startsWith(":")) target = target.slice(1).trimStart();
    if (/^#\d/u.test(target) || target.startsWith("https://") || target.startsWith("http://"))
      return true;
    if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#\d/u.test(target)) return true;
  }
  return false;
}
