// Pure match strategies and the query fingerprint used by the repo-search facade (Issue #179).
// Kept separate from repoSearch.ts to hold the file-length cap and to make every matcher
// independently testable.

import { createHash } from "node:crypto";
import type { RetrievalQuery } from "@oscharko-dev/keiko-contracts/connected-context";
import { RepoSearchInvalidQueryError } from "./errors.js";

export interface LineMatcher {
  readonly match: (line: string) => number;
}

export function fingerprintFor(query: RetrievalQuery): string {
  const canonical = JSON.stringify({
    kind: query.kind,
    text: query.text,
    caseSensitive: query.caseSensitive,
    maxResults: query.maxResults,
  });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

function buildNaturalLanguageMatcher(query: RetrievalQuery): LineMatcher {
  const rawTokens = query.text.split(/\s+/).filter((t) => t.length > 0);
  const tokens = query.caseSensitive ? rawTokens : rawTokens.map((t) => t.toLowerCase());
  const total = tokens.length;
  return {
    match: (line: string): number => {
      if (total === 0) {
        return 0;
      }
      const haystack = query.caseSensitive ? line : line.toLowerCase();
      let hits = 0;
      for (const token of tokens) {
        if (haystack.includes(token)) {
          hits += 1;
        }
      }
      return hits === 0 ? 0 : hits / total;
    },
  };
}

function buildExactSymbolMatcher(query: RetrievalQuery): LineMatcher {
  if (/\s/.test(query.text)) {
    throw new RepoSearchInvalidQueryError("exact-symbol query must not contain whitespace");
  }
  const needle = query.caseSensitive ? query.text : query.text.toLowerCase();
  return {
    match: (line: string): number => {
      const haystack = query.caseSensitive ? line : line.toLowerCase();
      return haystack.includes(needle) ? 1 : 0;
    },
  };
}

// Cap regex source length and refuse the classical catastrophic-backtracking shapes — any
// group `(...)` or character class `[...]` followed by a `+` / `*` / `{n,}` quantifier. The
// per-call elapsedMsMax cannot interrupt a synchronous `RegExp.exec` once it has entered a
// pathological backtrack, so the only safe defense is to refuse the pattern at compile time.
const MAX_REGEX_LENGTH = 200;
const DANGEROUS_REGEX_STRUCTURE = /\([^)]*\)[+*{]|\[[^\]]*\][+*{]/;

function buildRegexMatcher(query: RetrievalQuery): LineMatcher {
  if (query.text.length > MAX_REGEX_LENGTH) {
    throw new RepoSearchInvalidQueryError(
      `regex too long: ${String(query.text.length)} > ${String(MAX_REGEX_LENGTH)}`,
    );
  }
  if (DANGEROUS_REGEX_STRUCTURE.test(query.text)) {
    throw new RepoSearchInvalidQueryError(
      "regex contains repetition over a group or character class (potential catastrophic backtracking)",
    );
  }
  let regex: RegExp;
  try {
    regex = new RegExp(query.text, query.caseSensitive ? "g" : "gi");
  } catch {
    throw new RepoSearchInvalidQueryError(`invalid regex: ${query.text}`);
  }
  const cap = 100;
  return {
    match: (line: string): number => {
      regex.lastIndex = 0;
      let count = 0;
      while (regex.exec(line) !== null && count < cap) {
        count += 1;
        if (regex.lastIndex === 0) {
          break;
        }
      }
      return count === 0 ? 0 : count / cap;
    },
  };
}

export function buildMatcher(query: RetrievalQuery): LineMatcher {
  if (query.kind === "natural-language") {
    return buildNaturalLanguageMatcher(query);
  }
  if (query.kind === "exact-symbol") {
    return buildExactSymbolMatcher(query);
  }
  if (query.kind === "regex") {
    return buildRegexMatcher(query);
  }
  throw new RepoSearchInvalidQueryError(`unsupported query kind: ${query.kind}`);
}

// Anchored-glob compilation for findFiles. Supports `*`, `**`, `?`, and literal characters.
// Brace expansion and extglob patterns are intentionally not supported.
export function compileGlob(pattern: string): RegExp {
  let body = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern.charAt(i);
    if (ch === "*" && pattern.charAt(i + 1) === "*") {
      body += ".*";
      i += pattern.charAt(i + 2) === "/" ? 3 : 2;
      continue;
    }
    if (ch === "*") {
      body += "[^/]*";
    } else if (ch === "?") {
      body += "[^/]";
    } else if (/[.+^${}()|[\]\\]/.test(ch)) {
      body += `\\${ch}`;
    } else {
      body += ch;
    }
    i += 1;
  }
  return new RegExp(`^${body}$`);
}
