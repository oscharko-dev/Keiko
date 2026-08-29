// Windows-only smoke: proves the hardened cmd.exe wrapper (packages/keiko-tools/src/windows-shell.ts,
// issue #3350 / Node CVE-2024-27980) works end to end against a REAL Windows spawn — not just the
// pure-function golden vectors in windows-shell.test.ts (which run on any host but never touch a
// real cmd.exe). Two things only a live Windows process can prove:
//   (a) the escaped argument line SURVIVES System32\cmd.exe's own parser — every metacharacter is
//       caret-protected so cmd never treats it as command syntax, so a benign target .cmd runs and
//       exits 0 rather than the line breaking into a parse error;
//   (b) an argument shaped like a shell-injection payload (`& echo … > marker`) stays INERT data —
//       it must NEVER be re-interpreted as a command separator and must NEVER create the marker.
//       This is the actual security property the escaping exists for; the unit tests assert the
//       STRING shape, only a live cmd.exe proves Windows honours it.
//
// It deliberately does NOT try to record the child's exact argv back out of a batch script: faithful
// argv recording in cmd.exe is intractable for adversarial inputs (%* re-tokenizes; `!` re-expands
// under delayed expansion; embedded quotes break FOR/IF), and a fragile recorder would fail for
// fixture reasons unrelated to the production escaping. Exact byte-for-byte argv fidelity across the
// full adversarial matrix is proven deterministically, on every host, by windows-shell.test.ts's
// golden vectors; this smoke proves the two things those vectors cannot: real-cmd parseability and
// real-cmd injection-inertness.
//
// Not a *.test.mjs: vitest never runs this. It is invoked directly by the Windows CI leg because it
// needs a real win32 process, not vitest's node/jsdom environment.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

// A benign target: it IGNORES its arguments entirely (no %*, no FOR, no delayed expansion), records
// only that it ran, and exits 0. Nothing about a passed argument can make this script itself fail —
// so a non-zero exit means cmd.exe choked on the escaped LINE (an under-escaped metacharacter), and
// the injection marker is created only if a `&`/`|` in an argument broke out of the `cmd /c "…"`
// wrapper BEFORE this script ever ran. Both are production-escaping regressions, not fixture bugs.
function fixtureBatchScript() {
  return ["@echo off", '>"%KEIKO_CMD_SMOKE_RAN%" echo ran', "exit /b 0"].join("\r\n");
}

function commandResultSummary(result) {
  return [
    `status=${String(result.status ?? "none")}`,
    `signal=${String(result.signal ?? "none")}`,
    `errorCode=${String(result.error?.code ?? "none")}`,
  ].join(" ");
}

// The full adversarial battery from windows-shell.test.ts's golden-vector matrix — plain word,
// spaces, every listed metacharacter, a trailing backslash, an embedded quote, an empty string.
// Passed all at once: each must be caret-escaped so cmd.exe parses the whole line as literal
// arguments to the (argument-ignoring) fixture and exits 0. An under-escaped one makes cmd treat it
// as syntax and the spawn fails.
const METACHARACTER_ARGS = [
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
];

// Each entry tries to break out of the wrapper into a command that writes the injection marker. The
// marker is a bare relative name (no spaces/quotes) resolved against the spawn cwd, so a real
// breakout would create it there. Correct escaping keeps every one inert.
function injectionPayloads(marker) {
  return [
    `& echo pwned>${marker}`,
    `&& echo pwned>${marker}`,
    `| echo pwned>${marker}`,
    `& echo pwned>${marker} &`,
  ];
}

function spawnThroughWrapper(fixtureCmdPath, args, root, ranPath) {
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
  rmSync(ranPath, { force: true });
  return spawnSync(invocation.command, invocation.args, {
    cwd: root,
    env: { ...process.env, KEIKO_CMD_SMOKE_RAN: ranPath },
    shell: false,
    detached: false,
    windowsVerbatimArguments: true,
    encoding: "utf8",
    timeout: 30_000,
  });
}

function assertParseable(fixtureCmdPath, root, ranPath) {
  // (a) the escaped metacharacter line parses cleanly: the fixture runs and exits 0.
  const result = spawnThroughWrapper(fixtureCmdPath, METACHARACTER_ARGS, root, ranPath);
  assert.equal(result.error, undefined, commandResultSummary(result));
  assert.equal(
    result.status,
    0,
    `cmd.exe rejected the escaped metacharacter line — an under-escaped argument. ${commandResultSummary(result)}`,
  );
  assert.equal(existsSync(ranPath), true, "the target .cmd did not run");
}

function assertNoInjection(fixtureCmdPath, root, ranPath) {
  // (b) no injection payload breaks out of the wrapper into a second command.
  const marker = "keiko-cmd-injected.txt";
  const markerPath = join(root, marker);
  for (const payload of injectionPayloads(marker)) {
    rmSync(markerPath, { force: true });
    const result = spawnThroughWrapper(fixtureCmdPath, [payload], root, ranPath);
    assert.equal(result.error, undefined, commandResultSummary(result));
    assert.equal(
      existsSync(ranPath),
      true,
      `the target .cmd did not run for payload ${JSON.stringify(payload)}`,
    );
    assert.equal(
      existsSync(markerPath),
      false,
      `injection payload ${JSON.stringify(payload)} broke out of the wrapper and created the ` +
        "marker — a real escaping regression, not a fixture bug",
    );
  }
}

function assertShimDoubleEscape() {
  // Finding #3350-1: an npm node_modules\.bin\*.cmd shim re-parses %* a SECOND time, so its
  // arguments MUST be double-escaped (single-escaping is injectable through that second parse). This
  // asserts the production spawn-path API engages the double-escape branch for a shim path (the
  // deterministic, host-independent half). The real-cmd double parse is covered by the golden-vector
  // unit test (windows-shell.test.ts): a faithful %*-forwarding shim fixture's own cmd/FOR parsing
  // edge cases cannot be validated without a Windows host, so replaying it here could as easily fake
  // the property as prove it.
  const shim = buildWindowsShellInvocation(join("node_modules", ".bin", "eslint.cmd"), ["&"]);
  assert.equal(
    shim.args.some((part) => part.includes("^^^")),
    true,
    "a node_modules\\.bin\\*.cmd shim argument was not double-escaped (finding 1 regression)",
  );
}

function runWindowsCmdSpawnSmoke() {
  const root = mkdtempSync(join(tmpdir(), "keiko-cmd-spawn-"));
  let failure;
  try {
    const fixtureCmdPath = join(root, "keiko-argv-fixture.cmd");
    writeFileSync(fixtureCmdPath, fixtureBatchScript(), "utf8");
    const ranPath = join(root, "ran.txt");
    assertParseable(fixtureCmdPath, root, ranPath);
    assertNoInjection(fixtureCmdPath, root, ranPath);
    assertShimDoubleEscape();
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
