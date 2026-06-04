// Minimal glob matcher for KnowledgeSourceScope include/exclude lists (Issue #194).
//
// We intentionally support ONLY the safe subset: `*` matches any sequence of characters
// EXCEPT `/`; `**` matches any sequence including `/`; `?` matches any single non-`/`
// character. All other characters are literal. Brace expansion and character classes are
// NOT supported — adding them now would let a malformed glob slip past the path-safety
// gate, and callers who really need them can keep multiple entries instead.
//
// Pure function — no FS access, no clock, no regex source built from the input character-
// for-character (which would risk ReDoS); we compile a single anchored RegExp per glob
// with linear-time alternation only.

interface CompiledGlob {
  readonly source: string;
  readonly regex: RegExp;
}

const SPECIAL_RE = /[.+^${}()|[\]\\]/g;

// Build the regex source from the glob in a single pass so we never call `new RegExp` on
// an attacker-controlled string without escaping first. `**/` is treated as "zero or more
// path segments" (so `**/*.md` matches `foo.md` AND `a/b/foo.md`), matching the standard
// tooling convention; a bare `**` (not followed by `/`) matches any sequence including `/`.
function compileGlobSource(glob: string): string {
  let out = "^";
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i] ?? "";
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
          continue;
        }
        out += ".*";
        i += 1;
        continue;
      }
      out += "[^/]*";
      continue;
    }
    if (ch === "?") {
      out += "[^/]";
      continue;
    }
    out += ch.replace(SPECIAL_RE, "\\$&");
  }
  return `${out}$`;
}

export function compileGlob(glob: string): CompiledGlob {
  const source = compileGlobSource(glob);
  // The compiled pattern has bounded alternation (`.*`, `[^/]*`, `[^/]`, literals only),
  // so backtracking is linear in input length — safe against ReDoS even on hostile globs.
  return { source, regex: new RegExp(source) };
}

export function matchesGlob(glob: CompiledGlob, relativePath: string): boolean {
  return glob.regex.test(relativePath);
}

// Convenience: returns `true` when `relativePath` matches AT LEAST ONE of `globs`.
// An empty `globs` list returns `defaultWhenEmpty` — that distinguishes the two scopes:
//   * includeGlobs: default to "match everything" when unset.
//   * excludeGlobs: default to "match nothing" when unset.
export function matchesAny(
  globs: readonly CompiledGlob[],
  relativePath: string,
  defaultWhenEmpty: boolean,
): boolean {
  if (globs.length === 0) {
    return defaultWhenEmpty;
  }
  for (const glob of globs) {
    if (matchesGlob(glob, relativePath)) {
      return true;
    }
  }
  return false;
}

export function compileGlobList(globs: readonly string[] | undefined): readonly CompiledGlob[] {
  if (globs === undefined || globs.length === 0) {
    return [];
  }
  return globs.map((glob) => compileGlob(glob));
}

export type { CompiledGlob };
