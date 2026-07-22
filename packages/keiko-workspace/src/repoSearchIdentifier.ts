// Shared identifier-shape rules for query expansion and privacy-safe index tokenization.
// Test suffixes are recognized only at a real separator or PascalCase boundary so ordinary
// identifiers such as Contest, Latest, and ApplicationContest are never shortened.

const SEPARATED_TEST_SUFFIX_RE = /^(.+?)[./_-](?:tests?|specs?)$/iu;
const PASCAL_TEST_SUFFIX_RE = /^(.+?)(?:Tests?|Specs?)$/u;

export function stripTestIdentifierSuffix(token: string): string | undefined {
  const stripped = (SEPARATED_TEST_SUFFIX_RE.exec(token) ?? PASCAL_TEST_SUFFIX_RE.exec(token))?.[1];
  return stripped !== undefined && stripped.length >= 3 ? stripped : undefined;
}
