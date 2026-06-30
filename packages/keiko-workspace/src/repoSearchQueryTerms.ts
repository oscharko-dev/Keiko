// Deterministic query-term expansion for repository retrieval. Kept in keiko-workspace so both
// candidate ordering and line matching interpret code-shaped prompts the same way.

const QUERY_TOKEN_RE = /[\p{L}\p{N}_$@./:-]+/gu;
const TOKEN_SEPARATOR_RE = /[/@.:\-_]+/u;
const STACK_LOCATION_SUFFIX_RE = /^(.+?):\d+(?::\d+)?$/u;
const TEST_SUFFIX_RE = /(?:tests?|specs?)$/iu;

const MAX_EXPANDED_QUERY_TERMS = 48;
const DOMAIN_ALIASES: ReadonlyMap<string, readonly string[]> = new Map([
  ["front-end", ["web", "ui", "client"]],
  ["frontend", ["web", "ui", "client"]],
  ["oberflaeche", ["web", "ui", "client"]],
  ["oberfläche", ["web", "ui", "client"]],
  ["back-end", ["server", "api", "service"]],
  ["backend", ["server", "api", "service"]],
  ["infra", ["terraform", "kubernetes", "helm"]],
  ["infrastructure", ["terraform", "kubernetes", "helm"]],
  ["infrastruktur", ["terraform", "kubernetes", "helm"]],
]);

function normalizeCase(term: string, caseSensitive: boolean): string {
  return caseSensitive ? term : term.toLowerCase();
}

function addTerm(
  out: string[],
  seen: Set<string>,
  term: string,
  caseSensitive: boolean,
  minLength = 2,
): void {
  if (out.length >= MAX_EXPANDED_QUERY_TERMS) {
    return;
  }
  const trimmed = term.trim();
  if (trimmed.length < minLength || !/[\p{L}\p{N}]/u.test(trimmed)) {
    return;
  }
  const normalized = normalizeCase(trimmed, caseSensitive);
  if (seen.has(normalized)) {
    return;
  }
  seen.add(normalized);
  out.push(normalized);
}

function stripStackLocationSuffix(token: string): string {
  if (!token.includes("/") && !token.includes(".")) {
    return token;
  }
  const match = STACK_LOCATION_SUFFIX_RE.exec(token);
  return match?.[1] ?? token;
}

function stripLeadingRouteSlash(token: string): string {
  let out = token;
  while (out.startsWith("/")) {
    out = out.slice(1);
  }
  return out;
}

function stripTestSuffix(token: string): string | undefined {
  const stripped = token.replace(TEST_SUFFIX_RE, "");
  return stripped.length >= 3 && stripped.length < token.length ? stripped : undefined;
}

function isAsciiUpper(char: string): boolean {
  const code = char.charCodeAt(0);
  return code >= 65 && code <= 90;
}

function isAsciiLower(char: string): boolean {
  const code = char.charCodeAt(0);
  return code >= 97 && code <= 122;
}

function isAsciiDigit(char: string): boolean {
  const code = char.charCodeAt(0);
  return code >= 48 && code <= 57;
}

function shouldSplitBefore(previous: string, current: string, next: string | undefined): boolean {
  if (!isAsciiUpper(current)) {
    return false;
  }
  if (isAsciiLower(previous) || isAsciiDigit(previous)) {
    return true;
  }
  return isAsciiUpper(previous) && next !== undefined && isAsciiLower(next);
}

function camelParts(token: string): readonly string[] {
  const parts: string[] = [];
  let current = "";
  for (let index = 0; index < token.length; index += 1) {
    const char = token[index] ?? "";
    if (current.length > 0 && shouldSplitBefore(token[index - 1] ?? "", char, token[index + 1])) {
      if (current.length >= 2) {
        parts.push(current);
      }
      current = char;
      continue;
    }
    current += char;
  }
  if (current.length >= 2) {
    parts.push(current);
  }
  return parts;
}

function addIdentifierDerivatives(
  out: string[],
  seen: Set<string>,
  token: string,
  caseSensitive: boolean,
): void {
  const strippedTest = stripTestSuffix(token);
  if (strippedTest !== undefined) {
    addTerm(out, seen, strippedTest, caseSensitive);
  }
  for (const part of camelParts(token)) {
    addTerm(out, seen, part, caseSensitive);
  }
  if (strippedTest !== undefined) {
    for (const part of camelParts(strippedTest)) {
      addTerm(out, seen, part, caseSensitive);
    }
  }
}

function addDomainAliases(
  out: string[],
  seen: Set<string>,
  token: string,
  caseSensitive: boolean,
): void {
  const aliases = DOMAIN_ALIASES.get(token.toLowerCase());
  if (aliases === undefined) {
    return;
  }
  for (const alias of aliases) {
    addTerm(out, seen, alias, caseSensitive);
  }
}

function expandToken(
  out: string[],
  seen: Set<string>,
  rawToken: string,
  caseSensitive: boolean,
): void {
  const token = stripStackLocationSuffix(rawToken);
  addTerm(out, seen, token, caseSensitive);
  addDomainAliases(out, seen, token, caseSensitive);
  if (token.startsWith("/")) {
    addTerm(out, seen, stripLeadingRouteSlash(token), caseSensitive);
  }
  const segments = token.split(TOKEN_SEPARATOR_RE).filter((segment) => segment.length > 0);
  for (const segment of segments) {
    addTerm(out, seen, segment, caseSensitive);
    addDomainAliases(out, seen, segment, caseSensitive);
    addIdentifierDerivatives(out, seen, segment, caseSensitive);
  }
}

export function expandedQueryTerms(queryText: string, caseSensitive: boolean): readonly string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const singleCharacterFallbacks: string[] = [];
  for (const match of queryText.matchAll(QUERY_TOKEN_RE)) {
    if (match[0].length === 1) {
      singleCharacterFallbacks.push(match[0]);
    }
    expandToken(out, seen, match[0], caseSensitive);
    if (out.length >= MAX_EXPANDED_QUERY_TERMS) {
      break;
    }
  }
  if (out.length === 0) {
    for (const token of singleCharacterFallbacks) {
      addTerm(out, seen, token, caseSensitive, 1);
    }
  }
  return out;
}
