import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveWindowsMsvcEnv, windowsToolFromPath } from "../../scripts/lib/windows-msvc.mjs";
import {
  preprocessCLineSplices,
  stripCComments,
  stripDisabledPreprocessorBranches,
  stripStringLiteralBodies,
} from "../lib/c-source-scanner.mjs";
import { performance } from "node:perf_hooks";
import { setImmediate as nextTurn, setTimeout as delay } from "node:timers/promises";

const source = fileURLToPath(new URL("./secure_workspace_read.c", import.meta.url));
const SAFE_TEXT = "safe text\n";
const HELPER_DEADLINE_MS = 2_000;
const CONCURRENT_CONSISTENCY_READS = 32;
const WINDOWS_RESERVED_STEMS = [
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "CONIN$",
  "CONOUT$",
  "COM",
  "LPT",
  "CLOCK$",
  "GLOBALROOT",
  "DEVICE",
  "??",
];
const WINDOWS_RESERVED_DENIED = [
  "CON",
  "con.txt",
  "PRN",
  "AUX.log",
  "NUL.txt",
  "CONIN$",
  "conin$.txt",
  "CONOUT$",
  "conout$.log",
  "COM1",
  "COM9.log",
  "COM¹",
  "com¹.txt",
  "COM²",
  "com².log",
  "COM³",
  "com³.txt",
  "LPT1",
  "LPT9.log",
  "LPT¹",
  "lpt¹.txt",
  "LPT²",
  "lpt².log",
  "LPT³",
  "lpt³.txt",
  "CLOCK$",
  "GLOBALROOT",
  "GLOBALROOT.txt",
  "DEVICE",
  "DEVICE.log",
  "??",
];
const WINDOWS_RESERVED_PREFIX_ALLOWED = [
  "GLOBALROOTED",
  "CONSOLE",
  "DEVICEFUL",
  "CLOCK$X",
  "COM10",
  "LPT10",
  "CONIN$X",
  "CONOUT$X",
  "COM¹0",
  "LPT²X",
];
const isWindows = process.platform === "win32";

function request(root, path, { cap = 65_536, trailing = Buffer.alloc(0) } = {}) {
  const rootBytes = Buffer.from(root, "utf8");
  const pathBytes = Buffer.from(path, "utf8");
  const frame = Buffer.alloc(20 + rootBytes.length + pathBytes.length);
  frame.write("KSR1", 0, "ascii");
  frame.writeUInt16LE(1, 4);
  frame.writeUInt32LE(rootBytes.length, 8);
  frame.writeUInt32LE(pathBytes.length, 12);
  frame.writeUInt32LE(cap, 16);
  rootBytes.copy(frame, 20);
  pathBytes.copy(frame, 20 + rootBytes.length);
  return Buffer.concat([frame, trailing]);
}

// KEIKO-0382: the helper's frame parser has ten guards at its trust boundary (version, reserved,
// declared vs supplied lengths, size caps, NUL and UTF-8 in the path) and zero of them were
// exercised. `request()` above cannot express the malformed cases those guards exist for because
// it derives every header field from the payload; this sibling builder decouples them so a frame
// can carry a declared length that DIFFERS from the bytes actually appended, an out-of-domain
// version, a non-zero reserved half-word, or arbitrary raw path bytes including NULs and invalid
// UTF-8. Kept small and single-purpose: assertProtocolCases uses it, `request()` stays the
// well-formed builder every other case still calls.
const MALFORMED_DEFAULTS = {
  root: "",
  pathBytes: Buffer.alloc(0),
  cap: 65_536,
  version: 1,
  reserved: 0,
  trailing: Buffer.alloc(0),
};

// KEIKO-0382 (review-follow-up): the builder now accepts raw `rootBytes` alongside the string
// `root`, mirroring `pathBytes` — the helper's parser rejects NUL and invalid UTF-8 in BOTH
// fields, and covering only `path` left the equivalent `root` guards untested. When `rootBytes`
// is supplied, `root` is ignored.
function malformedRequest(overrides = {}) {
  const options = { ...MALFORMED_DEFAULTS, ...overrides };
  const rootBuf = Buffer.isBuffer(options.rootBytes)
    ? options.rootBytes
    : Buffer.from(options.root, "utf8");
  const pathBuf = Buffer.isBuffer(options.pathBytes)
    ? options.pathBytes
    : Buffer.from(options.pathBytes, "utf8");
  const declaredRootLen = options.declaredRootLen ?? rootBuf.length;
  const declaredPathLen = options.declaredPathLen ?? pathBuf.length;
  const frame = Buffer.alloc(20 + rootBuf.length + pathBuf.length);
  frame.write("KSR1", 0, "ascii");
  frame.writeUInt16LE(options.version, 4);
  frame.writeUInt16LE(options.reserved, 6);
  frame.writeUInt32LE(declaredRootLen, 8);
  frame.writeUInt32LE(declaredPathLen, 12);
  frame.writeUInt32LE(options.cap, 16);
  rootBuf.copy(frame, 20);
  pathBuf.copy(frame, 20 + rootBuf.length);
  return Buffer.concat([frame, options.trailing]);
}

// The helper's own limits. Codex 3792928019/3793028202 on #3202: the earlier form only had
// over-cap probes (`limit + 1` → status 1). If the C constant were lowered, an over-cap probe
// stayed over-cap and the assertion still passed — silent drift. The at-boundary probes below
// (in `assertBoundaryProbes`) send the exact `limit` value and expect a NON-malformed status;
// if the C constant drops, the at-boundary case becomes over-cap and the assertion trips. So
// the pair (`limit` accepted + `limit + 1` rejected) actually pins the boundary, not the
// harness-side value in isolation.
const HARNESS_KSR_MAX_ROOT = 32 * 1024;
const HARNESS_KSR_MAX_PATH = 4 * 1024;

function spawnHelper(binary, input, paused, mutate) {
  const started = performance.now();
  return new Promise((resolveResult, reject) => {
    const stdio = paused ? ["pipe", "pipe", "pipe", "pipe", "pipe"] : ["pipe", "pipe", "pipe"];
    const child = spawn(binary, [], { stdio, env: {} });
    const stdout = [];
    const stderr = [];
    let mutationDenied = false;
    let mutationError;
    const deadline = setTimeout(() => child.kill("SIGKILL"), HELPER_DEADLINE_MS);
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    if (paused) {
      child.stdio[3].once("data", async (signal) => {
        try {
          assert.deepEqual(signal, Buffer.of(1));
          await mutate();
        } catch (error) {
          if (isWindows && ["EACCES", "EBUSY", "EPERM"].includes(error?.code))
            mutationDenied = true;
          else mutationError = error;
        }
        child.stdio[4].end(Buffer.of(1));
      });
    }
    child.once("error", (error) => {
      clearTimeout(deadline);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(deadline);
      if (mutationError !== undefined) return reject(mutationError);
      if (signal !== null) return reject(new Error("helper exceeded its execution deadline"));
      resolveResult({
        code,
        durationMs: performance.now() - started,
        mutationDenied,
        stderr: Buffer.concat(stderr),
        stdout: Buffer.concat(stdout),
      });
    });
    child.stdin.end(input);
  });
}

const run = (binary, input) => spawnHelper(binary, input, false);
const runPaused = (binary, input, mutate) => spawnHelper(binary, input, true, mutate);

function response(result) {
  assert.equal(result.code, 0);
  assert.ok(result.durationMs < HELPER_DEADLINE_MS);
  assert.equal(result.stderr.length, 0, "helper must never write stderr");
  assert.ok(result.stdout.length >= 12);
  assert.equal(result.stdout.subarray(0, 4).toString("ascii"), "KSS1");
  assert.equal(result.stdout.readUInt16LE(4), 1);
  const status = result.stdout.readUInt16LE(6);
  const length = result.stdout.readUInt32LE(8);
  assert.equal(result.stdout.length, 12 + length);
  if (status !== 0) assert.equal(length, 0, "failure must be content-free");
  return { content: result.stdout.subarray(12), status };
}

