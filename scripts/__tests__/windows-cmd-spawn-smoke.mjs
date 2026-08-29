// Windows-only smoke: proves the hardened cmd.exe wrapper (packages/keiko-tools/src/windows-shell.ts,
// issue #3350 / Node CVE-2024-27980) works end to end against a REAL Windows spawn — not just the
// pure-function golden vectors in windows-shell.test.ts (which run on any host but never touch a real
// cmd.exe). Three things only a live Windows process can prove:
//   (a) ARGV FIDELITY. The child receives exactly the vector the caller passed — nothing dropped,
//       merged, reordered, or mangled. This is the property #3350 is about, so the target here is a
//       production-shaped shim (`@echo off` + `node recorder.js %*`, the shape npm generates) whose
//       recorder writes `process.argv.slice(2)` as JSON. Node takes its argv from the OS, so the
//       recording itself involves no second cmd.exe parse and cannot mangle what it observed.
//   (b) INJECTION INERTNESS. An argument shaped like a shell-injection payload (`& echo … > marker`)
//       stays data: it must never become a command separator and must never create the marker. This
//       is the security property the escaping exists for; the unit tests assert the STRING shape,
//       only a live cmd.exe proves Windows honours it.
//   (c) BOTH ESCAPING PATHS. An ordinary `.cmd` (single-escaped) and an npm `node_modules\.bin\*.cmd`
//       shim (double-escaped, because it re-parses `%*` a second time) are exercised as real spawns,
//       not only as string-shape assertions.
//
// Not a *.test.mjs: vitest never runs this. It is invoked directly by the Windows CI leg because it
// needs a real win32 process, not vitest's node/jsdom environment.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

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

// Records the argv the child actually received. Node parses its own command line with the CRT rules
// CreateProcess feeds it, so this observation is not filtered through a second cmd.exe parse.
function recorderScript() {
  return [
    'import { writeFileSync } from "node:fs";',
    "writeFileSync(process.env.KEIKO_CMD_SMOKE_OUT, JSON.stringify(process.argv.slice(2)), 'utf8');",
  ].join("\n");
}

// The shape npm actually generates for a `.bin` shim and that `npm.cmd` itself uses: forward `%*` on
// to node. Forwarding is what makes cmd.exe parse the arguments a SECOND time, which is exactly the
// condition the double-escaping branch exists for — a fixture that did not forward would not be able
// to detect an under-escaped shim argument at all.
function shimScript(recorderPath) {
  return ["@echo off", `"${process.execPath}" "${recorderPath}" %*`].join("\r\n");
}

function commandResultSummary(result) {
  return [
    `status=${String(result.status ?? "none")}`,
    `signal=${String(result.signal ?? "none")}`,
    `errorCode=${String(result.error?.code ?? "none")}`,
    `stderr=${String(result.stderr ?? "")
      .trim()
      .slice(0, 200)}`,
  ].join(" ");
}

// Every argument must arrive at the child byte-for-byte. `%` is deliberately absent: caret escaping
// does not neutralise cmd.exe's `%`-expansion inside a batch file, so a `%VAR%`-shaped argument is
// expanded by the shim layer rather than mangled by the escaping. That is a documented property of
// the algorithm this module reproduces (see windows-shell.ts), not a round-trip defect — `%` is still
// carried through the parseability and injection vectors below, where its behaviour is well-defined.
const ROUND_TRIP_ARGS = [
  "hello",
  "hello world",
  "&",
  "|",
  ">",
  "<",
  "^",
  '"',
  "!",
  "(",
  ")",
  "*",
  "trailing\\",
  'has"quote',
  "",
];

// The full battery, `%` included: each must be caret-escaped so cmd.exe parses the whole line as
// literal arguments and the child runs. An under-escaped one makes cmd treat it as syntax instead.
const METACHARACTER_ARGS = [...ROUND_TRIP_ARGS, "%"];

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

function spawnThroughWrapper(shimPath, args, root, outPath) {
  const invocation = buildWindowsShellInvocation(shimPath, args);
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
  rmSync(outPath, { force: true });
  return spawnSync(invocation.command, invocation.args, {
    cwd: root,
    env: { ...process.env, KEIKO_CMD_SMOKE_OUT: outPath },
    shell: false,
    detached: false,
    windowsVerbatimArguments: true,
    encoding: "utf8",
    timeout: 60_000,
  });
}

