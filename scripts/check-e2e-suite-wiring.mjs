#!/usr/bin/env node
// End-to-end suite wiring gate (Issue #2629, epic #2285 Wave 2).
//
// A `test:e2e:*` script that no workflow ever runs is not coverage — it is a file that reads as
// coverage. Epic #2285 shipped with seven of its eight end-to-end suites in exactly that state:
// present in package.json, referenced by no lane, never executed by anything.
//
// Five invariants, all machine-checked:
//   1. WIRED — every `test:e2e:*` script in package.json is invoked by at least one workflow, or is
//      recorded in the baseline as a known-unwired suite.
//   2. RATCHET — no baseline entry is stale. A recorded suite that has since been wired, or has
//      been deleted, must leave the baseline. The list may therefore only shrink, which is what
//      makes it a debt register rather than a permanent exemption. Every register below carries the
//      same ratchet and the same enforced reason.
//   3. OWNED — every `tests/e2e/config/*.config.ts` is named by at least one `test:e2e:*` script's
//      command, or is recorded in `configsWithoutScript`.
//   4. REACHABLE — every `tests/e2e/*.spec.ts` is reachable from a `test:e2e:*` script, or is
//      recorded in `specsWithoutLane` (audits KEIKO-0078 / KEIKO-0080, #2955).
//   5. ROUTED — every `/api/...` literal a retained spec names resolves to a route the server
//      actually mounts, or is recorded in `externalApiPaths` (audit KEIKO-0094, #2955).
//
// Invariants 4 and 5 are documented in full at their own sections below; the short version is that
// 1-3 each start from an artifact that already declares itself runnable, and a spec file declares
// nothing — so seventy spec files, and every route they called, were outside this gate entirely.
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

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parseDocument } from "yaml";