function assertSafeResult(result) {
  const decoded = response(result);
  assert.equal(decoded.status, 0);
  assert.equal(decoded.content.toString("utf8"), SAFE_TEXT);
}

async function compile(binary, paused = false) {
  const objectPath = join(dirname(binary), `${basename(binary)}.obj`);
  const args = isWindows
    ? [
        "/nologo",
        "/std:c11",
        "/W4",
        "/WX",
        "/O2",
        "/DUNICODE",
        "/D_UNICODE",
        "/D_CRT_SECURE_NO_WARNINGS",
        ...(paused ? ["/DKSR_TEST_PAUSE_AFTER_FINAL_OPEN"] : []),
        `/Fe:${binary}`,
        `/Fo:${objectPath}`,
        source,
        "/link",
        "ntdll.lib",
      ]
    : [
        "clang",
        "-std=c11",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-O2",
        "-D_DARWIN_C_SOURCE",
        ...(paused ? ["-DKSR_TEST_PAUSE_AFTER_FINAL_OPEN"] : []),
        "-o",
        binary,
        source,
      ];
  // Windows resolves the MSVC toolchain itself (shared lib, #3085): no workflow step persists
  // vcvars into the environment, and a bare "cl" is not reliably searched on options.env.PATH.
  const compileEnv = isWindows ? resolveWindowsMsvcEnv(process.env) : process.env;
  const compiler = isWindows ? windowsToolFromPath(compileEnv.PATH, "cl.exe") : "xcrun";
  await new Promise((resolveCompile, reject) => {
    const child = spawn(compiler, args, { env: compileEnv, stdio: ["ignore", "ignore", "pipe"] });
    const errors = [];
    child.stderr.on("data", (chunk) => errors.push(chunk));
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0
        ? resolveCompile()
        : reject(new Error(`native compile failed (${String(code)}): ${Buffer.concat(errors)}`)),
    );
  });
}

// KEIKO-0417: the 17 checks below used to run against RAW file text, so a security control that
// survived only as a `/* ... */` comment still satisfied `assert.match` and the deleted-but-
// documented behaviour passed as if it were live. Strip C block comments and line comments before
// matching. Two composition modes over the shared primitives in `../lib/c-source-scanner.mjs`:
//   - `stripCommentsAndStrings` blanks string literal bodies too — every assertion whose subject
//     is a code identifier uses this.
//   - `stripCommentsOnly` preserves string literals verbatim — the two assertions that observe
//     bytestrings inside `"..."` (WINDOWS_RESERVED_STEMS pass and `ascii_name_equals(...,
//     "GLOBALROOT")`) use this.
//
// Coderabbit 3793145636 on #3202: the earlier form duplicated the scanner primitives verbatim
// across this file and `native/runtime-supervisor/macos/test-protocol.mjs`, so a fix to one
// had to be applied to both in lockstep. Consolidated behind the shared module; only the
// composition helpers and the pin configuration stay local.
function stripCommentsAndStrings(rawSource) {
  return stripStringLiteralBodies(
    stripDisabledPreprocessorBranches(stripCComments(preprocessCLineSplices(rawSource))),
  );
}

function stripCommentsOnly(rawSource) {
  return stripDisabledPreprocessorBranches(stripCComments(preprocessCLineSplices(rawSource)));
}

