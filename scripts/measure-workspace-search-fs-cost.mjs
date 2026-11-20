#!/usr/bin/env node
// Reproducible measurement of the workspace text-search walk (#4438, epic #4429).
// Usage: node scripts/measure-workspace-search-fs-cost.mjs <corpus-root> [runs]
// Builds nothing and writes nothing: it searches <corpus-root> for a literal that matches no file,
// counts every WorkspaceFs port call per method, and prints wall time per run plus calls per file.
// Point it at a synthetic corpus only; never at a cloud-synced folder (reads hydrate files).
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import {
  DEFAULT_SEARCH_LIMITS,
  detectWorkspaceAt,
  searchText,
} from "../packages/keiko-workspace/dist/index.js";
import { nodeWorkspaceFs } from "../packages/keiko-workspace/dist/fs.js";

const NO_MATCH = "keiko-4438-no-such-literal-zz9";

function countingFs(counts) {
  const wrapped = {};
  for (const [name, value] of Object.entries(nodeWorkspaceFs)) {
    wrapped[name] =
      typeof value === "function"
        ? (...args) => {
            counts[name] = (counts[name] ?? 0) + 1;
            return value.apply(nodeWorkspaceFs, args);
          }
        : value;
  }
  return wrapped;
}

async function runOnce(root, counts) {
  const fs = counts === undefined ? nodeWorkspaceFs : countingFs(counts);
  const started = performance.now();
  const result = await searchText(
    { workspace: detectWorkspaceAt(root), scopeId: "measure-4438", relativePaths: [] },
    { kind: "regex", text: NO_MATCH, caseSensitive: false, maxResults: 20, emittedAtMs: 0 },
    { ...DEFAULT_SEARCH_LIMITS, maxMatchesReturned: 20 },
    { fs },
  );
  return { ms: performance.now() - started, result };
}

async function timeSequentially(root, runs) {
  if (runs <= 0) return [];
  const { ms } = await runOnce(root);
  return [Math.round(ms), ...(await timeSequentially(root, runs - 1))];
}

async function main() {
  const root = resolve(process.argv[2] ?? "");
  const runs = Number(process.argv[3] ?? "3");
  const counts = {};
  const counted = await runOnce(root, counts);
  const files = counted.result.filesScanned;
  // Runs are timed one after another on purpose: parallel runs would contend for the same disk.
  const timings = await timeSequentially(root, runs);
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  console.log(JSON.stringify({ files, timingsMs: timings, totalCalls: total, counts }, null, 2));
}

await main();
