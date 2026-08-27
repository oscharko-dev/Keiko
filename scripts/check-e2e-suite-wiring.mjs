#!/usr/bin/env node
// End-to-end suite wiring gate (Issue #2629, epic #2285 Wave 2).
//
// A `test:e2e:*` script that no workflow ever runs is not coverage — it is a file that reads as
// coverage. Epic #2285 shipped with seven of its eight end-to-end suites in exactly that state:
// present in package.json, referenced by no lane, never executed by anything.
//
// Three invariants, all machine-checked:
//   1. WIRED — every `test:e2e:*` script in package.json is invoked by at least one workflow, or is
//      recorded in the baseline as a known-unwired suite.
//   2. RATCHET — no baseline entry is stale. A recorded suite that has since been wired, or has
//      been deleted, must leave the baseline. The list may therefore only shrink, which is what
//      makes it a debt register rather than a permanent exemption.
//   3. OWNED — every `tests/e2e/config/*.config.ts` is named by at least one `test:e2e:*` script's
//      command, or is recorded in `configsWithoutScript`, with the same ratchet as (2).
//
// Invariant 3 closes the blind spot invariant 1 cannot see (audit KEIKO-0077). Invariant 1 starts
// from the scripts, so a fully-built suite whose config never received a script is invisible to it:
// there is no script to find unwired. Four configs were in exactly that state — a suite that no
// script can even name is less runnable than one that merely runs in no lane, yet only the latter
// was gated. Enumerating the configs and requiring an owning script is the only direction that
// catches a config authored without one.
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
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { compareStrings } from "./lib/compare-strings.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_PATH = join("docs", "qa", "unwired-e2e-suites.json");
const E2E_SCRIPT_PREFIX = "test:e2e:";
const REQUIRED_PER_PR = "required-per-pr";
const SCHEDULED_NONBLOCKING = "scheduled-nonblocking";
const EVENT_NONBLOCKING = "event-nonblocking";
const UNWIRED = "unwired";
const PROTECTION_CLASSES = new Set([
  REQUIRED_PER_PR,
  SCHEDULED_NONBLOCKING,
  EVENT_NONBLOCKING,
  UNWIRED,
]);
const PROTECTION_RANK = {
  [UNWIRED]: 0,
  [EVENT_NONBLOCKING]: 1,
  [SCHEDULED_NONBLOCKING]: 2,
  [REQUIRED_PER_PR]: 3,
};
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

function workflowTriggers(workflowText) {
  const triggers = new Set();
  let inTriggerBlock = false;
  for (const raw of workflowText.split(/\r?\n/u)) {
    const body = raw.trimStart();
    const indent = raw.length - body.length;
    inTriggerBlock = collectWorkflowTriggers(triggers, body, indent, inTriggerBlock);
  }
  return triggers;
}

function collectWorkflowTriggers(triggers, body, indent, inTriggerBlock) {
  if (indent === 0) return collectTopLevelWorkflowTriggers(triggers, body, inTriggerBlock);
  return collectNestedWorkflowTrigger(triggers, body, inTriggerBlock);
}

function collectTopLevelWorkflowTriggers(triggers, body, inTriggerBlock) {
  if (body.startsWith("#")) return inTriggerBlock;
  if (body.startsWith("on:")) {
    for (const trigger of body.slice("on:".length).match(/[A-Za-z_]+/gu) ?? []) {
      triggers.add(trigger);
    }
    return true;
  }
  return body === "" ? inTriggerBlock : false;
}

function collectNestedWorkflowTrigger(triggers, body, inTriggerBlock) {
  if (body.startsWith("#")) return inTriggerBlock;
  if (!inTriggerBlock) return false;
  const trigger = /^([A-Za-z_]+):/u.exec(body)?.[1];
  if (trigger !== undefined) triggers.add(trigger);
  return true;
}

function conditionAllowsPullRequest(condition) {
  if (condition === undefined || !condition.includes("github.event_name")) return true;
  if (condition.includes("github.event_name == 'pull_request'")) return true;
  return condition.includes("github.event_name != 'pull_request'") && condition.includes("||");
}

function segmentRunsScript(segment, script) {
  const at = segment.indexOf(script);
  if (at === -1) return false;
  const before = at === 0 ? "" : segment.charAt(at - 1);
  const after = segment.charAt(at + script.length);
  return (
    (before === "" || !NAME_CHARACTER.test(before)) && (after === "" || !NAME_CHARACTER.test(after))
  );
}

function blockRunHasSuite(lines, start, runIndent, script) {
  for (const raw of lines.slice(start + 1)) {
    const body = raw.trimStart();
    const indent = raw.length - body.length;
    if (body !== "" && indent <= runIndent) return false;
    if (segmentRunsScript(stripInlineComment(raw), script)) return true;
  }
  return false;
}

