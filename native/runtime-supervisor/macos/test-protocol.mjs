import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// KEIKO-0304: shared with `../test-protocol.mjs` (Windows). Six known divergences reconciled at the
// extraction; see the module's header for what and why. The macOS harness still owns its own
// clang compile of the fixture and its two-mode qualification runner (KEIKO-0277).
import {
  header,
  launchPacket,
  readBytes,
  response,
  streamReader,
  waitGone,
} from "../protocol-harness.mjs";
// Coderabbit 3793145636 on #3202: the C source scanner (line splicing, comment/literal
// handling, disabled-preprocessor-branch state machine) used to be duplicated in this file
// AND `native/secure-workspace-read/test-protocol.mjs`. Consolidated behind the shared module
// so a fix lands in one place.
import {
  decodeCStringEscapes,
  foldAdjacentStringLiterals,
  preprocessCLineSplices,
  stripCComments,
  stripDisabledPreprocessorBranches,
  stripStringLiteralBodies,
} from "../../lib/c-source-scanner.mjs";

const DEADLINE_MS = 15_000;
// `URL.pathname` retains percent encoding, so a checkout path containing spaces, `%`, `#` or `?`
// would reach xcrun as a mangled filename and fail the compile with a confusing "file not found".
// `fileURLToPath` decodes to a filesystem path xcrun can actually open (Windows keeps its own
// resolution, which is why the Windows harness carries its own helper).
const supervisorSource = fileURLToPath(new URL("./keiko_runtime_supervisor.c", import.meta.url));
const fixtureSource = fileURLToPath(new URL("./qualification_fixture.c", import.meta.url));

async function compileFixture(path, architecture) {
  const child = spawn(
    "/usr/bin/xcrun",
    [
      "clang",
      "-std=c11",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-O2",
      "-arch",
      architecture,
      "-o",
      path,
      fixtureSource,
    ],
    { env: {}, stdio: ["ignore", "ignore", "pipe"] },
  );
  const errors = [];
  child.stderr.on("data", (chunk) => errors.push(chunk));
  const status = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  assert.equal(status, 0, Buffer.concat(errors).toString("utf8"));
}

async function qualify(helper, fixture, root) {
  const child = spawn(helper, [], {
    env: {},
    stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
  });
  const responses = streamReader(child.stdio[4]);
  const output = streamReader(child.stdout);
  const errors = [];
  child.stderr.on("data", (chunk) => errors.push(chunk));
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  const deadline = setTimeout(() => child.kill(), DEADLINE_MS);
  let completed = false;
  try {
    child.stdio[3].write(launchPacket(fixture, root));
    assert.deepEqual(await response(responses), { kind: 1, payload: Buffer.alloc(0) });
    const observation = await readBytes(output, 12);
    assert.equal(observation.subarray(0, 4).toString("ascii"), "KRQ1");
    const pids = [observation.readUInt32LE(4), observation.readUInt32LE(8)];
    child.stdio[3].write(header("KRC1", 3, 0));
    const proof = await response(responses);
    assert.equal(proof.kind, 2);
    assert.equal(proof.payload.readUInt32LE(4), 0);
    await Promise.all(pids.map(waitGone));
    assert.equal(await exited, 0);
    assert.equal(Buffer.concat(errors).length, 0);
    completed = true;
  } finally {
    clearTimeout(deadline);
    if (!completed) child.kill("SIGKILL");
    await exited.catch(() => undefined);
  }
}

