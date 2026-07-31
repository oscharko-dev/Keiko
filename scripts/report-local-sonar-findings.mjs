#!/usr/bin/env node
// Turns the local SonarQube issue payload into the pre-push answer: which findings land on files
// this branch changed. Reads the payload on stdin; `docker/gates/run-sonar.sh` supplies it.
//
// This exists because `npm run check:sonar-rules` cannot see the rules that keep costing us CI
// rounds. eslint-plugin-sonarjs carries 279 rules in every published version up to 4.2.0; the full
// SonarJS analyzer carries hundreds more, and S7755, S7778, S7786 and S7776 are in that gap. Only a
// real analyzer finds them before the push instead of after it.
//
// It reports, it does not judge: the verdict stays with SonarCloud on the pull request. What it owes
// the reader is an honest count and no silent truncation - a finding it cannot place is listed, not
// dropped.

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const SCOPE_CHANGED = "changed";

export function parseIssuePayload(text) {
  if (typeof text !== "string" || text.trim() === "") {
    throw new TypeError("the SonarQube issue payload is empty");
  }
  const payload = JSON.parse(text);
  if (!Array.isArray(payload.issues)) {
    throw new TypeError("the SonarQube issue payload carries no issue list");
  }
  return payload;
}

/** `keiko-local:scripts/foo.mjs` -> `scripts/foo.mjs`. A component without a path stays as it is. */
export function componentPath(component) {
  if (typeof component !== "string") return "";
  const separator = component.indexOf(":");
  return separator < 0 ? component : component.slice(separator + 1);
}

// C0 and C1 control characters, named by code point rather than written into a pattern: a control
// character in source is invisible to a reviewer, and every regular-expression form of this range
// is rejected by `no-control-regex` for exactly that reason.
const C0_LAST = 0x1f;
const DELETE_CHARACTER = 0x7f;
const C1_LAST = 0x9f;

function isControlCharacter(character) {
  const codePoint = character.codePointAt(0) ?? 0;
  return codePoint <= C0_LAST || (codePoint >= DELETE_CHARACTER && codePoint <= C1_LAST);
}

const MAX_FIELD_LENGTH = 300;

/**
 * The analyzer is a connector, and connector output is untrusted text (AGENTS.md §7). A message
 * carrying an ANSI escape or a newline would rewrite the terminal report around it, so every field
 * that reaches the output is stripped of control characters and bounded in length first. The text
 * itself is kept — a finding you cannot read is a finding you cannot fix — but it can no longer
 * forge the report's own structure.
 */
export function sanitizeField(value, fallback) {
  if (typeof value !== "string") return fallback;
  const stripped = [...value]
    .map((c) => (isControlCharacter(c) ? " " : c))
    .join("")
    .trim();
  if (stripped === "") return fallback;
  return stripped.length > MAX_FIELD_LENGTH ? `${stripped.slice(0, MAX_FIELD_LENGTH)}…` : stripped;
}

export function selectFindings(payload, { scope, changed }) {
  const touched = new Set(changed);
  const selectedIssues =
    scope === SCOPE_CHANGED
      ? payload.issues.filter((issue) => touched.has(componentPath(issue.component)))
      : payload.issues;
  return selectedIssues.map((issue) => ({
    rule: sanitizeField(issue.rule, "unknown"),
    severity: sanitizeField(issue.severity, "UNKNOWN"),
    path: sanitizeField(componentPath(issue.component), ""),
    line: typeof issue.line === "number" && Number.isSafeInteger(issue.line) ? issue.line : 0,
    message: sanitizeField(issue.message, ""),
  }));
}

/**
 * Truncation is reported, never silent: a reader who sees 500 findings must be told that the server
 * had more, or they will read a capped list as a complete one.
 */
export function renderFindings(findings, payload, scope) {
  const lines = findings.map(
    (finding) =>
      `  ${finding.severity} ${finding.rule}  ${finding.path}:${String(finding.line)}\n    ${finding.message}`,
  );
  const total = typeof payload.total === "number" ? payload.total : payload.issues.length;
  const capped = total > payload.issues.length;
  const subject = scope === SCOPE_CHANGED ? "the files you changed" : "this project";
  const header =
    findings.length === 0
      ? `local-sonar: PASS - no unresolved finding on ${subject}.`
      : `local-sonar: ${String(findings.length)} finding(s) SonarCloud would likely report.`;
  const note = capped
    ? `\nlocal-sonar: NOTE - the server holds ${String(total)} finding(s); only ${String(payload.issues.length)} were fetched.`
    : "";
  return [header, ...lines].join("\n") + note;
}

function changedFiles(raw) {
  return raw
    .split("\n")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

function changedFilesFromJson(raw) {
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
    throw new TypeError("the changed-file JSON must be an array of strings");
  }
  return parsed;
}

export function isTruncated(payload) {
  const total = typeof payload.total === "number" ? payload.total : payload.issues.length;
  return total > payload.issues.length;
}

function truncatedVerdictIsIndeterminate(payload, scope, changed) {
  if (!isTruncated(payload)) return false;
  if (scope !== SCOPE_CHANGED) return true;
  return changed.length > 0;
}

export function runLocalSonarReport(io = {}) {
  const scope = io.scope ?? process.env.KEIKO_SONAR_SCOPE ?? SCOPE_CHANGED;
  const changedJson = io.changedJson ?? process.env.KEIKO_SONAR_CHANGED_JSON;
  const changed =
    changedJson === undefined
      ? changedFiles(io.changed ?? process.env.KEIKO_SONAR_CHANGED ?? "")
      : changedFilesFromJson(changedJson);
  const payload = parseIssuePayload(io.input ?? "");
  const findings = selectFindings(payload, { scope, changed });
  (io.log ?? writeOut)(renderFindings(findings, payload, scope));
  const truncated = isTruncated(payload);
  const indeterminate = truncatedVerdictIsIndeterminate(payload, scope, changed);
  return { findings, indeterminate, truncated };
}

async function readStdin(stream = process.stdin) {
  let text = "";
  stream.setEncoding("utf8");
  for await (const chunk of stream) text += chunk;
  return text;
}

const writeOut = (text) => process.stdout.write(`${text}\n`);
const writeErr = (text) => process.stderr.write(`${text}\n`);

export async function executeLocalSonarCli(io = {}) {
  const exit = io.setExitCode ?? ((value) => (process.exitCode = value));
  const error = io.error ?? writeErr;
  try {
    const input = io.input ?? (await (io.read ?? readStdin)());
    const { findings, indeterminate } = (io.run ?? runLocalSonarReport)({ ...io, input });
    if (indeterminate) {
      // A capped page can hide the very finding this run exists to catch, so an empty scoped list
      // over a truncated payload is not a pass when the verdict covers any files. A known-empty
      // diff cannot contain a hidden finding and remains a deterministic pass.
      error("local-sonar: FAIL - the analyzer returned a truncated issue list; narrow the scope.");
      exit(1);
      return;
    }
    exit(findings.length === 0 ? 0 : 1);
  } catch (cause) {
    error(`local-sonar: FAIL - ${errorMessage(cause)}`);
    exit(1);
  }
}

function errorMessage(cause) {
  return cause instanceof Error ? cause.message : String(cause);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await executeLocalSonarCli();
}
