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
import { performance } from "node:perf_hooks";

const source = fileURLToPath(new URL("./secure_workspace_read.c", import.meta.url));
const SAFE_TEXT = "safe text\n";
const HELPER_DEADLINE_MS = 2_000;
const CONCURRENT_CONSISTENCY_READS = 32;
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
        `/Fo:${join(dirname(binary), `${basename(binary)}.obj`)}`,
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
  const compiler = isWindows ? "cl" : "xcrun";
  await new Promise((resolveCompile, reject) => {
    const child = spawn(compiler, args, { env: process.env, stdio: ["ignore", "ignore", "pipe"] });
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

async function assertWindowsSourceContract() {
  const nativeSource = await readFile(source, "utf8");
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
  assert.match(nativeSource, /\*q == ':' \|\| \*q == '\?' \|\| \*q == '~'/u);
  assert.equal(nativeSource.match(/CreateFileW\(/gu)?.length, 1);
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
  assert.equal(response(await run(binary, request(fixture, "nested\\good.txt"))).status, 3);
  assert.equal(response(await run(binary, request(fixture, "linked/outside.txt"))).status, 4);
  assert.equal(response(await run(binary, request(fixture, "final-link.txt"))).status, 4);
  assert.equal(
    response(await run(binary, request(join(outside, "root-alias"), "nested/good.txt"))).status,
    4,
  );
  assert.equal(response(await run(binary, request(fixture, "hard-link.txt"))).status, 5);
  assert.equal(response(await run(binary, request(fixture, "nested"))).status, 5);
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
  const path64 = `${Array.from({ length: 63 }, (_, index) => `d${index}`).join("/")}/deep.txt`;
  const path65 = `${Array.from({ length: 64 }, (_, index) => `d${index}`).join("/")}/deep.txt`;
  assert.equal(response(await run(binary, request(fixture, path64))).status, 0);
  assert.equal(response(await run(binary, request(fixture, path65))).status, 3);
  if (isWindows) await assertWindowsPolicies(binary, fixture);
  else {
    assert.equal(response(await run(binary, request("/", "dev/null"))).status, 4);
    assert.equal(response(await run(binary, request("/dev", "null"))).status, 5);
  }
}

async function assertWindowsPolicies(binary, fixture) {
  for (const denied of [
    "CON",
    "NUL.txt",
    "COM1",
    "LPT9.log",
    "CLOCK$",
    "GLOBALROOT",
    "DEVICE",
    "??",
    "nested/good.txt:stream",
    "name?",
    "name.",
    "name ",
    "PROGRA~1",
  ]) {
    assert.equal(response(await run(binary, request(fixture, denied))).status, 3);
  }
  for (const invalidRoot of ["C:relative", "\\\\server\\share", "relative"])
    assert.equal(response(await run(binary, request(invalidRoot, "safe.txt"))).status, 1);
}

function assertRaceResult(result) {
  const decoded = response(result);
  assert.ok([0, 6, 8].includes(decoded.status), `unexpected race status: ${decoded.status}`);
  if (decoded.status === 0) assert.equal(decoded.content.toString("utf8"), SAFE_TEXT);
  if (result.mutationDenied) assert.equal(decoded.status, 0);
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
  assertRaceResult(await race(() => writeFile(target, "x".repeat(65_537))));
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
  let movedAway = false;
  try {
    assertRaceResult(
      await race(async () => {
        await rename(nested, moved);
        movedAway = true;
        await mkdir(nested);
        await writeFile(target, "replacement\n");
      }),
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
      await new Promise((resolveRetry) => setTimeout(resolveRetry, 5));
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
        await new Promise((resolveTurn) => setImmediate(resolveTurn));
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

function assertKnownGeneration(result, generations) {
  const decoded = response(result);
  if (decoded.status !== 0) return;
  assert.ok(
    generations.some((generation) => decoded.content.equals(generation)),
    "successful concurrent read returned external, partial, or mixed bytes",
  );
}

async function assertFileGenerationConsistency(binary, fixture) {
  const target = join(fixture, "concurrent-generation.txt");
  const generations = [
    Buffer.from(`${"a".repeat(2_584)}\n`),
    Buffer.from(`${"b".repeat(32_767)}\n`),
  ];
  await writeFile(target, generations[0]);
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
      assertKnownGeneration(
        await run(binary, request(fixture, "concurrent-generation.txt")),
        generations,
      );
    },
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
        let originalParked = false;
        await rename(parent, parked);
        originalParked = true;
        try {
          await rename(alias, parent);
          aliasInstalled = true;
          try {
            await new Promise((resolveTurn) => setImmediate(resolveTurn));
          } finally {
            await restoreRename(parent, alias);
            aliasInstalled = false;
          }
        } finally {
          if (!aliasInstalled && originalParked) {
            await restoreRename(parked, parent);
            originalParked = false;
          }
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
  const powershell = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
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
  const pausedBinary =
    binaryRoot === undefined
      ? undefined
      : join(
          binaryRoot,
          isWindows ? "secure-workspace-read-paused.exe" : "secure-workspace-read-paused",
        );
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
