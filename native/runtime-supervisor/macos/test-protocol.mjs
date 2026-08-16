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
// source pins were the only defence — and they silently accepted commented-out controls. Strip C
// comments before matching. String literals are PRESERVED so a real `execve("/bin/sh", …)` still
// trips the negative `\/bin\/sh` assertion below, but a `// old: execve("/bin/sh")` no longer
// does. Line splicing (`\<newline>` pairs) runs first, so a `\`-continued line comment cannot
// hide a control on its spliced-in tail either.
// Copy a C string OR character literal starting at the opening quote (index i) verbatim to
// `out`. `quote` is `"` for string literals and `'` for char literals. Returns the index of the
// byte AFTER the matching closing quote (or the end of source on unterminated input). Backslash
// escape handling is identical for both.
function copyQuotedVerbatim(source, start, out, quote) {
  let i = start + 1;
  let result = out + quote;
  while (i < source.length) {
    const c = source[i];
    if (c === "\\") {
      result += source.slice(i, i + 2);
      i += 2;
      continue;
    }
    result += c;
    i += 1;
    if (c === quote) return { out: result, next: i };
  }
  return { out: result, next: i };
}

// KEIKO-0277 (review-follow-up): a control retained only inside a `#if 0 ... #endif` block
// never compiles, but the byte scanner used to copy those bytes verbatim, so a deleted fd-close
// whose old form was wrapped in `#if 0` still satisfied `assert.match`. This pre-pass strips
// definitely-inactive preprocessor regions before the comment/literal scan runs. Nested
// `#if`/`#ifdef`/`#ifndef` are counted so `#if 0 ... #if X ... #endif ... #endif` closes the
// outer block on the OUTER `#endif`, not the inner one. On `#else` at the outer `#if 0`'s depth
// stripping stops — the else branch IS the live code. Non-literal `#if <expr>` and general
// preprocessor constants are intentionally out of scope: this is not a preprocessor, it targets
// the specific "disabled code" marker (`#if 0`) that hides tokens from the compiler.
function stripDisabledPreprocessorBranches(source) {
  const OPEN_IF = /^#\s*(?:if|ifdef|ifndef)\b/u;
  const CLOSE_ENDIF = /^#\s*endif\b/u;
  const ELSE_DIRECTIVE = /^#\s*else\b/u;
  // DISABLED_IF (review-follow-up on af74e79b, codex 3792928022): C accepts constant
  // expressions in `#if`, so a disabled block can appear as `#if 0`, `#if (0)`, `#if 0L`
  // (integer suffixes `U`, `L`, `LL`, `UL`, `ULL` and their lowercase equivalents), or
  // `#if 0 && FEATURE` (C left-to-right `&&` short-circuits regardless of FEATURE). The
  // composite `&&` form is recognised for a SINGLE trailing identifier (optionally `!`-prefixed);
  // more elaborate constant-expression evaluation stays out of scope.
  const DISABLED_IF =
    /^#\s*if\s+\(?\s*0[UuLl]{0,3}\s*\)?\s*(?:&&\s+!?[A-Za-z_][A-Za-z0-9_]*\s*)?\s*$/u;
  const lines = source.split("\n");
  const kept = [];
  let stripping = false;
  let depth = 0;
  for (const line of lines) {
    const trimmed = line.trimStart();
    if (stripping) {
      if (OPEN_IF.test(trimmed)) depth += 1;
      else if (CLOSE_ENDIF.test(trimmed)) {
        if (depth === 0) stripping = false;
        else depth -= 1;
      } else if (depth === 0 && ELSE_DIRECTIVE.test(trimmed)) stripping = false;
      continue;
    }
    if (DISABLED_IF.test(trimmed)) {
      stripping = true;
      depth = 0;
      continue;
    }
    kept.push(line);
  }
  return kept.join("\n");
}

