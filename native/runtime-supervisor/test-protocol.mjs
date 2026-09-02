import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { resolveWindowsMsvcEnv, windowsToolFromPath } from "../../scripts/lib/windows-msvc.mjs";
// KEIKO-0304: the codec and process helpers below used to live in a per-platform copy alongside a
// second copy under `macos/test-protocol.mjs` that had drifted in six observable ways. Both now
// import them from `./protocol-harness.mjs`, which reconciled each divergence deliberately (see
// its header). Windows still owns its platform-specific bits: MSVC compile, hermetic env, the
// two harness functions that carry the lifecycle guard, and the source contract.
import {
  explained,
  fileURLToPath,
  header,
  installControlPipeErrorGuard,
  launchPacket as sharedLaunchPacket,
  raiseControlPipeErrorIfIncomplete,
  readBytes,
  response,
  streamReader,
  waitForExit,
} from "./protocol-harness.mjs";
// Codex 3793795571 on #3202: the Windows source-contract assertions used to run against the
// raw file text, so a control retained only inside `/* ... */`, a diagnostic `"..."`, or a
// compiler-dead `#if 0` branch still satisfied the pin — the source-only lane runs on non-
// Windows hosts where behavioural qualification is skipped, so those pins were the only
// defence. Route through the shared scanner: `prepareCSource` for the negative shell-launch
// check (needs to see actual string bytes so `"cmd.exe"` inside a diagnostic string doesn't
// evade it) and `stripStringLiteralBodies(prepareCSource(...))` for positive identifier /
// call pins (blanks string bodies so a diagnostic `"CREATE_SUSPENDED"` cannot satisfy an
// assertion on the identifier).
import { prepareCSource, stripStringLiteralBodies } from "../lib/c-source-scanner.mjs";

const source = fileURLToPath(new URL("./windows/keiko_runtime_supervisor.c", import.meta.url));
const fixtureSource = fileURLToPath(new URL("./windows/qualification_fixture.c", import.meta.url));
const DEADLINE_MS = 10_000;

// Windows-specific env pairs (the supervised child needs SystemRoot for Win32/CRT plumbing).
function launchPacket(executable, cwd) {
  return sharedLaunchPacket(
    executable,
    cwd,
    [
      ["KEIKO_ALPHA", "one"],
      ["KEIKO_BETA", "two"],
      ["SystemRoot", process.env.SystemRoot ?? String.raw`C:\Windows`],
    ],
    ["--qualified", "second-argument"],
  );
}

async function compile(sourcePath, output) {
  const objectPath = join(dirname(output), `${basename(output)}.obj`);
  const compileEnv = resolveWindowsMsvcEnv(process.env);
  const result = await runProcess(windowsToolFromPath(compileEnv.PATH, "cl.exe"), compileEnv, [
    "/nologo",
    "/std:c11",
    "/W4",
    "/WX",
    "/O2",
    "/DUNICODE",
    "/D_UNICODE",
    "/D_CRT_SECURE_NO_WARNINGS",
    `/Fe:${output}`,
    `/Fo:${objectPath}`,
    sourcePath,
  ]);
  assert.equal(
    result.code,
    0,
    `native compile failed:\n  ${boundedDiagnostic("stdout", result.stdout)}\n  ${boundedDiagnostic(
      "stderr",
      result.stderr,
    )}`,
  );
}

function runProcess(command, env, args) {
  return new Promise((resolveResult, reject) => {
    // KEIKO-0802: MSVC's `cl.exe` writes `error C####` diagnostics to STDOUT, not stderr, so the
    // pre-fix stdio: ["ignore", "ignore", "pipe"] tuple threw them away and every compile failure
    // reported an empty `${result.stderr.toString("utf8")}` — a "native compile failed:" with no
    // clue what failed. Capture both streams and hand both back for the assertion message.
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) =>
      resolveResult({ code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) }),
    );
  });
}

// Bounded diagnostic slice for the compile-failed assertion message. cl.exe can produce many KB
// of `error C####` output on a bad file; the whole thing hitting the exception message is
// unhelpful noise, and a bare truncation drops the leading errors that actually name the fault.
// Take the first 4 KB and mark the truncation, so the assertion carries the FIRST diagnostics.
function boundedDiagnostic(label, buffer) {
  const cap = 4096;
  const text = buffer.toString("utf8");
  if (text.length <= cap) return text.length === 0 ? "" : `${label}=${text}`;
  return `${label}=${text.slice(0, cap)}<truncated, ${String(text.length - cap)} more bytes>`;
}

/* Windows children need SystemRoot for Win32/CRT plumbing; everything else stays withheld. */
function hermeticWindowsEnv() {
  return { SystemRoot: process.env.SystemRoot ?? String.raw`C:\Windows` };
}

