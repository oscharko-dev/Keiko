// Shared C-source scanner for the KEIKO source-contract harnesses. Coderabbit 3793145636 on
// #3202 called out that the same translation-phase and preprocessor-ladder implementation
// lived duplicated across `native/runtime-supervisor/macos/test-protocol.mjs` and
// `native/secure-workspace-read/test-protocol.mjs`, including the same constant-condition
// regexes and branch-state transitions. Any correction to comment, literal, or conditional
// handling had to be applied to two security source contracts in lockstep; a missed sibling
// update could let one gate accept controls that only exist in non-compiled code.
//
// This module is the single source of truth. Each harness imports the primitives it needs and
// composes them with its own pin configuration. The primitives are ordered to match C
// translation phases (§5.1.1.2 in C11):
//   Phase 2: line splicing (`\<newline>` pairs collapse)                → preprocessCLineSplices
//   Phase 3: comment stripping (block + line comments become spaces)    → stripCComments
//   Phase 4: preprocessor directive handling (`#if 0` / `#if 1` / …)    → stripDisabledPreprocessorBranches
//   (mode-specific post-pass, string-body blanking)                      → stripStringLiteralBodies
//
// Every function is pure and portable — no I/O, no platform assumptions. Both harnesses call
// these on file contents they've already read. Errors throw with descriptive messages so a
// malformed input fails the harness at a named stage instead of passing quietly.
//
// Extensive review-driven behaviour is captured here; each `codex NNNN` / `coderabbit NNNN`
// reference is the PR-#3202 review comment that motivated the choice.

// ---------------------------------------------------------------------------
// Phase 2: line splicing
// ---------------------------------------------------------------------------
// C translation phase 2 collapses `\<newline>` pairs BEFORE any subsequent processing. Codex
// 3792824427: without this, a directive like `#if \\\n0` splices to `#if 0` at compile time
// but is invisible to the disabled-branch strip. Codex 3792855831: comments then run in
// phase 3 (see `stripCComments`), and preprocessor directives in phase 4 — that ordering is
// what `stripDisabledPreprocessorBranches` documents.
export function preprocessCLineSplices(source) {
  return source.replace(/\\\r?\n/gu, "");
}

// ---------------------------------------------------------------------------
// Quote skippers (used by all comment- and literal-aware scans)
// ---------------------------------------------------------------------------
// Skip a C string literal starting at the opening `"` (index i). Returns the index of the
// byte AFTER the closing `"`. Throws on unterminated input — coderabbit 3793025301: silently
// accepting an unterminated `"..."` would let every token after the stray quote fall off the
// scan, so a deleted control after the unclosed string would escape the source contract.
// Module-internal helper (not exported: consumers get comment/literal handling via
// `stripCComments` and `stripStringLiteralBodies`).
function skipStringLiteral(source, start) {
  let i = start + 1;
  while (i < source.length) {
    const c = source[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === '"') return i + 1;
    i += 1;
  }
  throw new Error('unterminated C string literal: no closing `"`');
}

// Coderabbit 3792888545: C character constants can be multi-character (`'CreateFileW('`,
// implementation-defined `int` value) and can contain sequences that would otherwise look
// like comment starts (`'//'`, `'/*'`). Skip them the same way as string literals; same
// fail-closed rule as the string-literal case (coderabbit 3793025301). Module-internal.
function skipCharLiteral(source, start) {
  let i = start + 1;
  while (i < source.length) {
    const c = source[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "'") return i + 1;
    i += 1;
  }
  throw new Error("unterminated C character constant: no closing `'`");
}