async function assertWindowsSourceContract() {
  const rawSource = await readFile(source, "utf8");
  const nativeSource = stripCommentsAndStrings(rawSource);
  // Comments-only strip for the two assertions whose subject is a string-literal body inside
  // `"..."`. Reading the RAW source for those left a commented-out reserved-stem list or a
  // commented-out `ascii_name_equals(..., "GLOBALROOT")` invocation visible to the assertion,
  // which is precisely the regression the KEIKO-0417 rewrite exists to catch.
  const nativeSourceCommentsStripped = stripCommentsOnly(rawSource);
  assert.match(nativeSource, /GetFinalPathNameByHandleW\(root,/u);
  assert.match(nativeSource, /GetFinalPathNameByHandleW\(file,/u);
  assert.match(
    nativeSource,
    /before\.id\.VolumeSerialNumber != dirs\[0\]\.id\.VolumeSerialNumber/u,
  );
  assert.match(nativeSource, /OBJ_DONT_REPARSE/u);
  assert.match(nativeSource, /_write\(3, &byte, 1\).*_read\(4, &byte, 1\)/su);
  assert.match(nativeSource, /#include <fcntl\.h>.*#include <io\.h>/su);
  assert.match(
    nativeSource,
    /_setmode\(_fileno\(stdin\), _O_BINARY\).*_setmode\(_fileno\(stdout\), _O_BINARY\)/su,
  );
  assert.match(nativeSource, /if \(!binary_standard_io\(\)\) return 1;.*parse_request\(/su);
  for (const stem of WINDOWS_RESERVED_STEMS)
    assert.ok(nativeSourceCommentsStripped.includes(`"${stem}"`));
  // Assertions that embed CHARACTER literals (`'.'`, `':'`, `'?'`, `'~'`) must consume the
  // comments-only scan output: `stripCommentsAndStrings` blanks char literal bodies (so a
  // multi-character constant like `'CreateFileW('` cannot satisfy an assertion), which would
  // also blank the very literals these checks want to observe. Coderabbit 3792888545.
  assert.match(
    nativeSourceCommentsStripped,
    /while \(name_length < length && component\[name_length\] != '\.'\)/u,
  );
  assert.match(
    nativeSourceCommentsStripped,
    /ascii_name_equals\(component, name_length, "GLOBALROOT"\)/u,
  );
  assert.match(nativeSource, /windows_reserved_port_name\(component, name_length\)/u);
  assert.match(nativeSource, /bytes\[3\] == 0xc2/u);
  assert.match(nativeSource, /bytes\[4\] == 0xb9 \|\| bytes\[4\] == 0xb2 \|\| bytes\[4\] == 0xb3/u);
  assert.match(nativeSource, /_Static_assert\(sizeof\(KSR_SUPERSCRIPT_ONE_UTF8\) == 3/u);
  assert.doesNotMatch(nativeSource, /char name\[10\]/u);
  assert.match(nativeSourceCommentsStripped, /\*q == ':' \|\| \*q == '\?' \|\| \*q == '~'/u);
  assert.equal(nativeSource.match(/CreateFileW\(/gu)?.length, 1);

  assertCommentStrippingIsLoadBearing(rawSource);
  assertCommentsOnlyLeavesStringLiteralsIntact(rawSource);
}

// KEIKO-0417 negative self-test: proves stripCommentsAndStrings is load-bearing rather than
// decorative. Three mutations of the real source, each hiding a pinned security control in a
// different comment shape; every stripped scan must reject. A pre-fix scan of the same mutated
// text would still find the tokens (they sit inside the comments), so a passing assertion below
// is proof the stripping actively removed them.
//
// (a) `OBJ_CASE_INSENSITIVE | OBJ_DONT_REPARSE`'s use site moved into a `/* ... */` block.
// (b) The single `CreateFileW(` call moved into a `/* ... */` block.
// (c) `OBJ_DONT_REPARSE_LEAKED` hidden after a `\`-continued `//` line comment — proves the C
//     line-splicing preprocessor step. Without it, the physical newline terminates the `//` scan
//     and the following line is exposed as live code.
function assertCommentStrippingIsLoadBearing(rawSource) {
  const mutated = rawSource
    .replace(
      /OBJ_CASE_INSENSITIVE \| OBJ_DONT_REPARSE/u,
      "/* OBJ_CASE_INSENSITIVE | OBJ_DONT_REPARSE */ 0",
    )
    .replace(/CreateFileW\(/u, "/* CreateFileW( */ NopW(");
  const mutatedStripped = stripCommentsAndStrings(mutated);
  assert.equal(
    mutatedStripped.match(/OBJ_CASE_INSENSITIVE \| OBJ_DONT_REPARSE/u),
    null,
    "stripCommentsAndStrings must remove OBJ_DONT_REPARSE hidden in a block comment",
  );
  assert.equal(
    (mutatedStripped.match(/CreateFileW\(/gu) ?? []).length,
    0,
    "stripCommentsAndStrings must remove CreateFileW( hidden in a block comment",
  );
  const spliceMutated = "// disabled \\\nOBJ_DONT_REPARSE_LEAKED\nother_line();\n";
  const spliceStripped = stripCommentsAndStrings(spliceMutated);
  assert.equal(
    spliceStripped.match(/OBJ_DONT_REPARSE_LEAKED/u),
    null,
    "stripCommentsAndStrings must respect C `\\`-continued // line comments (splicing)",
  );
  // KEIKO-0417 (review-follow-up): unterminated `/* ... */` must throw. Both scanner modes share
  // the same walker, so exercising one covers both. A truncated source whose closing `*/` never
  // arrives would otherwise silently satisfy the source-contract regexes on the tokens BEFORE
  // the unclosed comment.
  assert.throws(
    () =>
      stripCommentsAndStrings(
        "CreateFileW(handle, GENERIC_READ, 0, NULL, OPEN_EXISTING, 0, NULL);\n/* opened but never closed\n",
      ),
    /unterminated C block comment/u,
    "stripCommentsAndStrings must throw on an unterminated /* ... */",
  );
  assert.throws(
    () => stripCommentsOnly("// prefix\n/* unclosed"),
    /unterminated C block comment/u,
    "stripCommentsOnly must throw on an unterminated /* ... */",
  );
  // Coderabbit 3793025301: unterminated char/string literals must throw for the same reason
  // block comments do — silently accepting them lets every token after the stray quote fall
  // off the scan, so a deleted control after the unclosed literal escapes the source contract.
  assert.throws(
    () => stripCommentsAndStrings("int f(void) { return '"),
    /unterminated C character constant/u,
    "unterminated char literal must throw",
  );
  assert.throws(
    () => stripCommentsAndStrings('int f(void) { return "'),
    /unterminated C string literal/u,
    "unterminated string literal must throw",
  );
  assertDisabledPreprocessorBranchesAreStripped();
}

// KEIKO-0417 (review-follow-up): a control retained only inside `#if 0 ... #endif` never
// compiles. The pre-pass strips those regions before comment/literal scanning so a deleted
// control wrapped in `#if 0` no longer satisfies the source-contract regexes. Nested
// `#if X ... #endif` inside the disabled block must count toward the balance; code after
// the outer `#endif` must survive.
function assertDisabledPreprocessorBranchesAreStripped() {
  assertBasicDisabledIfStrip();
  assertSplicedDisabledIfStrip();
  assertCommentedElseIsIgnored();
  assertMultilineCommentBeforeIfPreservesLines();
  assertDisabledIfVariants();
  assertCharLiteralHandling();
  assertElifBranchHandling();
}

// Codex 3792964066 + 3792986617 (#elif handling): the compiler picks exactly one branch of a
// `#if / #elif / #else / #endif` ladder. `#if 0` + `#elif 1` gives the elif branch as live;
// EVERY branch after the live one is dead. Broken up into helpers to stay under the
// max-lines-per-function ceiling.
function assertElifBranchHandling() {
  assertElifLiveBranchVisible();
  assertElifDisabledBranchStripped();
  assertBranchesAfterLiveElifStripped();
  assertLaterElifAfterLiveStripped();
}

function assertElifLiveBranchVisible() {
  const stripped = stripCommentsAndStrings(
    "int keep_before(void) { return 1; }\n" +
      "#if 0\nDEAD_BRANCH();\n#elif 1\nLIVE_BRANCH_TOKEN();\n#endif\n" +
      "int keep_after(void) { return 2; }\n",
  );
  assert.match(
    stripped,
    /LIVE_BRANCH_TOKEN/u,
    "outer-depth `#elif <non-zero>` must stop stripping so the live branch is visible to the scan",
  );
  assert.equal(
    stripped.match(/DEAD_BRANCH/u),
    null,
    "the disabled `#if 0` half before `#elif` must still be stripped",
  );
}

function assertElifDisabledBranchStripped() {
  const stripped = stripCommentsAndStrings(
    "#if 0\nA();\n#elif 0\nSHOULD_BE_STRIPPED_BY_ELIF_ZERO();\n#endif\nint live(void) { return 1; }\n",
  );
  assert.equal(
    stripped.match(/SHOULD_BE_STRIPPED_BY_ELIF_ZERO/u),
    null,
    "`#elif 0` at outer depth must keep stripping (its branch is deterministically dead)",
  );
}

function assertBranchesAfterLiveElifStripped() {
  const stripped = stripCommentsAndStrings(
    "int keep_before(void) { return 1; }\n" +
      "#if 0\nDEAD_A();\n" +
      "#elif 1\nLIVE_TOKEN();\n" +
      "#else\nDEAD_ELSE_TOKEN();\n" +
      "#endif\n" +
      "int keep_after(void) { return 2; }\n",
  );
  assert.match(stripped, /LIVE_TOKEN/u, "live `#elif 1` branch must be visible");
  assert.equal(
    stripped.match(/DEAD_A/u),
    null,
    "`#if 0` branch before a live `#elif` must be stripped",
  );
  assert.equal(
    stripped.match(/DEAD_ELSE_TOKEN/u),
    null,
    "`#else` after a live `#elif` must be stripped (the compiler picks exactly one branch)",
  );
}

function assertLaterElifAfterLiveStripped() {
  const stripped = stripCommentsAndStrings(
    "#if 0\nDEAD_A();\n" +
      "#elif 1\nLIVE_TOKEN2();\n" +
      "#elif SOMETHING\nDEAD_ELIF_TOKEN();\n" +
      "#endif\n",
  );
  assert.match(stripped, /LIVE_TOKEN2/u, "the first live `#elif` branch must be visible");
  assert.equal(
    stripped.match(/DEAD_ELIF_TOKEN/u),
    null,
    "any `#elif` after a live branch must be stripped",
  );
  assertNestedIfZeroInsideLiveElseStripped();
  assertNestedElseInsideDeadParentStripped();
  assertElifOneAfterUnknownExhausts();
  assertCompoundConstantTrueIf();
  assertParenthesizedConstantConditions();
  assertTrigraphIfZero();
}

// Codex 3793229696: `#if (0 && FEATURE)` and `#if 0 && defined(FEATURE)` are deterministically
// false but the per-directive regex used to stop at bare identifiers on the RHS and at a bare-
// zero paren pair (`(0)`). The scanner would retain those dead bodies, so a required control
// moved into one of these variants would still satisfy the positive assertion after the live
// control was deleted. Cover both new shapes plus the mirror TRUE forms so any future
// contributor sees the intent.
function assertParenthesizedConstantConditions() {
  const falseVariants = [
    "#if (0 && FEATURE)",
    "#if 0 && defined(FEATURE)",
    "#if (0 && defined(FEATURE))",
    "#if 0 && !defined(FEATURE)",
    "#if (0)",
  ];
  for (const variant of falseVariants) {
    const stripped = stripCommentsAndStrings(
      variant + "\nDEAD_PAREN_FALSE_BODY();\n#else\nLIVE_PAREN_FALSE_ELSE();\n#endif\n",
    );
    assert.equal(
      stripped.match(/DEAD_PAREN_FALSE_BODY/u),
      null,
      "parenthesized/`defined()` false form must strip its body: " + variant,
    );
    assert.match(
      stripped,
      /LIVE_PAREN_FALSE_ELSE/u,
      "`#else` after a false compound must survive: " + variant,
    );
  }
  const trueVariants = [
    "#if (1 || FEATURE)",
    "#if 1 || defined(FEATURE)",
    "#if (1 || defined(FEATURE))",
  ];
  for (const variant of trueVariants) {
    const stripped = stripCommentsAndStrings(
      variant + "\nLIVE_PAREN_TRUE_BODY();\n#else\nDEAD_PAREN_TRUE_ELSE();\n#endif\n",
    );
    assert.match(
      stripped,
      /LIVE_PAREN_TRUE_BODY/u,
      "parenthesized/`defined()` true form's body must survive: " + variant,
    );
    assert.equal(
      stripped.match(/DEAD_PAREN_TRUE_ELSE/u),
      null,
      "`#else` after a true compound must be stripped: " + variant,
    );
  }
}

// Codex 3793198453: `#if 1 || FEATURE` is deterministically true (C's `||` short-circuits on
// left=1). Track the ladder so the `#else` gets stripped.
function assertCompoundConstantTrueIf() {
  const stripped = stripCommentsAndStrings(
    "int keep_before(void) { return 1; }\n" +
      "#if 1 || FEATURE\n" +
      "LIVE_COMPOUND_TRUE_BODY();\n" +
      "#else\n" +
      "DEAD_ELSE_AFTER_COMPOUND_TRUE();\n" +
      "#endif\n" +
      "int keep_after(void) { return 2; }\n",
  );
  assert.match(stripped, /LIVE_COMPOUND_TRUE_BODY/u, "`#if 1 || FEATURE` body must survive");
  assert.equal(
    stripped.match(/DEAD_ELSE_AFTER_COMPOUND_TRUE/u),
    null,
    "`#else` after `#if 1 || FEATURE` must be stripped (compound is deterministically true)",
  );
  for (const variant of ["#if 1||FEATURE", "#if (1)||FEATURE", "#if 1L||!FLAG"]) {
    const s = stripCommentsAndStrings(variant + "\nLIVE();\n#else\nDEAD_VARIANT_ELSE();\n#endif\n");
    assert.equal(
      s.match(/DEAD_VARIANT_ELSE/u),
      null,
      "compound-true variant must strip the else-body: " + variant,
    );
  }
}

// Coderabbit 3793183804: `#elif 1` guarantees the ladder terminates before `#else` regardless
// of preceding `#elif <unknown>` branches. Either the unknown was true (its branch is picked)
// or false (this `#elif 1` is picked); in both cases the `#else` is dead.
function assertElifOneAfterUnknownExhausts() {
  const stripped = stripCommentsAndStrings(
    "#if 0\nDEAD_IF();\n" +
      "#elif FEATURE\nMAYBE_LIVE_ELIF_FEATURE();\n" +
      "#elif 1\nMAYBE_LIVE_ELIF_ONE();\n" +
      "#else\nDEAD_ELSE_AFTER_ELIF_ONE();\n" +
      "#endif\n",
  );
  assert.match(stripped, /MAYBE_LIVE_ELIF_FEATURE/u, "unknown `#elif` branch may still be live");
  assert.match(stripped, /MAYBE_LIVE_ELIF_ONE/u, "`#elif 1` branch may still be live");
  assert.equal(
    stripped.match(/DEAD_ELSE_AFTER_ELIF_ONE/u),
    null,
    "`#else` after `#elif 1` must be stripped — `#elif 1` exhausts the ladder even after an unknown predecessor",
  );
  assert.equal(stripped.match(/DEAD_IF/u), null, "the initial `#if 0` half must still be stripped");
}

// Coderabbit 3793183799: C11 trigraphs run in translation phase 1, before `\<newline>`
// splicing and preprocessing. `??=if 0` becomes `#if 0` after trigraph replacement. Ensure
// the scanner recognises that too.
function assertTrigraphIfZero() {
  const stripped = stripCommentsAndStrings(
    "int keep_before(void) { return 1; }\n" +
      "??=if 0\nDEAD_INSIDE_TRIGRAPH_IF();\n??=endif\n" +
      "int keep_after(void) { return 2; }\n",
  );
  assert.equal(
    stripped.match(/DEAD_INSIDE_TRIGRAPH_IF/u),
    null,
    "trigraph `??=if 0 ... ??=endif` must be stripped (`??=` converts to `#`)",
  );
  // `??/` converts to `\`, enabling line splicing on trigraph-continued lines.
  const spliceStripped = stripCommentsAndStrings(
    "// disabled ??/\nSHOULD_BE_STRIPPED_BY_TRIGRAPH_SPLICE();\n",
  );
  assert.equal(
    spliceStripped.match(/SHOULD_BE_STRIPPED_BY_TRIGRAPH_SPLICE/u),
    null,
    "trigraph `??/` at end of line must act as `\\` for line splicing",
  );
}

// Coderabbit 3793025299: nested `#if 0` inside a live `#elif`/`#else` branch must strip its
// body too. The single-frame model treated it as ordinary depth-tracking and let the dead
// nested body reach the source-contract assertions.
function assertNestedIfZeroInsideLiveElseStripped() {
  const stripped = stripCommentsAndStrings(
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
      "int keep_after(void) { return 2; }\n",
  );
  assert.match(
    stripped,
    /LIVE_BEFORE_NESTED/u,
    "live outer content BEFORE the nested `#if 0` must be visible",
  );
  assert.match(
    stripped,
    /LIVE_AFTER_NESTED/u,
    "live outer content AFTER the nested `#if 0` must be visible",
  );
  assert.equal(
    stripped.match(/NESTED_DEAD_TOKEN/u),
    null,
    "nested `#if 0` inside a live `#else` branch must have its body stripped",
  );
  assert.equal(
    stripped.match(/OUTER_DEAD/u),
    null,
    "the dead `#if 0` half of the outer ladder must still be stripped",
  );
}

// Codex 3793050405: the INVERSE nesting — a nested `#if 0` inside a STRIPPING parent's dead
// branch. Its own `#else` locally transitions to KEEPING mode, but the outer frame is still
// STRIPPING, so clang omits the whole outer branch including the inner `#else` body. Every
// frame on the stack must be KEEPING for a line to survive.
function assertNestedElseInsideDeadParentStripped() {
  const stripped = stripCommentsAndStrings(
    "int keep_before(void) { return 1; }\n" +
      "#if 0\n" +
      "#if 0\n" +
      "OUTER_DEAD_INNER_STRIPPING();\n" +
      "#else\n" +
      "NESTED_ELSE_INSIDE_DEAD_PIN();\n" +
      "#endif\n" +
      "#endif\n" +
      "int keep_after(void) { return 2; }\n",
  );
  assert.equal(
    stripped.match(/NESTED_ELSE_INSIDE_DEAD_PIN/u),
    null,
    "a nested `#else` INSIDE a dead outer `#if 0` branch must still be stripped (parent frame is STRIPPING)",
  );
  assert.equal(
    stripped.match(/OUTER_DEAD_INNER_STRIPPING/u),
    null,
    "the outer dead branch's own body must still be stripped",
  );
}

function assertBasicDisabledIfStrip() {
  const disabledIf = stripCommentsAndStrings(
    "int keep_before(void) { return 1; }\n" +
      "#if 0\nCreateFileW(bogus);\n#endif\n" +
      "int keep_after(void) { return 2; }\n",
  );
  assert.equal(
    disabledIf.match(/CreateFileW/u),
    null,
    "scanCSource must strip tokens inside `#if 0 ... #endif`",
  );
  const nestedIf = stripCommentsAndStrings(
    "int keep(void) { return 0; }\n" +
      "#if 0\n#if 1\nSHOULD_BE_STRIPPED();\n#endif\n#endif\n" +
      "int live(void) { return 1; }\n",
  );
  assert.equal(
    nestedIf.match(/SHOULD_BE_STRIPPED/u),
    null,
    "scanCSource must count nested `#if` inside a `#if 0` block",
  );
  assert.ok(
    nestedIf.includes("keep"),
    "code BEFORE the outer `#if 0 ... #endif` must survive the strip",
  );
  assert.ok(
    nestedIf.includes("live"),
    "code AFTER the outer `#if 0 ... #endif` must survive the strip",
  );
}

// KEIKO-0417 (review-follow-up on 7c976f77): a `\`-continued `#if \\\n0` splices to `#if 0`
// at C translation phase 2, before preprocessing. Proves the line-splice pre-pass runs FIRST.
function assertSplicedDisabledIfStrip() {
  const splicedDirective = stripCommentsAndStrings(
    "int keep_before(void) { return 1; }\n" +
      "#if \\\n0\nSHOULD_BE_STRIPPED_BY_SPLICED_IF();\n#endif\n" +
      "int keep_after(void) { return 2; }\n",
  );
  assert.equal(
    splicedDirective.match(/SHOULD_BE_STRIPPED_BY_SPLICED_IF/u),
    null,
    "line splicing must run BEFORE disabled-branch stripping so `#if \\\\\\n0` is recognised as `#if 0`",
  );
}

// KEIKO-0417 (review-follow-up on 44b9ef9b): a `#else` that lives ONLY inside a `/* */` block
// is invisible to the C preprocessor (translation phase 3 removes comments before phase 4
// interprets directives). Proves comment stripping runs BEFORE disabled-branch stripping.
function assertCommentedElseIsIgnored() {
  const commentedElse = stripCommentsAndStrings(
    "int keep(void) { return 1; }\n" +
      "#if 0\n" +
      "/* #else */\n" +
      "STILL_INSIDE_DISABLED_BRANCH();\n" +
      "#endif\n" +
      "int live(void) { return 2; }\n",
  );
  assert.equal(
    commentedElse.match(/STILL_INSIDE_DISABLED_BRANCH/u),
    null,
    "comment stripping must run BEFORE disabled-branch stripping so a `#else` inside `/* */` is not seen as a directive",
  );
}

// Coderabbit 3792888538: a multi-line block comment must be replaced with a same-length span of
// spaces AND newlines, so a `#if 0` directive on a line following the comment stays at
// line-start in the output.
function assertMultilineCommentBeforeIfPreservesLines() {
  const stripped = stripCommentsAndStrings(
    "int keep(void) { return 1; }\n" +
      "/* multi\n line \n block */\n" +
      "#if 0\n" +
      "SHOULD_BE_STRIPPED_AFTER_MULTILINE_COMMENT();\n" +
      "#endif\n",
  );
  assert.equal(
    stripped.match(/SHOULD_BE_STRIPPED_AFTER_MULTILINE_COMMENT/u),
    null,
    "block-comment stripping must preserve newlines so a following `#if 0` stays at line-start",
  );
}

// Coderabbit 3792888543: `#if (0)`, `#if 0L`, `#if (0U)` and integer-suffix variants are all
// constant-zero conditions the C preprocessor treats identically to `#if 0`.
// Codex 3792928022: `#if 0 && FEATURE` also short-circuits to 0 (C left-to-right `&&`), so a
// control wrapped in that composite form is likewise disabled and must be stripped.
// Coderabbit 3793183803: `#if 0&&FEATURE` (no whitespace around `&&`) is equally valid C.
function assertDisabledIfVariants() {
  const variants = [
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
    "#if 0&&FEATURE",
    "#if 0&&!FLAG",
    "#if (0)&&FEATURE",
  ];
  for (const variant of variants) {
    const stripped = stripCommentsAndStrings(
      `${variant}\nSHOULD_BE_STRIPPED_BY_DISABLED_IF_VARIANT();\n#endif\nint live(void) { return 1; }\n`,
    );
    assert.equal(
      stripped.match(/SHOULD_BE_STRIPPED_BY_DISABLED_IF_VARIANT/u),
      null,
      `disabled-if strip must recognise the constant-zero variant: ${variant}`,
    );
  }
}

// Coderabbit 3792888545: a multi-character constant `'CreateFileW('` must not satisfy the
// source-contract regex for `CreateFileW(`, and a `//` inside a char constant must not start a
// false line comment.
function assertCharLiteralHandling() {
  const charLiteralMultiChar = stripCommentsAndStrings(
    "int f(void) { return 'CreateFileW('; }\nint g(void) { return 1; }\n",
  );
  assert.equal(
    charLiteralMultiChar.match(/CreateFileW\(/u),
    null,
    "stripCommentsAndStrings must blank multi-character char-literal bodies",
  );
  const charLiteralWithSlashSlash = stripCComments(
    "int f(void) { return '//'; }\nOBJ_DONT_REPARSE_LIVE;\n",
  );
  assert.ok(
    charLiteralWithSlashSlash.includes("OBJ_DONT_REPARSE_LIVE"),
    "stripCComments must not treat `'//'` inside a char literal as a line-comment start",
  );
}

// KEIKO-0417 (review-follow-up): the two assertions that observe a bytestring inside `"..."`
// used to read the raw source, so a commented-out reserved-stem list or
// `ascii_name_equals(..., "GLOBALROOT")` invocation still satisfied them. `stripCommentsOnly`
// closes that gap without blanking the string literals they need to observe. This self-test
// proves it: mutate the real source to move `"GLOBALROOT"` inside a `/* ... */` block, run
// stripCommentsOnly, and assert both:
//   (1) the "GLOBALROOT" string literal that STILL lives outside comments is preserved (so
//       the reserved-stems assertion still works when the code is correct); and
//   (2) the extra commented-out `ascii_name_equals(..., "GLOBALROOT")` invocation we added is
//       NOT visible to the scan (so the ratchet has actually been strengthened).
function assertCommentsOnlyLeavesStringLiteralsIntact(rawSource) {
  const mutated =
    rawSource + '\n/* disabled: ascii_name_equals(component, name_length, "COMMENTED_STEM"); */\n';
  const scanned = stripCommentsOnly(mutated);
  assert.ok(
    scanned.includes('"GLOBALROOT"'),
    "stripCommentsOnly must preserve string literals so the reserved-stems check can see them",
  );
  assert.equal(
    scanned.match(/COMMENTED_STEM/u),
    null,
    'stripCommentsOnly must remove commented-out `ascii_name_equals(..., "…")` invocations',
  );
}

async function setupFixture(fixture, outside) {
  await mkdir(join(fixture, "nested"));
  await mkdir(join(outside, "outside-dir"));
  await writeFile(join(fixture, "nested", "good.txt"), SAFE_TEXT);
  await writeFile(join(fixture, "unicode.txt"), "Grüße 東京\n");
  await writeFile(join(fixture, "allowed-controls.txt"), "a\tb\r\n");
  await writeFile(join(fixture, "binary.txt"), Buffer.from([0x61, 0, 0x62]));
  await writeFile(join(fixture, "invalid-utf8.txt"), Buffer.from([0xc3, 0x28]));
  await writeFile(join(fixture, "c0.txt"), Buffer.from([0x61, 1, 0x62]));
  await writeFile(join(fixture, "c1.txt"), Buffer.from([0xc2, 0x80]));
  await writeFile(join(fixture, "exact.txt"), "x".repeat(65_536));
  await writeFile(join(fixture, "large.txt"), "x".repeat(65_537));
  await writeFile(join(fixture, "hard-source.txt"), "linked content");
  for (const name of WINDOWS_RESERVED_PREFIX_ALLOWED)
    await writeFile(join(fixture, name), SAFE_TEXT);
  await writeFile(join(outside, "outside.txt"), "outside\n");
  await writeFile(join(outside, "outside-dir", "outside.txt"), "outside\n");
  await symlink(
    join(outside, "outside-dir"),
    join(fixture, "linked"),
    isWindows ? "junction" : "dir",
  );
  await symlink(
    join(outside, isWindows ? "outside-dir" : "outside.txt"),
    join(fixture, "final-link.txt"),
    isWindows ? "junction" : "file",
  );
  await symlink(fixture, join(outside, "root-alias"), isWindows ? "junction" : "dir");
  await link(join(fixture, "hard-source.txt"), join(fixture, "hard-link.txt"));
  let deep = fixture;
  for (let index = 0; index < 65; index += 1) {
    deep = join(deep, `d${index}`);
    await mkdir(deep);
  }
  await writeFile(
    join(fixture, Array.from({ length: 63 }, (_, index) => `d${index}`).join("/"), "deep.txt"),
    "deep",
  );
  await writeFile(join(deep, "deep.txt"), "deep");
}

async function assertProtocolCases(binary, fixture, outside) {
  assertSafeResult(await run(binary, request(fixture, "nested/good.txt")));
  assert.equal(response(await run(binary, request(fixture, "unicode.txt"))).status, 0);
  assert.equal(response(await run(binary, request(fixture, "allowed-controls.txt"))).status, 0);
  for (const raw of [Buffer.alloc(0), Buffer.from("bad"), Buffer.alloc(20)]) {
    assert.equal(response(await run(binary, raw)).status, 1);
  }
  assert.equal(response(await run(binary, request(fixture, "../outside.txt"))).status, 3);
  assert.equal(response(await run(binary, request(fixture, "/absolute.txt"))).status, 3);
  assert.equal(
    response(await run(binary, request(fixture, String.raw`nested\good.txt`))).status,
    3,
  );
  assert.equal(response(await run(binary, request(fixture, "linked/outside.txt"))).status, 4);
  assert.equal(response(await run(binary, request(fixture, "final-link.txt"))).status, 4);
  assert.equal(
    response(await run(binary, request(join(outside, "root-alias"), "nested/good.txt"))).status,
    4,
  );
  assert.equal(response(await run(binary, request(fixture, "hard-link.txt"))).status, 5);
  assert.equal(response(await run(binary, request(fixture, "nested"))).status, isWindows ? 4 : 5);
  for (const name of ["binary.txt", "invalid-utf8.txt", "c0.txt", "c1.txt"]) {
    assert.equal(response(await run(binary, request(fixture, name))).status, 7);
  }
  assert.equal(response(await run(binary, request(fixture, "exact.txt"))).content.length, 65_536);
  assert.equal(response(await run(binary, request(fixture, "large.txt"))).status, 6);
  assert.equal(
    response(await run(binary, request(fixture, "nested/good.txt", { trailing: Buffer.of(1) })))
      .status,
    1,
  );
  assert.equal(
    response(await run(binary, request(fixture, "nested/good.txt", { cap: 1 }))).status,
    1,
  );
  const path64 = deepRelativePath(63);
  const path65 = deepRelativePath(64);
  assert.equal(response(await run(binary, request(fixture, path64))).status, 0);
  assert.equal(response(await run(binary, request(fixture, path65))).status, 3);
  if (isWindows) await assertWindowsPolicies(binary, fixture);
  else {
    assert.equal(response(await run(binary, request("/", "dev/null"))).status, 4);
    assert.equal(response(await run(binary, request("/dev", "null"))).status, 5);
  }

  await assertMalformedFrameGuards(binary, fixture);
  await assertSizeCapBoundaryProbes(binary, fixture);
}

// Codex 3793028202 on #3202: the over-cap probes on their own let a smaller C constant pass
// silently — an over-cap payload stays over-cap regardless of whether the cap is 4 KiB or
// 2 KiB. Pair each over-cap probe with an at-cap probe that expects a NON-malformed status;
// if the C constant drops, the at-cap payload becomes over-cap and the assertion trips. So the
// pair (at-cap accepted + over-cap rejected) pins the boundary rather than the harness value.
async function assertSizeCapBoundaryProbes(binary, fixture) {
  const prefix = isWindows ? "C:\\" : "/";
  const atCapRoot = Buffer.from(prefix + "x".repeat(HARNESS_KSR_MAX_ROOT - prefix.length), "utf8");
  const atCapPath = Buffer.from("x".repeat(HARNESS_KSR_MAX_PATH), "utf8");
  const cases = [
    {
      label: "rootLen == KSR_MAX_ROOT (at the boundary — must NOT reject as malformed)",
      frame: malformedRequest({ rootBytes: atCapRoot, pathBytes: Buffer.from("safe.txt") }),
    },
    {
      label: "pathLen == KSR_MAX_PATH (at the boundary — must NOT reject as malformed)",
      frame: malformedRequest({ root: fixture, pathBytes: atCapPath }),
    },
  ];
  for (const { label, frame } of cases) {
    const status = response(await run(binary, frame)).status;
    assert.notEqual(
      status,
      1,
      `expected non-malformed status for at-boundary case: ${label} (got ${String(status)}). ` +
        "If this trips after a change to KSR_MAX_ROOT/KSR_MAX_PATH, update HARNESS_KSR_MAX_ROOT/PATH to match.",
    );
  }
}

// KEIKO-0382: negative coverage for the frame-parser guards at the helper's trust boundary. Each
// case pins one guard by constructing a frame the helper must reject with status 1
// (KSR_MALFORMED_REQUEST). Kept platform-agnostic and run for every configuration — the parser is
// the same on every platform. Split by axis so no one builder function crosses the 50-line ceiling.
function frameLengthMismatchCases(fixture, pathBytes) {
  // Note: dedicated "declared rootLen/pathLen exceeds supplied bytes" probes used to sit here too,
  // but codex 3792928019 on #3202 correctly observed they cannot isolate the two
  // `fread(...) != declared_length` guards. Overstating rootLen by 1 consumes the first byte of
  // pathBytes; the subsequent path fread returns pathBytes.length - 1 bytes; the trailing byte
  // of the calloc'd path buffer is `\0`; and `memchr(out->path, 0, declaredPathLen)` rejects at
  // the same status 1. Overstating pathLen has the mirror effect: calloc leaves a trailing `\0`
  // that memchr catches. Both probes therefore pass with or without the fread-length guards.
  // Not reframed because inputs that TRULY isolate those guards would need instrumented builds
  // (or a distinguishable status enum); left out rather than misleadingly claiming to pin them.
  //
  // Note: zero-length root and zero-length path used to be listed here as separate cases, but
  // codex 3792824428 on #3202 correctly observed they cannot isolate the early `root_len == 0`
  // / `path_len == 0` guards — removing either check leaves the request to be rejected by the
  // downstream `valid_root("")` / `valid_path("")` at the same status 1, so the probes would
  // pass with or without the guard they claim to pin. Coverage of "empty is rejected" is
  // already provided by the interaction between the length fields and the downstream validators;
  // dedicated zero-length probes would only document overlapping behaviour, not isolate a
  // unique boundary. Kept out rather than reframed to avoid misleading a reader into believing
  // the pre-check is what fires.
  return [
    // Size cap breaches: proves the constants are actually enforced, not just declared. Each
    // root retains its platform's valid absolute-root prefix (`/` on POSIX, `<letter>:\` on
    // Windows) so that `valid_root` would NOT reject it if the size cap were removed. A pre-
    // fix version of this case used `"x".repeat(...)`, whose first byte `valid_root` rejects
    // on both platforms — so the test tripped on the wrong guard and would still pass if the
    // `root_len > KSR_MAX_ROOT` check were deleted (KEIKO-0382 review-follow-up).
    {
      label: "rootLen > KSR_MAX_ROOT (with valid absolute prefix, so only the size cap can reject)",
      frame: malformedRequest({ rootBytes: overCapRootBytes(), pathBytes }),
    },
    {
      label: "pathLen > KSR_MAX_PATH",
      frame: malformedRequest({
        root: fixture,
        pathBytes: Buffer.from("x".repeat(HARNESS_KSR_MAX_PATH + 1), "utf8"),
      }),
    },
  ];
}

// The valid-root prefix for the over-cap root probe. Built at call time so `isWindows` is honoured
// at run time, not module import time. Plain double-quoted string (not a template literal) — the
// Windows prefix ends in `\`, which in a template literal `` `C:\` `` would escape the closing
// backtick and swallow the rest of the file into an unterminated template.
function overCapRootBytes() {
  const prefix = isWindows ? "C:\\" : "/";
  const padded = prefix + "x".repeat(HARNESS_KSR_MAX_ROOT + 1 - prefix.length);
  return Buffer.from(padded, "utf8");
}

function frameHeaderShapeCases(fixture, pathBytes) {
  return [
    // Reserved half-word must be zero. Confirmed never set on any well-formed frame today; a
    // non-zero value is a forward-compatibility violation and must fail closed.
    {
      label: "non-zero reserved u16",
      frame: malformedRequest({ root: fixture, pathBytes, reserved: 1 }),
    },
    // Wrong protocol version.
    { label: "version != 1", frame: malformedRequest({ root: fixture, pathBytes, version: 2 }) },
  ];
}

function frameByteValidationCases(fixture, rootBytes, pathBytes) {
  // Note: dedicated NUL-byte probes for both root and path used to sit here, but codex 3792855835
  // on #3202 observed they cannot isolate the `memchr(..., 0, ...)` guards — `valid_utf8`
  // (secure_workspace_read.c line 48: `if (cp == 0 || ...) return 0`) independently rejects code
  // point zero, so removing either `memchr` check leaves the request rejected by the UTF-8 check
  // at the same status 1. Coverage of "NUL is rejected" is already provided by that downstream
  // interaction; keeping dedicated probes would only misleadingly document a pin they do not
  // actually isolate. The invalid-UTF-8 cases below DO isolate `valid_utf8` (the sequence
  // `0xc3, 0x28` contains no NUL, so `memchr` would not reject it — only the UTF-8 continuation
  // check does). Note preserved so a future contributor does not re-add the false pins.
  return [
    {
      label: "path is invalid UTF-8 (isolates valid_utf8; no NUL, so memchr would pass)",
      frame: malformedRequest({ root: fixture, pathBytes: Buffer.of(0xc3, 0x28) }),
    },
    {
      label: "root is invalid UTF-8 (isolates valid_utf8; no NUL, so memchr would pass)",
      frame: malformedRequest({
        rootBytes: Buffer.concat([rootBytes, Buffer.of(0xc3, 0x28)]),
        pathBytes,
      }),
    },
  ];
}

function buildMalformedFrameCases(fixture) {
  const rootBytes = Buffer.from(fixture, "utf8");
  const pathBytes = Buffer.from("nested/good.txt", "utf8");
  return [
    ...frameLengthMismatchCases(fixture, pathBytes),
    ...frameHeaderShapeCases(fixture, pathBytes),
    ...frameByteValidationCases(fixture, rootBytes, pathBytes),
  ];
}

async function assertMalformedFrameGuards(binary, fixture) {
  for (const { label, frame } of buildMalformedFrameCases(fixture)) {
    const status = response(await run(binary, frame)).status;
    assert.equal(status, 1, `expected status 1 (malformed) for: ${label}, got ${String(status)}`);
  }
}

function deepRelativePath(directoryCount) {
  const directories = Array.from({ length: directoryCount }, (_, index) => `d${index}`);
  return `${directories.join("/")}/deep.txt`;
}

async function assertWindowsPolicies(binary, fixture) {
  for (const denied of WINDOWS_RESERVED_DENIED) {
    assert.equal(
      response(await run(binary, request(fixture, denied))).status,
      3,
      `Windows reserved-name policy mismatch for ${JSON.stringify(denied)}`,
    );
  }
  for (const allowed of WINDOWS_RESERVED_PREFIX_ALLOWED) {
    assert.equal(
      response(await run(binary, request(fixture, allowed))).status,
      0,
      `Windows reserved-name prefix was over-rejected: ${JSON.stringify(allowed)}`,
    );
  }
  for (const denied of ["nested/good.txt:stream", "name?", "name.", "name ", "PROGRA~1"]) {
    assert.equal(
      response(await run(binary, request(fixture, denied))).status,
      3,
      `Windows path policy mismatch for ${JSON.stringify(denied)}`,
    );
  }
  for (const invalidRoot of ["C:relative", String.raw`\\server\share`, "relative"]) {
    assert.equal(
      response(await run(binary, request(invalidRoot, "safe.txt"))).status,
      1,
      `Windows root policy mismatch for ${JSON.stringify(invalidRoot)}`,
    );
  }
}

function assertRaceResult(result, label) {
  const decoded = response(result);
  assert.ok(
    [0, 6, 8].includes(decoded.status),
    `${label}: unexpected race status ${decoded.status}`,
  );
  if (decoded.status === 0)
    assert.equal(decoded.content.toString("utf8"), SAFE_TEXT, `${label}: unsafe content`);
  return decoded;
}

async function resetRaceFile(fixture) {
  await writeFile(join(fixture, "nested", "race.txt"), SAFE_TEXT);
}

async function assertAdversarialRaces(binary, fixture) {
  const nested = join(fixture, "nested");
  const target = join(nested, "race.txt");
  const moved = join(fixture, "moved-nested");
  const race = (mutate) => runPaused(binary, request(fixture, "nested/race.txt"), mutate);
  await resetRaceFile(fixture);
  assertRaceResult(await race(() => writeFile(target, "evil text\n")), "in-place rewrite");
  await resetRaceFile(fixture);
  assertRaceResult(await race(() => writeFile(target, "x".repeat(65_537))), "size growth");
  await resetRaceFile(fixture);
  const replacementResult = await race(async () => {
    const replacement = join(fixture, "replacement.txt");
    await writeFile(replacement, "replacement\n");
    await rename(replacement, target);
  });
  const replacementResponse = assertRaceResult(replacementResult, "replacement");
  if (replacementResult.mutationDenied)
    assert.equal(
      replacementResponse.status,
      8,
      "replacement: root mutation before denied target rename must close",
    );
  await resetRaceFile(fixture);
  assertRaceResult(
    await race(async () => {
      await rename(nested, moved);
      await rename(moved, nested);
    }),
    "ancestor rename round trip",
  );
  await resetRaceFile(fixture);
  let movedAway = false;
  try {
    assertRaceResult(
      await race(async () => {
        await rename(nested, moved);
        movedAway = true;
        await mkdir(nested);
        await writeFile(target, "replacement\n");
      }),
      "ancestor substitution",
    );
  } finally {
    if (movedAway) {
      await rm(nested, { recursive: true, force: true });
      await rename(moved, nested);
    }
  }
}

function isSharingDenied(error) {
  return isWindows && ["EACCES", "EBUSY", "EPERM"].includes(error?.code);
}

async function restoreRename(sourcePath, destinationPath) {
  let lastError;
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try {
      await rename(sourcePath, destinationPath);
      return;
    } catch (error) {
      if (!isSharingDenied(error)) throw error;
      lastError = error;
      await delay(5);
    }
  }
  throw lastError;
}

async function runConcurrentUpdater(label, update, read) {
  let active = true;
  let readsStarted = false;
  let attempts = 0;
  let postSpawnAttempts = 0;
  let sharingDenied = 0;
  let updaterError;
  let notifyStarted;
  const started = new Promise((resolveStarted) => {
    notifyStarted = resolveStarted;
  });
  const updater = (async () => {
    try {
      while (active) {
        attempts += 1;
        if (readsStarted) postSpawnAttempts += 1;
        try {
          await update(attempts);
        } catch (error) {
          if (isSharingDenied(error)) sharingDenied += 1;
          else throw error;
        } finally {
          notifyStarted();
        }
        await nextTurn();
      }
    } catch (error) {
      updaterError = error;
      active = false;
      notifyStarted();
    }
  })();
  await started;
  if (updaterError !== undefined) throw updaterError;
  readsStarted = true;
  try {
    await Promise.all(Array.from({ length: CONCURRENT_CONSISTENCY_READS }, read));
  } finally {
    readsStarted = false;
    active = false;
    await updater;
  }
  if (updaterError !== undefined) throw updaterError;
  assert.ok(postSpawnAttempts > 0, `${label} updater made no post-spawn attempt`);
  console.log(
    `secure-workspace-read consistency: case=${label} reads=${CONCURRENT_CONSISTENCY_READS} attempts=${attempts} postSpawnAttempts=${postSpawnAttempts} sharingDenied=${sharingDenied}`,
  );
}

// KEIKO-0446: returns whether this read actually observed a known generation, so the caller can
// require that at least one did. It used to return void on every non-zero status, which made the
// whole suite vacuous — see the liveness assertion in assertFileGenerationConsistency.
function assertKnownGeneration(result, generations) {
  const decoded = response(result);
  if (decoded.status !== 0) return false;
  assert.ok(
    generations.some((generation) => decoded.content.equals(generation)),
    "successful concurrent read returned external, partial, or mixed bytes",
  );
  return true;
}

async function assertFileGenerationConsistency(binary, fixture) {
  const target = join(fixture, "concurrent-generation.txt");
  const generations = [
    Buffer.from(`${"a".repeat(2_584)}\n`),
    Buffer.from(`${"b".repeat(32_767)}\n`),
  ];
  await writeFile(target, generations[0]);
  // KEIKO-0446: every non-zero status was silently accepted, and nothing required a single read to
  // succeed. A helper that answered KSR_ACCESS_DENIED (or CHANGED_DURING_READ, or MALFORMED) to all
  // 32 reads passed this suite unchanged — the suite proved only "no read returned WRONG bytes",
  // never "reads work". The target here is a plain regular file inside the fixture root, only ever
  // replaced atomically by rename, so a correct helper must succeed on a substantial fraction.
  let successfulReads = 0;
  await runConcurrentUpdater(
    "file-generation",
    async (attempt) => {
      const staged = join(fixture, `.concurrent-generation-${attempt}.tmp`);
      await writeFile(staged, generations[attempt % generations.length]);
      try {
        await rename(staged, target);
      } finally {
        await rm(staged, { force: true });
      }
    },
    async () => {
      if (
        assertKnownGeneration(
          await run(binary, request(fixture, "concurrent-generation.txt")),
          generations,
        )
      ) {
        successfulReads += 1;
      }
    },
  );
  assert.ok(
    successfulReads > 0,
    `file-generation consistency: none of the ${String(CONCURRENT_CONSISTENCY_READS)} concurrent ` +
      "reads observed a known generation — a helper that fails closed under all contention would " +
      "satisfy every other assertion in this suite",
  );
}

async function assertAncestorAliasConsistency(binary, fixture, outside) {
  const parent = join(fixture, "concurrent-parent");
  const parked = join(fixture, ".concurrent-parent-parked");
  const alias = join(fixture, ".concurrent-parent-alias");
  const outsideParent = join(outside, "concurrent-parent");
  await mkdir(parent);
  await mkdir(outsideParent);
  await writeFile(join(parent, "generation.txt"), SAFE_TEXT);
  await writeFile(join(outsideParent, "generation.txt"), "external bytes\n");
  await symlink(outsideParent, alias, isWindows ? "junction" : "dir");
  try {
    await runConcurrentUpdater(
      "ancestor-alias",
      async () => {
        let aliasInstalled = false;
        await rename(parent, parked);
        try {
          await rename(alias, parent);
          aliasInstalled = true;
          try {
            await nextTurn();
          } finally {
            await restoreRename(parent, alias);
            aliasInstalled = false;
          }
        } finally {
          if (!aliasInstalled) await restoreRename(parked, parent);
        }
      },
      async () => {
        assertKnownGeneration(
          await run(binary, request(fixture, "concurrent-parent/generation.txt")),
          [Buffer.from(SAFE_TEXT)],
        );
      },
    );
  } finally {
    await rm(alias, { force: true });
  }
}

async function assertExternalBinaryConsistency(binary, fixture, outside) {
  await assertFileGenerationConsistency(binary, fixture);
  await assertAncestorAliasConsistency(binary, fixture, outside);
}

async function stableResourceCount() {
  const samples = [];
  for (let index = 0; index < 7; index += 1) {
    if (isWindows) samples.push(await windowsHandleCount());
    else samples.push((await readdir("/dev/fd")).length);
  }
  samples.sort((left, right) => left - right);
  return samples[Math.floor(samples.length / 2)];
}

async function windowsHandleCount() {
  const powershell = String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`;
  return new Promise((resolveCount, reject) => {
    const child = spawn(
      powershell,
      ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${process.pid}).HandleCount`],
      { env: {}, stdio: ["ignore", "pipe", "ignore"] },
    );
    const output = [];
    child.stdout.on("data", (chunk) => output.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      const count = Number(Buffer.concat(output).toString("ascii").trim());
      if (code === 0 && Number.isSafeInteger(count)) resolveCount(count);
      else reject(new Error("resource probe failed"));
    });
  });
}

async function assertLoadEvidence(binary, fixture) {
  const frame = request(fixture, "nested/good.txt");
  assertSafeResult(await run(binary, frame));
  const before = await stableResourceCount();
  const durations = [];
  for (let index = 0; index < 1_000; index += 1) {
    const result = await run(binary, frame);
    assertSafeResult(result);
    durations.push(result.durationMs);
  }
  durations.sort((left, right) => left - right);
  const p95Ms = durations[Math.ceil(durations.length * 0.95) - 1];
  assert.ok(p95Ms <= 500, `sequential p95 exceeded 500ms: ${p95Ms.toFixed(1)}ms`);
  const started = performance.now();
  const concurrent = await Promise.all(Array.from({ length: 100 }, () => run(binary, frame)));
  const batchMs = performance.now() - started;
  concurrent.forEach(assertSafeResult);
  assert.ok(batchMs <= 10_000, `concurrent batch exceeded 10s: ${batchMs.toFixed(1)}ms`);
  const after = await stableResourceCount();
  assert.equal(after, before, "helper load test leaked parent resources");
  console.log(
    `secure-workspace-read load: sequential=1000 p95Ms=${p95Ms.toFixed(1)} concurrent=100 batchMs=${batchMs.toFixed(1)} resourceDelta=0`,
  );
}

function existingBinaryArgument(argv) {
  if (argv.length === 0) return undefined;
  if (argv.length !== 2 || argv[0] !== "--binary" || argv[1].length === 0)
    throw new Error("usage: test-protocol.mjs [--binary <existing-helper>]");
  return resolve(argv[1]);
}

if (!isWindows && process.platform !== "darwin") {
  throw new Error("secure-workspace-read executable harness supports only Windows and macOS");
}

const externalBinary = existingBinaryArgument(process.argv.slice(2));
const externalBinaryBytes =
  externalBinary === undefined ? undefined : await readFile(externalBinary);
let binaryRoot;
let fixture;
let outside;
try {
  binaryRoot = externalBinary === undefined ? await mkdtemp(join(tmpdir(), "ksr-bin-")) : undefined;
  fixture = await mkdtemp(join(tmpdir(), "ksr-fixture-"));
  outside = await mkdtemp(join(tmpdir(), "ksr-outside-"));
  const binary =
    externalBinary ??
    join(binaryRoot, isWindows ? "secure-workspace-read.exe" : "secure-workspace-read");
  const pausedBinaryName = isWindows
    ? "secure-workspace-read-paused.exe"
    : "secure-workspace-read-paused";
  const pausedBinary = binaryRoot === undefined ? undefined : join(binaryRoot, pausedBinaryName);
  await assertWindowsSourceContract();
  if (externalBinary === undefined) {
    await compile(binary);
    await compile(pausedBinary, true);
  }
  await setupFixture(fixture, outside);
  await assertProtocolCases(binary, fixture, outside);
  // Signed --binary runs protocol, live fixture consistency, and load checks against the exact
  // supplied bytes. Deterministically paused races require the compile-mode test companion.
  if (pausedBinary !== undefined) await assertAdversarialRaces(pausedBinary, fixture);
  if (externalBinary !== undefined) await assertExternalBinaryConsistency(binary, fixture, outside);
  await assertLoadEvidence(binary, fixture);
  if (externalBinaryBytes !== undefined)
    assert.deepEqual(
      await readFile(binary),
      externalBinaryBytes,
      "harness modified supplied binary",
    );
  console.log(`secure-workspace-read protocol tests: PASS (${basename(binary)})`);
} finally {
  if (fixture !== undefined) await rm(fixture, { recursive: true, force: true });
  if (outside !== undefined) await rm(outside, { recursive: true, force: true });
  if (binaryRoot !== undefined) await rm(binaryRoot, { recursive: true, force: true });
}
