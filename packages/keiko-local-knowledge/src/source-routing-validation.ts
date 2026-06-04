// source-routing-validation.ts — pure validators for Knowledge Capsule source-routing
// controls (Epic #189, Issue #263). Foundry-IQ "no global pool" rule is enforced at the
// type system by every record carrying capsuleId+sourceId; this module catches the
// **semantic** misconfigurations the type system cannot see:
//
//   * alwaysQuery=true on an empty or non-ready capsule (would query nothing or stale
//     data on every conversation turn).
//   * Routing instructions referencing source ids the capsule does not own.
//   * Include/exclude globs that silently broaden retrieval (empty arrays, duplicates,
//     `..` traversal, leading-slash absolute paths, or excludes that cancel includes).
//
// Pure module: no IO, no clock, no node:* imports. Safe to call from any layer.

import type {
  KnowledgeCapsule,
  KnowledgeSource,
  KnowledgeSourceScope,
} from "@oscharko-dev/keiko-contracts";

export type SourceRoutingValidationCode =
  | "always-query-without-sources"
  | "always-query-capsule-not-ready"
  | "always-query-source-list-mismatch"
  | "unknown-source-token"
  | "instructions-empty"
  | "include-globs-empty-array"
  | "exclude-globs-empty-array"
  | "duplicate-glob"
  | "glob-path-escape"
  | "absolute-glob"
  | "exclude-cancels-include";

export class SourceRoutingValidationError extends Error {
  readonly code: SourceRoutingValidationCode;
  constructor(code: SourceRoutingValidationCode, message: string) {
    super(message);
    this.name = "SourceRoutingValidationError";
    this.code = code;
  }
}

function fail(code: SourceRoutingValidationCode, message: string): never {
  throw new SourceRoutingValidationError(code, message);
}

// ─── alwaysQuery ───────────────────────────────────────────────────────────────
// Truthy alwaysQuery means: include this capsule in every retrieval scope for the
// current conversation by default. That makes a misconfiguration silently dangerous —
// an empty or unindexed capsule would either return nothing every turn or expose
// stale chunks. We refuse both states up front.

export function validateAlwaysQuery(
  capsule: KnowledgeCapsule,
  sources: readonly KnowledgeSource[],
): void {
  if (capsule.alwaysQuery !== true) return;
  if (capsule.sourceIds.length === 0) {
    fail(
      "always-query-without-sources",
      `Capsule ${String(capsule.id)} has alwaysQuery=true but no sources.`,
    );
  }
  if (capsule.lifecycleState !== "ready") {
    fail(
      "always-query-capsule-not-ready",
      `Capsule ${String(capsule.id)} cannot be alwaysQuery while lifecycleState=${capsule.lifecycleState}.`,
    );
  }
  const ids = new Set(sources.map((s) => String(s.id)));
  for (const declared of capsule.sourceIds) {
    if (!ids.has(String(declared))) {
      fail(
        "always-query-source-list-mismatch",
        `Capsule ${String(capsule.id)} declares source ${String(declared)} but it is not in the supplied source list.`,
      );
    }
  }
}

// ─── Routing instructions ─────────────────────────────────────────────────────
// `sourceRoutingInstructions` is free-form prose, but a Foundry-IQ-style convention
// uses `@source-id` tokens (e.g. "prefer @docs over @specs") to address specific
// sources. The validator extracts those tokens and refuses any that do not resolve
// to a source in this capsule. Instructions without tokens are accepted as-is.

const SOURCE_TOKEN_RE = /@([A-Za-z0-9][A-Za-z0-9_.-]*)/g;

export function validateRoutingInstructionsScope(
  instructions: string | undefined,
  sources: readonly KnowledgeSource[],
): void {
  if (instructions === undefined) return;
  if (instructions.trim().length === 0) {
    fail(
      "instructions-empty",
      "sourceRoutingInstructions must be omitted entirely or contain non-whitespace content.",
    );
  }
  const knownIds = new Set(sources.map((s) => String(s.id)));
  const tokens = extractSourceTokens(instructions);
  for (const token of tokens) {
    if (!knownIds.has(token)) {
      fail(
        "unknown-source-token",
        `sourceRoutingInstructions references @${token} which is not a source in this capsule.`,
      );
    }
  }
}

