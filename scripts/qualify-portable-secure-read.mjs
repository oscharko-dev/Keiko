#!/usr/bin/env node

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { runSecureWorkspaceReadBuild } from "./build-secure-workspace-read.mjs";
import { smokeSecureReadExecutable } from "./portable-secure-read-smoke.mjs";
import { PORTABLE_TARGETS, portableTargetByName } from "./portable-runtime.mjs";

export function nativeSecureReadTarget() {
  return PORTABLE_TARGETS.find(
    (target) =>
      target.nodePlatform === process.platform && target.nodeArchitecture === process.arch,
  )?.platformTarget;
}

export async function qualifyPortableSecureRead(platformTarget, load = true) {
  const target = portableTargetByName(platformTarget);
  if (
    target === undefined ||
    target.nodePlatform !== process.platform ||
    target.nodeArchitecture !== process.arch
  ) {
    throw new Error("portable-secure-read-qualification: target is not native to this host");
  }
  const root = await mkdtemp(join(tmpdir(), "keiko-secure-read-qualification-"));
  try {
    const executable = join(root, process.platform === "win32" ? "helper.exe" : "helper");
    const code = await runSecureWorkspaceReadBuild({
      argv: [process.execPath, "build-secure-workspace-read.mjs", platformTarget, executable],
    });
    if (code !== 0) throw new Error("portable-secure-read-qualification: native build failed");
    await smokeSecureReadExecutable(executable, target.nodePlatform, load);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export async function runPortableSecureReadQualification(argv = process.argv) {
  try {
    if (argv.length > 3)
      throw new TypeError("portable-secure-read-qualification: invalid arguments");
    const target = argv[2] ?? nativeSecureReadTarget();
    await qualifyPortableSecureRead(target);
    console.log(`portable-secure-read-qualification: PASS ${target}`);
    return 0;
  } catch (error) {
    console.error(
      error instanceof Error && error.message.startsWith("portable-secure-read-")
        ? error.message
        : "portable-secure-read-qualification: FAIL",
    );
    return 1;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename))
  process.exitCode = await runPortableSecureReadQualification();
