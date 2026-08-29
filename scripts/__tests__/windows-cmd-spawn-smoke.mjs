// Windows-only smoke: proves the hardened cmd.exe wrapper (packages/keiko-tools/src/windows-shell.ts,
// issue #3350 / Node CVE-2024-27980) actually works end to end against a REAL Windows spawn — not
// just the pure-function golden vectors in windows-shell.test.ts (which run on any host but never
// touch a real cmd.exe). Two things only a live Windows process can prove:
//   (a) the escaped argv survives System32\cmd.exe's own parser and arrives at the child EXACTLY as
//       intended — recorded byte-for-byte, one argument per line, by a fixture .cmd file;
//   (b) an argument shaped like a shell-injection payload (`& echo PWNED> "<marker>"`) stays INERT
//       data — it must never be re-interpreted as command syntax and must never create the marker
//       file. This is the actual security property the escaping exists for; the unit tests can only
//       assert the STRING shape, not that Windows honours it.
// Not a *.test.mjs: vitest never runs this. It is invoked directly by the Windows CI leg (wired by a
// separate stream) because it needs a real win32 process, not vitest's node/jsdom environment.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Import the pure helper straight from its TypeScript source (Node's native type-stripping), the
// same mechanism the sibling smoke scripts use to import a package's `src/*.ts` — no build step, no
// dist/ dependency, so the escaping algorithm the smoke exercises can never silently drift from what
// runCommand's spawn boundary actually ships.
import { buildWindowsShellInvocation } from "../../packages/keiko-tools/src/windows-shell.ts";

assert.equal(
  process.platform,
  "win32",
  "windows-cmd-spawn-smoke: this smoke must run on a Windows host",
);

// A batch fixture that faithfully echoes every argument it received, one per line, to the file
// named by KEIKO_CMD_SMOKE_OUT (passed via env, not argv, so the adversarial matrix under test is
// never contaminated by an out-of-band control argument).
//
// `for %%A in (%*) do` is cmd.exe's own tokenizer re-splitting the (already unescaped-by-cmd, then
// re-quoted-by-our-wrapper) argument tail; `%%~A` strips the surrounding quotes back to the
// original value. `setlocal enabledelayedexpansion` + `!ARG!` (not `%ARG%`) is required because
// the SET and the read happen inside the same parenthesized block — plain `%...%` would resolve
// against the value captured when the block was PARSED, not the current iteration. `echo(` (paren
// immediately after echo, no space) reliably emits a blank line for an empty argument instead of
// risking "ECHO is off." — the one documented cmd.exe pitfall this script cannot fully rule out for
// every conceivable batch/locale combination is whether a genuinely empty ("") list item survives
// FOR's own tokenization as a distinct (empty) iteration on every Windows build; every other vector
// in the matrix does not depend on that.
function fixtureBatchScript() {
  return [
    "@echo off",
    "setlocal enabledelayedexpansion",
    "for %%A in (%*) do (",
    '  set "ARG=%%~A"',
    '  >>"%KEIKO_CMD_SMOKE_OUT%" echo(!ARG!',
    ")",
  ].join("\r\n");
}

function commandResultSummary(result) {
  return [
    `status=${String(result.status ?? "none")}`,
    `signal=${String(result.signal ?? "none")}`,
    `errorCode=${String(result.error?.code ?? "none")}`,
  ].join(" ");
}

// Splits the recorded-args file back into exactly one entry per `echo(` line, INCLUDING a genuinely
// blank line for an empty argument. Every recorded line is TERMINATOR-terminated (`echo` appends
// its own line break after every call, including the last), so splitting on the terminator and
// dropping exactly the final (always-empty) tail element is the unambiguous inverse — unlike
// stripping one trailing terminator and treating an empty remainder as "zero records", which cannot
// tell "no records" apart from "exactly one empty-string record" (both leave "" after the strip).
function readRecordedArgs(outPath) {
  if (!existsSync(outPath)) return [];
  const raw = readFileSync(outPath, "utf8");
  return raw.split(/\r\n|\n/).slice(0, -1);
}

