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
// Copy a C string literal starting at the opening `"` (index i) verbatim to `out`. Returns the
// index of the byte AFTER the closing `"` (or the end of source on unterminated input).
function copyStringLiteralVerbatim(source, start, out) {
  let i = start + 1;
  let result = out + '"';
  while (i < source.length) {
    const c = source[i];
    if (c === "\\") {
      result += source.slice(i, i + 2);
      i += 2;
      continue;
    }
    result += c;
    i += 1;
    if (c === '"') return { out: result, next: i };
  }
  return { out: result, next: i };
}

function stripCCommentsPreservingLiterals(rawSource) {
  const source = rawSource.replace(/\\\r?\n/gu, "");
  let out = "";
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      if (end === -1) return out;
      out += "  ";
      i = end + 2;
    } else if (ch === "/" && next === "/") {
      const end = source.indexOf("\n", i + 2);
      if (end === -1) return out;
      i = end;
    } else if (ch === '"') {
      const copied = copyStringLiteralVerbatim(source, i, out);
      out = copied.out;
      i = copied.next;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
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
