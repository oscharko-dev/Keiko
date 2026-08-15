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

import { prepareOfflineSmokeForSetup } from "./installable-package-smoke.mjs";

try {
  await prepareOfflineSmokeForSetup();
} catch (error) {
  // A Corepack failure already exits through the smoke's own diagnostic. This catch is for
  // everything else — an unwritable temp directory, a cache path that fails its ownership check —
  // which would otherwise surface as a raw Node stack trace in a CI setup step and name neither
  // the step nor the cause.
  const reason = error instanceof Error ? error.message : String(error);
  console.error(`prepare-offline-smoke: could not prepare the offline smoke: ${reason}`);
  process.exit(1);
}
