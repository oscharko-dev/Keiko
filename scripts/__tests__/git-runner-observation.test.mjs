// Guards the one property this repository's git activity-log evidence rests on: a production module
// that spawns git does so through an OBSERVED runner (AGENTS.md §8 Rule 1).
//
// `gitRoutes.ts` re-exports `defaultGitProcessRunner` / `defaultGitNetworkProcessRunner` /
// `createGitProcessRunner` unchanged, and its own header used to recommend importing "the process
// surface from here". Nothing in the type system separates those from the wrapped runner
// `optionsWithDefaults` hands out, so a future route could grab one, spawn git directly, and lose
// every `git.process.failed` / `git.process.refused` line with no lint, dependency-cruiser or
// compiler signal — the review finding this test answers.
//
// The rule is per-OCCURRENCE, not per-file: each mention of a raw runner as a value must have
// `observedGitRunner` within a few lines of it. A per-file rule ("the file also mentions the
// wrapper somewhere") was written first and proved vacuous under sabotage — removing the wrapper
// call left the import behind, so the file still "mentioned" it and the guard stayed green against
// exactly the regression it exists to catch.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SERVER_SRC = join(REPO_ROOT, "packages", "keiko-server", "src");

const RAW_RUNNERS = [
  "defaultGitProcessRunner",
  "defaultGitNetworkProcessRunner",
  "createGitProcessRunner",
];

// `relative()` returns backslash-separated paths on Windows, while every literal below (EXEMPT,
// the assertions) is written forward-slash. Comparing raw `relative()` output against those
// literals would silently lose the EXEMPT entry and every `named` assertion on that platform,
// making the guard vacuous there rather than failing loudly.
function posixRelative(from, to) {
  return relative(from, to).split(sep).join("/");
}

// The module that DEFINES the wrapper cannot be required to call it.
const EXEMPT = new Set(["packages/keiko-server/src/gitProcessActivity.ts"]);

function productionSources(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...productionSources(full));
      continue;
    }
    if (!entry.endsWith(".ts") || entry.endsWith(".d.ts")) continue;
    if (entry.includes(".test.") || entry.includes(".bench.")) continue;
    if (entry.endsWith("test-support.ts") || entry.endsWith("testing.ts")) continue;
    out.push(full);
  }
  return out;
}

// Lines mentioning a raw runner as a VALUE — not a comment, not an `import type` / `export type`,
// and not the plain import or re-export that merely NAMES it for a composition root or a test.
function rawRunnerValueLines(source) {
  const lines = source.split("\n");
  const hits = [];
  let inImportOrExportBlock = false;
  for (const [index, line] of lines.entries()) {
    if (/^\s*(?:import|export)\s*\{/u.test(line)) inImportOrExportBlock = true;
    const isBlockEnd = inImportOrExportBlock && /\}\s*(?:from\s*"[^"]*"\s*)?;?\s*$/u.test(line);
    const skip =
      /^\s*(?:\/\/|\*|\/\*)/u.test(line) ||
      /\b(?:import|export)\s+type\b/u.test(line) ||
      /^\s*(?:import|export)\b/u.test(line) ||
      inImportOrExportBlock;
    if (isBlockEnd) inImportOrExportBlock = false;
    if (skip) continue;
    if (RAW_RUNNERS.some((runner) => line.includes(runner))) hits.push({ index, line });
  }
  return { hits, lines };
}

// A mention is observed when `observedGitRunner` appears within a small window around it, which is
// what a multi-line `observedGitRunner(\n  x ?? defaultGitProcessRunner,\n  …)` call looks like.
const OBSERVER_WINDOW = 4;

function unobservedRawRunnerLines(source) {
  const { hits, lines } = rawRunnerValueLines(source);
  return hits.filter(({ index }) => {
    const from = Math.max(0, index - OBSERVER_WINDOW);
    const to = Math.min(lines.length, index + OBSERVER_WINDOW + 1);
    return !lines.slice(from, to).some((line) => line.includes("observedGitRunner"));
  });
}

describe("git runner observation", () => {
  it("wraps every raw git runner a production source reaches for", () => {
    const offenders = productionSources(SERVER_SRC)
      .map((file) => ({ rel: posixRelative(REPO_ROOT, file), source: readFileSync(file, "utf8") }))
      .filter(({ rel }) => !EXEMPT.has(rel))
      .flatMap(({ rel, source }) =>
        unobservedRawRunnerLines(source).map(
          ({ index, line }) => `${rel}:${index + 1} ${line.trim()}`,
        ),
      );

    expect(offenders).toEqual([]);
  });

  it("actually inspects the files it claims to — the guard is not vacuous", () => {
    // A rule that scanned nothing would pass the assertion above forever. Pin that the sweep finds
    // the known observed spawn sites, so deleting or renaming them fails here rather than silently
    // shrinking the guarded set to zero.
    const scanned = productionSources(SERVER_SRC)
      .map((file) => posixRelative(REPO_ROOT, file))
      .filter((rel) => !EXEMPT.has(rel));
    const named = productionSources(SERVER_SRC)
      .map((file) => ({ rel: posixRelative(REPO_ROOT, file), source: readFileSync(file, "utf8") }))
      .filter(({ rel }) => !EXEMPT.has(rel))
      .filter(({ source }) => rawRunnerValueLines(source).hits.length > 0)
      .map(({ rel }) => rel);

    expect(scanned.length).toBeGreaterThan(100);
    expect(named).toContain("packages/keiko-server/src/gitRoutes.ts");
    expect(named).toContain("packages/keiko-server/src/gitRepositoryRoutes.ts");
    expect(named).toContain("packages/keiko-server/src/gitDelivery/syncExecution.ts");
    expect(named).toContain("packages/keiko-server/src/grounded-git-history-evidence.ts");
  });
});
