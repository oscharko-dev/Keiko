import {
  OPEN_RUN_STATUSES,
  readReleaseDispatchRuns,
  remoteTagCommit,
} from "./release-candidate.mjs";

// A stable build may prepare the exact command an allowlisted human authorizes, but it never owns
// actions:write and never dispatches release.yml itself. GitHub attributes a GITHUB_TOKEN dispatch
// to github-actions[bot], which the release job correctly refuses.

const COMMIT_SHA = /^[0-9a-f]{40}$/u;
const STABLE_TAG = /^v\d+\.\d+\.\d+$/u;
const REPOSITORY = /^[\w.-]+\/[\w.-]+$/u;
const PORTABLE_ASSETS_ARTIFACT_NAME = "portable-release-assets";

class ReleasePublishHandoffError extends Error {}

function fail(message) {
  throw new ReleasePublishHandoffError(`release-publish-handoff: ${message}`);
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0 || String(number) !== String(value)) {
    fail(`${label} is not a positive integer.`);
  }
  return number;
}

function triggeringActorLogin(run) {
  const login = run?.triggering_actor?.login;
  return typeof login === "string" && login !== "" ? login : undefined;
}

function isHumanTriggered(run) {
  const login = triggeringActorLogin(run);
  return login !== undefined && !login.endsWith("[bot]");
}

/**
 * @returns {{ action: "authorize" | "existing" | "blocked", reason: string }}
 */
export function releasePublishHandoffPlan({ releaseRuns, remoteTagSha, sourceSha, tag }) {
  if (typeof tag !== "string" || !STABLE_TAG.test(tag)) {
    fail("the tag is not a stable release tag.");
  }
  if (typeof sourceSha !== "string" || !COMMIT_SHA.test(sourceSha)) {
    fail("the build commit is not a full SHA.");
  }
  if (remoteTagSha !== sourceSha) {
    return {
      action: "blocked",
      reason: `${tag} now points at ${remoteTagSha ?? "nothing"}, not this build`,
    };
  }
  const open = releaseRuns.filter(
    (run) =>
      run?.head_branch === tag &&
      run?.event === "workflow_dispatch" &&
      OPEN_RUN_STATUSES.has(run?.status),
  );
  if (open.some((run) => run.head_sha !== sourceSha)) {
    return {
      action: "blocked",
      reason: `a superseded publish of ${tag} is still open and must finish or be cancelled`,
    };
  }
  const exact = open.filter((run) => run.head_sha === sourceSha);
  if (exact.some((run) => !isHumanTriggered(run))) {
    return {
      action: "blocked",
      reason: `an exact publish of ${tag} has no verified non-bot triggering actor`,
    };
  }
  if (exact.length > 0) {
    return {
      action: "existing",
      reason: `a non-bot publish of ${tag} at ${sourceSha} is already open`,
    };
  }
  return {
    action: "authorize",
    reason: `${tag} at ${sourceSha} is ready for explicit human authorization`,
  };
}

function handoffInputs(env) {
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

function authorizationCommand(inputs) {
  return [
    "gh workflow run release.yml",
    `--repo ${inputs.repository}`,
    `--ref ${inputs.tag}`,
    "-f publish=true",
    "-f npm_dist_tag=latest",
    `-f portable_assets_run_id=${String(inputs.runId)}`,
    `-f portable_assets_run_attempt=${String(inputs.runAttempt)}`,
    `-f portable_assets_artifact_name=${PORTABLE_ASSETS_ARTIFACT_NAME}`,
  ].join(" ");
}

/**
 * @param runGh (args) => {status, stdout, stderr, error}, with read-only workflow permissions
 */
export function runReleasePublishHandoff({ env, runGh }) {
  const inputs = handoffInputs(env);
  const plan = releasePublishHandoffPlan({
    releaseRuns: readReleaseDispatchRuns(runGh, inputs.repository),
    remoteTagSha: remoteTagCommit(runGh, inputs.repository, inputs.tag),
    sourceSha: inputs.sourceSha,
    tag: inputs.tag,
  });
  if (plan.action === "blocked") fail(plan.reason);
  return {
    command: plan.action === "authorize" ? authorizationCommand(inputs) : undefined,
    line: `Publish handoff for ${inputs.tag}: ${plan.action}, ${plan.reason}.`,
    plan,
  };
}

/** The CLI writes a body-free report and, when authorization is needed, the exact owner command. */
export function releasePublishHandoffMain({ appendFile, env, runGh, write }) {
  try {
    const report = runReleasePublishHandoff({ env, runGh });
    const summary = report.command
      ? `${report.line}\n\nAuthorize this exact build as an allowlisted human:\n\n\`\`\`sh\n${report.command}\n\`\`\`\n`
      : `${report.line}\n`;
    if (env.GITHUB_STEP_SUMMARY) appendFile(env.GITHUB_STEP_SUMMARY, summary);
    write("stdout", `${report.line}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const known =
      message.startsWith("release-publish-handoff: ") || message.startsWith("release-candidate: ");
    const report = known ? message : `release-publish-handoff: ${message}`;
    write("stderr", `${report}\n`);
    return 1;
  }
}
