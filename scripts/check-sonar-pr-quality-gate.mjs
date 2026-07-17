#!/usr/bin/env node

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
  customGate,
  headSha,
  issuesTotal,
  measures,
  overallMeasures,
}) {
  return [
    ...analysisFailures(analysis, headSha),
    ...findingFailures(issuesTotal, measures),
    ...coverageFailures(measures),
    ...duplicationFailures(measures),
    ...newHotspotFailures(measures),
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

function findingFailures(issuesTotal, measures) {
  return [
    ...issueTotalFailures(issuesTotal),
    ...violationFailures(measures),
    ...lineCountFailures(measures),
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

function lineCountFailures(measures) {
  return measures.new_lines === undefined ? ["New-code line count metric is missing."] : [];
}

function coverageFailures(measures) {
  if (measures.new_lines === undefined)
    return ["Cannot evaluate new-code coverage: Sonar did not report a new-code line count."];
  if (measures.new_lines === 0) return []; // documentation-only PR: no new code lines
  return countAwareRateFailures({
    count: measures.new_lines_to_cover,
    label: "New-code coverage",
    rate: measures.new_coverage,
    violates: (value) => value < KEIKO_REPOSITORY_GATE_CONTRACT.newCodeCoverageMinimum,
  });
}

function duplicationFailures(measures) {
  if (measures.new_lines === undefined)
    return ["Cannot evaluate new-code duplication: Sonar did not report a new-code line count."];
  if (measures.new_lines === 0) return []; // documentation-only PR: no new code lines
  return countAwareRateFailures({
    count: measures.new_duplicated_lines,
    label: "New-code duplication",
    rate: measures.new_duplicated_lines_density,
    violates: (value) => value > KEIKO_REPOSITORY_GATE_CONTRACT.newCodeDuplicationMaximum,
  });
}

function newHotspotFailures(measures) {
  return countAwareRateFailures({
    count: measures.new_security_hotspots,
    label: "New-code security-hotspot review",
    rate: measures.new_security_hotspots_reviewed,
    violates: (value) => value < KEIKO_REPOSITORY_GATE_CONTRACT.newCodeHotspotReviewMinimum,
  });
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
    headSha,
    pullRequest,
    token: env.SONAR_TOKEN,
  });
}

export async function runSonarPullRequestGate({
  headSha,
  load = sonarJson,
  log = console.log,
  pullRequest,
  token,
}) {
  const evidence = await fetchEvidence(pullRequest, token, load);
  const failures = evaluateSonarPullRequest({ ...evidence, headSha });
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