async function qualifyWindows(helper, runtime, root) {
  const child = spawn(helper, [], {
    env: hermeticWindowsEnv(),
    stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
  });
  const exited = new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", resolveExit);
  });
  const stderr = [];
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const responses = streamReader(child.stdio[4]);
  const output = streamReader(child.stdout);
  const controlPipeErrorState = installControlPipeErrorGuard(child);
  // KEIKO-0278: the same lifecycle guard the macOS `qualify` carries; DEADLINE_MS's bare
  // `child.kill()` only bounds the hang otherwise.
  const deadline = setTimeout(() => child.kill(), DEADLINE_MS);
  let completed = false;
  try {
    child.stdio[3].write(launchPacket(runtime, root));
    const acknowledgement = await explained(
      "launch acknowledgement",
      response(responses),
      exited,
      stderr,
    );
    assert.deepEqual(acknowledgement, { kind: 1, payload: Buffer.alloc(0) });
    const observation = await explained(
      "fixture observation",
      readBytes(output, 12),
      exited,
      stderr,
    );
    assert.equal(observation.subarray(0, 4).toString("ascii"), "KRQ1");
    const [rootProcess, descendant] = [observation.readUInt32LE(4), observation.readUInt32LE(8)];
    await writeSplitControlFrame(child.stdio[3]);
    const reap = await explained("reap response", response(responses), exited, stderr);
    assert.equal(reap.kind, 2);
    assert.equal(reap.payload.readUInt32LE(4), 0, "Job Object must report zero active processes");
    await Promise.all([waitForExit(rootProcess), waitForExit(descendant)]);
    assert.equal(await exited, 0);
    assert.equal(Buffer.concat(stderr).length, 0, "helper diagnostics must remain content-free");
    completed = true;
  } finally {
    clearTimeout(deadline);
    if (!completed) child.kill("SIGKILL");
    await exited.catch(() => undefined);
  }
  raiseControlPipeErrorIfIncomplete("qualifyWindows", controlPipeErrorState, completed);
}

/** Writes a control frame in two chunks, so the supervisor's reader has to reassemble a header it
 * received split across reads rather than one that happened to arrive whole. */
async function writeSplitControlFrame(control) {
  const frameBytes = header("KRC1", 3, 0);
  control.write(frameBytes.subarray(0, 5));
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  control.write(frameBytes.subarray(5));
}

// KEIKO-0730: after the control-EOF closure has been observed and the supervised pids have
// exited, assert the Windows fail-closed contract — wmain returns 1 after
// send_error(ERROR_JOB_OBSERVE) on the PeekNamedPipe failure branch (windows/keiko_runtime_
// supervisor.c:389-392, 494-496, 502-508), and stderr stays empty because the error is
// reported through the KRS1 error frame, never through a stderr write. The pre-fix bare
// `await exited` observed both but asserted neither.
async function assertControlEofFinalization(exited, stderr) {
  const eofExitCode = await exited;
  assert.equal(
    eofExitCode,
    1,
    "supervisor must exit with 1 on control EOF (send_error(ERROR_JOB_OBSERVE))",
  );
  assert.equal(
    Buffer.concat(stderr).length,
    0,
    "supervisor must not leak stderr diagnostics on the EOF fail-closed path",
  );
}

async function assertControlEofFailsClosed(helper, runtime, root) {
  const child = spawn(helper, [], {
    env: hermeticWindowsEnv(),
    stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
  });
  const exited = new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", resolveExit);
  });
  const stderr = [];
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const responses = streamReader(child.stdio[4]);
  const output = streamReader(child.stdout);
  const controlPipeErrorState = installControlPipeErrorGuard(child);
  // KEIKO-0278: this probe had NO watchdog at all.
  const deadline = setTimeout(() => child.kill(), DEADLINE_MS);
  let completed = false;
  try {
    child.stdio[3].write(launchPacket(runtime, root));
    const acknowledgement = await explained(
      "eof-probe acknowledgement",
      response(responses),
      exited,
      stderr,
    );
    assert.equal(acknowledgement.kind, 1);
    const observation = await explained(
      "eof-probe observation",
      readBytes(output, 12),
      exited,
      stderr,
    );
    const pids = [observation.readUInt32LE(4), observation.readUInt32LE(8)];
    child.stdio[3].end();
    const closure = await explained("eof-probe closure", response(responses), exited, stderr);
    assert.equal(closure.kind, 3);
    await Promise.all(pids.map(waitForExit));
    await assertControlEofFinalization(exited, stderr);
    completed = true;
  } finally {
    clearTimeout(deadline);
    if (!completed) child.kill("SIGKILL");
    await exited.catch(() => undefined);
  }
  raiseControlPipeErrorIfIncomplete(
    "assertControlEofFailsClosed",
    controlPipeErrorState,
    completed,
  );
}

async function assertSourceContract() {
  const rawSource = await readFile(source, "utf8");
  runSourceContractOn(rawSource);
  assertMutationRejected(rawSource);
}

