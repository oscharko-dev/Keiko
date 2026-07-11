#!/usr/bin/env node

const projectKey = "oscharko-dev_Keiko";
const sonarBaseUrl = "https://sonarcloud.io";

function finiteNumber(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function evaluateSonarPullRequest({ analysis, headSha, issuesTotal, measures }) {
  return [
    ...analysisFailures(analysis, headSha),
    ...findingFailures(issuesTotal, measures),
    ...coverageFailures(measures),
  ];
}

function analysisFailures(analysis, headSha) {
  const failures = [];
  if (analysis === undefined) failures.push("SonarCloud has no analysis for this pull request.");
  if (analysis?.commitSha !== headSha)
    failures.push("SonarCloud analysis is not bound to the current head commit.");
  if (analysis?.qualityGateStatus !== "OK")
    failures.push(`SonarCloud native quality gate is ${analysis?.qualityGateStatus ?? "missing"}.`);
  return failures;
}

function findingFailures(issuesTotal, measures) {
  const failures = [];
  if (issuesTotal !== 0)
    failures.push(`SonarCloud reports ${String(issuesTotal)} unresolved issue(s).`);
  if (measures.new_violations !== 0)
    failures.push(`SonarCloud reports ${String(measures.new_violations)} new violation(s).`);
  if (measures.new_duplicated_lines_density === undefined)
    failures.push("New-code duplication metric is missing.");
  else if (measures.new_duplicated_lines_density > 3)
    failures.push("New-code duplication exceeds 3%.");
  if (measures.new_security_hotspots_reviewed === undefined)
    failures.push("New-code security-hotspot review metric is missing.");
  else if (measures.new_security_hotspots_reviewed < 100)
    failures.push("Not all new security hotspots are reviewed.");
  return failures;
}

function coverageFailures(measures) {
  if (measures.new_lines_to_cover === undefined)
    return ["New-code coverable-line metric is missing."];
  if (measures.new_lines_to_cover > 0 && measures.new_coverage === undefined) {
    return ["New-code coverage is missing despite coverable new lines."];
  }
  if (measures.new_coverage !== undefined && measures.new_coverage < 85)
    return [`New-code coverage ${String(measures.new_coverage)}% is below 85%.`];
  return [];
}

async function sonarJson(path, token) {
  const headers =
    token === undefined || token.length === 0 ? {} : { Authorization: `Bearer ${token}` };
  const response = await globalThis.fetch(`${sonarBaseUrl}${path}`, { headers });
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

async function fetchEvidence(pullRequest, token) {
  const project = encodeURIComponent(projectKey);
  const pr = encodeURIComponent(pullRequest);
  const metrics =
    "new_coverage,new_duplicated_lines_density,new_lines_to_cover,new_security_hotspots_reviewed,new_violations";
  const [pullRequests, issues, measures] = await Promise.all([
    sonarJson(`/api/project_pull_requests/list?project=${project}`, token),
    sonarJson(
      `/api/issues/search?componentKeys=${project}&pullRequest=${pr}&resolved=false&ps=1`,
      token,
    ),
    sonarJson(
      `/api/measures/component?component=${project}&pullRequest=${pr}&metricKeys=${metrics}`,
      token,
    ),
  ]);
  const entry = pullRequests.pullRequests?.find((candidate) => candidate.key === pullRequest);
  return {
    analysis:
      entry === undefined
        ? undefined
        : { commitSha: entry.commit?.sha, qualityGateStatus: entry.status?.qualityGateStatus },
    issuesTotal: finiteNumber(issues.total),
    measures: measuresFromPayload(measures),
  };
}

async function main() {
  const pullRequest = process.env.SONAR_PULL_REQUEST;
  const headSha = process.env.SONAR_HEAD_SHA;
  if (pullRequest === undefined || headSha === undefined)
    throw new Error("SONAR_PULL_REQUEST and SONAR_HEAD_SHA are required.");
  const evidence = await fetchEvidence(pullRequest, process.env.SONAR_TOKEN);
  const failures = evaluateSonarPullRequest({ ...evidence, headSha });
  if (failures.length > 0) throw new Error(failures.join(" "));
  console.log(`sonar-pr-quality-gate: PASS - PR #${pullRequest} is clean at ${headSha}.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(
      `sonar-pr-quality-gate: FAIL - ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