function runStepHasSuite(lines, index, script) {
  const raw = lines[index];
  if (raw === undefined) return false;
  const body = raw.trimStart();
  const run = runValue(body);
  if (run === undefined) return false;
  if (!run.startsWith("|") && !run.startsWith(">")) return segmentRunsScript(run, script);
  return blockRunHasSuite(lines, index, raw.length - body.length, script);
}

function conditionBeforeStep(lines, index) {
  const previous = lines[index - 1];
  if (previous === undefined) return undefined;
  const body = previous.trimStart();
  const condition = /^(?:-[ \t]+)?if:(.*)$/u.exec(body)?.[1];
  return condition === undefined ? undefined : stripInlineComment(condition).trim();
}

function suiteStepConditions(script, workflowText) {
  const lines = workflowText.split(/\r?\n/u);
  return lines.flatMap((_, index) => {
    return runStepHasSuite(lines, index, script) ? [conditionBeforeStep(lines, index)] : [];
  });
}

function workflowRunsSuiteOnPullRequest(script, workflowText) {
  if (!isWiredInWorkflows(script, workflowText)) return false;
  return suiteStepConditions(script, workflowText).every(conditionAllowsPullRequest);
}

/**
 * Classify the strongest workflow protection a suite actually has. A passing required-per-PR lane
 * blocks a pull request; scheduled and other event/manual lanes detect regressions but do not.
 */
export function suiteProtectionClass(script, workflows) {
  let scheduled = false;
  let event = false;
  for (const workflow of workflows) {
    if (!isWiredInWorkflows(script, workflow.text)) continue;
    const triggers = workflowTriggers(workflow.text);
    if (triggers.has("pull_request") && workflowRunsSuiteOnPullRequest(script, workflow.text)) {
      return REQUIRED_PER_PR;
    }
    if (triggers.has("schedule")) scheduled = true;
    else event = true;
  }
  if (scheduled) return SCHEDULED_NONBLOCKING;
  return event ? EVENT_NONBLOCKING : UNWIRED;
}

export function checkE2eProtectionBaseline({ scripts, workflows, protectionBaseline }) {
  const suites = scripts.filter((name) => name.startsWith(E2E_SCRIPT_PREFIX)).sort(compareStrings);
  const problems = [];
  const protection = {};
  for (const suite of suites) {
    const actual = suiteProtectionClass(suite, workflows);
    protection[suite] = actual;
    const expected = protectionBaseline[suite];
    if (expected === undefined) {
      problems.push(
        `${BASELINE_PATH} has no protection class for ${suite}. Record its current class (${actual}).`,
      );
    } else if (PROTECTION_RANK[actual] < PROTECTION_RANK[expected]) {
      problems.push(
        `${suite} protection downgraded from ${expected} to ${actual}. Update its lane or the ` +
          "baseline through an explicit reviewed change.",
      );
    }
  }
  for (const suite of Object.keys(protectionBaseline).sort(compareStrings)) {
    if (!protection[suite]) {
      problems.push(
        `${BASELINE_PATH} records protection for ${suite}, which no longer exists. Remove it.`,
      );
    }
  }
  return { problems, protection };
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

const CONFIG_DIR = join("tests", "e2e", "config");
const CONFIG_SUFFIX = ".config.ts";

/**
 * Validate that every Playwright config has an owning `test:e2e:*` script. `scriptCommands` is the
 * command strings of those scripts; a config is owned when one of them names its basename, which is
 * what `--config tests/e2e/config/<name>` does. Deliberately matched on the basename rather than by
 * re-deriving the `--config` argument: an owning script that reaches the file by any other spelling
 * is still an owning script, and this cannot drift from the flag's syntax.
 */
/**
 * The Playwright config basenames a command actually RUNS, read from its `--config` arguments in
 * both spellings (`--config <path>` and `--config=<path>`). Returns basenames so an alternate but
 * equivalent path spelling still resolves to the same config, while a bare mention of the filename
 * somewhere else in the command resolves to nothing.
 */
const CONFIG_FLAG = "--config";
const CONFIG_FLAG_INLINE = `${CONFIG_FLAG}=`;

// Whitespace splitting keeps the quote characters, so `--config="…/x.config.ts"` would otherwise
// end in `.ts"` and match no config — a legitimate command reading as unowned.
function unquote(value) {
  const quoted = /^"([^"]*)"$|^'([^']*)'$/u.exec(value);
  return quoted?.[1] ?? quoted?.[2] ?? value;
}

function configArgumentValue(token, nextToken) {
  if (token.startsWith(CONFIG_FLAG_INLINE)) {
    return unquote(token.slice(CONFIG_FLAG_INLINE.length));
  }
  return token === CONFIG_FLAG && nextToken !== undefined ? unquote(nextToken) : undefined;
}