// ---------------------------------------------------------------------------
// Phase 3: comment stripping
// ---------------------------------------------------------------------------
// Strip C block and line comments in one pass. Preserves string AND character literals
// VERBATIM so the caller can decide (via `stripStringLiteralBodies`, or not) whether to blank
// their bodies for a code-only scan.
//
// KEIKO-0417 background: the 17 source-contract assertions used to run against RAW file text,
// so a security control that survived only as a `/* ... */` comment still satisfied
// `assert.match`. Comment stripping closes that hole.
//
// Coderabbit 3792888538: block comments are replaced with a same-length span of spaces AND
// preserved newlines so a following `#if 0` directive stays at line-start for the line-based
// preprocessor scan (line positions in error messages also stay accurate).
//
// Line comments (`//`) CAN end at EOF without a newline; that is valid C, and no token can be
// hidden by a `//` at EOF because everything after is comment text the scanner would drop.
//
// Unterminated block comments throw — same fail-closed rule as unterminated quotes.
export function stripCComments(source) {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      if (end === -1) throw new Error("unterminated C block comment: no `*/` after opening `/*`");
      out += source.slice(i, end + 2).replace(/[^\n]/gu, " ");
      i = end + 2;
      continue;
    }
    if (ch === "/" && next === "/") {
      const end = source.indexOf("\n", i + 2);
      if (end === -1) return out;
      i = end;
      continue;
    }
    if (ch === '"') {
      const after = skipStringLiteral(source, i);
      out += source.slice(i, after);
      i = after;
      continue;
    }
    if (ch === "'") {
      const after = skipCharLiteral(source, i);
      out += source.slice(i, after);
      i = after;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Mode-specific post-pass: blank string and character literal BODIES
// ---------------------------------------------------------------------------
// Post-pass for the "strip strings too" mode: blanks `"..."` and `'...'` bodies so an
// assertion whose subject is a code identifier cannot be satisfied by that identifier
// appearing inside a literal (coderabbit 3792888545: `'CreateFileW('` as a multi-character
// constant would otherwise satisfy the `CreateFileW(` assertion). Runs AFTER `stripCComments`
// and `stripDisabledPreprocessorBranches`, so it never sees a literal that lived only inside
// a comment or a disabled branch.
export function stripStringLiteralBodies(source) {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '"') {
      out += '""';
      i = skipStringLiteral(source, i);
      continue;
    }
    if (ch === "'") {
      out += "''";
      i = skipCharLiteral(source, i);
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Phase 4: preprocessor ladder handling
// ---------------------------------------------------------------------------
// KEIKO-0417 (extended across many review rounds on #3202): a control retained only inside a
// preprocessor branch that clang omits still satisfies raw-text source-contract regexes. This
// pass tracks preprocessor ladders whose branches we CAN evaluate at scan time (constant-zero
// / constant-one conditions) and strips lines that lie in a definitively-dead branch.
//
// Recognised patterns (see the regex table below):
//   `#if 0`, `#if (0)`, `#if 0L`, ...    → deterministically FALSE. Body dead.
//   `#if 0 && FEATURE`                   → C left-to-right `&&` short-circuits. Body dead.
//   `#if 1`, `#if (1)`, `#if 1L`, ...    → deterministically TRUE. If-body live, subsequent branches dead.
//   `#elif 0`, `#elif 0L`, ...           → this branch's body dead; sibling branches unchanged.
//   `#elif 1`                            → this branch's body live; subsequent siblings dead.
//   `#elif <anything else>`              → potentially live; subsequent siblings may also be live.
//   `#else`                              → live if no potentially-live predecessor; else potentially live.
//   `#endif`                             → closes the current frame.
//
// Macro-gated `#ifdef X` / `#ifndef X` / `#if X` are OUT OF SCOPE (codex 3793101248): they
// require the actual `-D` flags and `#include` chain. Documented tradeoff — this scanner
// checks source shape, not preprocessed output, so it can run on any host without a full
// clang toolchain. The source-contract's stated purpose remains "catch silent deletion of the
// token from the source" and does NOT claim "catch macro-gated deletion".
//
// State machine:
//   Stack of frames (codex 3793025299, 3793050405). Every tracked directive pushes a new
//   frame. `#endif` pops. Top-of-stack determines the current "should this line be kept"
//   answer. A line is kept only if EVERY frame is in KEEPING mode — the compiler emits a
//   line only if every enclosing conditional picks the branch containing it.
//   Per-frame flags:
//     mode: STRIPPING | KEEPING
//     sawDefLive: a preceding branch was DEFINITIVELY live (`#elif 1` after only-zero
//       predecessors, or `#else` in the same context). Subsequent branches are dead.
//     sawUnkLive: a preceding branch was POTENTIALLY live (`#elif FEATURE`). Subsequent
//       branches may ALSO be live; the ladder does not know which the compiler picked.
//     depth: nested `#if X` (untracked) inside this frame — plain counter so the matching
//       `#endif` reaches this frame, not the outer one.

// Module-internal (not exported: the composition helpers below wrap all directive matching).
const PREPROCESSOR_PATTERNS = {
  OPEN_IF: /^#\s*(?:if|ifdef|ifndef)\b/u,
  CLOSE_ENDIF: /^#\s*endif\b/u,
  ELSE_DIRECTIVE: /^#\s*else\b/u,
  ELIF_DIRECTIVE: /^#\s*elif\b/u,
  DISABLED_IF: /^#\s*if\s+\(?\s*0[UuLl]{0,3}\s*\)?\s*(?:&&\s+!?[A-Za-z_][A-Za-z0-9_]*\s*)?\s*$/u,
  DISABLED_ELIF:
    /^#\s*elif\s+\(?\s*0[UuLl]{0,3}\s*\)?\s*(?:&&\s+!?[A-Za-z_][A-Za-z0-9_]*\s*)?\s*$/u,
};

// Extracted so the outer regex object is not polluted with the `1`-shape variants and so a
// future contributor can extend them independently. Codex 3793074555 added constant-true.
const DEFINITIVELY_TRUE_IF = /^#\s*if\s+\(?\s*1[UuLl]{0,3}\s*\)?\s*$/u;
const DEFINITIVELY_TRUE_ELIF = /^#\s*elif\s+\(?\s*1[UuLl]{0,3}\s*\)?\s*$/u;

const STRIPPING = "stripping";
const KEEPING = "keeping";

export function stripDisabledPreprocessorBranches(source) {
  const lines = source.split("\n");
  const kept = [];
  const stack = [];
  for (const line of lines) {
    processLadderLine(line, stack, kept);
  }
  return kept.join("\n");
}

function processLadderLine(line, stack, kept) {
  const p = PREPROCESSOR_PATTERNS;
  const trimmed = line.trimStart();
  if (p.DISABLED_IF.test(trimmed)) {
    stack.push({ mode: STRIPPING, sawDefLive: false, sawUnkLive: false, depth: 0 });
    return;
  }
  if (DEFINITIVELY_TRUE_IF.test(trimmed)) {
    stack.push({ mode: KEEPING, sawDefLive: true, sawUnkLive: false, depth: 0 });
    return;
  }
  if (stack.length === 0) {
    kept.push(line);
    return;
  }
  const frame = stack[stack.length - 1];
  if (p.OPEN_IF.test(trimmed)) {
    frame.depth += 1;
    return;
  }
  if (p.CLOSE_ENDIF.test(trimmed)) {
    if (frame.depth === 0) stack.pop();
    else frame.depth -= 1;
    return;
  }
  if (frame.depth > 0) {
    if (allFramesKeeping(stack)) kept.push(line);
    return;
  }
  handleOuterDirectiveOrLine(line, trimmed, frame, stack, kept);
}

function allFramesKeeping(stack) {
  for (const frame of stack) if (frame.mode !== KEEPING) return false;
  return true;
}

function handleOuterDirectiveOrLine(line, trimmed, frame, stack, kept) {
  const p = PREPROCESSOR_PATTERNS;
  if (p.ELSE_DIRECTIVE.test(trimmed)) {
    applyElseTransition(frame);
    return;
  }
  if (p.ELIF_DIRECTIVE.test(trimmed)) {
    applyElifTransition(trimmed, frame);
    return;
  }
  if (allFramesKeeping(stack)) kept.push(line);
}

function applyElseTransition(frame) {
  if (frame.sawDefLive) {
    frame.mode = STRIPPING;
    return;
  }
  frame.mode = KEEPING;
  frame.sawDefLive = !frame.sawUnkLive;
}

function applyElifTransition(trimmed, frame) {
  const p = PREPROCESSOR_PATTERNS;
  if (frame.sawDefLive) {
    frame.mode = STRIPPING;
    return;
  }
  if (p.DISABLED_ELIF.test(trimmed)) {
    frame.mode = STRIPPING;
    return;
  }
  frame.mode = KEEPING;
  if (DEFINITIVELY_TRUE_ELIF.test(trimmed)) {
    frame.sawDefLive = !frame.sawUnkLive;
  } else {
    frame.sawUnkLive = true;
  }
}
