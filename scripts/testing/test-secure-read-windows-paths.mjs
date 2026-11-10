#!/usr/bin/env node
// #4068 W7: Windows path-spelling and sharing proofs of the secure-read helper.
//
// These live apart from native/secure-workspace-read/test-protocol.mjs because that directory is
// hashed as the helper's approved source tree: editing the harness there invalidates the runtime
// approval pin without changing a single shipped byte. Nothing here is part of the helper's input.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runSecureWorkspaceReadBuild } from "../build-secure-workspace-read.mjs";
import { readSecureWorkspaceFile } from "../portable-secure-read-smoke.mjs";

const SAFE_TEXT = "safe text\n";
const STATUS_MALFORMED = 1;
const STATUS_DENIED = 3;
const CONCURRENT_READS = 32;

function assertSafeRead(result, label) {
  assert.equal(result.status, 0, `${label}: expected a successful read`);
  assert.equal(result.content.toString("utf8"), SAFE_TEXT, `${label}: wrong bytes`);
}

async function assertInvalidRoots(binary, fixture) {
  for (const prefix of ["\\\\?\\", "\\\\.\\", "\\??\\"]) {
    const { status } = await readSecureWorkspaceFile(binary, prefix + fixture, "safe.txt");
    assert.equal(status, STATUS_MALFORMED, `device root must be refused: ${prefix}`);
  }
}

async function assertPathSpellings(binary, fixture) {
  const directory = "Windows Pfade 東京";
  const root = join(fixture, directory);
  const name = "Grüße 東京.txt";
  await mkdir(root);
  await writeFile(join(root, name), SAFE_TEXT);
  await writeFile(join(root, "Case Probe.txt"), SAFE_TEXT);
  await writeFile(join(root, "Case Probe.txt:private"), "ALTERNATE_STREAM_CANARY");
  // Compare returned bytes, not only a success code: aliases must resolve the intended file.
  assertSafeRead(await readSecureWorkspaceFile(binary, root, name), "spaces and Unicode");
  assertSafeRead(await readSecureWorkspaceFile(binary, root, "case probe.TXT"), "case alias");
  assertSafeRead(
    await readSecureWorkspaceFile(binary, join(fixture.toUpperCase(), directory), name),
    "root case alias",
  );
  assertSafeRead(
    await readSecureWorkspaceFile(binary, root.replaceAll("\\", "/"), name),
    "forward-slash root",
  );
  const stream = await readSecureWorkspaceFile(binary, root, "Case Probe.txt:private");
  assert.equal(stream.status, STATUS_DENIED, "alternate data stream must be refused");

  const segments = Array.from({ length: 3 }, (_, index) => "long" + index + "-".repeat(90));
  const longDirectory = join(root, ...segments);
  await mkdir(longDirectory, { recursive: true });
  await writeFile(join(longDirectory, name), SAFE_TEXT);
  const relative = [...segments, name].join("/");
  assert.ok(join(root, relative).length > 260, "long-path fixture must exceed legacy MAX_PATH");
  assertSafeRead(await readSecureWorkspaceFile(binary, root, relative), "long path");
}

// Keep staging churn outside the reader's ancestor chain. On Windows the helper denies target
// replacement while reading; creating or removing a sibling of the target changes the observed
// root and correctly refuses the read, which would hide that sharing protection.
async function assertKnownGenerations(binary, fixture) {
  const root = join(fixture, "generations");
  const staging = join(fixture, "generations-staging");
  await mkdir(root);
  await mkdir(staging);
  const target = join(root, "target.txt");
  const generations = [`${"a".repeat(2_584)}\n`, `${"b".repeat(32_767)}\n`];
  await writeFile(target, generations[0]);
  let active = true;
  let attempts = 0;
  const updater = (async () => {
    while (active) {
      const staged = join(staging, `${attempts}.tmp`);
      await writeFile(staged, generations[attempts % generations.length]);
      attempts += 1;
      // A sharing violation is the protection under test; the staged file is removed either way.
      await rename(staged, target).catch((error) => {
        if (error.code !== "EPERM" && error.code !== "EBUSY") throw error;
      });
      await rm(staged, { force: true });
    }
  })();
  let known = 0;
  try {
    for (let index = 0; index < CONCURRENT_READS; index += 1) {
      const result = await readSecureWorkspaceFile(binary, root, "target.txt");
      if (result.status !== 0) continue;
      assert.ok(generations.includes(result.content.toString("utf8")), "mixed or foreign bytes");
      known += 1;
    }
  } finally {
    active = false;
    await updater;
  }
  assert.ok(known > 0, "no read observed a known generation under isolated staging churn");
  return { known, attempts };
}

async function main() {
  assert.equal(process.platform, "win32", "this qualification runs only on native Windows");
  const fixture = await realpath(await mkdtemp(join(tmpdir(), "keiko-secure-read-windows-")));
  try {
    const binary = join(fixture, "keiko-secure-workspace-read.exe");
    const code = await runSecureWorkspaceReadBuild({
      argv: [process.execPath, "build-secure-workspace-read.mjs", "windows-x64", binary],
    });
    assert.equal(code, 0, "secure-read helper build failed");
    const workspace = join(fixture, "workspace");
    await mkdir(workspace);
    await writeFile(join(workspace, "safe.txt"), SAFE_TEXT);
    await assertInvalidRoots(binary, workspace);
    await assertPathSpellings(binary, workspace);
    const { known, attempts } = await assertKnownGenerations(binary, workspace);
    console.log(
      `secure-read Windows paths: PASS knownGenerationReads=${known} updaterAttempts=${attempts}`,
    );
  } finally {
    await rm(fixture, { force: true, recursive: true });
  }
}

await main();
