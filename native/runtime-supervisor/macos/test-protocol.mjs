import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
const source = new URL("./keiko_runtime_supervisor.c", import.meta.url);
const fixtureSource = new URL("./qualification_fixture.c", import.meta.url);

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
      fixtureSource.pathname,
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

const sourceText = await readFile(source, "utf8");
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

// KEIKO-0277: Windows-sibling two-mode shape. `--helper <path>` qualifies an exact staged binary
// (release-qualification form the portable pipeline uses). Without `--helper`, compile the
// supervisor from source into a scratch root and qualify THAT — same clang invocation as
// scripts/check-macos-native-quality.sh, so the behavioural qualification runs on every PR from
// that gate instead of being reachable only at release time. The source contract above is
// deliberately placed BEFORE the platform guard so it runs on every host.
async function compileSupervisor(path, architecture) {
  const supervisorSource = new URL("./keiko_runtime_supervisor.c", import.meta.url);
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
      supervisorSource.pathname,
    ],
    { env: {}, stdio: ["ignore", "ignore", "pipe"] },
  );
  const errors = [];
  child.stderr.on("data", (chunk) => errors.push(chunk));
  const status = await new Promise((resolve) => {
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
if (process.platform === "darwin") {
  const helperIndex = process.argv.indexOf("--helper");
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
