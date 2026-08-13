#!/usr/bin/env node
// Downloads the pinned Yarn into Corepack's cache so the installable-package smoke never has to
// (#3130). The smoke resolves its dependencies entirely offline; acquiring the package-manager
// binary is the one thing it cannot do without a network, so that step belongs in setup — before
// the gate — rather than inside it, where an outage at the package-manager host would fail a
// required check that has nothing to do with Keiko.
//
// Idempotent: a cached tool is left alone and no request is made.

import { provisionPinnedYarnForSetup } from "./installable-package-smoke.mjs";

provisionPinnedYarnForSetup();
