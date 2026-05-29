// PURE filtering. Two tiers (ADR-0005 D3):
//   1. isDenied()  — ALWAYS-ON security deny list. Enforced before every read regardless
//      of .gitignore. Secret/dep/build/cache/vcs/log/os files are never discovered or read.
//   2. compileIgnore()/isIgnored() — best-effort noise reduction over a DOCUMENTED, bounded
//      .gitignore subset. Never relaxes the deny list.
// Glob translation produces only linear regex pieces (`[^/]*`, `.*`) so there is no
// catastrophic backtracking (no ReDoS).

export const DEFAULT_DENY_PATTERNS: readonly string[] = Object.freeze([
  // secrets
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
  "id_rsa",
  "id_ed25519",
  "id_ecdsa",
  "id_dsa",
  "*.p12",
  "*.pfx",
  ".npmrc",
  // deps
  "node_modules",
  // build
  "dist",
  "build",
  "out",
  "coverage",
  // caches
  ".cache",
  ".next",
  ".turbo",
  // vcs
  ".git",
  // logs
  "*.log",
  // os
  ".DS_Store",
]);

// Iterates from the end rather than using /\/+$/ to avoid quadratic ReDoS on
// inputs with many consecutive trailing slashes (CodeQL js/polynomial-redos).
function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47 /* "/" */) {
    end -= 1;
  }
  return value.slice(0, end);
}

function normalize(relPath: string): string {
  return stripTrailingSlashes(relPath.replace(/\\/g, "/").replace(/^\.\//, ""));
}

function segments(relPath: string): readonly string[] {
  return normalize(relPath)
    .split("/")
    .filter((part) => part.length > 0);
}

const EXAMPLE_ENV = ".env.example";

// Always-on security check. Denied if ANY path segment matches a deny pattern (a denied
// directory denies everything under it). `.env.example` is the single documented exception.
// Matching is CASE-INSENSITIVE: on case-insensitive filesystems (macOS, Windows) `.ENV` and
// `.env` name the same file, so a case-only variant must not bypass the deny list.
export function isDenied(relPath: string): boolean {
  for (const part of segments(relPath)) {
    const lower = part.toLowerCase();
    if (lower === EXAMPLE_ENV) {
      continue;
    }
    for (const pattern of DEFAULT_DENY_PATTERNS) {
      if (denyMatch(pattern, lower)) {
        return true;
      }
    }
  }
  return false;
}

// A single basename glob supporting `*` (any run of non-separator chars). Linear. Both the
// pattern and the name are lowercased so matching is case-insensitive (case-insensitive
// filesystems must not let a case-only variant like `.ENV` bypass the deny list).
function denyMatch(pattern: string, name: string): boolean {
  return globToRegExp(pattern.toLowerCase(), false).test(name);
}

// ─── .gitignore subset ──────────────────────────────────────────────────────────
// Supported: blank/comment lines, plain `name`, directory `dir/`, extension `*.ext`,
// leading-"/" anchor, `**` segments, and negation `!`. Order matters; later rules win.

interface IgnoreRule {
  readonly regex: RegExp;
  // For a `dir/` rule, matches the directory entry exactly (no trailing nested suffix), so a
  // same-named FILE is not treated as the ignored directory.
  readonly dirEntryRegex: RegExp | null;
  readonly negated: boolean;
  readonly dirOnly: boolean;
}

export interface IgnoreMatcher {
  readonly rules: readonly IgnoreRule[];
}

function globBody(glob: string): string {
  let body = "";
  let i = 0;
  while (i < glob.length) {
    // charAt returns "" past the end; the loop bound guarantees a real char here, so there is
    // no dead nullish fallback. charAt(i + 1)/(i + 2) safely return "" at the boundary.
    const char = glob.charAt(i);
    if (char === "*" && glob.charAt(i + 1) === "*") {
      body += ".*";
      i += glob.charAt(i + 2) === "/" ? 3 : 2;
      continue;
    }
    if (char === "*") {
      body += "[^/]*";
    } else if (char === "?") {
      body += "[^/]";
    } else {
      body += escapeLiteral(char);
    }
    i += 1;
  }
  return body;
}

function globToRegExp(glob: string, anchored: boolean): RegExp {
  const prefix = anchored ? "^" : "^(?:.*/)?";
  return new RegExp(`${prefix}${globBody(glob)}(?:/.*)?$`);
}

// Matches the path that names the directory itself (no nested suffix), used so a `dir/` rule
// can distinguish a real subdirectory from a same-named file at another depth.
function globToDirEntryRegExp(glob: string, anchored: boolean): RegExp {
  const prefix = anchored ? "^" : "^(?:.*/)?";
  return new RegExp(`${prefix}${globBody(glob)}$`);
}

function escapeLiteral(char: string): string {
  return /[.*+?^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
}

function stripAnchors(value: string, anchored: boolean, dirOnly: boolean): string {
  let core = value;
  if (anchored) {
    core = core.slice(1);
  }
  if (dirOnly) {
    core = core.slice(0, -1);
  }
  return core;
}

function buildRule(rawLine: string): IgnoreRule | null {
  const line = rawLine.trim();
  if (line.length === 0 || line.startsWith("#")) {
    return null;
  }
  const negated = line.startsWith("!");
  const afterBang = negated ? line.slice(1) : line;
  const anchored = afterBang.startsWith("/");
  const dirOnly = afterBang.endsWith("/");
  const core = stripAnchors(afterBang, anchored, dirOnly);
  if (core.length === 0) {
    return null;
  }
  return {
    regex: globToRegExp(core, anchored),
    dirEntryRegex: dirOnly ? globToDirEntryRegExp(core, anchored) : null,
    negated,
    dirOnly,
  };
}

export function compileIgnore(lines: readonly string[]): IgnoreMatcher {
  const rules: IgnoreRule[] = [];
  for (const line of lines) {
    const rule = buildRule(line);
    if (rule !== null) {
      rules.push(rule);
    }
  }
  return { rules };
}

export function isIgnored(matcher: IgnoreMatcher, relPath: string, isDir: boolean): boolean {
  const target = normalize(relPath);
  let ignored = false;
  for (const rule of matcher.rules) {
    if (ruleMatches(rule, target, isDir)) {
      ignored = !rule.negated;
    }
  }
  return ignored;
}

// A `dir/` rule ignores either the matching directory entry itself (only when it IS a
// directory), or any path genuinely nested under it. A same-named FILE is not ignored.
function ruleMatches(rule: IgnoreRule, target: string, isDir: boolean): boolean {
  if (!rule.dirOnly) {
    return rule.regex.test(target);
  }
  if (rule.dirEntryRegex?.test(target) === true) {
    return isDir;
  }
  return rule.regex.test(target);
}