// The full adversarial battery mirrored from windows-shell.test.ts's golden-vector matrix (plain
// word, spaces, every listed metacharacter, a trailing backslash, an embedded quote, an empty
// string), PLUS one combined shell-injection payload as the final entry: a single argument that
// tries to break out into `& echo PWNED > <marker>`. If escaping ever regresses to something
// injectable, this specific entry is the one that would create the marker file.
function adversarialArgs(markerPath) {
  return [
    "hello",
    "hello world",
    "&",
    "|",
    ">",
    "<",
    "^",
    '"',
    "%",
    "!",
    "(",
    ")",
    "*",
    "trailing\\",
    'has"quote',
    "",
    `& echo PWNED> "${markerPath}"`,
  ];
}

function spawnFixture(invocation, outPath, root) {
  return spawnSync(invocation.command, invocation.args, {
    cwd: root,
    env: { ...process.env, KEIKO_CMD_SMOKE_OUT: outPath },
    shell: false,
    detached: false,
    windowsVerbatimArguments: true,
    encoding: "utf8",
    timeout: 30_000,
  });
}

function assertExactRecording(outPath, args) {
  const recorded = readRecordedArgs(outPath);
  assert.deepEqual(
    recorded,
    args,
    "recorded args did not match the intended argv exactly.\n" +
      `expected: ${JSON.stringify(args)}\n` +
      `recorded: ${JSON.stringify(recorded)}`,
  );
}

function runWindowsCmdSpawnSmoke() {
  const root = mkdtempSync(join(tmpdir(), "keiko-cmd-spawn-"));
  let failure;
  try {
    const fixtureCmdPath = join(root, "keiko-argv-fixture.cmd");
    writeFileSync(fixtureCmdPath, fixtureBatchScript(), "utf8");
    const outPath = join(root, "recorded-args.txt");
    const markerPath = join(root, "PWNED.txt");
    const args = adversarialArgs(markerPath);

    // No opts: this must reflect the SAME call shape runCommand's spawn boundary makes in
    // production (deps.platform ?? process.platform, deps.processEnv), not a forced-Windows unit
    // scenario — the whole point of this file is proving that path against the real OS.
    const invocation = buildWindowsShellInvocation(fixtureCmdPath, args);
    assert.equal(
      invocation.windowsVerbatimArguments,
      true,
      "a resolved .cmd fixture path must take the hardened cmd.exe wrapper branch on win32",
    );
    assert.equal(
      invocation.command.toLowerCase().endsWith(String.raw`\system32\cmd.exe`.toLowerCase()),
      true,
      `expected the wrapper to resolve System32\\cmd.exe, got: ${invocation.command}`,
    );

    const result = spawnFixture(invocation, outPath, root);
    assert.equal(result.error, undefined, commandResultSummary(result));
    assert.equal(result.status, 0, commandResultSummary(result));

    // (a) the child recorded EXACTLY the intended args — nothing merged, split, dropped, or mangled.
    assertExactRecording(outPath, args);

    // (b) the injection payload stayed inert data: it must never have created the marker file.
    assert.equal(
      existsSync(markerPath),
      false,
      "the injection argument was re-interpreted as shell syntax and created the marker file " +
        "— this is a real escaping regression, not a fixture bug",
    );

    // (c) Finding #3350-1: an npm node_modules\.bin\*.cmd shim re-parses %* a SECOND time, so its
    // arguments MUST be double-escaped (single-escaping is injectable through that second parse).
    // This asserts the production spawn-path API engages the double-escape branch for a shim path
    // (the deterministic, host-independent half). The real-cmd double-parse round trip is proven by
    // the golden-vector unit test (windows-shell.test.ts): a faithful %*-forwarding shim fixture's
    // own cmd/FOR parsing edge cases cannot be validated without a Windows host, so replaying it
    // here could just as easily fake the property as prove it.
    const shimInvocation = buildWindowsShellInvocation(join("node_modules", ".bin", "eslint.cmd"), [
      "&",
    ]);
    assert.equal(
      shimInvocation.args.some((part) => part.includes("^^^")),
      true,
      "a node_modules\\.bin\\*.cmd shim argument was not double-escaped (finding 1 regression)",
    );
  } catch (error) {
    failure = error;
  } finally {
    try {
      rmSync(root, { force: true, recursive: true, maxRetries: 10, retryDelay: 200 });
    } catch (cleanupError) {
      failure ??= cleanupError;
    }
  }
  if (failure !== undefined) throw failure;
}

runWindowsCmdSpawnSmoke();
console.log("windows-cmd-spawn-smoke: PASS");