// KEIKO-0277 (review-follow-up): the assertions below used to run against the RAW source, so a
// deleted fd-close or non-PATH spawn call whose old form remained in a `//` or `/* ... */` block
// would still satisfy `assert.match`. Since the behavioural qualification is deliberately skipped
// on hosts without the Endpoint Security system extension (per KEIKO-0277's fallback), those
// source pins were the only defence — and they silently accepted commented-out controls.
//
// Two composition modes over the shared C source scanner (coderabbit 3793145636 on #3202
// consolidated the previously duplicated primitives into `native/lib/c-source-scanner.mjs`):
//  - `stripCCommentsAndStrings` blanks string literal bodies too, so positive `assert.match`
//    pins can't be satisfied by an identifier that happens to appear inside a compiled
//    diagnostic string (codex 3792964064).
//  - `stripCCommentsPreservingLiterals` keeps string bodies verbatim; used ONLY for the
//    negative shell-path check where a real `execve("/bin/sh", …)` should still trip.
function stripCCommentsAndStrings(rawSource) {
  return stripStringLiteralBodies(stripCCommentsPreservingLiterals(rawSource));
}

function stripCCommentsPreservingLiterals(rawSource) {
  // Codex 3793282534: adjacent string literals concatenate at compile time (C11 §6.4.5). Fold
  // them BEFORE the negative shell-path pin runs so `"/bin/" "sh"` cannot evade the regex that
  // expects a contiguous `"/bin/…sh"` literal.
  //
  // Codex 3793436216: also decode escape sequences inside string literals (C11 §6.4.4.4).
  // `"/bin/\x73h"` reaches clang as `/bin/sh`; without decoding, the negative shell-path
  // regex would miss the escape-hidden form.
  //
  // Codex 3793469154: order matters — DECODE FIRST, THEN FOLD. C11 §6.4.4.4 (escape decoding
  // in phase 5) precedes §6.4.5 (string concatenation in phase 6). If we fold first, an
  // adjacent-pair like `"\x2f" "bin/sh"` collapses to `"\x2fbin/sh"`; the variable-length hex
  // escape decoder then greedily consumes `2fb` as hex and produces `"ûin/sh"`, which does
  // not match the shell-path regex. Decoding each token first yields `"/" "bin/sh"`, which
  // then folds correctly to `"/bin/sh"`.
  return foldAdjacentStringLiterals(
    decodeCStringEscapes(
      stripDisabledPreprocessorBranches(stripCComments(preprocessCLineSplices(rawSource))),
    ),
  );
}

