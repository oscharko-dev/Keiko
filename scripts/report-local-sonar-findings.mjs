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

export function selectFindings(payload, { scope, changed }) {
  const findings = payload.issues.map((issue) => ({
    rule: typeof issue.rule === "string" ? issue.rule : "unknown",
    severity: typeof issue.severity === "string" ? issue.severity : "UNKNOWN",
    path: componentPath(issue.component),
    line: typeof issue.line === "number" ? issue.line : 0,
    message: typeof issue.message === "string" ? issue.message : "",
  }));
  if (scope !== SCOPE_CHANGED) return findings;
  const touched = new Set(changed);
  return findings.filter((finding) => touched.has(finding.path));
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
  const header =
    findings.length === 0
      ? `local-sonar: PASS - no unresolved finding on ${scope === SCOPE_CHANGED ? "the files you changed" : "this project"}.`
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

export function runLocalSonarReport(io = {}) {
  const scope = io.scope ?? process.env.KEIKO_SONAR_SCOPE ?? SCOPE_CHANGED;
  const changed = changedFiles(io.changed ?? process.env.KEIKO_SONAR_CHANGED ?? "");
  const payload = parseIssuePayload(io.input ?? "");
  const findings = selectFindings(payload, { scope, changed });
  (io.log ?? console.log)(renderFindings(findings, payload, scope));
  return findings;
}

async function readStdin(stream = process.stdin) {
  let text = "";
  stream.setEncoding("utf8");
  for await (const chunk of stream) text += chunk;
  return text;
}

export async function executeLocalSonarCli(io = {}) {
  const exit = io.setExitCode ?? ((value) => (process.exitCode = value));
  try {
    const input = io.input ?? (await (io.read ?? readStdin)());
    const findings = (io.run ?? runLocalSonarReport)({ ...io, input });
    exit(findings.length === 0 ? 0 : 1);
  } catch (cause) {
    (io.error ?? console.error)(`local-sonar: FAIL - ${errorMessage(cause)}`);
    exit(1);
  }
}

function errorMessage(cause) {
  return cause instanceof Error ? cause.message : String(cause);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await executeLocalSonarCli();
}
