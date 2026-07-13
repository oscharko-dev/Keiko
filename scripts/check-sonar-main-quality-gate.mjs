#!/usr/bin/env node

import { pathToFileURL } from "node:url";

import {
  evaluateSonarPullRequest,
  measuresFromPayload,
  sonarJson,
} from "./check-sonar-pr-quality-gate.mjs";
import {
  KEIKO_GATE_ID,
  SONAR_MAIN_BRANCH,
  SONAR_ORGANIZATION,
  SONAR_PROJECT_KEY,
} from "./sonar-quality-gate-contract.mjs";

function finiteNumber(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

async function fetchMainEvidence(token, load) {
  const project = encodeURIComponent(SONAR_PROJECT_KEY);
  const branch = encodeURIComponent(SONAR_MAIN_BRANCH);
  const organization = encodeURIComponent(SONAR_ORGANIZATION);
  const newMetrics =
    "new_coverage,new_duplicated_lines,new_duplicated_lines_density,new_lines,new_lines_to_cover,new_security_hotspots,new_security_hotspots_reviewed,new_violations";
  const overallMetrics = "security_hotspots,security_hotspots_reviewed";
  const [analyses, status, issues, measures, overall, customGate] = await Promise.all([
    load(`/api/project_analyses/search?project=${project}&branch=${branch}&ps=1`, token),
    load(`/api/qualitygates/project_status?projectKey=${project}&branch=${branch}`, token),
    load(
      `/api/issues/search?componentKeys=${project}&branch=${branch}&resolved=false&sinceLeakPeriod=true&ps=1`,
      token,
    ),
    load(
      `/api/measures/component?component=${project}&branch=${branch}&metricKeys=${newMetrics}`,
      token,
    ),
    load(
      `/api/measures/component?component=${project}&branch=${branch}&metricKeys=${overallMetrics}`,
      token,
    ),
    load(`/api/qualitygates/show?organization=${organization}&id=${KEIKO_GATE_ID}`, token),
  ]);
  const latest = analyses.analyses?.[0];
  return {
    analysis:
      latest === undefined
        ? undefined
        : {
            commitSha: latest.revision,
            qualityGateStatus: status.projectStatus?.status,
          },
    customGate,
    issuesTotal: finiteNumber(issues.total),
    measures: measuresFromPayload(measures),
    overallMeasures: measuresFromPayload(overall),
  };
}

export async function runSonarMainGate({ headSha, load = sonarJson, log = console.log, token }) {
  const evidence = await fetchMainEvidence(token, load);
  const failures = evaluateSonarPullRequest({ ...evidence, headSha });
  if (failures.length > 0) throw new Error(failures.join(" "));
  log(`sonar-main-quality-gate: PASS - dev is clean at ${headSha}.`);
}

export async function runSonarMainGateCli(input = {}) {
  const env = input.env ?? process.env;
  if (env.SONAR_HEAD_SHA === undefined) throw new Error("SONAR_HEAD_SHA is required.");
  await (input.run ?? runSonarMainGate)({
    headSha: env.SONAR_HEAD_SHA,
    token: env.SONAR_TOKEN,
  });
}

export async function executeSonarMainGateCli(input = {}) {
  try {
    await runSonarMainGateCli(input);
  } catch (error) {
    (input.error ?? console.error)(
      `sonar-main-quality-gate: FAIL - ${error instanceof Error ? error.message : String(error)}`,
    );
    (input.setExitCode ?? ((value) => (process.exitCode = value)))(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await executeSonarMainGateCli();
}