function extractSourceTokens(instructions: string): readonly string[] {
  const out: string[] = [];
  for (const match of instructions.matchAll(SOURCE_TOKEN_RE)) {
    const captured = match[1];
    if (captured !== undefined && captured.length > 0) {
      out.push(captured);
    }
  }
  return out;
}

// ─── Glob patterns ────────────────────────────────────────────────────────────
// The contract's KnowledgeSourceScope only enforces TYPES on includeGlobs/excludeGlobs.
// This validator enforces SEMANTICS: callers must omit the field instead of passing
// an empty array, must not duplicate patterns, must not contain `..` or absolute
// paths, and excludeGlobs must not byte-match an includeGlobs entry (cancelling it).

export function validateGlobPatterns(scope: KnowledgeSourceScope): void {
  if (scope.kind === "files") return;
  validateGlobList(scope.includeGlobs, "include");
  validateGlobList(scope.excludeGlobs, "exclude");
  if (scope.includeGlobs !== undefined && scope.excludeGlobs !== undefined) {
    const includeSet = new Set(scope.includeGlobs);
    for (const pattern of scope.excludeGlobs) {
      if (includeSet.has(pattern)) {
        fail(
          "exclude-cancels-include",
          `excludeGlobs entry "${pattern}" byte-matches an includeGlobs entry; the include is silently cancelled.`,
        );
      }
    }
  }
}

function validateGlobList(
  patterns: readonly string[] | undefined,
  kind: "include" | "exclude",
): void {
  if (patterns === undefined) return;
  if (patterns.length === 0) {
    fail(
      kind === "include" ? "include-globs-empty-array" : "exclude-globs-empty-array",
      `${kind}Globs must be omitted, not supplied as an empty array.`,
    );
  }
  const seen = new Set<string>();
  for (const pattern of patterns) {
    assertGlobShape(pattern);
    if (seen.has(pattern)) {
      fail("duplicate-glob", `Duplicate ${kind} glob pattern "${pattern}".`);
    }
    seen.add(pattern);
  }
}

function isWindowsDriveAbsolute(pattern: string): boolean {
  // Matches C:\ or C:/ — a single drive letter followed by colon and a separator.
  return (
    pattern.length >= 3 &&
    /[A-Za-z]/.test(pattern[0] ?? "") &&
    pattern[1] === ":" &&
    (pattern[2] === "/" || pattern[2] === "\\")
  );
}

function assertGlobShape(pattern: string): void {
  if (pattern.startsWith("/")) {
    fail(
      "absolute-glob",
      `Glob pattern "${pattern}" is absolute; patterns must be source-root-relative.`,
    );
  }
  if (isWindowsDriveAbsolute(pattern) || pattern.startsWith("\\\\")) {
    fail(
      "absolute-glob",
      `Glob pattern "${pattern}" is an absolute Windows path; patterns must be source-root-relative.`,
    );
  }
  // Reject any `..` segment. Split on EITHER separator so Windows-style backslash paths
  // are also caught (e.g. "sub\..\other"). Match component-bounded so substrings like
  // "abc..def" inside a filename are allowed; only path-segment traversal is refused.
  const segments = pattern.split(/[/\\]/);
  for (const segment of segments) {
    if (segment === "..") {
      fail("glob-path-escape", `Glob pattern "${pattern}" contains a parent-directory segment.`);
    }
  }
}

// ─── Composite ─────────────────────────────────────────────────────────────────

export function validateSourceRoutingForCapsule(
  capsule: KnowledgeCapsule,
  sources: readonly KnowledgeSource[],
): void {
  validateAlwaysQuery(capsule, sources);
  validateRoutingInstructionsScope(capsule.sourceRoutingInstructions, sources);
  for (const src of sources) {
    validateGlobPatterns(src.scope);
  }
}
