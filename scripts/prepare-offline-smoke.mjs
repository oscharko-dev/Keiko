#!/usr/bin/env node
// Prepares everything the installable-package smoke needs before any step that can mutate the
// installed dependency tree (#3130):
//
//   1. caches the pinned Yarn, so the gate never reaches the package-manager host mid-run; and
//   2. seeds the offline vendor registry from the intact `node_modules`.
//
// Both are prerequisites rather than work the gate should do itself. The seeding in particular has
// to happen before `prune:package-native-optionals`, which deletes the native optional packages —
// a seed created after it would serve inert stubs where the real host binding belongs.
//
// Idempotent: a cached tool and an existing seed are left alone.

import { pathToFileURL } from "node:url";

import {
  isSmokeGateFailure,
  prepareOfflineSmokeForSetup,
  smokeGateFailureSetupSummary,
} from "./installable-package-smoke.mjs";

export async function runPrepareOfflineSmoke(options = {}) {
  const {
    exit = (code) => process.exit(code),
    isFailure = isSmokeGateFailure,
    prepare = prepareOfflineSmokeForSetup,
    setupSummary = smokeGateFailureSetupSummary,
    writeError = (message) => console.error(message),
  } = options;
  try {
    await prepare();
  } catch (error) {
    if (isFailure(error)) {
      writeError(`installable-smoke failed: ${setupSummary(error)}`);
      exit(1);
      return;
    }
    // Everything else — an unwritable temp directory, a cache path that fails its ownership check —
    // would otherwise surface as a raw Node stack trace in a CI setup step and name neither the step
    // nor the cause.
    const reason = error instanceof Error ? error.message : String(error);
    writeError(`prepare-offline-smoke: could not prepare the offline smoke: ${reason}`);
    exit(1);
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runPrepareOfflineSmoke();
}
