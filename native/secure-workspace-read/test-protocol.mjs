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
import { join } from "node:path";
import { performance } from "node:perf_hooks";

const source = new URL("./secure_workspace_read.c", import.meta.url);
const SAFE_TEXT = "safe text\n";
const HELPER_DEADLINE_MS = 2_000;

function request(root, path, { cap = 65536, trailing = Buffer.alloc(0) } = {}) {
  const rootBytes = Buffer.from(root, "utf8");
  const pathBytes = Buffer.from(path, "utf8");
  const frame = Buffer.alloc(20 + rootBytes.length + pathBytes.length);
  frame.write("KSR1", 0, "ascii");
  frame.writeUInt16LE(1, 4);
  frame.writeUInt16LE(0, 6);
  frame.writeUInt32LE(rootBytes.length, 8);
  frame.writeUInt32LE(pathBytes.length, 12);
  frame.writeUInt32LE(cap, 16);
  rootBytes.copy(frame, 20);
  pathBytes.copy(frame, 20 + rootBytes.length);
  return Buffer.concat([frame, trailing]);
}

function run(binary, input) {
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [], { stdio: ["pipe", "pipe", "pipe"], env: {} });
    const stdout = [];
    const stderr = [];
    const deadline = setTimeout(() => child.kill("SIGKILL"), HELPER_DEADLINE_MS);
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", (error) => {
      clearTimeout(deadline);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(deadline);
      const durationMs = performance.now() - started;
      if (signal !== null) {
        reject(new Error("helper exceeded its execution deadline"));
        return;
      }
      resolve({
        code,
        durationMs,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      });
    });
    child.stdin.end(input);
  });
}

function runPaused(binary, input, mutate) {
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [], { stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"], env: {} });
    const stdout = [];
    const stderr = [];
    const deadline = setTimeout(() => child.kill("SIGKILL"), HELPER_DEADLINE_MS);
    let mutationError;
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.stdio[3].once("data", async (signal) => {
      try {
        assert.deepEqual(signal, Buffer.of(1));
        await mutate();
      } catch (error) {
        mutationError = error;
      }
      child.stdio[4].end(Buffer.of(1));
    });
    child.once("error", (error) => {
      clearTimeout(deadline);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(deadline);
      if (mutationError !== undefined) {
        reject(mutationError);
        return;
      }
      if (signal !== null) {
        reject(new Error("paused helper exceeded its execution deadline"));
        return;
      }
      resolve({
        code,
        durationMs: performance.now() - started,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      });
    });
    child.stdin.end(input);
  });
}

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
  return { status, content: result.stdout.subarray(12) };
}

function assertSafeResult(result) {
  const decoded = response(result);
  assert.equal(decoded.status, 0);
  assert.equal(decoded.content.toString("utf8"), SAFE_TEXT);
}

async function compile(binary) {
  const testPause = binary.endsWith("-paused");
  await new Promise((resolve, reject) => {
    const compiler = spawn("xcrun", [
      "clang",
      "-std=c11",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-O2",
      "-D_DARWIN_C_SOURCE",
      ...(testPause ? ["-DKSR_TEST_PAUSE_AFTER_FINAL_OPEN"] : []),
      "-o",
      binary,
      source.pathname,
    ]);
    compiler.once("error", reject);
    compiler.once("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`compile failed: ${code}`)),
    );
  });
}