function recordedArgs(outPath) {
  assert.equal(existsSync(outPath), true, "the target .cmd did not run (no recording was written)");
  return JSON.parse(readFileSync(outPath, "utf8"));
}

// (a) ARGV FIDELITY: the exact vector, through a real cmd.exe parse (twice, on the shim path).
function assertArgvRoundTrip(label, shimPath, root, outPath) {
  const result = spawnThroughWrapper(shimPath, ROUND_TRIP_ARGS, root, outPath);
  assert.equal(result.error, undefined, `${label}: ${commandResultSummary(result)}`);
  assert.equal(
    result.status,
    0,
    `${label}: cmd.exe rejected the escaped line — an under-escaped argument. ${commandResultSummary(result)}`,
  );
  assert.deepEqual(
    recordedArgs(outPath),
    ROUND_TRIP_ARGS,
    `${label}: the child received a DIFFERENT argv than was passed — the escaping dropped, merged, ` +
      "reordered or mangled an argument",
  );
}

// The parseability half of (a), with `%` included: the line must still parse and the child still run.
function assertParseable(label, shimPath, root, outPath) {
  const result = spawnThroughWrapper(shimPath, METACHARACTER_ARGS, root, outPath);
  assert.equal(result.error, undefined, `${label}: ${commandResultSummary(result)}`);
  assert.equal(
    result.status,
    0,
    `${label}: cmd.exe rejected the escaped metacharacter line. ${commandResultSummary(result)}`,
  );
  assert.equal(recordedArgs(outPath).length, METACHARACTER_ARGS.length, `${label}: argument count`);
}

// (b) INJECTION INERTNESS: no payload breaks out of the wrapper into a second command.
function assertNoInjection(label, shimPath, root, outPath) {
  const marker = "keiko-cmd-injected.txt";
  const markerPath = join(root, marker);
  for (const payload of injectionPayloads(marker)) {
    rmSync(markerPath, { force: true });
    const result = spawnThroughWrapper(shimPath, [payload], root, outPath);
    assert.equal(result.error, undefined, `${label}: ${commandResultSummary(result)}`);
    assert.deepEqual(
      recordedArgs(outPath),
      [payload],
      `${label}: the injection payload did not arrive as a single literal argument`,
    );
    assert.equal(
      existsSync(markerPath),
      false,
      `${label}: injection payload ${JSON.stringify(payload)} broke out of the wrapper and created ` +
        "the marker — a real escaping regression, not a fixture bug",
    );
  }
}

// The deterministic, host-independent half of (c): the `.bin` shim path must engage the double-escape
// branch at all. Kept alongside the live spawns because it names the branch directly, so a wrapper
// that stopped detecting shims would fail here with an unambiguous message.
function assertShimDoubleEscape() {
  const shim = buildWindowsShellInvocation(join("node_modules", ".bin", "eslint.cmd"), ["&"]);
  assert.equal(
    shim.args.some((part) => part.includes("^^^")),
    true,
    "a node_modules\\.bin\\*.cmd shim argument was not double-escaped (finding 1 regression)",
  );
}

function writeFixture(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, "utf8");
}

function runWindowsCmdSpawnSmoke() {
  const root = mkdtempSync(join(tmpdir(), "keiko-cmd-spawn-"));
  let failure;
  try {
    const recorderPath = join(root, "keiko-argv-recorder.mjs");
    writeFixture(recorderPath, recorderScript());
    const outPath = join(root, "recorded-argv.json");

    // The ordinary path (single-escaped) and the npm shim path (double-escaped). The second must
    // literally sit under `node_modules\.bin\` — that PATH SHAPE is what selects double escaping.
    const ordinaryShim = join(root, "tools", "keiko-recorder.cmd");
    const binShim = join(root, "node_modules", ".bin", "keiko-recorder.cmd");
    writeFixture(ordinaryShim, shimScript(recorderPath));
    writeFixture(binShim, shimScript(recorderPath));

    for (const [label, shimPath] of [
      ["ordinary .cmd", ordinaryShim],
      ["node_modules\\.bin shim", binShim],
    ]) {
      assertArgvRoundTrip(label, shimPath, root, outPath);
      assertParseable(label, shimPath, root, outPath);
      assertNoInjection(label, shimPath, root, outPath);
    }
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
