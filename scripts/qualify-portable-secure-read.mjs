#!/usr/bin/env node

import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { runSecureWorkspaceReadBuild } from "./build-secure-workspace-read.mjs";
import { smokeSecureReadExecutable } from "./portable-secure-read-smoke.mjs";
import { PORTABLE_TARGETS, portableTargetByName, sha256File } from "./portable-runtime.mjs";
import { hashHelperSourceTree } from "./stage-dev-coding-runtime.mjs";

const helperSource = resolve(dirname(import.meta.filename), "../native/secure-workspace-read");

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
  const sourceTreeSha256 = hashHelperSourceTree(helperSource);
  const root = await mkdtemp(join(tmpdir(), "keiko-secure-read-qualification-"));
  try {
    // Use the shipped basename too: the macOS linker embeds it in the ad-hoc code signature.
    const executable = join(
      root,
      `keiko-secure-workspace-read${process.platform === "win32" ? ".exe" : ""}`,
    );
    const code = await runSecureWorkspaceReadBuild({
      argv: [process.execPath, "build-secure-workspace-read.mjs", platformTarget, executable],
    });
    if (code !== 0) throw new Error("portable-secure-read-qualification: native build failed");
    await smokeSecureReadExecutable(executable, target.nodePlatform, load);
    if (hashHelperSourceTree(helperSource) !== sourceTreeSha256)
      throw new Error("portable-secure-read-qualification: helper source changed during proof");
    // Bind the passing native proof to the actual bytes before the temporary artifact is removed.
    // This is build evidence for review, never an automatic runtime approval.
    return {
      platformTarget,
      sha256: await sha256File(executable),
      sizeBytes: (await stat(executable)).size,
      sourceTreeSha256,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export async function runPortableSecureReadQualification(argv = process.argv) {
  try {
    if (argv.length > 3)
      throw new TypeError("portable-secure-read-qualification: invalid arguments");
    const target = argv[2] ?? nativeSecureReadTarget();
    const evidence = await qualifyPortableSecureRead(target);
    console.log(`portable-secure-read-qualification: identity ${JSON.stringify(evidence)}`);
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