async function assertWindowsSourceContract() {
  const nativeSource = await readFile(source, "utf8");
  assert.match(nativeSource, /GetFinalPathNameByHandleW\(root,/u);
  assert.match(nativeSource, /GetFinalPathNameByHandleW\(file,/u);
  assert.match(nativeSource, /_wcsnicmp\(root_path, file_path, prefix_length\)/u);
  assert.match(nativeSource, /_wcsicmp\(suffix, expected\) == 0/u);
  assert.match(nativeSource, /\*q == ':' \|\| \*q == '\?' \|\| \*q == '~'/u);
  assert.equal(
    nativeSource.match(/CreateFileW\(/gu)?.length,
    1,
    "only the trusted root may use a pathname open",
  );
}

async function stableFdCount() {
  const samples = [];
  for (let index = 0; index < 9; index += 1) {
    samples.push((await readdir("/dev/fd")).length);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  samples.sort((left, right) => left - right);
  return samples[Math.floor(samples.length / 2)];
}

async function setupFixture(fixture) {
  await mkdir(join(fixture, "nested"));
  await writeFile(join(fixture, "nested", "good.txt"), SAFE_TEXT);
  await writeFile(join(fixture, "binary.txt"), Buffer.from([0x61, 0, 0x62]));
  await writeFile(join(fixture, "invalid-utf8.txt"), Buffer.from([0xc3, 0x28]));
  await writeFile(join(fixture, "c0.txt"), Buffer.from([0x61, 1, 0x62]));
  await writeFile(join(fixture, "c1.txt"), Buffer.from([0xc2, 0x80]));
  await writeFile(join(fixture, "exact.txt"), "x".repeat(65536));
  await writeFile(join(fixture, "large.txt"), "x".repeat(65537));
  await writeFile(join(fixture, "hard-source.txt"), "linked content");
  await symlink("nested", join(fixture, "linked"));
  await symlink("nested/good.txt", join(fixture, "final-link.txt"));
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

async function assertProtocolCases(binary, fixture) {
  assertSafeResult(await run(binary, request(fixture, "nested/good.txt")));
  assert.equal(response(await run(binary, request(fixture, "../outside.txt"))).status, 3);
  assert.equal(response(await run(binary, request(fixture, "linked/good.txt"))).status, 4);
  assert.equal(response(await run(binary, request(fixture, "final-link.txt"))).status, 4);
  assert.equal(response(await run(binary, request(fixture, "hard-link.txt"))).status, 5);
  assert.equal(response(await run(binary, request(fixture, "binary.txt"))).status, 7);
  assert.equal(response(await run(binary, request(fixture, "invalid-utf8.txt"))).status, 7);
  assert.equal(response(await run(binary, request(fixture, "c0.txt"))).status, 7);
  assert.equal(response(await run(binary, request(fixture, "c1.txt"))).status, 7);
  assert.equal(response(await run(binary, request(fixture, "exact.txt"))).status, 0);
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
  const path64 = `${Array.from({ length: 63 }, (_, index) => `d${index}`).join("/")}/deep.txt`;
  const path65 = `${Array.from({ length: 64 }, (_, index) => `d${index}`).join("/")}/deep.txt`;
  assert.equal(response(await run(binary, request(fixture, path64))).status, 0);
  assert.equal(response(await run(binary, request(fixture, path65))).status, 3);
  assert.equal(response(await run(binary, request(fixture, "nested"))).status, 5);
  assert.equal(response(await run(binary, request("/", "dev/null"))).status, 4);
  assert.equal(response(await run(binary, request("/dev", "null"))).status, 5);
}

function assertRaceResult(result) {
  const decoded = response(result);
  assert.ok([0, 6, 8].includes(decoded.status), `unexpected race status: ${decoded.status}`);
  if (decoded.status === 0) assert.equal(decoded.content.toString("utf8"), SAFE_TEXT);
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
  assertRaceResult(await race(() => writeFile(target, "evil text\n")));

  await resetRaceFile(fixture);
  assertRaceResult(await race(() => writeFile(target, "x".repeat(65537))));

  await resetRaceFile(fixture);
  assertRaceResult(
    await race(async () => {
      const replacement = join(fixture, "replacement.txt");
      await writeFile(replacement, "replacement\n");
      await rename(replacement, target);
    }),
  );

  await resetRaceFile(fixture);
  assertRaceResult(
    await race(async () => {
      await rename(nested, moved);
      await rename(moved, nested);
    }),
  );

  await resetRaceFile(fixture);
  try {
    assertRaceResult(
      await race(async () => {
        await rename(nested, moved);
        await mkdir(nested);
        await writeFile(target, "replacement\n");
      }),
    );
  } finally {
    await rm(nested, { recursive: true, force: true });
    await rename(moved, nested);
  }
}

async function assertLoadEvidence(binary, fixture) {
  const safeRequest = request(fixture, "nested/good.txt");
  const fdBefore = await stableFdCount();
  const sequentialDurations = [];
  for (let index = 0; index < 1_000; index += 1) {
    const result = await run(binary, safeRequest);
    assertSafeResult(result);
    sequentialDurations.push(result.durationMs);
  }
  const ordered = [...sequentialDurations].sort((left, right) => left - right);
  const p95Ms = ordered[Math.ceil(ordered.length * 0.95) - 1];
  const maxMs = ordered.at(-1);
  assert.ok(p95Ms <= 500, `sequential p95 exceeded 500ms: ${p95Ms.toFixed(1)}ms`);
  assert.ok(maxMs < HELPER_DEADLINE_MS);

  const concurrentStarted = performance.now();
  const concurrent = await Promise.all(Array.from({ length: 100 }, () => run(binary, safeRequest)));
  const concurrentMs = performance.now() - concurrentStarted;
  assert.ok(concurrentMs <= 10_000, `concurrent batch exceeded 10s: ${concurrentMs.toFixed(1)}ms`);
  concurrent.forEach(assertSafeResult);

  const fdAfter = await stableFdCount();
  assert.equal(fdAfter - fdBefore, 0, "helper load test leaked parent descriptors");
  console.log(
    `secure-workspace-read load: sequential=1000 p95Ms=${p95Ms.toFixed(1)} maxMs=${maxMs.toFixed(1)} concurrent=100 batchMs=${concurrentMs.toFixed(1)} fdDelta=0`,
  );
}

let binaryRoot;
let fixture;
try {
  binaryRoot = await mkdtemp(join(tmpdir(), "ksr-bin-"));
  fixture = await mkdtemp(join(tmpdir(), "ksr-fixture-"));
  const binary = join(binaryRoot, "secure-workspace-read");
  const pausedBinary = join(binaryRoot, "secure-workspace-read-paused");
  await assertWindowsSourceContract();
  await compile(binary);
  await compile(pausedBinary);
  await setupFixture(fixture);
  await assertProtocolCases(binary, fixture);
  await assertAdversarialRaces(pausedBinary, fixture);
  await assertLoadEvidence(binary, fixture);
  console.log("secure-workspace-read protocol tests: PASS");
} finally {
  if (fixture !== undefined) await rm(fixture, { recursive: true, force: true });
  if (binaryRoot !== undefined) await rm(binaryRoot, { recursive: true, force: true });
}