// Quote-aware, not a plain whitespace split: a quoted path may legitimately contain a space, and
// splitting it into two tokens would lose the config and report an owned config as unowned.
//
// A token is a RUN of unquoted and quoted pieces, not an alternation between them. The simpler
// `"…"|'…'|\S+` form still fails the attached spelling: at `--config="a b.ts"` the quote sits mid
// token, so the quoted branch cannot start there and `\S+` grabs `--config="a` up to the space.
// Repeating the group keeps `--config=` and `"a b.ts"` in one token.
const SHELL_TOKEN = /(?:[^\s"']+|"[^"]*"|'[^']*')+/gu;

export function playwrightConfigNames(command) {
  if (typeof command !== "string") return [];
  const tokens = command.match(SHELL_TOKEN) ?? [];
  const found = [];
  for (const [index, token] of tokens.entries()) {
    const value = configArgumentValue(token, tokens[index + 1]);
    if (value?.endsWith(CONFIG_SUFFIX) === true) found.push(basename(value));
  }
  return found;
}

export function checkE2eConfigOwnership({ configs, scriptCommands, unownedConfigs }) {
  const recorded = new Set(unownedConfigs);
  // Ownership is decided by the RESOLVED `--config` argument, not by a substring of the command.
  // A substring test accepted `echo playwright.issue-9999-orphan.config.ts` as ownership — a
  // command that runs nothing — so any config could be waved through the OWNED invariant by
  // mentioning its name. A non-string command (a malformed `"test:e2e:x": null`, which is valid
  // JSON) yields no configs rather than crashing on `.includes`; both are the fail-closed
  // direction, leaving the config unowned rather than silently blessed.
  const ownedByCommands = new Set(
    scriptCommands.flatMap((command) => playwrightConfigNames(command)),
  );
  const owned = new Set(configs.filter((config) => ownedByCommands.has(config)));
  const problems = [];

  for (const config of [...configs].sort(compareStrings)) {
    if (owned.has(config) || recorded.has(config)) continue;
    problems.push(
      `${join(CONFIG_DIR, config)} has no test:e2e:* script that runs it. Add one following the ` +
        `"test:e2e:<slug>": "playwright test --config ${CONFIG_DIR}/<config> --project=chromium" ` +
        `convention, or record it in ${BASELINE_PATH} with the reason it cannot have one yet.`,
    );
  }

  const present = new Set(configs);
  for (const config of [...recorded].sort(compareStrings)) {
    if (!present.has(config)) {
      problems.push(
        `${BASELINE_PATH} records ${config}, which no longer exists. Remove the entry.`,
      );
    } else if (owned.has(config)) {
      problems.push(
        `${BASELINE_PATH} records ${config} as having no script, but one now runs it. Remove the ` +
          "entry — the register only shrinks.",
      );
    }
  }
  return problems;
}

export function validateUnownedConfigs(configs) {
  if (!Array.isArray(configs)) {
    throw new TypeError(`${BASELINE_PATH} must carry a "configsWithoutScript" array.`);
  }
  const seen = new Set();
  for (const config of configs) {
    if (typeof config !== "string" || !config.endsWith(CONFIG_SUFFIX)) {
      throw new TypeError(
        `${BASELINE_PATH} configsWithoutScript entries must be "*${CONFIG_SUFFIX}" file names; ` +
          `found ${JSON.stringify(config)}.`,
      );
    }
    if (seen.has(config)) throw new TypeError(`${BASELINE_PATH} records ${config} more than once.`);
    seen.add(config);
  }
  return configs;
}

/**
 * The recorded reason is the whole justification for a scriptless config, so it has to be
 * enforced rather than merely conventional: an unreasoned entry is an unexplained exemption, and a
 * reason left behind by a removed entry is stale evidence. Both fail closed here.
 */
export function validateUnownedConfigReasons(configs, reasons) {
  if (typeof reasons !== "object" || reasons === null || Array.isArray(reasons)) {
    throw new TypeError(`${BASELINE_PATH} must carry a "configsWithoutScriptReasons" object.`);
  }
  for (const config of configs) {
    const reason = reasons[config];
    if (typeof reason !== "string" || reason.trim().length === 0) {
      throw new TypeError(
        `${BASELINE_PATH} records ${config} with no reason. Every configsWithoutScript entry ` +
          "needs a non-empty configsWithoutScriptReasons entry stating why a script would be wrong.",
      );
    }
  }
  const recorded = new Set(configs);
  for (const config of Object.keys(reasons)) {
    if (!recorded.has(config)) {
      throw new TypeError(
        `${BASELINE_PATH} carries a configsWithoutScriptReasons entry for ${config}, which is not ` +
          "in configsWithoutScript. Remove the stale reason.",
      );
    }
  }
  return reasons;
}

function readE2eConfigs(repoRoot) {
  return readdirSync(join(repoRoot, CONFIG_DIR)).filter((name) => name.endsWith(CONFIG_SUFFIX));
}

function readWorkflows(repoRoot) {
  const dir = join(repoRoot, ".github", "workflows");
  return readdirSync(dir)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .sort(compareStrings)
    .map((name) => ({ name, text: readFileSync(join(dir, name), "utf8") }));
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

function validateProtectionBaseline(protection) {
  if (typeof protection !== "object" || protection === null || Array.isArray(protection)) {
    throw new TypeError(`${BASELINE_PATH} must carry a "suiteProtection" object.`);
  }
  for (const [suite, protectionClass] of Object.entries(protection)) {
    if (!suite.startsWith(E2E_SCRIPT_PREFIX)) {
      throw new TypeError(`${BASELINE_PATH} suiteProtection keys must be E2E script names.`);
    }
    if (typeof protectionClass !== "string" || !PROTECTION_CLASSES.has(protectionClass)) {
      throw new TypeError(`${BASELINE_PATH} records an invalid protection class for ${suite}.`);
    }
  }
  return protection;
}

function readBaseline(repoRoot) {
  const parsed = JSON.parse(readFileSync(join(repoRoot, BASELINE_PATH), "utf8"));
  // Absent field ⇒ nothing recorded ⇒ every scriptless config fails. That is the fail-closed
  // direction, so a baseline predating this list degrades to "stricter", never to "silent".
  const configsWithoutScript = validateUnownedConfigs(parsed.configsWithoutScript ?? []);
  validateUnownedConfigReasons(configsWithoutScript, parsed.configsWithoutScriptReasons ?? {});
  return {
    suites: validateBaselineSuites(parsed.suites),
    suiteProtection: validateProtectionBaseline(parsed.suiteProtection ?? {}),
    configsWithoutScript,
  };
}

/**
 * Read package.json, the workflows and the baseline from `repoRoot` and evaluate the gate over
 * them. Exported so the suite exercises the real readers against the real repository — a gate
 * whose only coverage is over synthetic fixtures never proves it can load its own inputs.
 */
export function runE2eSuiteWiringGate(repoRoot = REPO_ROOT) {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  const allScripts = pkg.scripts ?? {};
  const scripts = Object.keys(allScripts);
  const { suites: baseline, suiteProtection, configsWithoutScript } = readBaseline(repoRoot);
  const configs = readE2eConfigs(repoRoot);
  const workflows = readWorkflows(repoRoot);
  const protection = checkE2eProtectionBaseline({
    scripts,
    workflows,
    protectionBaseline: suiteProtection,
  });
  return {
    problems: [
      ...checkE2eSuiteWiring({
        scripts,
        workflowText: workflows.map((workflow) => workflow.text).join("\n"),
        baseline,
      }),
      ...protection.problems,
      ...checkE2eConfigOwnership({
        configs,
        scriptCommands: scripts
          .filter((name) => name.startsWith(E2E_SCRIPT_PREFIX))
          .map((name) => allScripts[name]),
        unownedConfigs: configsWithoutScript,
      }),
    ],
    total: scripts.filter((name) => name.startsWith(E2E_SCRIPT_PREFIX)).length,
    recorded: baseline.length,
    configs: configs.length,
    unownedConfigs: configsWithoutScript.length,
    protection: protection.protection,
  };
}

export function formatGateReport({
  problems,
  total,
  recorded,
  configs,
  unownedConfigs,
  protection = {},
}) {
  if (problems.length > 0) {
    return [
      `e2e-suite-wiring: FAIL — ${String(problems.length)} problem(s)`,
      ...problems.map((problem) => `  - ${problem}`),
      "",
    ].join("\n");
  }
  const suiteLines = Object.entries(protection)
    .sort(([left], [right]) => compareStrings(left, right))
    .map(([suite, protectionClass]) => {
      const blocksPullRequest =
        protectionClass === REQUIRED_PER_PR ? "blocks PR" : "does not block PR";
      return `  - ${suite}: ${protectionClass} (${blocksPullRequest})`;
    });
  return [
    `e2e-suite-wiring: PASS — ${String(total - recorded)} of ${String(total)} suite(s) run in a ` +
      `workflow; ${String(recorded)} recorded as not yet wired. ` +
      `${String(configs - unownedConfigs)} of ${String(configs)} config(s) have an owning script; ` +
      `${String(unownedConfigs)} recorded as scriptless.`,
    ...suiteLines,
    "",
  ].join("\n");
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
