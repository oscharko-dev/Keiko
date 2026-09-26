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
  smokeGateFailureLogSummary,
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
    // Everything else may carry local paths or endpoint-shaped text, so keep only the stable
    // fingerprint and byte counts while naming the failing setup step.
    writeError(
      `prepare-offline-smoke: could not prepare the offline smoke: ${smokeGateFailureLogSummary(
        error,
      )}`,
    );
    exit(1);
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runPrepareOfflineSmoke();
}
