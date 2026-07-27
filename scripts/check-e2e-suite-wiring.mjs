#!/usr/bin/env node
// End-to-end suite wiring gate (Issue #2629, epic #2285 Wave 2).
//
// A `test:e2e:*` script that no workflow ever runs is not coverage — it is a file that reads as
// coverage. Epic #2285 shipped with seven of its eight end-to-end suites in exactly that state:
// present in package.json, referenced by no lane, never executed by anything.
//
// Two invariants, both machine-checked:
//   1. WIRED — every `test:e2e:*` script in package.json is invoked by at least one workflow, or is
//      recorded in the baseline as a known-unwired suite.
//   2. RATCHET — no baseline entry is stale. A recorded suite that has since been wired, or has
//      been deleted, must leave the baseline. The list may therefore only shrink, which is what
//      makes it a debt register rather than a permanent exemption.
//
// The baseline exists because this gate was introduced over a tree that already had a backlog of
// unwired suites. Wiring all of them is a different piece of work with a real CI-minute cost;
// silently passing them, or blocking every future change until they are all wired, are both worse.
// Adding an entry is a visible diff on a governed file, exactly like the coverage baseline
// (ADR-0158's per-file floors) this borrows its shape from.
//
// Exported as `checkE2eSuiteWiring({ scripts, workflowText, baseline })` so scripts/__tests__ can
// drive it over fixtures — including an intentionally unwired suite, which is how the gate proves
// it can still fail.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { compareStrings } from "./lib/compare-strings.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_PATH = join("docs", "qa", "unwired-e2e-suites.json");
const E2E_SCRIPT_PREFIX = "test:e2e:";
// A script name continues through these characters, so a bare substring test would let
// `test:e2e:foo` be "satisfied" by a lane that only runs `test:e2e:foo-extended`.
const NAME_CHARACTER = /[A-Za-z0-9:_-]/u;

// Only two positions in a workflow actually execute a suite, and the gate reads only those:
//
//   1. a `run:` command — inline (`- run: npm run x`) or inside a `run: |` block scalar;
//   2. a bare sequence item whose whole value is the script name, which is how
//      `e2e-extended.yml` lists a group under `strategy.matrix.suite` and invokes it as
//      `npm run ${{ matrix.suite }}`.
//
// Everything else is prose. A step called `name: test:e2e:orphan`, or a trailing comment on an
// unrelated command, would otherwise mark a suite wired and silence the gate — the precise failure
// this gate exists to prevent, arriving through the gate itself.
//
// Line-oriented rather than YAML-parsed, matching the repository's other workflow gates
// (check-zizmor-anchors, check-release-required-workflow-names) and adding no dependency.
function stripInlineComment(value) {
  const at = value.search(/\s#/u);
  return at === -1 ? value : value.slice(0, at);
}

// A `run:` value, or undefined when the line is not a run step. Empty string is a real value (the
// block-scalar forms `|` and `>` are detected by the caller), so `undefined` is the only "no".
// `\s*` never sits directly against the `(.*)` remainder, and the leading classes are disjoint, so
// the engine has one path through this and cannot backtrack super-linearly (sonarjs S8786).
function runValue(body) {
  const run = /^-?[ \t]*run:(.*)$/u.exec(body);
  return run === null ? undefined : (run[1] ?? "").trimStart();
}

// A sequence item that is nothing but a value: `- test:e2e:x`, optionally quoted. Suite names
// contain colons, so the value class must keep them; `- name: x` and `- uses: y` are excluded by
// the whitespace after their key, which the single-token anchor rejects. Quote stripping is a
// separate alternation rather than a backreference — same reason as above.
const QUOTED_VALUE = /^"([^"]*)"$|^'([^']*)'$/u;

function sequenceItemValue(body) {
  const item = /^-[ \t]+(\S+)[ \t]*$/u.exec(stripInlineComment(body))?.[1];
  if (item === undefined) return undefined;
  const quoted = QUOTED_VALUE.exec(item);
  return quoted?.[1] ?? quoted?.[2] ?? item;
}

function blockScalarContinues(body, indent, blockIndent) {
  return blockIndent !== undefined && (body === "" || indent > blockIndent);
}

export function executableWorkflowSegments(workflowText) {
  const segments = [];
  let blockIndent;
  for (const raw of workflowText.split(/\r?\n/u)) {
    const body = raw.trimStart();
    const indent = raw.length - body.length;
    if (blockScalarContinues(body, indent, blockIndent)) {
      segments.push(stripInlineComment(raw));
      continue;
    }
    blockIndent = undefined;
    if (body.startsWith("#")) continue;
    const run = runValue(body);
    if (run === undefined) {
      const item = sequenceItemValue(body);
      if (item !== undefined) segments.push(item);
      continue;
    }
    if (run.startsWith("|") || run.startsWith(">")) blockIndent = indent;
    else segments.push(stripInlineComment(run));
  }
  return segments;
}

