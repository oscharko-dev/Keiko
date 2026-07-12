#!/usr/bin/env node

import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { clearTimeout, setTimeout } from "node:timers";

import {
  portableTargetByName,
  sha256File,
  validatePortableCandidateManifest,
  validatePortableStagingManifest,
} from "./portable-runtime.mjs";

function fail(message) {
  throw new Error(`portable-secure-read-smoke: ${message}`);
}

function request(root, relativePath) {
  const rootBytes = Buffer.from(root, "utf8");
  const pathBytes = Buffer.from(relativePath, "utf8");
  const frame = Buffer.alloc(20 + rootBytes.length + pathBytes.length);
  frame.write("KSR1", 0, "ascii");
  frame.writeUInt16LE(1, 4);
  frame.writeUInt32LE(rootBytes.length, 8);
  frame.writeUInt32LE(pathBytes.length, 12);
  frame.writeUInt32LE(65_536, 16);
  rootBytes.copy(frame, 20);
  pathBytes.copy(frame, 20 + rootBytes.length);
  return frame;
}

async function runHelper(executable, frame) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(executable, [], { env: {}, stdio: ["pipe", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    const timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", () =>
      reject(new Error("portable-secure-read-smoke: helper process failed")),
    );
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (code !== 0 || signal !== null || Buffer.concat(stderr).length !== 0) {
        reject(new Error("helper process failed closed incorrectly"));
        return;
      }
      resolveResult({ bytes: Buffer.concat(stdout), durationMs: performance.now() - started });
    });
    const started = performance.now();
    child.stdin.end(frame);
  });
}

async function runDecoded(executable, frame) {
  const result = await runHelper(executable, frame);
  return { ...decode(result.bytes), durationMs: result.durationMs };
}

function decode(bytes) {
  if (bytes.length < 12 || bytes.subarray(0, 4).toString("ascii") !== "KSS1")
    fail("response is malformed");
  const status = bytes.readUInt16LE(6);
  const length = bytes.readUInt32LE(8);
  if (bytes.length !== 12 + length || (status !== 0 && length !== 0))
    fail("response is not bounded");
  return { status, content: bytes.subarray(12) };
}

function manifestFailures(manifest) {
  return manifest.security?.verificationPolicy === "production"
    ? validatePortableCandidateManifest(manifest)
    : validatePortableStagingManifest(manifest);
}

export async function smokePortableSecureRead(stageRoot, platformTarget, load = false) {
  const target = portableTargetByName(platformTarget);
  if (target === undefined) fail("target is unsupported");
  const manifestPath = join(stageRoot, "manifest", "portable-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const failures = manifestFailures(manifest);
  if (failures.length > 0) fail("manifest is invalid");
  const helper = manifest.nativeHelpers[0];
  const resourceRoot =
    target.nodePlatform === "darwin"
      ? join(stageRoot, "payload", "Keiko", "Keiko.app", "Contents", "Resources")
      : join(stageRoot, "payload", "Keiko");
  const executable = join(resourceRoot, ...helper.executablePath.split("/"));
  if ((await sha256File(executable)) !== helper.shippedSha256)
    fail("helper digest does not match manifest");
  const fixture = await mkdtemp(join(tmpdir(), "keiko-portable-secure-read-"));
  try {
    await mkdir(join(fixture, "src"));
    await writeFile(join(fixture, "src", "safe.txt"), "portable secure read\n");
    const normal = await runDecoded(executable, request(fixture, "src/safe.txt"));
    if (normal.status !== 0 || normal.content.toString("utf8") !== "portable secure read\n")
      fail("normal read failed");
    if (target.nodePlatform === "win32") await smokeWindowsDeniedNames(executable, fixture);
    if (load) await smokeLoad(executable, fixture, target.nodePlatform);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
}

async function smokeWindowsDeniedNames(executable, fixture) {
  const deniedNames = [
    "CON",
    "NUL.txt",
    "COM1",
    "LPT9.log",
    "CLOCK$",
    "GLOBALROOT",
    "DEVICE",
    "??",
    "src/safe.txt:stream",
    "name?",
    "name.",
    "name ",
    "PROGRA~1",
  ];
  for (const deniedName of deniedNames) {
    const denied = await runDecoded(executable, request(fixture, deniedName));
    if (denied.status === 0 || denied.content.length !== 0) {
      fail("Windows denied-name matrix did not fail closed");
    }
  }
}

function assertExactRead(result) {
  if (
    result.status !== 0 ||
    result.content.toString("utf8") !== "portable secure read\n" ||
    result.durationMs >= 2_000
  ) {
    fail("load qualification read failed");
  }
}

async function smokeLoad(executable, fixture, nodePlatform) {
  const before = await stableResourceCount(nodePlatform);
  const frame = request(fixture, "src/safe.txt");
  const durations = [];
  for (let index = 0; index < 1_000; index += 1) {
    const result = await runDecoded(executable, frame);
    assertExactRead(result);
    durations.push(result.durationMs);
  }
  durations.sort((left, right) => left - right);
  const p95 = durations[Math.ceil(durations.length * 0.95) - 1];
  if (p95 > 500 || durations.at(-1) >= 2_000) fail("sequential load qualification exceeded bounds");
  const batchStarted = performance.now();
  const concurrent = await Promise.all(
    Array.from({ length: 100 }, () => runDecoded(executable, frame)),
  );
  concurrent.forEach(assertExactRead);
  if (performance.now() - batchStarted > 10_000)
    fail("concurrent load qualification exceeded bounds");
  const after = await stableResourceCount(nodePlatform);
  if (after !== before) fail("load qualification detected a parent resource delta");
}

async function stableResourceCount(nodePlatform) {
  const samples = [];
  for (let index = 0; index < 5; index += 1) {
    samples.push(
      nodePlatform === "win32" ? await windowsHandleCount() : (await readdir("/dev/fd")).length,
    );
  }
  samples.sort((left, right) => left - right);
  return samples[2];
}

async function windowsHandleCount() {
  const executable = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
  return new Promise((resolveCount, reject) => {
    const child = spawn(
      executable,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-Process -Id ${String(process.pid)}).HandleCount`,
      ],
      { env: {}, stdio: ["ignore", "pipe", "ignore"] },
    );
    const output = [];
    child.stdout.on("data", (chunk) => output.push(chunk));
    child.once("error", () =>
      reject(new Error("portable-secure-read-smoke: resource probe failed")),
    );
    child.once("close", (code) => {
      const count = Number(Buffer.concat(output).toString("ascii").trim());
      if (code !== 0 || !Number.isSafeInteger(count)) {
        reject(new Error("portable-secure-read-smoke: resource probe failed"));
      } else resolveCount(count);
    });
  });
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const [stageRoot, platformTarget, mode] = process.argv.slice(2);
  if (stageRoot === undefined || platformTarget === undefined) process.exitCode = 2;
  else {
    try {
      await smokePortableSecureRead(resolve(stageRoot), platformTarget, mode === "--load");
      console.log(`portable-secure-read-smoke: PASS ${platformTarget}`);
    } catch (error) {
      console.error(
        error instanceof Error && error.message.startsWith("portable-secure-read-smoke:")
          ? error.message
          : "portable-secure-read-smoke: redacted failure",
      );
      process.exitCode = 1;
    }
  }
}
