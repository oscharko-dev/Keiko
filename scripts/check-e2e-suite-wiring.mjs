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

import { parseDocument } from "yaml";

import { compareStrings } from "./lib/compare-strings.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_PATH = join("docs", "qa", "unwired-e2e-suites.json");
const E2E_SCRIPT_PREFIX = "test:e2e:";
const RUNS_PER_PR = "runs-per-pr";
const PUSH_NONBLOCKING = "push-nonblocking";
const SCHEDULED_NONBLOCKING = "scheduled-nonblocking";
const MANUAL_NONBLOCKING = "manual-nonblocking";
const UNWIRED = "unwired";
const PROTECTION_CLASSES = new Set([
  RUNS_PER_PR,
  PUSH_NONBLOCKING,
  SCHEDULED_NONBLOCKING,
  MANUAL_NONBLOCKING,
  UNWIRED,
]);
const PROTECTION_RANK = {
  [UNWIRED]: 0,
  [MANUAL_NONBLOCKING]: 1,
  [SCHEDULED_NONBLOCKING]: 2,
  [PUSH_NONBLOCKING]: 3,
  [RUNS_PER_PR]: 4,
};
// Only two positions in a workflow can make a suite discoverable:
//
//   1. a `run:` command — inline (`- run: npm run x`) or inside a `run: |` block scalar;
//   2. a bare sequence item whose whole value is the script name, which is how
//      `e2e-extended.yml` lists a group under `strategy.matrix.suite` and invokes it as
//      `npm run ${{ matrix.suite }}`.
//
// For the WIRED invariant, a bare matrix item is sufficient: the workflow's indirection can still
// invoke that suite. Protection classification is stricter: it requires a concrete `npm run` step
// whose shell command and event reachability the gate can prove. This deliberately leaves a matrix
// item with no directly attributable execution step at `unwired`, rather than inventing protection.
//
// Workflow commands are read line-oriented, matching the repository's other workflow gates. The
// top-level `on` declaration is parsed as YAML because comments, quoted keys, flow collections and
// nested event filters otherwise make a text scan ambiguous.
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
  return executableWorkflowSegments(workflowText).some(
    (segment) => segment.trim() === script || shellCommandRunsScript(segment, script),
  );
}

function workflowTriggers(workflowText) {
  const document = parseDocument(workflowText);
  if (document.errors.length > 0) return new Set();
  const workflow = document.toJS();
  if (typeof workflow !== "object" || workflow === null || Array.isArray(workflow))
    return new Set();
  return knownWorkflowTriggers(workflow.on);
}

const CLASSIFIED_TRIGGER_EVENTS = new Set([
  "pull_request",
  "push",
  "schedule",
  "workflow_dispatch",
]);

function knownWorkflowTriggers(value) {
  if (typeof value === "string") return classifiedTriggerSet([value]);
  if (Array.isArray(value)) return classifiedTriggerSet(value);
  if (typeof value !== "object" || value === null) return new Set();
  return classifiedTriggerSet(Object.keys(value));
}

function classifiedTriggerSet(values) {
  return new Set(
    values.filter((value) => typeof value === "string" && CLASSIFIED_TRIGGER_EVENTS.has(value)),
  );
}

function conditionAllowsEvent(condition, event) {
  if (condition === undefined) return true;
  const expression = conditionExpression(condition, event);
  if (expression === undefined) return false;
  return evaluateBooleanExpression(expression);
}

function conditionExpression(condition, event) {
  const trimmed = condition.trim();
  const unwrapped =
    trimmed.startsWith("${{") && trimmed.endsWith("}}") ? trimmed.slice(3, -2).trim() : condition;
  const withEventValues = unwrapped
    .replace(EVENT_COMPARISON, (_match, operator, _quote, value) => {
      return String(compareKnownValue(event, operator, value));
    })
    .replace(BASE_REF_COMPARISON, (_match, operator, _quote, value) => {
      return String(event === "pull_request" && compareKnownValue("dev", operator, value));
    })
    .replace(/\balways\(\)|\bsuccess\(\)|!cancelled\(\)/gu, "true")
    .replace(UNKNOWN_REFERENCE, (value) => {
      return value === "true" || value === "false" ? value : "unknown";
    })
    .trim();
  return BOOLEAN_EXPRESSION.test(withEventValues) ? withEventValues : undefined;
}