export function isWiredInWorkflows(script, workflowText) {
  return executableWorkflowSegments(workflowText).some((segment) => {
    let from = 0;
    for (;;) {
      const at = segment.indexOf(script, from);
      if (at === -1) return false;
      const before = at === 0 ? "" : segment.charAt(at - 1);
      const after = segment.charAt(at + script.length);
      if (
        (before === "" || !NAME_CHARACTER.test(before)) &&
        (after === "" || !NAME_CHARACTER.test(after))
      ) {
        return true;
      }
      from = at + script.length;
    }
  });
}

/**
 * Validate end-to-end suite wiring. Returns the list of human-readable problems; an empty list
 * means every suite either runs in a workflow or is a recorded, still-accurate baseline entry.
 */
export function checkE2eSuiteWiring({ scripts, workflowText, baseline }) {
  const suites = scripts.filter((name) => name.startsWith(E2E_SCRIPT_PREFIX)).sort(compareStrings);
  const recorded = new Set(baseline);
  const problems = [];

  for (const suite of suites) {
    if (isWiredInWorkflows(suite, workflowText) || recorded.has(suite)) continue;
    problems.push(
      `${suite} is defined in package.json but no workflow runs it. Add it to a lane, or ` +
        `record it in ${BASELINE_PATH} with the reason it cannot run yet.`,
    );
  }

  const defined = new Set(suites);
  for (const suite of [...recorded].sort(compareStrings)) {
    if (!defined.has(suite)) {
      problems.push(`${BASELINE_PATH} records ${suite}, which no longer exists. Remove the entry.`);
    } else if (isWiredInWorkflows(suite, workflowText)) {
      problems.push(
        `${BASELINE_PATH} records ${suite} as unwired, but a workflow now runs it. Remove the ` +
          "entry — the baseline only shrinks.",
      );
    }
  }
  return problems;
}

function readWorkflowText(repoRoot) {
  const dir = join(repoRoot, ".github", "workflows");
  return readdirSync(dir)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .map((name) => readFileSync(join(dir, name), "utf8"))
    .join("\n");
}

// The register is only trustworthy if it is well formed. A duplicate entry passes a naive read and
// then inflates `recorded`, so the PASS line reports fewer wired suites than there are — and with
// enough duplicates, a negative count. An entry that is not a suite name records debt against
// nothing. Both fail closed here rather than becoming a quietly wrong report.
export function validateBaselineSuites(suites) {
  if (!Array.isArray(suites)) throw new TypeError(`${BASELINE_PATH} must carry a "suites" array.`);
  const seen = new Set();
  for (const suite of suites) {
    if (typeof suite !== "string" || !suite.startsWith(E2E_SCRIPT_PREFIX)) {
      throw new TypeError(
        `${BASELINE_PATH} entries must be "${E2E_SCRIPT_PREFIX}*" script names; found ` +
          `${JSON.stringify(suite)}.`,
      );
    }
    if (seen.has(suite)) throw new TypeError(`${BASELINE_PATH} records ${suite} more than once.`);
    seen.add(suite);
  }
  return suites;
}

function readBaseline(repoRoot) {
  const parsed = JSON.parse(readFileSync(join(repoRoot, BASELINE_PATH), "utf8"));
  return validateBaselineSuites(parsed.suites);
}

/**
 * Read package.json, the workflows and the baseline from `repoRoot` and evaluate the gate over
 * them. Exported so the suite exercises the real readers against the real repository — a gate
 * whose only coverage is over synthetic fixtures never proves it can load its own inputs.
 */
export function runE2eSuiteWiringGate(repoRoot = REPO_ROOT) {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  const scripts = Object.keys(pkg.scripts ?? {});
  const baseline = readBaseline(repoRoot);
  return {
    problems: checkE2eSuiteWiring({
      scripts,
      workflowText: readWorkflowText(repoRoot),
      baseline,
    }),
    total: scripts.filter((name) => name.startsWith(E2E_SCRIPT_PREFIX)).length,
    recorded: baseline.length,
  };
}

export function formatGateReport({ problems, total, recorded }) {
  if (problems.length > 0) {
    return [
      `e2e-suite-wiring: FAIL — ${String(problems.length)} problem(s)`,
      ...problems.map((problem) => `  - ${problem}`),
      "",
    ].join("\n");
  }
  return (
    `e2e-suite-wiring: PASS — ${String(total - recorded)} of ${String(total)} suite(s) run in a ` +
    `workflow; ${String(recorded)} recorded as not yet wired.\n`
  );
}

export function main(write = (text) => process.stdout.write(text)) {
  const result = runE2eSuiteWiringGate();
  write(formatGateReport(result));
  return result.problems.length > 0 ? 1 : 0;
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href) {
  process.exitCode = main();
}
