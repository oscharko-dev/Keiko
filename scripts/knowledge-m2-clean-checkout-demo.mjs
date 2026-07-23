#!/usr/bin/env node
// Knowledge M2 clean-checkout demo — CLI entry point (Issue #2634 / Epic #2556 Definition of Done).
//
// A three-line shim: all logic lives in `scripts/lib/clean-checkout-demo-cli.mjs` so unit tests
// can drive it directly (v8 coverage does not follow subprocess spawns). The runbook's
// `npm run demo:clean-checkout` alias resolves through this file.
//
// See `scripts/lib/clean-checkout-demo-cli.mjs` for the demo journey, evidence validation, and
// failure-line discipline.

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { runCliFromEntryPoint } from "./lib/clean-checkout-demo-cli.mjs";

const entryPoint = process.argv[1];
const isDirectInvocation =
  entryPoint !== undefined &&
  import.meta.url === pathToFileURL(resolve(entryPoint)).href &&
  existsSync(entryPoint);
if (isDirectInvocation) {
  await runCliFromEntryPoint();
}
