/**
 * Owns the shape and idempotency of the GitHub Deployment record that proves a `latest` npm
 * publish actually landed (issue #3252). `.github/workflows/release.yml`'s `publish` job carries
 * `environment: npm-publish`, so GitHub creates and manages that job's own deployment
 * automatically the moment the job starts — recording a second one from inside that job would
 * just duplicate it. Every OTHER path that promotes a package to `latest` (today: the
 * governed-container `release:publish` run used for 0.3.12-0.3.15) does not run inside that job
 * and gets no deployment for free, which is exactly how the Deployments panel fell behind npm
 * `latest`. This module is the one place that repairs that gap; `scripts/release-publish.mjs`
 * only ever runs as a spawned CLI, so the decision lives here where in-process tests can prove
 * every branch (AGENTS.md section 7's fixture rule).
 */

const NPM_PUBLISH_ENVIRONMENT = "npm-publish";
const PERMISSION_STATUS_PATTERN = /\b(403|404)\b/u;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The exact detection signal for "this is the workflow's own environment-gated `publish` job",
 * where GitHub already owns the deployment lifecycle. Both halves are required: `GITHUB_ACTIONS`
 * alone is true for every job in every workflow, and `GITHUB_JOB` alone (a bare job id) says
 * nothing about whether Actions is the thing running it.
 */
export function runsInsideActionsPublishJob(env) {
  return env.GITHUB_ACTIONS === "true" && env.GITHUB_JOB === "publish";
}

function skipReason({ env, tag, dryRun, planOnly }) {
  if (planOnly === true) return "plan-only run.";
  if (dryRun === true) return "dry run.";
  if (tag !== "latest") return `dist-tag ${String(tag)} is not latest.`;
  if (runsInsideActionsPublishJob(env)) {
    return "running inside the Actions `publish` job, which GitHub already deploys.";
  }
  return undefined;
}

function ghErrorDetail(result) {
  if (result?.error !== undefined) return result.error.message;
  return `${result?.stdout ?? ""}\n${result?.stderr ?? ""}`.trim();
}

function ghFailure(result) {
  const detail = ghErrorDetail(result);
  return { detail, httpStatus: PERMISSION_STATUS_PATTERN.exec(detail)?.[1], kind: "error" };
}

function ghParsedJson(stdout) {
  try {
    return { kind: "ok", value: JSON.parse(String(stdout ?? "")) };
  } catch {
    return { detail: "gh returned a response that was not valid JSON.", kind: "error" };
  }
}

function ghJson(spawnGh, args, input) {
  const result = spawnGh(args, input === undefined ? {} : { input });
  if (result?.error !== undefined || result?.status !== 0) return ghFailure(result);
  return ghParsedJson(result.stdout);
}

function hasSuccessfulStatus(spawnGh, repository, deploymentId) {
  const statuses = ghJson(spawnGh, [
    "api",
    `repos/${repository}/deployments/${String(deploymentId)}/statuses`,
  ]);
  return statuses.kind === "ok" && Array.isArray(statuses.value)
    ? statuses.value.some((status) => isRecord(status) && status.state === "success")
    : false;
}

/**
 * Idempotency check: a `success` deployment already recorded for this exact ref+environment
 * means this run must not create a second one. A read failure here is treated as "not found"
 * rather than fatal — the create call right after this one is what enforces fail-closed
 * permission handling, and a transient listing hiccup must not itself block re-recording.
 */
function findExistingSuccessfulDeployment({ log, ref, repository, spawnGh }) {
  const listed = ghJson(spawnGh, [
    "api",
    `repos/${repository}/deployments?ref=${encodeURIComponent(ref)}&environment=${NPM_PUBLISH_ENVIRONMENT}`,
  ]);
  if (listed.kind !== "ok" || !Array.isArray(listed.value)) {
    if (listed.kind === "error") {
      log(
        `npm-publish-deployment: could not list existing deployments for ${ref} (${listed.detail}).`,
      );
    }
    return false;
  }
  return listed.value.some(
    (deployment) =>
      isRecord(deployment) &&
      Number.isSafeInteger(deployment.id) &&
      hasSuccessfulStatus(spawnGh, repository, deployment.id),
  );
}

function permissionFailureMessage(step, result) {
  const statusNote = result.httpStatus === undefined ? "" : ` (HTTP ${result.httpStatus})`;
  return (
    `published but the GitHub deployment record was refused while ${step}${statusNote}: ` +
    `${result.detail}. The token needs the deployments:write permission on the ` +
    `${NPM_PUBLISH_ENVIRONMENT} environment.`
  );
}