import { compareStrings } from "./lib/compare-strings.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_PATH = join("docs", "qa", "unwired-e2e-suites.json");
const E2E_SCRIPT_PREFIX = "test:e2e:";
const RUNS_PER_PR = "runs-per-pr";
const PULL_REQUEST_NONBLOCKING = "pull-request-nonblocking";
const PUSH_NONBLOCKING = "push-nonblocking";
const SCHEDULED_NONBLOCKING = "scheduled-nonblocking";
const MANUAL_NONBLOCKING = "manual-nonblocking";
const UNWIRED = "unwired";
const PROTECTION_CLASSES = new Set([
  RUNS_PER_PR,
  PULL_REQUEST_NONBLOCKING,
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
  // A pull-request execution that may continue after a failure supplies signal, but cannot block
  // delivery. Keep it below the blocking class while retaining that useful execution fact.
  [PULL_REQUEST_NONBLOCKING]: 4,
  [RUNS_PER_PR]: 5,
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

function hasContinueOnErrorAtIndent(lines, start, end, indent) {
  for (let index = start; index < end; index += 1) {
    const raw = lines[index];
    if (raw === undefined || lineIndent(raw) !== indent) continue;
    const value = mappingValue(raw, "continue-on-error");
    if (continuesOnError(value)) return true;
  }
  return false;
}

function continuesOnError(value) {
  // The classification may call a lane blocking only when it can prove that a failing suite
  // fails its step and job. An expression (or malformed value) is therefore non-blocking unless
  // it is the literal false value GitHub Actions documents for this field.
  return value !== undefined && value !== "false";
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

function directSuiteStepExecution(lines, runIndex) {
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
  const stepEndIndex = stepEnd(lines, start);
  const jobEndIndex = jobEnd(lines, job);
  return {
    conditions: [...stepConditions, ...jobConditions],
    continuesOnError:
      continuesOnError(mappingValue(raw, "continue-on-error")) ||
      hasContinueOnErrorAtIndent(lines, start + 1, stepEndIndex, stepIndent + 2) ||
      hasContinueOnErrorAtIndent(lines, job, jobEndIndex, lineIndent(lines[job]) + 2),
  };
}

function suiteStepExecutions(script, workflowText) {
  const lines = workflowText.split(/\r?\n/u);
  return lines.flatMap((_, index) => {
    const raw = lines[index];
    if (
      raw === undefined ||
      (!runStepHasSuite(lines, index, script) && !matrixRunStepHasSuite(lines, index, script))
    ) {
      return [];
    }
    const execution = directSuiteStepExecution(lines, index);
    return execution === undefined ? [undefined] : [execution];
  });
}

function stepRunsOnEvent(execution, event) {
  return (
    execution !== undefined &&
    execution.conditions.every((condition) => conditionAllowsEvent(condition, event))
  );
}

function protectionClassForEvent(event, continuesOnError) {
  if (event === "pull_request" && continuesOnError) return PULL_REQUEST_NONBLOCKING;
  if (event === "pull_request") return RUNS_PER_PR;
  if (event === "push") return PUSH_NONBLOCKING;
  if (event === "schedule") return SCHEDULED_NONBLOCKING;
  return MANUAL_NONBLOCKING;
}

function workflowProtectionClass(script, workflowText) {
  const triggers = workflowTriggers(workflowText);
  let protection = UNWIRED;
  for (const execution of suiteStepExecutions(script, workflowText)) {
    for (const event of triggers) {
      if (!stepRunsOnEvent(execution, event)) continue;
      const eventProtection = protectionClassForEvent(event, execution.continuesOnError);
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
    } else if (actual !== expected) {
      problems.push(
        `${suite} protection changed from ${expected} to ${actual}. Update its lane or the ` +
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

// Four registers now record debt in this one file, and a register is only trustworthy if it is
// well formed: a duplicate entry passes a naive read and then inflates the recorded count, so the
// PASS line reports fewer wired suites than there are — and with enough duplicates, a negative
// count. An entry that is not of the register's own kind records debt against nothing. Both fail
// closed here rather than becoming a quietly wrong report. One implementation, so a fifth register
// cannot arrive with a subtly different notion of "well formed".
function validateRegisterEntries(values, { field, describes, accepts }) {
  if (!Array.isArray(values)) {
    throw new TypeError(`${BASELINE_PATH} must carry a "${field}" array.`);
  }
  const seen = new Set();
  for (const value of values) {
    if (typeof value !== "string" || !accepts(value)) {
      throw new TypeError(
        `${BASELINE_PATH} ${field} entries must be ${describes}; found ${JSON.stringify(value)}.`,
      );
    }
    if (seen.has(value)) throw new TypeError(`${BASELINE_PATH} records ${value} more than once.`);
    seen.add(value);
  }
  return values;
}

/**
 * The recorded reason is the whole justification for a register entry, so it has to be enforced
 * rather than merely conventional: an unreasoned entry is an unexplained exemption, and a reason
 * left behind by a removed entry is stale evidence. Both fail closed here.
 */
function validateRegisterReasons(values, reasons, { field, reasonsField, requirement }) {
  if (typeof reasons !== "object" || reasons === null || Array.isArray(reasons)) {
    throw new TypeError(`${BASELINE_PATH} must carry a "${reasonsField}" object.`);
  }
  for (const value of values) {
    const reason = reasons[value];
    if (typeof reason !== "string" || reason.trim().length === 0) {
      throw new TypeError(
        `${BASELINE_PATH} records ${value} with no reason. Every ${field} entry ` +
          `needs a non-empty ${reasonsField} entry stating ${requirement}.`,
      );
    }
  }
  const recorded = new Set(values);
  for (const value of Object.keys(reasons)) {
    if (!recorded.has(value)) {
      throw new TypeError(
        `${BASELINE_PATH} carries a ${reasonsField} entry for ${value}, which is not ` +
          `in ${field}. Remove the stale reason.`,
      );
    }
  }
  return reasons;
}

export function validateUnownedConfigs(configs) {
  return validateRegisterEntries(configs, {
    field: "configsWithoutScript",
    describes: `"*${CONFIG_SUFFIX}" file names`,
    accepts: (value) => value.endsWith(CONFIG_SUFFIX),
  });
}

export function validateUnownedConfigReasons(configs, reasons) {
  return validateRegisterReasons(configs, reasons, {
    field: "configsWithoutScript",
    reasonsField: "configsWithoutScriptReasons",
    requirement: "why a script would be wrong",
  });
}

export function validateUnreachableSpecs(specs) {
  return validateRegisterEntries(specs, {
    field: "specsWithoutLane",
    describes: `"*${SPEC_SUFFIX}" file names`,
    accepts: (value) => value.endsWith(SPEC_SUFFIX),
  });
}

export function validateUnreachableSpecReasons(specs, reasons) {
  return validateRegisterReasons(specs, reasons, {
    field: "specsWithoutLane",
    reasonsField: "specsWithoutLaneReasons",
    requirement: "why no lane can run it yet",
  });
}

export function validateExternalApiPaths(paths) {
  return validateRegisterEntries(paths, {
    field: "externalApiPaths",
    describes: '"/api/*" paths',
    accepts: (value) => value.startsWith("/api/"),
  });
}

export function validateExternalApiPathReasons(paths, reasons) {
  return validateRegisterReasons(paths, reasons, {
    field: "externalApiPaths",
    reasonsField: "externalApiPathReasons",
    requirement: "why this server deliberately does not mount it",
  });
}

// ─── Invariant 4: REACHABLE ────────────────────────────────────────────────────────────────────
//
// Invariants 1-3 each start from an artifact that already declares itself runnable: a `test:e2e:*`
// script, or a Playwright config. A spec file declares nothing, so `tests/e2e/*.spec.ts` had no
// dimension at all. Eleven specs sat in the tree named by no script and by no config's literal
// `testMatch` — indistinguishable, to this gate, from the fifty-nine that run, because it never
// enumerated them (audits KEIKO-0078 / KEIKO-0080, #2955).
//
// A spec is REACHABLE when some `test:e2e:*` script actually runs it:
//   a) the command names its path (`playwright test tests/e2e/x.spec.ts …`);
//   b) the command's `--config` resolves to a config whose LITERAL `testMatch` names it;
//   c) the command's `--config` resolves to a config that collects by glob AND the command carries
//      a `--grep <tag>` the spec declares.
//
// (b) is literal-only on purpose. The shared config's `testMatch: "**/*.spec.ts"` collects every
// spec in the tree, so honouring a glob would mark all seventy reachable through a config whose
// only script greps `@smoke` — the gate would report total coverage over a lane that runs eight.
// A glob config reaches a spec only through (c), where the tag is the real selector.
const SPEC_DIR = join("tests", "e2e");
const SPEC_SUFFIX = ".spec.ts";

// Blank every comment while copying string literals through byte-for-byte. Blanking rather than
// deleting keeps offsets stable, and copying strings verbatim keeps `"http://127.0.0.1"` from being
// truncated at its own `//`. A misread region is copied rather than dropped, so the failure
// direction is "the gate sees a path it should have ignored", never "the gate missed a call".
export function blankComments(source) {
  const out = [];
  let index = 0;
  while (index < source.length) {
    if (source.startsWith("//", index)) index = blankLineComment(source, index, out);
    else if (source.startsWith("/*", index)) index = blankBlockComment(source, index, out);
    else if (isQuoteCharacter(source[index])) index = copyStringLiteral(source, index, out);
    else {
      out.push(source[index]);
      index += 1;
    }
  }
  return out.join("");
}

function isQuoteCharacter(character) {
  return character === '"' || character === "'" || character === "`";
}

function blankLineComment(source, start, out) {
  let index = start;
  while (index < source.length && source[index] !== "\n") {
    out.push(" ");
    index += 1;
  }
  return index;
}

function blankBlockComment(source, start, out) {
  const terminator = source.indexOf("*/", start + 2);
  const stop = terminator === -1 ? source.length : terminator + 2;
  for (let index = start; index < stop; index += 1) {
    out.push(source[index] === "\n" ? "\n" : " ");
  }
  return stop;
}

function copyStringLiteral(source, start, out) {
  const quote = source[start];
  if (quote === "`") return copyTemplateLiteral(source, start, out);
  out.push(quote);
  let index = start + 1;
  while (index < source.length) {
    const character = source[index];
    out.push(character);
    index += 1;
    if (character === "\\" && index < source.length) {
      out.push(source[index]);
      index += 1;
    } else if (character === quote) break;
  }
  return index;
}

/**
 * A template literal, copied verbatim to its REAL end.
 *
 * Treating the backtick as a plain toggle desynchronises on a nested template: the inner backtick
 * of `` `outer ${`http://inner`} tail` `` closes the outer string early, the scanner drops into
 * code mode over the remaining text, and the first `//` it meets there blanks the rest of the line
 * — taking any real route call or tag on it along. That is a silent fail-open for both invariants,
 * so the interpolation is tracked by depth and a nested quote is handed back to the copier.
 */
function copyTemplateLiteral(source, start, out) {
  const state = { depth: 0, index: start + 1 };
  out.push(source[start]);
  while (state.index < source.length) {
    if (source[state.index] === "`" && state.depth === 0) {
      out.push("`");
      return state.index + 1;
    }
    copyTemplateCharacter(source, state, out);
  }
  return state.index;
}

function copyTemplateCharacter(source, state, out) {
  const character = source[state.index];
  if (character === "\\") {
    state.index = copyEscapedPair(source, state.index, out);
    return;
  }
  if (character === "$" && source[state.index + 1] === "{") {
    out.push("$", "{");
    state.depth += 1;
    state.index += 2;
    return;
  }
  if (state.depth > 0 && isQuoteCharacter(character)) {
    state.index = copyStringLiteral(source, state.index, out);
    return;
  }
  if (state.depth > 0 && character === "{") state.depth += 1;
  if (state.depth > 0 && character === "}") state.depth -= 1;
  out.push(character);
  state.index += 1;
}

function copyEscapedPair(source, index, out) {
  out.push(source[index]);
  if (index + 1 >= source.length) return index + 1;
  out.push(source[index + 1]);
  return index + 2;
}

// A Playwright config selects specs through `testMatch` and excludes through `testIgnore`. Both are
// read as literals: a quoted name, an array of quoted names, or a regular expression whose escaped
// dots spell one file name. Anything containing a `*` is a glob and selects nothing LITERALLY —
// see (b) above for why that distinction is the whole point.
export function configSelectorValues(rawText, key) {
  // Blanked first, exactly as the spec side is. `.exec` returns the FIRST match in the file, so a
  // prose comment mentioning a quoted `testMatch:` above the real declaration would win over it —
  // and this repository writes dense explanatory comments in precisely these files. The spec-side
  // extractors already blank; leaving this one raw was the asymmetry.
  const text = blankComments(rawText);
  const single = new RegExp(String.raw`${key}:\s*"([^"]*)"`, "u").exec(text);
  if (single !== null) return [single[1]];
  const array = new RegExp(String.raw`${key}:\s*\[([^\]]*)\]`, "u").exec(text);
  if (array !== null) return [...array[1].matchAll(/"([^"]*)"/gu)].map((match) => match[1]);
  const expression = new RegExp(String.raw`${key}:\s*/([^/\n]*)/[a-z]*`, "u").exec(text);
  return expression === null ? [] : [expression[1].replaceAll("\\", "")];
}

export function parseConfigSelection(text) {
  const match = configSelectorValues(text, "testMatch");
  return {
    literals: match.filter((value) => !value.includes("*")),
    collectsByGlob: match.length === 0 || match.some((value) => value.includes("*")),
    ignoredGlobs: configSelectorValues(text, "testIgnore"),
  };
}

function globMatches(glob, name) {
  const escaped = glob.replaceAll(/[.+^${}()|[\]\\]/gu, String.raw`\$&`).replaceAll("*", "[^/]*");
  return new RegExp(`^${escaped}$`, "u").test(name);
}

function configReachesSpec(selection, spec) {
  if (selection.ignoredGlobs.some((glob) => globMatches(glob, spec))) return false;
  return selection.literals.includes(spec);
}

// The `@tag` values a spec declares, read from its comment-blanked source so a tag named only in a
// comment cannot pass for a selector. `--grep @smoke` matches on the rendered test title, so the
// tag may equally live in a title literal or in a constant the title interpolates.
export function declaredSpecTags(source) {
  return new Set([...blankComments(source).matchAll(/@[a-z][a-z0-9-]*/giu)].map((m) => m[0]));
}

/**
 * The effective `--grep` / `--grep-invert` of a command.
 *
 * Playwright registers both as ordinary Commander options, so a repeated flag OVERWRITES rather
 * than accumulating — modelling several `--grep` flags as a conjunction would call a spec reachable
 * that Playwright never selects. `--grep-invert` is read for the same reason in the other
 * direction: a script that excludes a tag does not run the specs carrying it, and a gate blind to
 * the exclusion reports coverage that does not exist.
 */
function commandGrepFilters(command) {
  if (typeof command !== "string") return { grep: undefined, invert: undefined };
  const tokens = command.match(SHELL_TOKEN) ?? [];
  const filters = { grep: undefined, invert: undefined };
  for (const [index, token] of tokens.entries()) {
    for (const [flag, key] of [
      ["--grep", "grep"],
      ["--grep-invert", "invert"],
    ]) {
      if (token === flag && tokens[index + 1] !== undefined)
        filters[key] = unquote(tokens[index + 1]);
      else if (token.startsWith(`${flag}=`)) filters[key] = unquote(token.slice(flag.length + 1));
    }
  }
  return filters;
}

// A positional `*.spec.ts` argument, which is how `test:e2e:editor-chat-2119` names its one file.
// A `--config` value is excluded by construction: it never ends in `.spec.ts`.
/**
 * The spec files a command actually hands to Playwright.
 *
 * Two things have to be true of a token before it counts, and both were once missing. It must
 * belong to a `playwright` invocation — `echo tests/e2e/new.spec.ts && playwright test …` names a
 * spec Playwright never collects — and it must be a POSITIONAL operand, not a flag or a flag's
 * value, or `--output=stale.spec.ts` marks an unreachable spec reachable. Either mistake produces
 * the false-green inventory this gate exists to prevent.
 */
export function commandSpecNames(command) {
  if (typeof command !== "string") return [];
  const tokens = (command.match(SHELL_TOKEN) ?? []).map((token) => unquote(token));
  const names = [];
  let inPlaywright = false;
  for (const [index, token] of tokens.entries()) {
    // `playwright` is matched anywhere rather than only at a command start, so `npx playwright
    // test …` and a direct `node_modules/.bin/playwright` both count; a separator ends the run.
    if (SHELL_COMMAND_SEPARATORS.has(token)) inPlaywright = false;
    else if (basename(token) === "playwright") inPlaywright = true;
    else if (inPlaywright && isSpecOperand(tokens, index)) names.push(basename(token));
  }
  return names;
}

/** A positional `*.spec.ts` argument: not a flag, and not the value one consumed. */
function isSpecOperand(tokens, index) {
  const token = tokens[index] ?? "";
  if (token.startsWith("-") || VALUE_FLAGS.has(tokens[index - 1] ?? "")) return false;
  return token.endsWith(SPEC_SUFFIX);
}

const SHELL_COMMAND_SEPARATORS = new Set([";", "|", "||", "&", "&&"]);

// Playwright options that consume the following token as their value.
const VALUE_FLAGS = new Set([
  "--config",
  "-c",
  "--grep",
  "-g",
  "--grep-invert",
  "--project",
  "--reporter",
  "--output",
  "--workers",
  "--timeout",
  "--retries",
  "--shard",
]);

function scriptReachesSpec(script, spec, selections, specTags) {
  if (script.specNames.includes(spec)) return true;
  return script.configs.some((config) => {
    const selection = selections.get(config);
    if (selection === undefined) return false;
    if (configReachesSpec(selection, spec)) return true;
    return selection.collectsByGlob && grepReachesSpec(script, spec, selection, specTags);
  });
}

function grepReachesSpec(script, spec, selection, specTags) {
  if (selection.ignoredGlobs.some((glob) => globMatches(glob, spec))) return false;
  const declared = specTags.get(spec);
  const { grep, invert } = script.filters;
  if (grep === undefined || declared?.has(grep) !== true) return false;
  return invert === undefined || !declared.has(invert);
}

function resolveScript(script) {
  return {
    name: script.name,
    specNames: commandSpecNames(script.command),
    configs: playwrightConfigNames(script.command),
    filters: commandGrepFilters(script.command),
  };
}

/**
 * Which `test:e2e:*` script runs each spec. `scripts` is `{ name, command }`; `selections` maps a
 * config file name to its parsed selection; `specTags` maps a spec name to the tags it declares.
 * Returns a Map from spec name to the first script that reaches it, so the report can name it.
 */
export function reachableSpecs({ specs, scripts, selections, specTags }) {
  const resolved = scripts.map((script) => resolveScript(script));
  const reached = new Map();
  for (const spec of specs) {
    const owner = resolved.find((script) => scriptReachesSpec(script, spec, selections, specTags));
    if (owner !== undefined) reached.set(spec, owner.name);
  }
  return reached;
}

export function checkE2eSpecReachability({ specs, scripts, selections, specTags, recordedSpecs }) {
  const reached = reachableSpecs({ specs, scripts, selections, specTags });
  const recorded = new Set(recordedSpecs);
  const problems = [];
  for (const spec of [...specs].sort(compareStrings)) {
    if (reached.has(spec) || recorded.has(spec)) continue;
    problems.push(
      `${join(SPEC_DIR, spec)} is reachable from no test:e2e:* script. Name it in a config's ` +
        `testMatch, give it a script, or tag it into a grep lane — or record it in ` +
        `${BASELINE_PATH} with the reason it cannot run yet.`,
    );
  }
  const present = new Set(specs);
  for (const spec of [...recorded].sort(compareStrings)) {
    if (!present.has(spec)) {
      problems.push(`${BASELINE_PATH} records ${spec}, which no longer exists. Remove the entry.`);
    } else if (reached.has(spec)) {
      problems.push(
        `${BASELINE_PATH} records ${spec} as unreachable, but ${reached.get(spec)} now runs it. ` +
          "Remove the entry — the register only shrinks.",
      );
    }
  }
  return { problems, reached };
}

// ─── Invariant 5: ROUTED ───────────────────────────────────────────────────────────────────────
//
// A wired suite that calls a route the server does not mount is worse than an unwired one: it
// reads as a passing journey right up to the moment it runs. `editor-agent-docking-2122.spec.ts`
// sat in exactly that state — it POSTed `/api/editor/agent/authority` and
// `/api/coding-workbench/autonomous-delivery/confirm`, two routes #2256 deliberately UNMOUNTED,
// and its own `routes.test.ts` pins that they must stay unmounted. Nothing connected the two facts.
//
// The mounted set is read from the BUILT `API_ROUTES` rather than re-derived from the source. That
// is not a convenience: `routes.ts` composes its table from route GROUPS, some produced by factory
// calls, and one group (`AUTONOMOUS_DELIVERY_ROUTE_GROUP`) is DEFINED but deliberately never
// spread. A source scan for `pattern:` literals finds that group and would bless the exact dead
// call this invariant exists to catch. The production table is the only answer that cannot drift.
// The separator may be escaped: a spec that recognises a route with a REGULAR EXPRESSION spells it
// `/\/api\/editor\/…/u`, and a finder anchored on a bare `/api/` never matches it — the route would
// then be exempt from this invariant for no better reason than the syntax that named it.
// `normalizeApiPathReference` unescapes what this captures.
const API_PATH_REFERENCE = /(?:\\?\/)api(?:\\?\/)[^\s"'`,;)\]}>]*/gu;
// Everything after one of these is a wildcard, an interpolation, or a pattern fragment, so the
// literal bounds a FAMILY of paths rather than naming one. `page.route("**/api/git/status*")` is a
// legitimate interception of every status call; resolving it by prefix keeps that honest without
// pretending the test named a single route.
// `:` is deliberately absent. It names a parameterised SEGMENT, structurally identical to the
// `:param` the mounted patterns use, so truncating at it turned `/api/editor/gone/:id/rename` into
// the prefix `/api/editor` — which any one of the sixty-odd real editor routes then satisfies.
// Kept whole, it is matched segment-for-segment against the table instead.
const REFERENCE_TERMINATORS = ["?", "#", "$", "*", "[", "(", "{"];

export function normalizeApiPathReference(raw) {
  let path = raw.replaceAll(String.raw`\/`, "/");
  let prefix = false;
  for (const terminator of REFERENCE_TERMINATORS) {
    const at = path.indexOf(terminator);
    if (at === -1) continue;
    path = path.slice(0, at);
    prefix = true;
  }
  if (path.endsWith("/")) {
    path = path.slice(0, -1);
    prefix = true;
  }
  return { path, prefix };
}

// `request.post("/api/x")` and friends. The verb is the call site's own, so it is read from there
// rather than guessed — an interception glob or a bare string carries no method and stays
// path-only, which is what `undefined` means downstream.
const REQUEST_VERB = /\b(?:request|page)\.(get|post|put|patch|delete)\(\s*[`'"]?[^`'")]*$/u;

function referenceMethod(source, at) {
  const verb = REQUEST_VERB.exec(source.slice(Math.max(0, at - 120), at))?.[1];
  return verb === undefined ? undefined : verb.toUpperCase();
}

export function apiPathReferences(source) {
  const found = new Map();
  const blanked = blankComments(source);
  for (const match of blanked.matchAll(API_PATH_REFERENCE)) {
    const method = referenceMethod(blanked, match.index ?? 0);
    const reference = { ...normalizeApiPathReference(match[0]), method };
    // A bare `/api` carries no route to check: as a prefix it matches the entire table, so
    // accepting it would wave through whatever followed it. No spec builds a route from a bare
    // base today (they all name the full path), and one that started to would be reported by the
    // reachability of its own literal rather than silently blessed here.
    if (reference.path === "/api") continue;
    // Keyed by path AND method: one spec may legitimately GET and POST the same route, and the
    // two are different questions of the table.
    const key = `${reference.method ?? "*"} ${reference.path}`;
    const existing = found.get(key);
    if (existing === undefined || (existing.prefix && !reference.prefix)) found.set(key, reference);
  }
  return [...found.values()];
}

function patternMatchesPath(pattern, path) {
  const patternParts = pattern.split("/");
  const pathParts = path.split("/");
  if (patternParts.length !== pathParts.length) return false;
  return patternParts.every((part, index) => segmentMatches(part, pathParts[index] ?? ""));
}

// A `:param` on either side is a placeholder for one NON-EMPTY segment: an empty one comes from a
// doubled slash in an interpolated URL, which is a defect in the spec rather than a route the
// server serves, and accepting it would resolve that defect away.
function segmentMatches(patternPart, pathPart) {
  if (patternPart.startsWith(":") || pathPart.startsWith(":")) return pathPart.length > 0;
  return patternPart === pathPart;
}

export function routeResolves(reference, patterns) {
  // A method the call site named must be one the table serves for that pattern: the server
  // dispatches on method AND pattern, so `request.post("/api/health")` against a GET-only route is
  // a journey that cannot succeed, and a path-only projection called it mounted.
  const candidates = patterns.filter(
    (route) => reference.method === undefined || route.method === reference.method,
  );
  if (!reference.prefix) {
    return candidates.some((route) => patternMatchesPath(route.pattern, reference.path));
  }
  return candidates.some(
    (route) => route.pattern === reference.path || route.pattern.startsWith(`${reference.path}/`),
  );
}

/**
 * Every `/api/...` literal a retained spec names must resolve to a mounted route, or be recorded as
 * an endpoint this server deliberately does not mount. `specSources` is `{ name, source }`.
 */
export function checkE2eRouteResolution({ specSources, patterns, externalPaths }) {
  const recorded = new Set(externalPaths);
  const problems = [];
  const seen = new Set();
  for (const { name, source } of specSources) {
    for (const reference of apiPathReferences(source)) {
      if (recorded.has(reference.path)) {
        seen.add(reference.path);
        continue;
      }
      if (routeResolves(reference, patterns)) continue;
      problems.push(
        `${join(SPEC_DIR, name)} calls ${reference.path}, which no mounted server route serves. ` +
          `Repair the journey against the current route, delete it, or record the path in ` +
          `${BASELINE_PATH} with the reason this server deliberately does not mount it.`,
      );
    }
  }
  for (const path of [...recorded].sort(compareStrings)) {
    if (!seen.has(path)) {
      problems.push(
        `${BASELINE_PATH} records ${path} as an unmounted endpoint, but no spec names it any ` +
          "more. Remove the entry — the register only shrinks.",
      );
    } else if (routeResolves({ path, prefix: false }, patterns)) {
      // The other direction, and the one that matters most: an entry recorded because the server
      // deliberately does not mount a path must not survive the day it starts mounting it. Without
      // this the exemption is permanent, and the register would stop describing the server.
      problems.push(
        `${BASELINE_PATH} records ${path} as an endpoint this server does not mount, but a route ` +
          "now serves it. Remove the entry — the register only shrinks.",
      );
    }
  }
  return problems;
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

export function validateBaselineSuites(suites) {
  return validateRegisterEntries(suites, {
    field: "suites",
    describes: `"${E2E_SCRIPT_PREFIX}*" script names`,
    accepts: (value) => value.startsWith(E2E_SCRIPT_PREFIX),
  });
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
  // Absent field ⇒ nothing recorded ⇒ every scriptless config, unreachable spec and unmounted path
  // fails. That is the fail-closed direction, so a baseline predating one of these lists degrades
  // to "stricter", never to "silent".
  const configsWithoutScript = validateUnownedConfigs(parsed.configsWithoutScript ?? []);
  validateUnownedConfigReasons(configsWithoutScript, parsed.configsWithoutScriptReasons ?? {});
  const specsWithoutLane = validateUnreachableSpecs(parsed.specsWithoutLane ?? []);
  validateUnreachableSpecReasons(specsWithoutLane, parsed.specsWithoutLaneReasons ?? {});
  const externalApiPaths = validateExternalApiPaths(parsed.externalApiPaths ?? []);
  validateExternalApiPathReasons(externalApiPaths, parsed.externalApiPathReasons ?? {});
  return {
    suites: validateBaselineSuites(parsed.suites),
    suiteProtection: validateProtectionBaseline(parsed.suiteProtection ?? {}),
    configsWithoutScript,
    specsWithoutLane,
    externalApiPaths,
  };
}

const SERVER_ROUTE_TABLE = join("packages", "keiko-server", "dist", "index.js");

/**
 * The patterns the product actually mounts, read from the BUILT server package export rather than
 * re-derived from `routes.ts`. Re-deriving is the failure this invariant exists to catch: the table
 * is composed from route GROUPS, several produced by factory calls, and at least one group is
 * DEFINED but deliberately never spread into it. A source scan for `pattern:` literals collects
 * that group and would bless the exact dead call the gate is looking for. An unreadable table is
 * reported as the finding — never skipped, which would silently remove the invariant.
 */
const SERVER_SOURCE_DIR = join("packages", "keiko-server", "src");

// The walk stats every TypeScript file in the server package, so it is done once per directory and
// remembered: nothing can change it inside a single run, and the suite calls the gate four times.
const newestSourceTimes = new Map();

/** The newest modification time under a directory, or 0 when it does not exist. */
function newestSourceTime(directory) {
  const cached = newestSourceTimes.get(directory);
  if (cached !== undefined) return cached;
  let newest = 0;
  if (existsSync(directory)) {
    for (const entry of readdirSync(directory, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
      newest = Math.max(newest, statSync(join(entry.parentPath ?? entry.path, entry.name)).mtimeMs);
    }
  }
  newestSourceTimes.set(directory, newest);
  return newest;
}

/**
 * A built table older than the source it was built from answers the wrong question.
 *
 * This is not hypothetical: the invariant's motivating incident is a route #2256 UNMOUNTED, and a
 * dist predating that removal still exports it — so the dead call the gate exists to catch resolves
 * cleanly. CI always builds before this step, but the local run AGENTS.md asks for is exactly where
 * a stale dist sits, so the check belongs here rather than in the lane ordering.
 */
function assertRouteTableIsFresh(repoRoot, entry) {
  const built = statSync(entry).mtimeMs;
  const source = newestSourceTime(join(repoRoot, SERVER_SOURCE_DIR));
  if (source <= built) return;
  throw new Error(
    `${SERVER_ROUTE_TABLE} is older than ${SERVER_SOURCE_DIR}, so the mounted route set it ` +
      "reports is not the one this checkout serves. Run `npm run build:packages` first.",
  );
}

// Read in a CHILD Node process, not by importing here. The server package is a large module graph,
// and a test runner that intercepts module loading transforms all of it — which took this gate's
// own suite from eight seconds to nearly a minute. A plain `node -e` pays none of that, and the
// answer is the same production table either way.
const ROUTE_TABLE_READER = [
  "const { pathToFileURL } = require('node:url');",
  "import(pathToFileURL(process.argv[1]).href)",
  "  .then((m) => { process.stdout.write(JSON.stringify(m.API_ROUTES?.map((r) => [r.method, r.pattern]) ?? null)); })",
  "  .catch((error) => { process.stderr.write(String(error?.message ?? error)); process.exit(1); });",
].join("\n");

function readRouteTable(entry) {
  const result = spawnSync(process.execPath, ["-e", ROUTE_TABLE_READER, entry], {
    encoding: "utf8",
    maxBuffer: 1 << 24,
  });
  if (result.status !== 0) {
    throw new Error(
      `${SERVER_ROUTE_TABLE} could not be loaded, so the mounted route set is unknown. Run ` +
        `\`npm run build:packages\` first — this gate reads the production route table. ` +
        `(${(result.stderr || "").trim().split("\n")[0] ?? "no detail"})`,
    );
  }
  return JSON.parse(result.stdout);
}

// Keyed by the built file, which cannot change inside one run: the CLI reads it once, but the suite
// evaluates the gate several times and each read is a child process.
const routePatternCache = new Map();

export async function mountedRoutePatterns(repoRoot) {
  const entry = join(repoRoot, SERVER_ROUTE_TABLE);
  const cached = routePatternCache.get(entry);
  if (cached !== undefined) return cached;
  if (existsSync(entry)) assertRouteTableIsFresh(repoRoot, entry);
  const table = readRouteTable(entry);
  if (!Array.isArray(table) || table.length === 0) {
    throw new TypeError(`${SERVER_ROUTE_TABLE} exported no API_ROUTES table.`);
  }
  const patterns = [
    ...new Map(
      table.map(([method, pattern]) => [`${method} ${pattern}`, { method, pattern }]),
    ).values(),
  ].sort((left, right) =>
    compareStrings(`${left.pattern} ${left.method}`, `${right.pattern} ${right.method}`),
  );
  routePatternCache.set(entry, patterns);
  return patterns;
}

// Every Playwright config a `test:e2e:*` command can name, which is a wider set than invariant 3's
// enumeration: `memoriaviva-m1-certification.config.ts` sits beside the specs rather than in the
// config directory, and a spec it selects is reachable through it all the same.
function readConfigSelections(repoRoot) {
  const directories = [join(repoRoot, SPEC_DIR), join(repoRoot, CONFIG_DIR)];
  const selections = new Map();
  for (const directory of directories) {
    for (const name of readdirSync(directory)) {
      if (!name.endsWith(CONFIG_SUFFIX)) continue;
      // A `--config` argument is resolved to its BASENAME, so two configs sharing one across the
      // two directories are indistinguishable to every caller. Picking a winner would silently
      // answer for the wrong file; there is no collision today and this keeps it that way.
      if (selections.has(name)) {
        throw new TypeError(
          `${name} exists in both ${SPEC_DIR} and ${CONFIG_DIR}. A config is addressed by its ` +
            "base name, so the two are indistinguishable — rename one.",
        );
      }
      selections.set(name, parseConfigSelection(readFileSync(join(directory, name), "utf8")));
    }
  }
  return selections;
}

function readE2eSpecs(repoRoot) {
  const directory = join(repoRoot, SPEC_DIR);
  return readdirSync(directory)
    .filter((name) => name.endsWith(SPEC_SUFFIX))
    .sort(compareStrings)
    .map((name) => ({ name, source: readFileSync(join(directory, name), "utf8") }));
}

/**
 * Read package.json, the workflows and the baseline from `repoRoot` and evaluate the gate over
 * them. Exported so the suite exercises the real readers against the real repository — a gate
 * whose only coverage is over synthetic fixtures never proves it can load its own inputs.
 */
function readGateInputs(repoRoot) {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  const allScripts = pkg.scripts ?? {};
  const scripts = Object.keys(allScripts);
  return {
    scripts,
    e2eScripts: scripts
      .filter((name) => name.startsWith(E2E_SCRIPT_PREFIX))
      .map((name) => ({ name, command: allScripts[name] })),
    baseline: readBaseline(repoRoot),
    configs: readE2eConfigs(repoRoot),
    workflows: readWorkflows(repoRoot),
    specSources: readE2eSpecs(repoRoot),
    selections: readConfigSelections(repoRoot),
  };
}

function gateProblems(inputs, protection, reachability, patterns) {
  const { scripts, e2eScripts, baseline, configs, workflows, specSources } = inputs;
  return [
    ...checkE2eSuiteWiring({
      scripts,
      workflowText: workflows.map((workflow) => workflow.text).join("\n"),
      baseline: baseline.suites,
    }),
    ...protection.problems,
    ...checkE2eConfigOwnership({
      configs,
      scriptCommands: e2eScripts.map((script) => script.command),
      unownedConfigs: baseline.configsWithoutScript,
    }),
    ...reachability.problems,
    ...checkE2eRouteResolution({
      specSources,
      patterns,
      externalPaths: baseline.externalApiPaths,
    }),
  ];
}

export async function runE2eSuiteWiringGate(repoRoot = REPO_ROOT) {
  const inputs = readGateInputs(repoRoot);
  const { baseline, configs, specSources } = inputs;
  const protection = checkE2eProtectionBaseline({
    scripts: inputs.scripts,
    workflows: inputs.workflows,
    protectionBaseline: baseline.suiteProtection,
  });
  const reachability = checkE2eSpecReachability({
    specs: specSources.map((spec) => spec.name),
    scripts: inputs.e2eScripts,
    selections: inputs.selections,
    specTags: new Map(specSources.map((spec) => [spec.name, declaredSpecTags(spec.source)])),
    recordedSpecs: baseline.specsWithoutLane,
  });
  const patterns = await mountedRoutePatterns(repoRoot);
  return {
    problems: gateProblems(inputs, protection, reachability, patterns),
    total: inputs.e2eScripts.length,
    recorded: baseline.suites.length,
    configs: configs.length,
    unownedConfigs: baseline.configsWithoutScript.length,
    specs: specSources.length,
    unreachableSpecs: baseline.specsWithoutLane.length,
    externalPaths: baseline.externalApiPaths.length,
    protection: protection.protection,
  };
}

export function formatGateReport({
  problems,
  total,
  recorded,
  configs,
  unownedConfigs,
  specs = 0,
  unreachableSpecs = 0,
  externalPaths = 0,
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
      `${String(unownedConfigs)} recorded as scriptless. ` +
      `${String(specs - unreachableSpecs)} of ${String(specs)} spec(s) are reachable from a ` +
      `script; ${String(unreachableSpecs)} recorded as laneless. Every /api path a retained spec ` +
      `names resolves to a mounted route, except ${String(externalPaths)} recorded as ` +
      "deliberately unmounted.",
    ...suiteLines,
    "",
  ].join("\n");
}

export async function main(write = (text) => process.stdout.write(text)) {
  const result = await runE2eSuiteWiringGate();
  write(formatGateReport(result));
  return result.problems.length > 0 ? 1 : 0;
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href) {
  process.exitCode = await main();
}
