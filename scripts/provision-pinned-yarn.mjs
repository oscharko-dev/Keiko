#!/usr/bin/env node
// Downloads the pinned Yarn into Corepack's cache so the installable-package smoke never has to
// (#3130). The smoke resolves its dependencies entirely offline; acquiring the package-manager
// binary is the one thing it cannot do without a network, so that step belongs in setup — before
// the gate — rather than inside it, where an outage at the package-manager host would fail a
// required check that has nothing to do with Keiko.
//
// Idempotent: a cached tool is left alone and no request is made.

import { provisionPinnedYarnForSetup } from "./installable-package-smoke.mjs";

try {
  provisionPinnedYarnForSetup();
} catch (error) {
  // A Corepack failure already exits through the smoke's own diagnostic. This catch is for
  // everything else — an unwritable temp directory, a cache path that fails its ownership check —
  // which would otherwise surface as a raw Node stack trace in a CI setup step and name neither
  // the step nor the cause.
  const reason = error instanceof Error ? error.message : String(error);
  console.error(`provision-pinned-yarn: could not provision the pinned Yarn: ${reason}`);
  process.exit(1);
}