function createDeployment({ description, ref, repository, spawnGh }) {
  return ghJson(
    spawnGh,
    ["api", "--method", "POST", `repos/${repository}/deployments`, "--input", "-"],
    JSON.stringify({
      auto_merge: false,
      description,
      environment: NPM_PUBLISH_ENVIRONMENT,
      ref,
      required_contexts: [],
      task: "deploy",
    }),
  );
}

function createDeploymentStatus({
  deploymentId,
  description,
  environmentUrl,
  repository,
  spawnGh,
}) {
  return ghJson(
    spawnGh,
    [
      "api",
      "--method",
      "POST",
      `repos/${repository}/deployments/${String(deploymentId)}/statuses`,
      "--input",
      "-",
    ],
    JSON.stringify({
      description,
      environment: NPM_PUBLISH_ENVIRONMENT,
      environment_url: environmentUrl,
      state: "success",
    }),
  );
}

function deploymentDescription({ npmPublishTimeIso, pathLabel, pkg }) {
  return (
    `${pathLabel} npm publish of ${pkg.name}@${pkg.version} ` +
    `(registry publish time ${npmPublishTimeIso}; dist-tag latest)`
  );
}

/**
 * Every path that reaches here except the Actions `publish` job itself (`runsInsideActionsPublishJob`
 * already filtered that one out) records this run's own publish outside GitHub's automatic
 * environment deployment — today that is exclusively the governed-container operator run.
 */
function publishPathLabel(env) {
  return env.GITHUB_ACTIONS === "true" ? "GitHub Actions" : "governed-container";
}

/**
 * Records a GitHub Deployment for a `latest` npm publish that did not run inside the Actions
 * `publish` job (which GitHub already deploys for). Idempotent per ref+environment. Fails closed
 * on a 403/404 from either write call instead of leaving a silently stale Deployments panel.
 *
 * @param env               process.env-like object
 * @param spawnGh           (args, {input}?) => {status, stdout, stderr, error} — the gh seam;
 *                           `input` is piped to gh's stdin for `--input -` POST bodies
 * @param log               (message) => void
 * @param now               () => Date, overridable for deterministic tests
 * @param pkg                { name, version }
 * @param repository        `owner/repo`
 * @param tag                the dist-tag this publish targeted
 * @param dryRun, planOnly   the publish run's own flags
 * @returns { kind: "skipped", reason } | { kind: "already-recorded" } |
 *          { kind: "recorded", deploymentId } | { kind: "failed", failure }
 */
function createAndRecordDeployment({ description, pkg, ref, repository, spawnGh }) {
  const created = createDeployment({ description, ref, repository, spawnGh });
  if (created.kind === "error") {
    return {
      failure: permissionFailureMessage("creating the deployment", created),
      kind: "failed",
    };
  }
  const deploymentId = isRecord(created.value) ? created.value.id : undefined;
  if (!Number.isSafeInteger(deploymentId)) {
    return {
      failure: "published but the GitHub deployment response carried no deployment id.",
      kind: "failed",
    };
  }

  const status = createDeploymentStatus({
    deploymentId,
    description,
    environmentUrl: `https://www.npmjs.com/package/${pkg.name}/v/${pkg.version}`,
    repository,
    spawnGh,
  });
  if (status.kind === "error") {
    return {
      failure: permissionFailureMessage("recording the success status", status),
      kind: "failed",
    };
  }
  return { deploymentId, kind: "recorded" };
}

export function recordNpmPublishDeployment({
  dryRun = false,
  env,
  log,
  now = () => new Date(),
  pkg,
  planOnly = false,
  repository,
  spawnGh,
  tag,
}) {
  const reason = skipReason({ dryRun, env, planOnly, tag });
  if (reason !== undefined) return { kind: "skipped", reason };

  const ref = `v${pkg.version}`;
  if (findExistingSuccessfulDeployment({ log, ref, repository, spawnGh })) {
    log(
      `npm-publish-deployment: SKIP ${ref} already recorded as a successful ${NPM_PUBLISH_ENVIRONMENT} deployment.`,
    );
    return { kind: "already-recorded" };
  }

  const description = deploymentDescription({
    npmPublishTimeIso: now().toISOString(),
    pathLabel: publishPathLabel(env),
    pkg,
  });
  const result = createAndRecordDeployment({ description, pkg, ref, repository, spawnGh });
  if (result.kind === "recorded") {
    log(
      `npm-publish-deployment: recorded ${NPM_PUBLISH_ENVIRONMENT} deployment ` +
        `${String(result.deploymentId)} for ${ref}.`,
    );
  }
  return result;
}
