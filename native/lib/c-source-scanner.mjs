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
// Phase 1: trigraph replacement (C11 §5.1.1.2)
// ---------------------------------------------------------------------------
// C11 phase 1 replaces the nine trigraph sequences with their single-character equivalents
// BEFORE line splicing runs. Most modern compilers disable trigraphs by default (Clang and
// GCC require `-trigraphs`), but a source that uses them still compiles under those flags —
// and `??=include <sched.h>` / `??=if 0` would then appear in the source as directives that
// this scanner would miss. Coderabbit 3793183799: apply trigraph replacement first so
// `??=if 0` reaches `stripDisabledPreprocessorBranches` as `#if 0` and gets stripped.
// See C11 §5.2.1.1 for the full table.
function convertTrigraphs(source) {
  return source.replace(/\?\?([=/'()!<>-])/gu, (_, second) => TRIGRAPH_MAP[second]);
}
const TRIGRAPH_MAP = {
  "=": "#",
  "/": "\\",
  "'": "^",
  "(": "[",
  ")": "]",
  "!": "|",
  "<": "{",
  ">": "}",
  "-": "~",
};

// ---------------------------------------------------------------------------
// Phase 2: line splicing
// ---------------------------------------------------------------------------
// C translation phase 2 collapses `\<newline>` pairs BEFORE any subsequent processing. Codex
// 3792824427: without this, a directive like `#if \\\n0` splices to `#if 0` at compile time
// but is invisible to the disabled-branch strip. Codex 3792855831: comments then run in
// phase 3 (see `stripCComments`), and preprocessor directives in phase 4 — that ordering is
// what `stripDisabledPreprocessorBranches` documents.
//
// Coderabbit 3793183799: apply trigraph conversion (phase 1) first so a `??/` in the source
// becomes a real `\` before we look for `\<newline>` pairs.
export function preprocessCLineSplices(source) {
  return convertTrigraphs(source).replace(/\\\r?\n/gu, "");
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
// Phase 6: adjacent string-literal concatenation (C11 §5.1.1.2 phase 6, §6.4.5)
// ---------------------------------------------------------------------------
// C concatenates adjacent string literals of the same encoding at compile time. `"/bin/" "sh"`
// produces the same object as `"/bin/sh"` — same runtime path, same shell launched. Codex
// 3793282534 on #3202: the negative shell-path pin used a regex that expects a single
// contiguous `"/bin/…sh"` literal, so a supervisor rewritten to `"/bin/" "sh"` would evade the
// check while still launching a shell. Fold adjacent literals here (after comment / disabled-
// branch stripping) so the pin sees what the compiler will emit. Repeat the pass until no more
// adjacent pairs remain to fold, so chains like `"a" "b" "c"` collapse fully.
//
// Only PLAIN string literals (unprefixed) are folded — modelling wide (`L"…"`), UTF-8 (`u8"…"`),
// UTF-16 (`u"…"`), or UTF-32 (`U"…"`) prefixes correctly requires per-encoding rules and none of
// the source-contract pins reach into those literals. The regex matches a body of ordinary
// chars and escape pairs; unterminated literals cannot appear here because `stripCComments` and
// the earlier phases already threw on those. Char literals (`'…'`) are unaffected — they don't
// concatenate.
export function foldAdjacentStringLiterals(source) {
  let previous;
  let current = source;
  do {
    previous = current;
    current = previous.replace(/"((?:[^"\\]|\\.)*)"(\s+)"((?:[^"\\]|\\.)*)"/gu, '"$1$3"');
  } while (current !== previous);
  return current;
}

// ---------------------------------------------------------------------------
// Phase 5: character-escape decoding inside string literals (C11 §6.4.4.4)
// ---------------------------------------------------------------------------
// C string literals accept escape sequences that the compiler decodes at translation phase 5.
// `"/bin/\x73h"` reaches the compiled binary as `/bin/sh`; the negative shell-path pin that
// looks for `\/bin\/[a-z]*sh\b` on the raw literal source would miss it. Codex 3793436216 on
// #3202: decode escapes inside string literal BODIES so pins observe what the compiler will
// emit. Only string literals get the decoding — character literals stay untouched; their
// escape spellings are semantically meaningful to the pins that observe them (e.g. `'\?'`,
// `'\"'`) and the source contract doesn't currently make a string/char decoding claim.
//
// Escapes handled (§6.4.4.4):
//   simple:  \n \t \r \b \f \a \v \? \' \" \\ \0
//   octal:   \0…\777 (1–3 octal digits)
//   hex:     \xHH…   (variable-length hex digits)
// Unknown / malformed escapes are left verbatim — same fail-open policy as the C compiler,
// which keeps a `\z` in the compiled string. Universal character names (`\uHHHH`, `\UHHHHHHHH`)
// are out of scope for the source-contract pins today; extending later is a single case.
export function decodeCStringEscapes(source) {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '"') {
      const end = skipStringLiteral(source, i);
      out += '"' + decodeCStringLiteralBody(source.slice(i + 1, end - 1)) + '"';
      i = end;
      continue;
    }
    if (ch === "'") {
      const end = skipCharLiteral(source, i);
      out += source.slice(i, end);
      i = end;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

// Coderabbit 3793501296 + codex 3793578610 on #3202: PRESERVE both the escaped-double-quote
// (`\"`) AND the escaped-backslash (`\\`) spellings verbatim. Decoding either would corrupt
// string-literal boundaries downstream:
//   - `\"` decoded to `"` would create a spurious boundary in the middle of a compiled literal.
//     `"a\"CON\"b"` (value `a"CON"b`) would become `"a"CON"b"` and a naive `.includes('"CON"')`
//     reserved-stem pin would fire on the spurious middle boundary, masking deletion of the
//     real `"CON"` source token.
//   - `\\` decoded to `\` at the end of a literal (`"foo\\"` — value `foo\`) would emit the
//     scanner text `"foo\"`; downstream `stripStringLiteralBodies` would then treat the closing
//     quote as escaped, hunt for a real closer that doesn't exist, and throw
//     `unterminated C string literal`. Any source that added a trailing-backslash path literal
//     (Windows paths like `"C:\\"`) would fail the source-contract harness even though the
//     compile is valid.
// Both preservations keep the string-literal token shape downstream pins parse. Character-level
// escapes (`\n`, `\t`, `\r`, `\b`, `\f`, `\a`, `\v`) still decode because they don't affect
// string-boundary reading and don't reintroduce escape-sequence starts.
const SIMPLE_ESCAPE_MAP = {
  n: "\n",
  t: "\t",
  r: "\r",
  b: "\b",
  f: "\f",
  a: "\x07",
  v: "\v",
  "?": "?",
  "'": "'",
  '"': '\\"',
  "\\": "\\\\",
};

function decodeCStringLiteralBody(body) {
  let out = "";
  let i = 0;
  while (i < body.length) {
    if (body[i] !== "\\") {
      out += body[i];
      i += 1;
      continue;
    }
    const next = body[i + 1];
    if (next === undefined) {
      out += "\\";
      i += 1;
      continue;
    }
    const consumed = decodeCEscapeAt(body, i, (decoded) => {
      out += decoded;
    });
    i += consumed;
  }
  return out;
}

function decodeCEscapeAt(body, i, emit) {
  const next = body[i + 1];
  if (next === "x") return decodeHexEscape(body, i, emit);
  if (/[0-7]/u.test(next)) return decodeOctalEscape(body, i, emit);
  if (Object.prototype.hasOwnProperty.call(SIMPLE_ESCAPE_MAP, next)) {
    emit(SIMPLE_ESCAPE_MAP[next]);
    return 2;
  }
  // Unknown escape: leave verbatim (matches compiler behaviour of preserving `\z`).
  emit("\\" + next);
  return 2;
}

function decodeHexEscape(body, i, emit) {
  let j = i + 2;
  while (j < body.length && /[0-9a-fA-F]/u.test(body[j])) j += 1;
  if (j === i + 2) {
    emit("\\x");
    return 2;
  }
  const value = parseInt(body.slice(i + 2, j), 16);
  emit(preservedByteSpelling(value));
  return j - i;
}

function decodeOctalEscape(body, i, emit) {
  let j = i + 1;
  const limit = Math.min(body.length, i + 4);
  while (j < limit && /[0-7]/u.test(body[j])) j += 1;
  const value = parseInt(body.slice(i + 1, j), 8);
  emit(preservedByteSpelling(value));
  return j - i;
}

// Codex 3793642858 on #3202: a numeric escape whose byte value is a string/char delimiter or
// backslash MUST be emitted as an escaped spelling, not as the raw byte. `"\42..."` (octal 42
// = 34 = `"`) decoded to a bare `"` reconstructs scanner text like `"a"posix_spawn(...)"b"`;
// `stripStringLiteralBodies` then treats the middle bytes as code and leaves a pinned call
// visible even though it exists only inside a compiled diagnostic string, letting a deleted
// live control keep satisfying the positive source pin. Same reasoning for `\` and `'` —
// emitting them as escapes preserves the source-token shape downstream expects.
function preservedByteSpelling(value) {
  if (value === 0x22) return '\\"';
  if (value === 0x27) return "\\'";
  if (value === 0x5c) return "\\\\";
  return String.fromCharCode(value & 0xff);
}

// ---------------------------------------------------------------------------
// Path-normalisation: collapse `./` current-directory components and `//` runs
// ---------------------------------------------------------------------------
// Codex 3793578605 + 3793642847 on #3202: the OS resolves both `/bin/./sh` AND `/bin//sh`
// to `/bin/sh` before executing. The negative shell-path pin's regex expects a contiguous
// `/bin/sh`. Collapse both forms in the whole prepared source so the pin sees the resolved
// path. Applies globally rather than per-literal so a token boundary between literal and
// adjacent code (`"/bin" "/./sh"` after fold) still normalises. Repeats until fixpoint to
// handle chains (`/./././`, `////`).
//
// URL schemes are preserved: the `://` after `http`/`https`/`file`/etc. is meaningful, so the
// `//` collapse uses a negative lookbehind to skip when preceded by `:`. This lets
// `https://example.com` stay intact while `/bin//sh` still collapses.
//
// `..` (parent) is NOT normalised — resolving it requires the preceding component. That
// omission is documented (`#if 0 && FEATURE` similar recognition-only policy) and leaves a
// theoretical `/bin/../bin/sh` bypass; the shell-path regex could still be widened later, but
// the source-contract call site for this scanner does not host `..` in any real supervisor
// path today.
export function normalizeCurrentDirComponents(source) {
  let previous;
  let current = source;
  do {
    previous = current;
    current = previous.replace(/\/\.(?=\/)/gu, "").replace(/(?<!:)\/{2,}/gu, "/");
  } while (current !== previous);
  return current;
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
//   Stack of frames (codex 3793025299, 3793050405, 3793282541). EVERY `#if` / `#ifdef` /
//   `#ifndef` pushes a new frame; `#endif` pops. Tracked (constant) forms push with the
//   deterministic mode; untracked (macro-gated) forms push a conservative KEEPING frame with
//   `sawDefLive=false` — so a constant-dead sibling branch such as `#elif 0` inside a macro-
//   gated ladder can still be recognised and stripped (its body is dead regardless of what the
//   compiler picked for the outer condition). Top-of-stack determines the current "should this
//   line be kept" answer. A line is kept only if EVERY frame is in KEEPING mode — the compiler
//   emits a line only if every enclosing conditional picks the branch containing it.
//   Per-frame flags:
//     mode: STRIPPING | KEEPING
//     sawDefLive: a preceding branch was DEFINITIVELY live (`#elif 1` after only-zero
//       predecessors, or `#else` in the same context). Subsequent branches are dead.
//     sawUnkLive: a preceding branch was POTENTIALLY live (`#elif FEATURE`). Subsequent
//       branches may ALSO be live; the ladder does not know which the compiler picked.

// Module-internal (not exported: the composition helpers below wrap all directive matching).
//
// Constant-condition regex building blocks (codex 3793229696 on #3202). The DISABLED and
// DEFINITIVELY_TRUE patterns share the same three shapes: bare literal (`0`/`1`), literal +
// short-circuiting operator + one RHS atom (`0 && FEATURE`, `1 || FEATURE`), and either of
// those wrapped in a single outer paren pair (`(0 && FEATURE)`). The RHS atom accepts both a
// plain identifier and a `defined(IDENT)` call, optionally negated with `!`; the reviewer
// called out `#if 0 && defined(FEATURE)` and `#if (0 && FEATURE)` as valid deterministically-
// false shapes the earlier per-regex spelling missed. Compose from parts so any future
// extension (e.g. `defined X` without parens, multi-atom AND chains) is a single edit.
//
// Coderabbit 3793183803: allow zero whitespace after `&&` (`#if 0&&FEATURE`) — it's valid C
// and evaluates to false. Whitespace before the identifier is `\s*` (was `\s+`) so both
// `0 && FEATURE` and `0&&FEATURE` match.
const _IDENT = "[A-Za-z_][A-Za-z0-9_]*";
const _DEFINED_CALL = `defined\\s*\\(\\s*${_IDENT}\\s*\\)`;
// RHS of a short-circuiting operator: bare identifier or `defined(IDENT)`, optionally `!`.
const _RHS_ATOM = `!?\\s*(?:${_IDENT}|${_DEFINED_CALL})`;
// Zero-valued integer literal across every C spelling that evaluates to zero: bare `0`, an
// octal chain of zeros (`00`, `000`, …) — leading `0` starts an octal literal so every all-
// zero digit sequence is also zero — and hexadecimal zero (`0x0`, `0X00`, …). Any of them
// may carry the usual U/L integer suffix combinations. Coderabbit 3793329577 on #3202: the
// earlier `0[UuLl]{0,3}` spelling matched only the bare decimal form, so `#if 0x0` or `#if 00`
// slipped past the deterministically-false pin and a required control retained only in that
// branch would still satisfy the source contract after the live copy was deleted.
const _ZERO_LITERAL = "(?:0[0]*|0[xX]0+)[UuLl]{0,3}";
// ANY nonzero integer literal — C's `#if` treats every nonzero integer as true, not just one.
// Widened from the previous one-only form (codex 3793398789 on #3202) so `#if 2`, `#if 42`,
// `#if 0x10`, `#if 077` are all recognised as deterministically-true. The earlier constant-one
// spelling missed these; `#if 2 ... #else REQUIRED_PIN ... #endif` was treated as unknown and
// both branches survived the strip, letting a required control retained only in the compiler-
// dead `#else` satisfy the source pin after the live copy was deleted. The three alternatives
// cover:
//   - decimal nonzero: `[1-9]\d*`               → `1`, `2`, `42`, `1000`
//   - octal   nonzero: `0[0-7]*[1-7][0-7]*`     → any leading-zero chain with at least one
//                                                  nonzero octal digit (`01`, `010`, `077`)
//   - hex     nonzero: `0[xX][0-9a-fA-F]*[1-9a-fA-F][0-9a-fA-F]*`
//                                                → `0x1`, `0xff`, `0X10`, `0x0F` (any hex
//                                                  value with at least one nonzero digit)
// The USUAL zero forms (`0`, `00`, `0x0`, `0X00`) are excluded by construction — each
// alternative requires at least one nonzero digit — so `_ZERO_LITERAL` and this pattern remain
// mutually exclusive.
const _NONZERO_LITERAL =
  "(?:[1-9]\\d*|0[0-7]*[1-7][0-7]*|0[xX][0-9a-fA-F]*[1-9a-fA-F][0-9a-fA-F]*)[UuLl]{0,3}";
// The literal itself may be parenthesized (`(0)`, `(1)`, `(2)`) — preserved from the original
// spelling so `#if (0)` still matches. `\(?` and `\)?` are BOTH optional but always paired in
// practice. Codex 3793436218 on #3202: also accept a leading unary `+` or `-` so `#if -1`,
// `#if +42`, `#if -0` are handled — the C preprocessor evaluates `-<zero>` to zero and
// `-<nonzero>` / `+<nonzero>` to nonzero. Whitespace between the sign and the literal is
// allowed (`- 1`).
const _parenZero = `\\(?\\s*[-+]?\\s*${_ZERO_LITERAL}\\s*\\)?`;
const _parenNonzero = `\\(?\\s*[-+]?\\s*${_NONZERO_LITERAL}\\s*\\)?`;
// Codex 3793501034 on #3202: `!0` is unconditionally true and `!1` is unconditionally false —
// logical NOT of a recognised constant. Pair each side with the negation of the opposite: a
// TRUE literal form is either a nonzero literal OR the negation of a zero literal; a FALSE
// literal form is either a zero literal OR the negation of a nonzero literal. Whitespace
// between `!` and the value is allowed (`! 0`, `!(0)`, `! ( 0 )`).
const _parenTrueLiteral = `(?:${_parenNonzero}|!\\s*${_parenZero})`;
const _parenFalseLiteral = `(?:${_parenZero}|!\\s*${_parenNonzero})`;
// Coderabbit 3793501284 on #3202: extend the RHS after a constant-short-circuit to accept
// parenthesised sub-expressions like `(FEATURE || OTHER)`. Because C's `&&` and `||` short-
// circuit on a constant left operand, the WHOLE expression's truth value is determined by the
// literal alone — we don't need to evaluate the RHS's structure, only recognise its SHAPE so
// the directive line parses fully. One level of parenthesised atoms joined by short-circuit
// operators is enough for the real-world forms; nested paren depths >1 fall back to unknown.
const _rhsAtomOrPareneChain = `(?:${_RHS_ATOM}|\\(\\s*${_RHS_ATOM}(?:\\s*(?:&&|\\|\\|)\\s*${_RHS_ATOM})*\\s*\\))`;
// `<literal>` alone or `<literal> <op> <RHS-atom-or-parened>`. `<op>` is `&&` for FALSE (short-
// circuits on left=0), `||` for TRUE (short-circuits on left=nonzero).
const _falseExpr = `${_parenFalseLiteral}(?:\\s*&&\\s*${_rhsAtomOrPareneChain})?`;
const _trueExpr = `${_parenTrueLiteral}(?:\\s*\\|\\|\\s*${_rhsAtomOrPareneChain})?`;
// Optional outer parens wrapping the WHOLE constant expression, e.g. `(0 && FEATURE)`. Note the
// two alternatives are needed together so both `(0) && FEATURE` (inner-only) and
// `(0 && FEATURE)` (outer-whole) work.
const _falseCond = `(?:\\(\\s*${_falseExpr}\\s*\\)|${_falseExpr})`;
const _trueCond = `(?:\\(\\s*${_trueExpr}\\s*\\)|${_trueExpr})`;

const PREPROCESSOR_PATTERNS = {
  OPEN_IF: /^#\s*(?:if|ifdef|ifndef)\b/u,
  CLOSE_ENDIF: /^#\s*endif\b/u,
  ELSE_DIRECTIVE: /^#\s*else\b/u,
  ELIF_DIRECTIVE: /^#\s*elif\b/u,
  DISABLED_IF: new RegExp(`^#\\s*if\\s+${_falseCond}\\s*$`, "u"),
  DISABLED_ELIF: new RegExp(`^#\\s*elif\\s+${_falseCond}\\s*$`, "u"),
};

// Constant-true forms — extracted so the outer regex object is not polluted with the `1`-shape
// variants and so a future contributor can extend them independently. Codex 3793074555 added
// constant-true; codex 3793198453 added `#if 1 || FEATURE` (mirror of `#if 0 && FEATURE`);
// codex 3793229696 added outer parens (`#if (1 || FEATURE)`) and `defined()` on the RHS.
const DEFINITIVELY_TRUE_IF = new RegExp(`^#\\s*if\\s+${_trueCond}\\s*$`, "u");
const DEFINITIVELY_TRUE_ELIF = new RegExp(`^#\\s*elif\\s+${_trueCond}\\s*$`, "u");

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
    stack.push({ mode: STRIPPING, sawDefLive: false, sawUnkLive: false });
    return;
  }
  if (DEFINITIVELY_TRUE_IF.test(trimmed)) {
    stack.push({ mode: KEEPING, sawDefLive: true, sawUnkLive: false });
    return;
  }
  // Codex 3793642853 on #3202: constant arithmetic like `#if 1 + 1` matches neither of the
  // regex patterns above but the C preprocessor evaluates it (to 2 → nonzero → true here).
  // Any spawn / fd-close pin retained only in a `#else` after such a condition would satisfy
  // the source-only native contract despite being compiler-dead. Evaluate constant arithmetic
  // conditions with a strict-char-set-validated JS `Function` fallback; unknown / macro-gated
  // conditions still fall through to the untracked-frame path below.
  if (tryConstantArithmeticIf(trimmed, stack)) return;
  // Untracked (macro-gated) `#if X` / `#ifdef X` / `#ifndef X`: push a conservative KEEPING
  // frame instead of bumping a depth counter on the parent (codex 3793282541). The reason is
  // subtle — the parent-depth model treated `#elif`/`#else` inside the untracked ladder as
  // ordinary lines, so `#elif 0` in `#if FEATURE ... #elif 0 REQUIRED_PIN ... #endif` never
  // flipped anything to STRIPPING and `REQUIRED_PIN` leaked into the effective source
  // (satisfying pin assertions the compiler would have never seen). By pushing a real frame
  // we route `#elif`/`#else` to `applyElif/ElseTransition` on the correct frame, so a
  // constant-dead sibling branch is stripped even when the containing condition is unknown.
  // Initial state: mode KEEPING (unknown branch may be picked), sawDefLive false, sawUnkLive
  // false — matches the semantics of an untracked `#if X` opening branch.
  if (p.OPEN_IF.test(trimmed)) {
    stack.push({ mode: KEEPING, sawDefLive: false, sawUnkLive: false });
    return;
  }
  if (stack.length === 0) {
    kept.push(line);
    return;
  }
  const frame = stack[stack.length - 1];
  if (p.CLOSE_ENDIF.test(trimmed)) {
    stack.pop();
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
  if (DEFINITIVELY_TRUE_ELIF.test(trimmed)) {
    // Coderabbit 3793183804: `#elif 1` is unconditionally exhaustive — if we reach it, all
    // preceding branches must have been false, so this branch is picked; and `#elif 1` cannot
    // itself be skipped (its condition is always true). Either way the compiler picks EXACTLY
    // this branch OR a preceding one, so every subsequent `#elif`/`#else` is dead — regardless
    // of whether a prior `#elif <unknown>` was seen. Set sawDefLive unconditionally.
    frame.mode = KEEPING;
    frame.sawDefLive = true;
    return;
  }
  // Codex 3793642853 on #3202: constant arithmetic elif (`#elif 1 + 1`, `#elif 1 - 1`, …)
  // evaluated via the JS-Function fallback with strict char-set validation.
  if (tryConstantArithmeticElif(trimmed, frame)) return;
  // Fallback: unknown condition. Potentially live — this branch survives.
  frame.mode = KEEPING;
  frame.sawUnkLive = true;
}

// Codex 3793642853 on #3202: constant-arithmetic evaluator for preprocessor conditions the
// regex fallbacks don't already cover. Strict char-set validation rejects any identifier or
// call so the JS `Function` eval only ever sees a pure integer expression (digits + hex prefix
// + U/L suffixes + unary/binary +-*/% + comparison + logical/bitwise + parens + whitespace).
// C integer suffixes are stripped and C octal literals are converted to JS `0o…` form before
// eval. Returns the numeric result or null if the expression is not a pure integer constant.
function evaluateConstantArithmetic(exprText) {
  const trimmed = exprText.trim();
  if (trimmed.length === 0) return null;
  if (!/^[\s0-9xXa-fA-FUuLl+\-*/%()<>=!&|^~]+$/u.test(trimmed)) return null;
  // Reject `**` — JS treats it as exponentiation, C treats a bare `*` sequence as syntax error.
  if (trimmed.includes("**")) return null;
  let js = trimmed.replace(/([0-9a-fA-F])[UuLl]{1,3}\b/gu, "$1");
  // C octal: `0<octal-digits>`. Convert to JS `0o<digits>`. Bare `0` and `0x…` stay as-is.
  js = js.replace(/\b0([0-7]+)(?![0-9a-fA-F])/gu, "0o$1");
  try {
    const result = new Function('"use strict"; return (' + js + ");")();
    // C comparison and logical operators return `int` (0 or 1); JavaScript returns `boolean`.
    // Normalise so `1 == 1` → 1 and `1 < 0` → 0 land in the caller as usable truth values.
    if (typeof result === "boolean") return result ? 1 : 0;
    if (typeof result !== "number" || !Number.isFinite(result)) return null;
    return Math.trunc(result);
  } catch {
    return null;
  }
}

function tryConstantArithmeticIf(trimmed, stack) {
  const match = /^#\s*if\s+(.+?)\s*$/u.exec(trimmed);
  if (match === null) return false;
  const value = evaluateConstantArithmetic(match[1]);
  if (value === null) return false;
  stack.push(
    value === 0
      ? { mode: STRIPPING, sawDefLive: false, sawUnkLive: false }
      : { mode: KEEPING, sawDefLive: true, sawUnkLive: false },
  );
  return true;
}

function tryConstantArithmeticElif(trimmed, frame) {
  const match = /^#\s*elif\s+(.+?)\s*$/u.exec(trimmed);
  if (match === null) return false;
  const value = evaluateConstantArithmetic(match[1]);
  if (value === null) return false;
  if (value === 0) {
    frame.mode = STRIPPING;
  } else {
    frame.mode = KEEPING;
    frame.sawDefLive = true;
  }
  return true;
}