function runSourceContractOn(rawSource) {
  // Two composition modes over the shared scanner (codex 3793795571 on #3202): positive
  // identifier / call pins consume the string-blanked scan (so a diagnostic `"CREATE_SUSPENDED"`
  // cannot satisfy an assertion on the identifier); the negative shell-launch pin consumes
  // the literal-preserving scan (so a real `system("cmd.exe")` still trips it).
  const preparedText = prepareCSource(rawSource);
  const codeText = stripStringLiteralBodies(preparedText);
  assert.match(codeText, /JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE/u);
  assert.match(codeText, /CREATE_SUSPENDED/u);
  assert.match(codeText, /AssignProcessToJobObject\(job, process->hProcess\)/u);
  assert.match(codeText, /ResumeThread\(process->hThread\)/u);
  assert.match(codeText, /JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO/u);
  assert.match(codeText, /accounting\.ActiveProcesses == 0/u);
  assert.match(codeText, /PROC_THREAD_ATTRIBUTE_HANDLE_LIST/u);
  assert.match(codeText, /SetDefaultDllDirectories\(LOAD_LIBRARY_SEARCH_SYSTEM32\)/u);
  assert.match(codeText, /SetDllDirectoryW\(L(?:"")?\)/u);
  // Coderabbit 3793899396 on #3202: the negative shell-launch regex must accept `system` /
  // `ShellExecute` calls with OPTIONAL whitespace before the opening parenthesis (`system
  // ("cmd")` and `ShellExecute (…)` both compile identically). Word boundary on `system`
  // avoids matching identifiers that merely CONTAIN "system" (`filesystem`, `MyShellExecute
  // Handler`).
  assert.doesNotMatch(preparedText, /\bsystem\s*\(|\bShellExecute\w*\s*\(|cmd\.exe|powershell/iu);
}

// Codex 3793905525 on #3202: fail-before-fix proof for the shared-scanner wiring. Move a
// required control (`CREATE_SUSPENDED`) into a `/* ... */` comment, then verify that
// `runSourceContractOn` rejects the mutated source. Without the scanner wiring the mutated
// source would still satisfy the raw-text match, so this test is what pins the trust-boundary
// remediation instead of hoping the future author remembers to run through the shared code.
function assertMutationRejected(rawSource) {
  const commentedOut = rawSource.replace(/CREATE_SUSPENDED/gu, "/* CREATE_SUSPENDED */ (void)0");
  assert.notEqual(commentedOut, rawSource, "mutation must have changed the source");
  assert.throws(
    () => runSourceContractOn(commentedOut),
    /CREATE_SUSPENDED/,
    "assertSourceContract must reject a mutation that hides CREATE_SUSPENDED in a comment " +
      "— pins that the shared scanner strips comments before running the identifier pin",
  );
  // Coderabbit 3794185693 on #3202: use global regexes so EVERY occurrence is mutated. If
  // `CREATE_SUSPENDED` appears twice, a non-global replace leaves the second occurrence
  // satisfying the pin and `assert.throws` sees no error — meta-test would pass against a
  // correct implementation.
  const diagnosticSource = rawSource.replace(/CREATE_SUSPENDED/gu, '(void)"CREATE_SUSPENDED"');
  assert.throws(
    () => runSourceContractOn(diagnosticSource),
    /CREATE_SUSPENDED/,
    "assertSourceContract must reject a mutation that hides CREATE_SUSPENDED inside a " +
      "diagnostic string — pins that `stripStringLiteralBodies` runs on the identifier pin",
  );
  const withoutLoaderHardening = rawSource.replace(
    "SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32)",
    "0",
  );
  assert.notEqual(
    withoutLoaderHardening,
    rawSource,
    "loader-hardening mutation must change source",
  );
  assert.throws(
    () => runSourceContractOn(withoutLoaderHardening),
    /SetDefaultDllDirectories/,
    "assertSourceContract must reject a source that drops its runtime DLL search-path hardening",
  );
}

await assertSourceContract();
// Codex on #3202: validate the ENTIRE argv on Windows too — parallel to the macOS harness's
// KNOWN_FLAGS check. A typo like `--helpr <path>` or a bare `--helper` (no value) previously
// slid past silently and compiled the repo source instead of qualifying the staged binary,
// so a release invocation could report success against the wrong artifact.
const WINDOWS_KNOWN_FLAGS = new Set(["--helper"]);
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (!WINDOWS_KNOWN_FLAGS.has(arg)) {
    throw new Error(
      `unknown Windows qualification flag: ${JSON.stringify(arg)}. Supported: --helper <path>`,
    );
  }
  if (arg === "--helper") i += 1; // consume path value; validity checked below.
}
if (process.platform === "win32") {
  const root = await mkdtemp(join(tmpdir(), "keiko-runtime-supervisor-"));
  try {
    const helperArgumentIndex = process.argv.indexOf("--helper");
    const suppliedHelper =
      helperArgumentIndex === -1 ? undefined : process.argv[helperArgumentIndex + 1];
    if (
      helperArgumentIndex !== -1 &&
      (suppliedHelper === undefined || suppliedHelper.length === 0)
    ) {
      throw new Error("--helper requires a non-empty path to the staged supervisor binary");
    }
    const helper = suppliedHelper ?? join(root, "keiko-runtime-supervisor.exe");
    const runtime = join(root, "qualification-fixture.exe");
    if (suppliedHelper === undefined) await compile(source, helper);
    await compile(fixtureSource, runtime);
    await qualifyWindows(helper, runtime, root);
    await assertControlEofFailsClosed(helper, runtime, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