// Strip C block and line comments in one pass, preserving string AND character literals
// verbatim (no interpretation). Throws on unterminated `/* ... */`.
// - Block comments: replaced with a same-length span of spaces AND newlines preserved
//   (coderabbit 3792888538) so subsequent line-based scans see directives at their original
//   physical line positions.
// - Char literals (`'...'`): skipped verbatim so a `'//'` or `'/*'` inside a multi-character
//   constant cannot start a false comment (coderabbit 3792888545).
function stripCCommentsOnly(rawSource) {
  let out = "";
  let i = 0;
  while (i < rawSource.length) {
    const ch = rawSource[i];
    const next = rawSource[i + 1];
    if (ch === "/" && next === "*") {
      const end = rawSource.indexOf("*/", i + 2);
      if (end === -1) throw new Error("unterminated C block comment: no `*/` after opening `/*`");
      out += rawSource.slice(i, end + 2).replace(/[^\n]/gu, " ");
      i = end + 2;
    } else if (ch === "/" && next === "/") {
      // Line comment CAN end at EOF without a newline; that is valid C, and no token can be
      // hidden by a `//` at EOF because everything after is comment text.
      const end = rawSource.indexOf("\n", i + 2);
      if (end === -1) return out;
      i = end;
    } else if (ch === '"') {
      const copied = copyQuotedVerbatim(rawSource, i, out, '"');
      out = copied.out;
      i = copied.next;
    } else if (ch === "'") {
      const copied = copyQuotedVerbatim(rawSource, i, out, "'");
      out = copied.out;
      i = copied.next;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

// KEIKO-0277 (review-follow-up on 44b9ef9b): C translation phase 3 removes comments BEFORE
// phase 4 executes preprocessor directives. Running `stripDisabledPreprocessorBranches` on text
// that still contains comments would interpret a `#else` or `#endif` inside a `/* */` block as
// a real directive, exposing a following disabled control to the byte scanner. Correct chain:
//   phase 2 (line splice) → phase 3 (comment strip) → phase 4 (#if 0 strip)
// String literals are PRESERVED throughout so the negative `\/bin\/sh` assertion still trips on
// a real `execve("/bin/sh", …)`, and a `// old: execve("/bin/sh")` still gets stripped by the
// comment pass regardless.
function stripCCommentsPreservingLiterals(rawSource) {
  return stripDisabledPreprocessorBranches(stripCCommentsOnly(rawSource.replace(/\\\r?\n/gu, "")));
}

const rawSource = await readFile(supervisorSource, "utf8");
const sourceText = stripCCommentsPreservingLiterals(rawSource);
assert.match(sourceText, /KEIKO_MONITOR_ARM/u);
assert.match(sourceText, /KEIKO_MONITOR_STOP/u);
assert.match(sourceText, /KEIKO_MONITOR_ZERO_LIVE/u);
// KEIKO-0261: fd 3 and fd 4 are the supervisor's control and response pipes. Closing both in the
// child's spawn file actions is what keeps the supervised runtime off them — without it the
// runtime could speak the control protocol to its own supervisor. The qualification fixture never
// touches those descriptors, so no behavioural test observes this; the source pin is the only
// thing standing between the boundary and a silent deletion.
assert.match(sourceText, /posix_spawn_file_actions_addclose\(&actions, 3\)/u);
assert.match(sourceText, /posix_spawn_file_actions_addclose\(&actions, 4\)/u);
// The non-PATH spawn form: posix_spawn takes an explicit path, so a hostile PATH cannot redirect
// the launch. The negative below rejects every PATH-searching sibling.
assert.match(sourceText, /posix_spawn\(/u);
assert.doesNotMatch(
  sourceText,
  /setsid|setpgid|killpg|\/bin\/sh|system\(|posix_spawnp|execvp|execlp|execvP/u,
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

// KEIKO-0277: Windows-sibling two-mode shape. `--helper <path>` qualifies an exact staged binary
// (release-qualification form the portable pipeline uses). Without `--helper`, compile the
// supervisor from source into a scratch root and qualify THAT — same clang invocation as
// scripts/check-macos-native-quality.sh, so the behavioural qualification runs on every PR from
// that gate instead of being reachable only at release time. The source contract above is
// deliberately placed BEFORE the platform guard so it runs on every host.
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