const rawSource = await readFile(supervisorSource, "utf8");
// String-blanked scan for positive identifier / call pins — a diagnostic string that happens
// to contain the pinned tokens must NOT satisfy the assertion.
const codeText = stripCCommentsAndStrings(rawSource);
// String-preserving scan for the negative shell-string check — a real `execve("/bin/sh", …)`
// must still trip it. Comments and disabled `#if 0` blocks are stripped from both scans.
const codeAndLiteralsText = stripCCommentsPreservingLiterals(rawSource);
assert.match(codeText, /KEIKO_MONITOR_ARM/u);
assert.match(codeText, /KEIKO_MONITOR_STOP/u);
assert.match(codeText, /KEIKO_MONITOR_ZERO_LIVE/u);
// KEIKO-0261: fd 3 and fd 4 are the supervisor's control and response pipes. Closing both in the
// child's spawn file actions is what keeps the supervised runtime off them — without it the
// runtime could speak the control protocol to its own supervisor. The qualification fixture never
// touches those descriptors, so no behavioural test observes this; the source pin is the only
// thing standing between the boundary and a silent deletion.
assert.match(codeText, /posix_spawn_file_actions_addclose\(&actions, 3\)/u);
assert.match(codeText, /posix_spawn_file_actions_addclose\(&actions, 4\)/u);
// The non-PATH spawn form: posix_spawn takes an explicit path, so a hostile PATH cannot redirect
// the launch. The negative below rejects every PATH-searching sibling — literal-preserving scan
// so a real `execve("/bin/sh", …)` still trips.
assert.match(codeText, /posix_spawn\(/u);
// Codex 3793074557 on #3202: the earlier form only rejected the exact `/bin/sh` path. A
// supervisor rewritten to wrap the requested command with `posix_spawn("/bin/bash", ...
// "-c", ...)` or `/bin/zsh` would still satisfy the positive `posix_spawn(` pin AND miss this
// negative. Widened to any absolute path under `/bin/`, `/usr/bin/`, `/usr/local/bin/`, or
// `/sbin/` whose executable name ends in `sh` — that covers `sh`, `bash`, `zsh`, `ksh`,
// `dash`, `ash`, `csh`, `tcsh`, and `fish` on any of the standard system paths, without
// tripping on unrelated tokens containing "sh".
//
// Codex 3793356678 on #3202: also reject `env`-mediated launches. `posix_spawn(..., "/usr/bin/
// env", ...)` with args like `sh -c ...` satisfies the positive spawn pin and hides a shell
// launch behind an ostensibly-neutral path. The supervisor should launch the requested runtime
// directly with a fixed absolute path (KEIKO-0304's no-shell contract); if a future need for
// `env` appears it should surface here so the reviewer weighs it, not slide past silently.
assert.doesNotMatch(
  codeAndLiteralsText,
  /setsid|setpgid|killpg|\/(?:s?bin|usr\/(?:local\/)?bin)\/(?:[a-z]*sh|env)\b|system\(|posix_spawnp|execvp|execlp|execvP/u,
);

// Codex 3792964064 negative self-test: a deleted control retained only as text inside a compiled
// diagnostic string must NOT satisfy the positive pin. Take the real source, replace the fd-3
// close with an equivalent-shaped STRING literal, and prove the string-blanked scan rejects it.
// The literal-preserving scan would still see the text and fail this test — proof that the two
// modes are load-bearing.
const stringHiddenSource = rawSource.replace(
  /posix_spawn_file_actions_addclose\(&actions, 3\);/u,
  '(void)"posix_spawn_file_actions_addclose(&actions, 3)";',
);
const stringHiddenBlanked = stripCCommentsAndStrings(stringHiddenSource);
assert.equal(
  stringHiddenBlanked.match(/posix_spawn_file_actions_addclose\(&actions, 3\)/u),
  null,
  "stripCCommentsAndStrings must not let a compiled diagnostic string satisfy the positive pin",
);

// KEIKO-0277 (review-follow-up) negative self-test: proves stripCCommentsPreservingLiterals is
// load-bearing. Mutate the real source to move `posix_spawn_file_actions_addclose(&actions, 3)`
// into a `/* ... */` block, and prove the stripped scan no longer sees it. A raw-source scan of
// the same mutated text would still find the token inside the comment.
const mutatedSource = rawSource.replace(
  /posix_spawn_file_actions_addclose\(&actions, 3\)/u,
  "/* posix_spawn_file_actions_addclose(&actions, 3) */ (void)0",
);
const mutatedStripped = stripCCommentsPreservingLiterals(mutatedSource);
assert.equal(
  mutatedStripped.match(/posix_spawn_file_actions_addclose\(&actions, 3\)/u),
  null,
  "stripCCommentsPreservingLiterals must remove fd-close pin hidden in a block comment",
);

// KEIKO-0277 (review-follow-up): unterminated `/* ... */` must throw, not silently return the
// partial prefix. A truncated or malformed source whose closing `*/` never arrives would
// otherwise satisfy the source-contract regexes on the tokens BEFORE the unclosed comment.
assert.throws(
  () =>
    stripCCommentsPreservingLiterals(
      "posix_spawn_file_actions_addclose(&actions, 3);\n/* opened but never closed\n",
    ),
  /unterminated C block comment/u,
  "stripCCommentsPreservingLiterals must throw on an unterminated /* ... */",
);

// KEIKO-0277 (review-follow-up): `#if 0 ... #endif` blocks must be stripped before the byte
// scan. Test on a synthetic fixture so `#if 0` appears at line start (C preprocessor requires
// directives to be first on the line; the real source's fd-close call is prefixed with `(void)`
// which would prevent line-start recognition if we tried to wrap it in place). Nesting covered
// too: a `#if 0 { #if 1 { X } #endif } #endif` must fully strip X, and code after the outer
// `#endif` must survive.
const disabledIfSample =
  "int keep_before(void) { return 1; }\n" +
  "#if 0\nposix_spawn_file_actions_addclose(&actions, 3);\n#endif\n" +
  "int keep_after(void) { return 2; }\n";
const disabledIfStripped = stripCCommentsPreservingLiterals(disabledIfSample);
assert.equal(
  disabledIfStripped.match(/posix_spawn_file_actions_addclose\(&actions, 3\)/u),
  null,
  "stripCCommentsPreservingLiterals must strip tokens inside `#if 0 ... #endif`",
);
assert.ok(
  disabledIfStripped.includes("keep_before"),
  "code BEFORE the outer `#if 0 ... #endif` must survive the strip",
);
assert.ok(
  disabledIfStripped.includes("keep_after"),
  "code AFTER the outer `#if 0 ... #endif` must survive the strip",
);
const nestedIfSample =
  "int keep(void) { return 0; }\n" +
  "#if 0\n#if 1\nSHOULD_BE_STRIPPED();\n#endif\n#endif\n" +
  "int live(void) { return 1; }\n";
const nestedIfStripped = stripCCommentsPreservingLiterals(nestedIfSample);
assert.equal(
  nestedIfStripped.match(/SHOULD_BE_STRIPPED/u),
  null,
  "stripCCommentsPreservingLiterals must count nested `#if` inside a `#if 0` block",
);
assert.ok(
  nestedIfStripped.includes("keep"),
  "code BEFORE the outer `#if 0 ... #endif` (with nesting) must survive the strip",
);
assert.ok(
  nestedIfStripped.includes("live"),
  "code AFTER the outer `#if 0 ... #endif` (with nesting) must survive the strip",
);
// KEIKO-0277 (review-follow-up on 7c976f77): a `\`-continued directive `#if \\\n0` splices to
// `#if 0` at C translation phase 2, before preprocessing. Running the disabled-branch strip on
// the raw text would miss this shape. Proves the line-splice pre-pass runs FIRST.
const splicedDirectiveSample =
  "int keep_before(void) { return 1; }\n" +
  "#if \\\n0\nSHOULD_BE_STRIPPED_BY_SPLICED_IF();\n#endif\n" +
  "int keep_after(void) { return 2; }\n";
const splicedDirectiveStripped = stripCCommentsPreservingLiterals(splicedDirectiveSample);
assert.equal(
  splicedDirectiveStripped.match(/SHOULD_BE_STRIPPED_BY_SPLICED_IF/u),
  null,
  "line splicing must run BEFORE disabled-branch stripping so `#if \\\\\\n0` is recognised as `#if 0`",
);
// KEIKO-0277 (review-follow-up on 44b9ef9b): a `#else` that lives ONLY inside a `/* */` block
// is invisible to the C preprocessor (translation phase 3 removes comments before phase 4
// interprets directives). Running disabled-branch stripping on comment-inclusive text would
// treat that commented `#else` as an early exit from `stripping`, exposing the following
// disabled control. Proves comment stripping runs BEFORE disabled-branch stripping.
const commentedElseSample =
  "int keep(void) { return 1; }\n" +
  "#if 0\n" +
  "/* #else */\n" +
  "STILL_INSIDE_DISABLED_BRANCH();\n" +
  "#endif\n" +
  "int live(void) { return 2; }\n";
const commentedElseStripped = stripCCommentsPreservingLiterals(commentedElseSample);
assert.equal(
  commentedElseStripped.match(/STILL_INSIDE_DISABLED_BRANCH/u),
  null,
  "comment stripping must run BEFORE disabled-branch stripping so a `#else` inside `/* */` is not seen as a directive",
);
// Coderabbit 3792888538 (block-comment newlines): a multi-line block comment must be replaced
// with a same-length span of spaces AND newlines, so a `#if 0` directive on a line after the
// comment stays at line-start in the stripped output.
const multilineCommentBeforeIf =
  "int keep(void) { return 1; }\n" +
  "/* multi\n line \n block */\n" +
  "#if 0\n" +
  "SHOULD_BE_STRIPPED_AFTER_MULTILINE_COMMENT();\n" +
  "#endif\n";
const multilineStripped = stripCCommentsPreservingLiterals(multilineCommentBeforeIf);
assert.equal(
  multilineStripped.match(/SHOULD_BE_STRIPPED_AFTER_MULTILINE_COMMENT/u),
  null,
  "block-comment stripping must preserve newlines so a following `#if 0` stays at line-start",
);
// Coderabbit 3792888543 (disabled-if variants): `#if (0)`, `#if 0L`, `#if (0U)` and integer-
// suffix variants. Codex 3792928022: `#if 0 && FEATURE` also short-circuits to 0 (C left-to-
// right `&&`), so a control wrapped in that composite form is likewise disabled.
for (const variant of [
  "#if (0)",
  "#if 0L",
  "#if 0U",
  "#if 0LL",
  "#if (0UL)",
  "#if  0",
  "#if 0 && FEATURE",
  "#if 0 && FEATURE_NAME",
  "#if (0) && FLAG",
  "#if 0L && !DISABLED_MACRO",
]) {
  const stripped = stripCCommentsPreservingLiterals(
    `${variant}\nSHOULD_BE_STRIPPED_BY_DISABLED_IF_VARIANT();\n#endif\nint live(void) { return 1; }\n`,
  );
  assert.equal(
    stripped.match(/SHOULD_BE_STRIPPED_BY_DISABLED_IF_VARIANT/u),
    null,
    `disabled-if strip must recognise the constant-zero variant: ${variant}`,
  );
}
// Coderabbit 3792888545 (char literals): a `//` sequence inside a char constant must not start
// a false line comment (which would drop the following code from the scan and let a deleted
// control on the dropped line pass the source contract).
const charLiteralWithSlashSlash = stripCCommentsPreservingLiterals(
  "int f(void) { return '//'; }\nposix_spawn_file_actions_addclose(&actions, 3);\n",
);
assert.match(
  charLiteralWithSlashSlash,
  /posix_spawn_file_actions_addclose\(&actions, 3\)/u,
  "stripCCommentsPreservingLiterals must not treat `'//'` inside a char literal as a line-comment start",
);

// Codex 3792964066 (#elif handling): `#if 0 ... #elif 1 ... #endif` — the elif branch is
// compiler-included, so a control that lives there is LIVE and must be visible to the scan.
// Before this fix, the scanner treated `#elif` as if it were still part of the disabled block
// and dropped the live branch through the closing `#endif`.
const elifWithLiveBranch = stripCCommentsPreservingLiterals(
  "int keep_before(void) { return 1; }\n" +
    "#if 0\nDEAD_BRANCH();\n#elif 1\nLIVE_BRANCH_TOKEN();\n#endif\n" +
    "int keep_after(void) { return 2; }\n",
);
assert.match(
  elifWithLiveBranch,
  /LIVE_BRANCH_TOKEN/u,
  "outer-depth `#elif <non-zero>` must stop stripping so the live branch is visible to the scan",
);
assert.equal(
  elifWithLiveBranch.match(/DEAD_BRANCH/u),
  null,
  "the disabled `#if 0` half before `#elif` must still be stripped",
);
// A `#elif 0` is deterministically false — its branch is dead, keep stripping through it.
const elifDisabledSample = stripCCommentsPreservingLiterals(
  "#if 0\nA();\n#elif 0\nSHOULD_BE_STRIPPED_BY_ELIF_ZERO();\n#endif\nint live(void) { return 1; }\n",
);
assert.equal(
  elifDisabledSample.match(/SHOULD_BE_STRIPPED_BY_ELIF_ZERO/u),
  null,
  "`#elif 0` at outer depth must keep stripping (its branch is deterministically dead)",
);
// Codex 3792986617: after a LIVE branch in the ladder, EVERY subsequent branch is dead — the
// compiler picks exactly one. `#if 0 ... #elif 1 ... #else DEAD ... #endif` must strip the
// `#else` body too, otherwise a fd-close or spawn control retained only there satisfies the
// source contract after the live implementation is deleted.
const elifThenDeadElseSample = stripCCommentsPreservingLiterals(
  "int keep_before(void) { return 1; }\n" +
    "#if 0\nDEAD_A();\n" +
    "#elif 1\nLIVE_TOKEN();\n" +
    "#else\nDEAD_ELSE_TOKEN();\n" +
    "#endif\n" +
    "int keep_after(void) { return 2; }\n",
);
assert.match(elifThenDeadElseSample, /LIVE_TOKEN/u, "live `#elif 1` branch must be visible");
assert.equal(
  elifThenDeadElseSample.match(/DEAD_A/u),
  null,
  "`#if 0` branch before a live `#elif` must be stripped",
);
assert.equal(
  elifThenDeadElseSample.match(/DEAD_ELSE_TOKEN/u),
  null,
  "`#else` after a live `#elif` must be stripped (the compiler picks exactly one branch)",
);
// Also cover: `#if 0 ... #elif 1 ... #elif SOMETHING ... #endif` — the second `#elif` is dead
// (the first `#elif 1` was live). Its body must be stripped.
const elifThenDeadElifSample = stripCCommentsPreservingLiterals(
  "#if 0\nDEAD_A();\n" +
    "#elif 1\nLIVE_TOKEN2();\n" +
    "#elif SOMETHING\nDEAD_ELIF_TOKEN();\n" +
    "#endif\n",
);
assert.match(
  elifThenDeadElifSample,
  /LIVE_TOKEN2/u,
  "the first live `#elif` branch must be visible",
);
assert.equal(
  elifThenDeadElifSample.match(/DEAD_ELIF_TOKEN/u),
  null,
  "any `#elif` after a live branch must be stripped",
);
// Coderabbit 3793025299 (nested `#if 0` inside live branch): the single-frame state machine
// treated it as ordinary depth-tracking and let the dead body reach the source contract.
const nestedInsideLiveSample =
  "int keep_before(void) { return 1; }\n" +
  "#if 0\n" +
  "OUTER_DEAD();\n" +
  "#else\n" +
  "LIVE_BEFORE_NESTED();\n" +
  "#if 0\n" +
  "NESTED_DEAD_TOKEN();\n" +
  "#endif\n" +
  "LIVE_AFTER_NESTED();\n" +
  "#endif\n" +
  "int keep_after(void) { return 2; }\n";
const nestedInsideLiveStripped = stripCCommentsPreservingLiterals(nestedInsideLiveSample);
assert.match(
  nestedInsideLiveStripped,
  /LIVE_BEFORE_NESTED/u,
  "live outer content BEFORE the nested `#if 0` must be visible",
);
assert.match(
  nestedInsideLiveStripped,
  /LIVE_AFTER_NESTED/u,
  "live outer content AFTER the nested `#if 0` must be visible",
);
assert.equal(
  nestedInsideLiveStripped.match(/NESTED_DEAD_TOKEN/u),
  null,
  "nested `#if 0` inside a live `#else` branch must have its body stripped",
);
// Codex 3793050405 (inverse nesting): a nested `#if 0 ... #else PIN` inside a STRIPPING
// parent must have its inner `#else` body stripped too. Every frame on the stack must be
// KEEPING for a line to survive; clang omits the whole outer branch.
const nestedInsideDeadSample =
  "int keep_before(void) { return 1; }\n" +
  "#if 0\n" +
  "#if 0\n" +
  "OUTER_DEAD_INNER_STRIPPING();\n" +
  "#else\n" +
  "NESTED_ELSE_INSIDE_DEAD_PIN();\n" +
  "#endif\n" +
  "#endif\n" +
  "int keep_after(void) { return 2; }\n";
const nestedInsideDeadStripped = stripCCommentsPreservingLiterals(nestedInsideDeadSample);
assert.equal(
  nestedInsideDeadStripped.match(/NESTED_ELSE_INSIDE_DEAD_PIN/u),
  null,
  "nested `#else` INSIDE a dead outer `#if 0` branch must still be stripped (parent frame is STRIPPING)",
);
assert.equal(
  nestedInsideDeadStripped.match(/OUTER_DEAD_INNER_STRIPPING/u),
  null,
  "the outer dead branch's own body must still be stripped",
);
// Codex 3793074555: `#if 1 ... #else DEAD ... #endif`. The if-body is live, the else-body
// is compiler-dead. Track constant-true `#if` so the else-body gets stripped.
const constantTrueIfSample =
  "int keep_before(void) { return 1; }\n" +
  "#if 1\n" +
  "LIVE_IN_IF_ONE();\n" +
  "#else\n" +
  "DEAD_IN_ELSE_OF_IF_ONE();\n" +
  "#endif\n" +
  "int keep_after(void) { return 2; }\n";
const constantTrueIfStripped = stripCCommentsPreservingLiterals(constantTrueIfSample);
assert.match(constantTrueIfStripped, /LIVE_IN_IF_ONE/u, "the `#if 1` body must be visible");
assert.equal(
  constantTrueIfStripped.match(/DEAD_IN_ELSE_OF_IF_ONE/u),
  null,
  "the `#else` after `#if 1` must be stripped (compiler picks the if-body)",
);
// Also cover `#if 1L` and `#if (1)` — same constant-true variants as the DISABLED_IF suffixes.
for (const variant of ["#if (1)", "#if 1L", "#if 1U", "#if (1UL)"]) {
  const stripped = stripCCommentsPreservingLiterals(
    variant + "\nLIVE_VARIANT();\n#else\nDEAD_ELSE_OF_TRUE_VARIANT();\n#endif\n",
  );
  assert.match(
    stripped,
    /LIVE_VARIANT/u,
    "constant-true #if variant must keep the if-body: " + variant,
  );
  assert.equal(
    stripped.match(/DEAD_ELSE_OF_TRUE_VARIANT/u),
    null,
    "constant-true #if variant must strip the else-body: " + variant,
  );
}
// Codex 3793074557 negative self-test: mutate the real source to insert a hard-coded shell
// path OTHER than `/bin/sh` and prove the widened negative assertion trips. If the code base
// had a real `posix_spawn(..., "/bin/bash", "-c", ...)` call, we'd want the test to fail.
const alternateShellSample = rawSource.replace(
  /posix_spawn\(/u,
  '_dummy_marker(); posix_spawn("/bin/bash", "-c", ...',
);
const alternateShellStripped = stripCCommentsPreservingLiterals(alternateShellSample);
assert.match(
  alternateShellStripped,
  /\/(?:s?bin|usr\/(?:local\/)?bin)\/[a-z]*sh\b/u,
  "widened shell-path negative assertion regex must match `/bin/bash`",
);
for (const shellPath of [
  "/bin/bash",
  "/bin/zsh",
  "/bin/ksh",
  "/bin/dash",
  "/bin/csh",
  "/bin/tcsh",
  "/usr/bin/bash",
  "/usr/local/bin/fish",
  "/sbin/nologin_but_not_sh_ending", // sanity: this one must NOT match (ends in "ending")
]) {
  const shouldMatch = /sh$/.test(shellPath);
  const actual = /\/(?:s?bin|usr\/(?:local\/)?bin)\/[a-z]*sh\b/u.test(shellPath);
  assert.equal(
    actual,
    shouldMatch,
    `shell-path regex on ${shellPath}: expected ${shouldMatch}, got ${actual}`,
  );
}
// Coderabbit 3793025301: unterminated `'...'` and `"..."` must throw for the same reason
// unterminated `/* ... */` throws — silently accepting them drops every token after the stray
// quote from the scan.
assert.throws(
  () => stripCCommentsPreservingLiterals("int f(void) { return '"),
  /unterminated C character constant/u,
  "unterminated char literal must throw",
);
assert.throws(
  () => stripCCommentsPreservingLiterals('int f(void) { return "'),
  /unterminated C string literal/u,
  "unterminated string literal must throw",
);

// KEIKO-0277 (codex 3793145634 corrected the stale form of this comment on #3202):
// Behavioural qualification is OPT-IN via `--helper <path>` (release form: the exact staged
// binary the portable pipeline just built) or `--compile` (developer form: compile the
// supervisor from source, then qualify THAT). WITHOUT either flag, only the source contract
// above runs — that is what `scripts/check-macos-native-quality.sh` does on every PR, because
// the behavioural qualification needs an installed Endpoint Security system extension that no
// hosted runner carries. The earlier comment implied the source-only lane also compiled and
// qualified, which could cause contributors to report ES behaviour as verified when in fact
// only source assertions ran. The source contract above is deliberately placed BEFORE the
// platform guard so it runs on every host.
async function compileSupervisor(path, architecture) {
  const child = spawn(
    "/usr/bin/xcrun",
    [
      "clang",
      "-std=c11",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-O2",
      "-D_DARWIN_C_SOURCE",
      "-arch",
      architecture,
      "-o",
      path,
      supervisorSource,
    ],
    { env: {}, stdio: ["ignore", "ignore", "pipe"] },
  );
  const errors = [];
  child.stderr.on("data", (chunk) => errors.push(chunk));
  // Mirror `compileFixture`'s error handling: if xcrun cannot be spawned at all (missing binary,
  // ENOENT, EPERM), Node emits an unhandled `error` event that terminates the entire qualification
  // process. Listening for it and rejecting the promise turns that failure into a named stage.
  const status = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  if (status !== 0) {
    throw new Error(
      `compileSupervisor exited with ${String(status)}: ${Buffer.concat(errors).toString("utf8")}`,
    );
  }
}

// KEIKO-0277: behavioural qualification requires the installed Endpoint Security system extension
// to be present and ACTIVE — the supervisor answers ERROR_MONITOR_UNAVAILABLE otherwise, and no
// hosted runner has that setup. The finding's own fallback for that case is to keep the
// platform-independent source contract (above) unconditionally in the quality lane and gate the
// behavioural qualification on an explicit opt-in. `--helper` is the release form the portable
// pipeline uses (scripts/qualify-macos-runtime-release.mjs); `--compile` is the developer form
// that builds from source and qualifies THAT — usable on a workstation with the system extension
// installed. Neither flag → source contract only, no behavioural attempt, no false-red on CI.
// KEIKO-0277 (review-follow-up): validate `--helper`'s argument on every host (not only darwin) so
// a malformed invocation from the release pipeline fails fast instead of silently downgrading to
// the source-contract path and reporting success. `--helper` with no path, or with the empty
// string, is the exact malformed shape the release pipeline would produce if its exact-staged-
// binary lookup produced nothing.
const helperIndex = process.argv.indexOf("--helper");
if (helperIndex !== -1) {
  const supplied = process.argv[helperIndex + 1];
  if (supplied === undefined || supplied.length === 0) {
    throw new Error("--helper requires a non-empty path to the staged supervisor binary");
  }
}
if (process.platform === "darwin") {
  const helper = helperIndex === -1 ? undefined : process.argv[helperIndex + 1];
  const shouldCompile = process.argv.includes("--compile");
  if (helper !== undefined || shouldCompile) {
    const architecture = process.arch === "arm64" ? "arm64" : "x86_64";
    const root = await mkdtemp(join(tmpdir(), "keiko-macos-runtime-qualification-"));
    try {
      const fixture = join(root, "qualification-fixture");
      await compileFixture(fixture, architecture);
      let staged = helper;
      if (staged === undefined) {
        staged = join(root, "keiko-runtime-supervisor");
        await compileSupervisor(staged, architecture);
      }
      await qualify(staged, fixture, root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}
