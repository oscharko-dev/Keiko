import {
  OPEN_RUN_STATUSES,
  readReleaseDispatchRuns,
  remoteTagCommit,
} from "./release-candidate.mjs";

// ADR-0177 D8: the last job of a stable tag build asks release.yml to publish exactly that build, so
// nobody copies a run id into a dispatch form. It publishes nothing itself: the publish job it starts
// still waits for the npm-publish approval (ADR-0170 D3). This module owns the decision;
// scripts/request-release-publish.mjs only wires gh.

const COMMIT_SHA = /^[0-9a-f]{40}$/u;
const STABLE_TAG = /^v\d+\.\d+\.\d+$/u;
const REPOSITORY = /^[\w.-]+\/[\w.-]+$/u;
const PORTABLE_ASSETS_ARTIFACT_NAME = "portable-release-assets";

class ReleasePublishRequestError extends Error {}

function fail(message) {
  throw new ReleasePublishRequestError(`request-release-publish: ${message}`);
}

function runId(value) {
  if (!Number.isSafeInteger(value) || value <= 0)
    fail("a superseded run id is not a positive integer.");
  return value;
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0 || String(number) !== String(value)) {
    fail(`${label} is not a positive integer.`);
  }
  return number;
}

/**
 * @param releaseRuns   release.yml workflow_dispatch runs, newest first, as the API lists them
 * @param remoteTagSha  the commit the tag points at now, or undefined
 * @returns {{ action: "dispatch" | "skip", cancel: number[], reason: string }}
 */
export function releasePublishRequestPlan({ releaseRuns, remoteTagSha, sourceSha, tag }) {
  if (typeof tag !== "string" || !STABLE_TAG.test(tag))
    fail("the tag is not a stable release tag.");
  if (typeof sourceSha !== "string" || !COMMIT_SHA.test(sourceSha)) {
    fail("the build commit is not a full SHA.");
  }
  if (remoteTagSha !== sourceSha) {
    return {
      action: "skip",
      cancel: [],
      reason: `${tag} now points at ${remoteTagSha ?? "nothing"}, whose own build asks for its publish`,
    };
  }
  const open = releaseRuns.filter(
    (run) =>
      run?.head_branch === tag &&
      run?.event === "workflow_dispatch" &&
      OPEN_RUN_STATUSES.has(run?.status),
  );
  // A publish of an older candidate that still waits for approval would only fail closed once
  // approved; cancelling it keeps the approval queue to the build that can actually publish.
  const cancel = open
    .filter((run) => run.head_sha !== sourceSha && run.status === "waiting")
    .map((run) => runId(run.id));
  if (open.some((run) => run.head_sha === sourceSha)) {
    return {
      action: "skip",
      cancel,
      reason: `a publish of ${tag} at ${sourceSha} is already open`,
    };
  }
  return {
    action: "dispatch",
    cancel,
    reason: `${tag} at ${sourceSha} is ready for the npm-publish approval`,
  };
}

function requestInputs(env) {
  const repository = env.GITHUB_REPOSITORY;
  if (typeof repository !== "string" || !REPOSITORY.test(repository)) {
    fail("GITHUB_REPOSITORY is not owner/repo.");
  }
  return {
    repository,
    runAttempt: positiveInteger(env.RUN_ATTEMPT, "RUN_ATTEMPT"),
    runId: positiveInteger(env.RUN_ID, "RUN_ID"),
    sourceSha: env.SOURCE_SHA,
    tag: env.RELEASE_TAG,
  };
}

function cancelSupersededRuns(runGh, repository, runIds) {
  return runIds.filter((id) => {
    const result = runGh([
      "api",
      "--method",
      "POST",
      `repos/${repository}/actions/runs/${id}/cancel`,
    ]);
    return result?.error !== undefined || result?.status !== 0;
  });
}

/**
 * @param runGh  (args) => {status, stdout, stderr, error}, with a token that holds actions: write
 * @returns the report line
 */
export function runReleasePublishRequest({ env, runGh }) {
  const inputs = requestInputs(env);
  const plan = releasePublishRequestPlan({
    releaseRuns: readReleaseDispatchRuns(runGh, inputs.repository),
    remoteTagSha: remoteTagCommit(runGh, inputs.repository, inputs.tag),
    sourceSha: inputs.sourceSha,
    tag: inputs.tag,
  });
  const notCancelled = cancelSupersededRuns(runGh, inputs.repository, plan.cancel);
  // Dispatching past a stale approval would put two approvals for one tag in the queue.
  if (notCancelled.length > 0) {
    fail(`superseded publish run(s) ${notCancelled.join(", ")} could not be cancelled.`);
  }
  if (plan.action === "dispatch") {
    const dispatched = runGh([
      "workflow",
      "run",
      "release.yml",
      "--repo",
      inputs.repository,
      "--ref",
      inputs.tag,
      "-f",
      "publish=true",
      "-f",
      "npm_dist_tag=latest",
      "-f",
      `portable_assets_run_id=${inputs.runId}`,
      "-f",
      `portable_assets_run_attempt=${inputs.runAttempt}`,
      "-f",
      `portable_assets_artifact_name=${PORTABLE_ASSETS_ARTIFACT_NAME}`,
    ]);
    if (dispatched?.error !== undefined || dispatched?.status !== 0) {
      fail(`release.yml could not be dispatched for ${inputs.tag}.`);
    }
  }
  return `Publish request for ${inputs.tag}: ${plan.action}, ${plan.reason}; cancelled ${plan.cancel.length} superseded run(s).`;
}

/**
 * The CLI around runReleasePublishRequest: the report line on stdout and in the step summary, or one
 * error line on stderr and exit code 1.
 *
 * @param write  (stream: "stdout" | "stderr", text) => void
 */
export function releasePublishRequestMain({ appendFile, env, runGh, write }) {
  try {
    const line = runReleasePublishRequest({ env, runGh });
    if (env.GITHUB_STEP_SUMMARY) appendFile(env.GITHUB_STEP_SUMMARY, `${line}\n`);
    write("stdout", `${line}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const known =
      message.startsWith("request-release-publish: ") || message.startsWith("release-candidate: ");
    const report = known ? message : `request-release-publish: ${message}`;
    write("stderr", `${report}\n`);
    return 1;
  }
}