const EVENT_COMPARISON = /github\.event_name\s*(==|!=)\s*(['"])([^'"]+)\2/gu;
const BASE_REF_COMPARISON = /github\.base_ref\s*(==|!=)\s*(['"])([^'"]+)\2/gu;
const UNKNOWN_REFERENCE = /\b[A-Za-z_][A-Za-z0-9_.]*\b/gu;
const BOOLEAN_EXPRESSION = /^(?:\s|true|false|unknown|&&|\|\||!|\(|\))+$/u;

function compareKnownValue(actual, operator, expected) {
  return operator === "==" ? actual === expected : actual !== expected;
}

function evaluateBooleanExpression(expression) {
  const tokens = expression.match(/true|false|unknown|&&|\|\||!|\(|\)/gu);
  if (tokens === null) return false;
  const state = { index: 0, tokens };
  const value = parseBooleanOr(state);
  return value === true && state.index === tokens.length;
}

function parseBooleanOr(state) {
  let value = parseBooleanAnd(state);
  while (value !== undefined && state.tokens[state.index] === "||") {
    state.index += 1;
    const right = parseBooleanAnd(state);
    if (right === undefined) return undefined;
    value = booleanOr(value, right);
  }
  return value;
}

function parseBooleanAnd(state) {
  let value = parseBooleanPrimary(state);
  while (value !== undefined && state.tokens[state.index] === "&&") {
    state.index += 1;
    const right = parseBooleanPrimary(state);
    if (right === undefined) return undefined;
    value = booleanAnd(value, right);
  }
  return value;
}

function parseBooleanPrimary(state) {
  const token = state.tokens[state.index];
  if (token === "!") {
    state.index += 1;
    const value = parseBooleanPrimary(state);
    return value === undefined ? undefined : booleanNot(value);
  }
  if (token === "(") return parseParenthesizedBoolean(state);
  if (token === "true" || token === "false") {
    state.index += 1;
    return token === "true";
  }
  if (token === "unknown") {
    state.index += 1;
    return null;
  }
  return undefined;
}

function booleanOr(left, right) {
  if (left === true || right === true) return true;
  if (left === false && right === false) return false;
  return null;
}

function booleanAnd(left, right) {
  if (left === false || right === false) return false;
  if (left === true && right === true) return true;
  return null;
}

function booleanNot(value) {
  return value === null ? null : !value;
}

function parseParenthesizedBoolean(state) {
  state.index += 1;
  const value = parseBooleanOr(state);
  if (value === undefined || state.tokens[state.index] !== ")") return undefined;
  state.index += 1;
  return value;
}

function shellTokens(command) {
  const state = { tokens: [], token: "", quote: undefined };
  for (const character of command) {
    if (state.quote !== undefined) appendQuotedShellCharacter(state, character);
    else appendUnquotedShellCharacter(state, character);
  }
  if (state.quote !== undefined) return [];
  flushShellToken(state);
  return state.tokens;
}

function appendQuotedShellCharacter(state, character) {
  if (character === state.quote) state.quote = undefined;
  else state.token += character;
}

function appendUnquotedShellCharacter(state, character) {
  if (character === '"' || character === "'") {
    state.quote = character;
  } else if (/\s/u.test(character)) {
    flushShellToken(state);
  } else if (isShellSeparator(character)) {
    flushShellToken(state);
    state.tokens.push(character);
  } else state.token += character;
}

function flushShellToken(state) {
  if (state.token === "") return;
  state.tokens.push(state.token);
  state.token = "";
}

function isShellSeparator(token) {
  return token === ";" || token === "|" || token === "&";
}

function shellCommandRunsScript(command, script) {
  const tokens = shellTokens(command);
  let commandStart = true;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (isShellSeparator(token)) {
      commandStart = true;
      continue;
    }
    if (commandStart && shellTokensRunScript(tokens, index, script)) {
      return true;
    }
    if (commandStart && isShellAssignment(token)) continue;
    commandStart = false;
  }
  return false;
}

function shellTokensRunScript(tokens, index, script) {
  return tokens[index] === "npm" && tokens[index + 1] === "run" && tokens[index + 2] === script;
}

function isShellAssignment(token) {
  const assignment = token.indexOf("=");
  if (assignment < 1 || !isShellNameStart(token.codePointAt(0))) return false;
  for (let index = 1; index < assignment; index += 1) {
    if (!isShellNameContinue(token.codePointAt(index))) return false;
  }
  return true;
}

function isShellNameStart(codePoint) {
  return (
    codePoint === 95 ||
    (codePoint >= 65 && codePoint <= 90) ||
    (codePoint >= 97 && codePoint <= 122)
  );
}

function isShellNameContinue(codePoint) {
  return isShellNameStart(codePoint) || (codePoint >= 48 && codePoint <= 57);
}

function blockRunHasSuite(lines, start, runIndent, script) {
  for (const raw of lines.slice(start + 1)) {
    const body = raw.trimStart();
    const indent = raw.length - body.length;
    if (body !== "" && indent <= runIndent) return false;
    if (shellCommandRunsScript(stripInlineComment(raw), script)) return true;
  }
  return false;
}

function runStepHasSuite(lines, index, script) {
  const raw = lines[index];
  if (raw === undefined) return false;
  const body = raw.trimStart();
  const run = runValue(body);
  if (run === undefined) return false;
  if (!run.startsWith("|") && !run.startsWith(">")) return shellCommandRunsScript(run, script);
  return blockRunHasSuite(lines, index, raw.length - body.length, script);
}

function matrixSuiteRun(run) {
  return /^npm[ \t]+run[ \t]+\$\{\{[ \t]*matrix\.suite[ \t]*\}\}[ \t]*$/u.test(run);
}

function matrixRunStepHasSuite(lines, index, script) {
  const raw = lines[index];
  if (raw === undefined || !matrixSuiteRun(runValue(raw.trimStart()) ?? "")) return false;
  const start = stepStart(lines, index);
  if (start === undefined) return false;
  const job = jobStart(lines, start);
  return job !== undefined && jobMatrixSuiteContains(lines, job, jobEnd(lines, job), script);
}

function jobMatrixSuiteContains(lines, start, end, script) {
  const jobIndent = lineIndent(lines[start] ?? "");
  const strategyIndent = jobIndent + 2;
  const matrixIndent = strategyIndent + 2;
  const suiteIndent = matrixIndent + 2;
  let state = { inStrategy: false, inMatrix: false, inSuite: false };
  for (const raw of lines.slice(start + 1, end)) {
    const indent = lineIndent(raw);
    const body = raw.trim();
    if (state.inSuite && indent > suiteIndent && sequenceItemValue(raw.trimStart()) === script) {
      return true;
    }
    state = matrixStateForLine(state, indent, body, { strategyIndent, matrixIndent, suiteIndent });
  }
  return false;
}

function matrixStateForLine(state, indent, body, indents) {
  if (indent === indents.strategyIndent) {
    return { inStrategy: body === "strategy:", inMatrix: false, inSuite: false };
  }
  if (state.inStrategy && indent === indents.matrixIndent) {
    return { ...state, inMatrix: body === "matrix:", inSuite: false };
  }
  if (state.inMatrix && indent === indents.suiteIndent) {
    return { ...state, inSuite: body === "suite:" };
  }
  return state;
}

function lineIndent(raw) {
  return raw.length - raw.trimStart().length;
}

function sequenceItemIndent(raw) {
  return /^-[ \t]+/u.test(raw.trimStart()) ? lineIndent(raw) : undefined;
}

function mappingValue(raw, key) {
  const body = raw.trimStart();
  const keyExpression = new RegExp(String.raw`^(?:-[ \t]+)?${key}:(.*)$`, "u");
  const value = keyExpression.exec(body)?.[1];
  return value === undefined ? undefined : stripInlineComment(value).trim();
}

function stepStart(lines, runIndex) {
  const run = lines[runIndex];
  if (run === undefined) return undefined;
  const runIndent = lineIndent(run);
  if (sequenceItemIndent(run) !== undefined) return runIndex;
  for (let index = runIndex - 1; index >= 0; index -= 1) {
    const candidate = lines[index];
    if (candidate === undefined) continue;
    const indent = sequenceItemIndent(candidate);
    if (indent !== undefined && indent < runIndent) return index;
  }
  return undefined;
}

function stepEnd(lines, start) {
  const first = lines[start];
  if (first === undefined) return start;
  const indent = sequenceItemIndent(first);
  if (indent === undefined) return start;
  for (let index = start + 1; index < lines.length; index += 1) {
    const candidate = lines[index];
    if (candidate !== undefined && sequenceItemIndent(candidate) === indent) return index;
  }
  return lines.length;
}

function conditionsAtIndent(lines, start, end, indent) {
  const conditions = [];
  for (let index = start; index < end; index += 1) {
    const raw = lines[index];
    if (raw !== undefined && lineIndent(raw) === indent) {
      const condition = mappingValue(raw, "if");
      if (condition !== undefined) conditions.push(condition);
    }
  }
  return conditions;
}

function jobStart(lines, step) {
  const first = lines[step];
  if (first === undefined) return undefined;
  const stepIndent = sequenceItemIndent(first);
  if (stepIndent === undefined) return undefined;
  const stepsIndent = stepIndent - 2;
  for (let index = step - 1; index >= 0; index -= 1) {
    const raw = lines[index];
    if (raw === undefined) continue;
    if (lineIndent(raw) === stepsIndent && raw.trim() === "steps:") {
      return findJobStart(lines, index, stepsIndent - 2);
    }
  }
  return undefined;
}

function findJobStart(lines, before, indent) {
  for (let index = before - 1; index >= 0; index -= 1) {
    const raw = lines[index];
    if (raw === undefined || lineIndent(raw) !== indent) continue;
    if (/^[A-Za-z][A-Za-z0-9_-]*:[ \t]*(?:#.*)?$/u.test(raw.trim())) return index;
  }
  return undefined;
}

function jobEnd(lines, start) {
  const raw = lines[start];
  if (raw === undefined) return start;
  const indent = lineIndent(raw);
  for (let index = start + 1; index < lines.length; index += 1) {
    const candidate = lines[index];
    if (candidate !== undefined && candidate.trim() !== "" && lineIndent(candidate) <= indent) {
      return index;
    }
  }
  return lines.length;
}

function directSuiteStepConditions(lines, runIndex) {
  const start = stepStart(lines, runIndex);
  if (start === undefined) return undefined;
  const raw = lines[start];
  if (raw === undefined) return undefined;
  const stepIndent = sequenceItemIndent(raw);
  if (stepIndent === undefined) return undefined;
  const initialCondition = mappingValue(raw, "if");
  const stepConditions = [
    ...(initialCondition === undefined ? [] : [initialCondition]),
    ...conditionsAtIndent(lines, start + 1, stepEnd(lines, start), stepIndent + 2),
  ];
  const job = jobStart(lines, start);
  if (job === undefined) return undefined;
  const jobConditions = conditionsAtIndent(
    lines,
    job,
    jobEnd(lines, job),
    lineIndent(lines[job]) + 2,
  );
  return [...stepConditions, ...jobConditions];
}

function suiteStepConditions(script, workflowText) {
  const lines = workflowText.split(/\r?\n/u);
  return lines.flatMap((_, index) => {
    const raw = lines[index];
    if (
      raw === undefined ||
      (!runStepHasSuite(lines, index, script) && !matrixRunStepHasSuite(lines, index, script))
    ) {
      return [];
    }
    const conditions = directSuiteStepConditions(lines, index);
    return conditions === undefined ? [undefined] : [conditions];
  });
}

function stepRunsOnEvent(conditions, event) {
  return (
    conditions !== undefined &&
    conditions.every((condition) => conditionAllowsEvent(condition, event))
  );
}

function protectionClassForEvent(event) {
  if (event === "pull_request") return RUNS_PER_PR;
  if (event === "push") return PUSH_NONBLOCKING;
  if (event === "schedule") return SCHEDULED_NONBLOCKING;
  return MANUAL_NONBLOCKING;
}

function workflowProtectionClass(script, workflowText) {
  const triggers = workflowTriggers(workflowText);
  let protection = UNWIRED;
  for (const conditions of suiteStepConditions(script, workflowText)) {
    for (const event of triggers) {
      if (!stepRunsOnEvent(conditions, event)) continue;
      const eventProtection = protectionClassForEvent(event);
      if (PROTECTION_RANK[eventProtection] > PROTECTION_RANK[protection]) {
        protection = eventProtection;
      }
    }
  }
  return protection;
}

/**
 * Classify the strongest event on which a concrete suite step actually executes. The class says
 * where the suite runs, not whether a repository setting makes a resulting check merge-required.
 */
export function suiteProtectionClass(script, workflows) {
  let protection = UNWIRED;
  for (const workflow of workflows) {
    const workflowProtection = workflowProtectionClass(script, workflow.text);
    if (PROTECTION_RANK[workflowProtection] > PROTECTION_RANK[protection]) {
      protection = workflowProtection;
    }
  }
  return protection;
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
      const runsOnPullRequest =
        protectionClass === RUNS_PER_PR ? "runs on PR" : "does not run on PR";
      return `  - ${suite}: ${protectionClass} (${runsOnPullRequest})`;
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
