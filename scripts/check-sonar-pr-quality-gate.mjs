#!/usr/bin/env node

import { execFileSync } from "node:child_process";

import { parseChangedFiles } from "./check-mutation-scope.mjs";
import { isCoverableProductSource, systemGitExecutable } from "./sonar-analysis-scope.mjs";
import {
  KEIKO_GATE_ID,
  KEIKO_REPOSITORY_GATE_CONTRACT,
  SONAR_MAIN_BRANCH,
  SONAR_ORGANIZATION,
  SONAR_PROJECT_KEY,
  countAwareRateFailures,
  gateContractFailures,
} from "./sonar-quality-gate-contract.mjs";

const sonarBaseUrl = "https://sonarcloud.io";

function finiteNumber(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function evaluateSonarPullRequest({
  analysis,
  analyzable = true,
  customGate,
  headSha,
  issuesTotal,
  measures,
  overallMeasures,
}) {
  return [
    ...analysisFailures(analysis, headSha),
    ...findingFailures(issuesTotal, measures, analyzable),
    ...coverageFailures(measures, analyzable),
    ...duplicationFailures(measures, analyzable),
    ...newHotspotFailures(measures, analyzable),
    ...overallHotspotFailures(overallMeasures),
    ...gateContractFailures(customGate),
  ];
}

function analysisFailures(analysis, headSha) {
  const failures = [];
  if (analysis === undefined) failures.push("SonarCloud has no analysis for this pull request.");
  if (analysis?.commitSha !== headSha)
    failures.push("SonarCloud analysis is not bound to the current head commit.");
  if (analysis?.qualityGateStatus !== KEIKO_REPOSITORY_GATE_CONTRACT.nativeGateStatus)
    failures.push(`SonarCloud native quality gate is ${analysis?.qualityGateStatus ?? "missing"}.`);
  return failures;
}

function findingFailures(issuesTotal, measures, analyzable) {
  return [
    ...issueTotalFailures(issuesTotal),
    ...violationFailures(measures),
    ...lineCountFailures(measures, analyzable),
  ];
}

function issueTotalFailures(issuesTotal) {
  if (issuesTotal === undefined) return ["SonarCloud issue total is missing."];
  if (issuesTotal !== KEIKO_REPOSITORY_GATE_CONTRACT.unresolvedPullRequestIssuesMaximum) {
    return [`SonarCloud reports ${String(issuesTotal)} unresolved issue(s).`];
  }
  return [];
}

function violationFailures(measures) {
  if (measures.new_violations === undefined) return ["New-code violation metric is missing."];
  if (measures.new_violations !== KEIKO_REPOSITORY_GATE_CONTRACT.newViolationsMaximum)
    return [`SonarCloud reports ${String(measures.new_violations)} new violation(s).`];
  return [];
}

// The new-code re-checks (line count, coverage, duplication, new-code hotspots) re-verify what the
// native Keiko Banking Grade gate already enforces. They fail closed when SonarCloud omits a metric
// because, for a change that touches coverable product source, an absent metric means a partial or
// untrustworthy analysis. When `analyzable` is false the pull request changed no coverable product
// source (docs, workflow, or other non-lcov paths), so SonarCloud legitimately reports no new-code
// metrics and there is nothing for these re-checks to evaluate. The always-on checks — native gate
// status, gate contract, unresolved issues, new violations, and overall hotspot review — still run.
function lineCountFailures(measures, analyzable) {
  if (!analyzable) return [];
  return measures.new_lines === undefined ? ["New-code line count metric is missing."] : [];
}

function coverageFailures(measures, analyzable) {
  if (!analyzable) return [];
  if (measures.new_lines === undefined)
    return ["Cannot evaluate new-code coverage: Sonar did not report a new-code line count."];
  return countAwareRateFailures({
    count: measures.new_lines_to_cover,
    label: "New-code coverage",
    rate: measures.new_coverage,
    violates: (value) => value < KEIKO_REPOSITORY_GATE_CONTRACT.newCodeCoverageMinimum,
  });
}

function duplicationFailures(measures, analyzable) {
  if (!analyzable) return [];
  return countAwareRateFailures({
    count: measures.new_duplicated_lines,
    label: "New-code duplication",
    rate: measures.new_duplicated_lines_density,
    violates: (value) => value > KEIKO_REPOSITORY_GATE_CONTRACT.newCodeDuplicationMaximum,
  });
}

function newHotspotFailures(measures, analyzable) {
  if (!analyzable) return [];
  return countAwareRateFailures({
    count: measures.new_security_hotspots,
    label: "New-code security-hotspot review",
    rate: measures.new_security_hotspots_reviewed,
    violates: (value) => value < KEIKO_REPOSITORY_GATE_CONTRACT.newCodeHotspotReviewMinimum,
  });
}

// Determines whether the pull request changed any coverable product source. A base revision is
// required to compute the diff; without one we fail closed by treating the change as analyzable so
// the full new-code evidence is still required. Reuses the same diff shape as the sibling LCOV
// source-mapping gate so both gates classify changed files identically.
export function isAnalyzableChange({
  base,
  execute = execFileSync,
  head,
  root = process.cwd(),
} = {}) {
  if (base === undefined || base.length === 0) return true;
  const changed = parseChangedFiles(
    execute(
      systemGitExecutable(),
      ["diff", "--name-status", "--diff-filter=ACMR", `${base}...${head}`],
      { cwd: root, encoding: "utf8" },
    ),
  );
  return changed.some(isCoverableProductSource);
}

function overallHotspotFailures(measures = {}) {
  return countAwareRateFailures({
    count: measures.security_hotspots,
    label: "Overall security-hotspot review",
    rate: measures.security_hotspots_reviewed,
    violates: (value) => value < KEIKO_REPOSITORY_GATE_CONTRACT.overallHotspotReviewMinimum,
  });
}

export async function sonarJson(path, token, request = globalThis.fetch) {
  const headers =
    token === undefined || token.length === 0 ? {} : { Authorization: `Bearer ${token}` };
  const response = await request(`${sonarBaseUrl}${path}`, { headers });
  if (!response.ok) throw new Error(`SonarCloud API returned ${String(response.status)}.`);
  return response.json();
}

export function measuresFromPayload(payload) {
  return Object.fromEntries(
    (payload.component?.measures ?? []).map((measure) => [
      measure.metric,
      finiteNumber(measure.period?.value ?? measure.periods?.[0]?.value ?? measure.value),
    ]),
  );
}

async function fetchEvidence(pullRequest, token, load = sonarJson) {
  const project = encodeURIComponent(SONAR_PROJECT_KEY);
  const pr = encodeURIComponent(pullRequest);
  const metrics =
    "new_coverage,new_duplicated_lines,new_duplicated_lines_density,new_lines,new_lines_to_cover,new_security_hotspots,new_security_hotspots_reviewed,new_violations";
  const overallMetrics = "security_hotspots,security_hotspots_reviewed";
  const organization = encodeURIComponent(SONAR_ORGANIZATION);
  const branch = encodeURIComponent(SONAR_MAIN_BRANCH);
  const [pullRequests, issues, measures, overall, customGate] = await Promise.all([
    load(`/api/project_pull_requests/list?project=${project}`, token),
    load(
      `/api/issues/search?componentKeys=${project}&pullRequest=${pr}&resolved=false&ps=1`,
      token,
    ),
    load(
      `/api/measures/component?component=${project}&pullRequest=${pr}&metricKeys=${metrics}`,
      token,
    ),
    load(
      `/api/measures/component?component=${project}&branch=${branch}&metricKeys=${overallMetrics}`,
      token,
    ),
    load(`/api/qualitygates/show?organization=${organization}&id=${KEIKO_GATE_ID}`, token),
  ]);
  const entry = pullRequests.pullRequests?.find((candidate) => candidate.key === pullRequest);
  return {
    analysis:
      entry === undefined
        ? undefined
        : { commitSha: entry.commit?.sha, qualityGateStatus: entry.status?.qualityGateStatus },
    issuesTotal: finiteNumber(issues.total),
    measures: measuresFromPayload(measures),
    overallMeasures: measuresFromPayload(overall),
    customGate,
  };
}

export async function runSonarPullRequestGateCli(input = {}) {
  const env = input.env ?? process.env;
  const pullRequest = env.SONAR_PULL_REQUEST;
  const headSha = env.SONAR_HEAD_SHA;
  if (pullRequest === undefined || headSha === undefined)
    throw new Error("SONAR_PULL_REQUEST and SONAR_HEAD_SHA are required.");
  await (input.run ?? runSonarPullRequestGate)({
    base: env.SONAR_BASE_SHA,
    headSha,
    pullRequest,
    token: env.SONAR_TOKEN,
  });
}

export async function runSonarPullRequestGate({
  base,
  execute,
  headSha,
  load = sonarJson,
  log = console.log,
  pullRequest,
  root,
  token,
}) {
  const evidence = await fetchEvidence(pullRequest, token, load);
  const analyzable = isAnalyzableChange({ base, execute, head: headSha, root });
  const failures = evaluateSonarPullRequest({ ...evidence, analyzable, headSha });
  if (failures.length > 0) throw new Error(failures.join(" "));
  log(`sonar-pr-quality-gate: PASS - PR #${pullRequest} is clean at ${headSha}.`);
}

export async function executeSonarPullRequestGateCli(input = {}) {
  try {
    await runSonarPullRequestGateCli(input);
  } catch (error) {
    (input.error ?? console.error)(
      `sonar-pr-quality-gate: FAIL - ${error instanceof Error ? error.message : String(error)}`,
    );
    (input.setExitCode ?? ((value) => (process.exitCode = value)))(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await executeSonarPullRequestGateCli();
