import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import {
  evaluateKeikoForQuality,
  isValidHeadSha,
  latestQodoReview,
} from "./keiko-for-quality-core.mjs";
import {
  evidence,
  github,
  installationToken,
  isOwnCommentEvent,
  mergeContextForHead,
  parseStabilityMs,
  publishCheck,
  publishDashboardComment,
  pullNeedsEvaluation,
  pullRequestNumbers,
  reconciliationErrorKind,
  repositoryInstallation,
  resultWithEvidenceUpdatedAt,
  targetForRepository,
} from "./keiko-for-quality-worker.mjs";

// GitHub Actions' own App id. When the shell authenticates with the workflow GITHUB_TOKEN, the
// aggregate check is produced under this id; App auth (below) instead preserves the Keiko for
// Quality App id so the exact branch-protection pin is unchanged. See
// docs/qa/keiko-for-quality-action-evaluation.md.
const actionsAppId = 15368;

// The proof-of-concept publishes under a distinct identity so it coexists with the live Cloudflare
// Worker on real pull requests for side-by-side equivalence comparison, without touching the
// worker's gating check or dashboard comment (both are keyed by producer App id and marker).
const defaultCheckName = "Keiko for Quality (Action)";
const defaultMarker = "<!-- keiko-for-quality-action-dashboard:v1 -->";
const defaultLabel = "kfq-action-poc";

// React only to completions of the direct required-check contexts (the union across quality
// targets). Since Issue #2508 the aggregate no longer reads check-run evidence — branch protection
// owns those contexts directly — but their completions remain the natural "time passed on this
// pull" signals that let a stability-window verdict settle without a cron. The fixed allowlist is a
// trigger filter, not merge authority, and it structurally prevents a self-trigger loop: neither
// this workflow's job status check nor the aggregate check it posts is a listed name, so their
// completions are ignored (the Actions GITHUB_TOKEN also suppresses recursion, but App auth would
// not).
const reevaluationCheckNames = new Set([
  "ci",
  "actionlint",
  "Verify pinned action SHAs",
  "zizmor",
  "Analyze (actions)",
  "Analyze (javascript-typescript)",
  "Build, scan, SBOM, smoke",
  "Review dependency diff (dev/main)",
  "ui",
  "native",
  "Scan dependency lockfiles",
  "SonarCloud Code Analysis",
  "Socket Security: Project Report",
  "Socket Security: Pull Request Alerts",
]);

function hasValue(value) {
  return typeof value === "string" && value.trim() !== "";
}

function isDryRun(env) {
  return hasValue(env.KFQ_DRY_RUN) && env.KFQ_DRY_RUN !== "0" && env.KFQ_DRY_RUN !== "false";
}

// Prefer App auth (producer stays the Keiko for Quality App id) and fall back to the workflow
// GITHUB_TOKEN (producer becomes GitHub Actions). Fail closed when neither credential is present.
export function resolveAuth(env) {
  if (hasValue(env.KFQ_APP_ID) && hasValue(env.KFQ_PRIVATE_KEY_PKCS8)) {
    const producerAppId = Number(env.KFQ_APP_ID);
    if (!Number.isInteger(producerAppId)) throw new Error("KFQ_APP_ID must be an integer App id.");
    return {
      appEnv: {
        GITHUB_APP_ID: env.KFQ_APP_ID,
        GITHUB_PRIVATE_KEY_PKCS8: env.KFQ_PRIVATE_KEY_PKCS8,
      },
      mode: "app",
      producerAppId,
    };
  }
  if (hasValue(env.GITHUB_TOKEN)) {
    return { mode: "token", producerAppId: actionsAppId, token: env.GITHUB_TOKEN };
  }
  throw new Error("Missing credentials: set KFQ_APP_ID + KFQ_PRIVATE_KEY_PKCS8, or GITHUB_TOKEN.");
}

export function actionIdentity(env) {
  return {
    // An explicitly EMPTY label (set to "") disables the opt-in gate (ADR-0142 cutover); only an
    // absent variable falls back to the proof-of-concept label.
    label: env.KFQ_ACTION_LABEL === undefined ? defaultLabel : env.KFQ_ACTION_LABEL.trim(),
    marker: hasValue(env.KFQ_DASHBOARD_MARKER) ? env.KFQ_DASHBOARD_MARKER : defaultMarker,
    name: hasValue(env.KFQ_CHECK_NAME) ? env.KFQ_CHECK_NAME : defaultCheckName,
  };
}

export function parseEvent(env) {
  if (!hasValue(env.GITHUB_EVENT_NAME)) throw new Error("GITHUB_EVENT_NAME is required.");
  if (!hasValue(env.GITHUB_EVENT_PATH)) throw new Error("GITHUB_EVENT_PATH is required.");
  return {
    eventName: env.GITHUB_EVENT_NAME,
    payload: JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8")),
  };
}

function parseConfig(env) {
  return {
    stabilityMs: parseStabilityMs(env.STABILITY_WINDOW_MS),
    targetEnv: {
      TARGET_REPOSITORIES_JSON: env.TARGET_REPOSITORIES_JSON,
      TARGET_REPOSITORY: env.TARGET_REPOSITORY,
    },
  };
}

// The pull requests this event should (re)evaluate. A completed run of an unlisted check (our own
// job status, our posted aggregate check) yields none; an edit to our own dashboard comment yields
// none; everything else maps through the shared worker extractor.
export function affectedPullNumbers(eventName, payload, producerAppId) {
  if (eventName === "check_run") {
    return reevaluationCheckNames.has(payload?.check_run?.name)
      ? pullRequestNumbers(eventName, payload)
      : [];
  }
  if (isOwnCommentEvent(eventName, payload, { GITHUB_APP_ID: producerAppId })) return [];
  return pullRequestNumbers(eventName, payload);
}

// Before the ADR-0142 cutover a pull was evaluated only when it opted in via the configured label,
// scoping the proof-of-concept to sample pull requests while the live Worker owned the real gate.
// Post-cutover the workflow sets an explicitly empty label, which disables the gate: every pull is
// evaluated. A manual dispatch or a dry run targets a pull explicitly and never needs a label.
export function pullIsOptedIn(pull, label, eventName, dryRun) {
  if (dryRun === true || eventName === "workflow_dispatch") return true;
  if (label === "") return true;
  const labels = Array.isArray(pull?.labels) ? pull.labels : [];
  return labels.some((entry) => entry?.name === label);
}

function resolveTarget(owner, repository, targetEnv) {
  try {
    return targetForRepository(`${owner}/${repository}`, targetEnv);
  } catch (error) {
    if (error instanceof Error && error.message.includes("outside the quality target set")) {
      return undefined;
    }
    throw error;
  }
}

async function resolveToken(auth, owner, repository, installationId) {
  if (auth.mode === "token") return auth.token;
  const id = Number.isInteger(installationId)
    ? installationId
    : await repositoryInstallation(owner, repository, auth.appEnv);
  return installationToken(id, auth.appEnv);
}

function resolvePulls(env, options, producerAppId) {
  // A manual dispatch (and local dry run) names the pull explicitly through KFQ_PR. Guard on a
  // non-empty value first: for every other event the workflow passes KFQ_PR through as an empty
  // string, and Number("") is 0 — a valid integer that would otherwise evaluate a phantom pull #0.
  if (hasValue(env.KFQ_PR)) {
    const explicit = Number(env.KFQ_PR);
    if (Number.isInteger(explicit) && explicit > 0) {
      return { eventName: "workflow_dispatch", installationId: undefined, prNumbers: [explicit] };
    }
  }
  const { eventName, payload } = options.event ?? parseEvent(env);
  return {
    eventName,
    installationId: payload?.installation?.id,
    prNumbers: affectedPullNumbers(eventName, payload, producerAppId),
  };
}

function logVerdict(pullNumber, headSha, result, dryRun) {
  const verdict = result.passed ? "passed" : `failing failures=${String(result.failures.length)}`;
  console.log(
    `keiko-for-quality-action: ${dryRun ? "dry-run " : ""}pr=${String(pullNumber)} head=${headSha.slice(0, 12)} ${verdict}`,
  );
  // Core failure strings are already redacted (check names, counts) and safe to surface for the
  // side-by-side equivalence comparison.
  if (!result.passed) for (const failure of result.failures) console.log(`  - ${failure}`);
}

async function publishResult(context) {
  const env = { GITHUB_APP_ID: context.producerAppId };
  await publishCheck(
    context.owner,
    context.repository,
    context.headSha,
    context.result,
    context.token,
    env,
    context.identity.name,
  );
  await publishDashboardComment({
    currentEvidence: context.currentEvidence,
    env,
    marker: context.identity.marker,
    name: context.identity.name,
    owner: context.owner,
    pull: context.pull,
    pullNumber: context.pullNumber,
    repository: context.repository,
    result: context.result,
    token: context.token,
  });
}

async function evaluateHeadOnce(context, headSha, evaluationTime) {
  const { config, owner, pullNumber, repository, token } = context;
  const currentEvidence = await evidence(owner, repository, pullNumber, token);
  const merge = await mergeContextForHead(currentEvidence, owner, repository, headSha, token);
  const decisionResult = evaluateKeikoForQuality({
    comments: currentEvidence.comments,
    headSha,
    mergeCommitTime: merge.commitTime,
    mergeParents: merge.parents,
    now: evaluationTime,
    stabilityMs: config.stabilityMs,
  });
  return {
    currentEvidence,
    decisionResult,
    merge,
  };
}

// The in-window stability wait is the one pending state with a known, bounded settlement time —
// and, because the Action is purely event-driven, the triggering event can be the Qodo comment
// itself with no later allowlisted completion to re-run the evaluator (Qodo review of PR #2519).
// Return the remaining wait when the verdict is pending on the stability window alone; anything
// longer than this bound stays pending and settles through a later event or manual dispatch.
const stabilityWindowFailure = "Review-product evidence is inside the stability window.";
const maxSettleWaitMs = 300_000;

function settleDelayMs({ currentEvidence, decisionResult, merge }, headSha, config, now) {
  const stabilityOnly =
    decisionResult.failures.length === 1 && decisionResult.failures[0] === stabilityWindowFailure;
  if (!stabilityOnly) return undefined;
  const review = latestQodoReview(
    currentEvidence.comments,
    headSha,
    merge.parents,
    merge.commitTime,
  );
  if (review === undefined) return undefined;
  const waitMs = Date.parse(review.updatedAt) + config.stabilityMs - now;
  return waitMs > 0 && waitMs <= maxSettleWaitMs ? waitMs : undefined;
}

// Evaluate once; when the only failure is the still-open stability window, hold this run for the
// bounded remaining time and re-evaluate on refreshed evidence so the same run settles the verdict
// instead of stranding an in_progress check. A review that moved during the wait re-enters the
// window and is carried by its own issue_comment event, so one settle pass is enough.
async function settledEvaluation(context, headSha) {
  const first = await evaluateHeadOnce(context, headSha, context.now);
  const waitMs = context.dryRun
    ? undefined
    : settleDelayMs(first, headSha, context.config, context.now);
  if (waitMs === undefined) return { ...first, evaluatedAt: context.now };
  console.log(`keiko-for-quality-action: settle-wait ms=${String(waitMs)}`);
  await context.delay(waitMs);
  const evaluatedAt = context.now + waitMs;
  return { ...(await evaluateHeadOnce(context, headSha, evaluatedAt)), evaluatedAt };
}

async function evaluatePull(context) {
  const { dryRun, eventName, identity, now, owner, pullNumber, repository, target, token } =
    context;
  const pull = await github(`/repos/${owner}/${repository}/pulls/${String(pullNumber)}`, token);
  if (!pullNeedsEvaluation(pull, target.baseBranch, now)) {
    console.log(`keiko-for-quality-action: skip pr=${String(pullNumber)} reason=not-open-dev-base`);
    return;
  }
  if (!pullIsOptedIn(pull, identity.label, eventName, dryRun)) {
    console.log(`keiko-for-quality-action: skip pr=${String(pullNumber)} reason=not-opted-in`);
    return;
  }
  const headSha = pull.head?.sha;
  if (!isValidHeadSha(headSha)) throw new Error("Pull request head SHA is invalid.");
  const { currentEvidence, decisionResult, evaluatedAt, merge } = await settledEvaluation(
    context,
    headSha,
  );
  const result = resultWithEvidenceUpdatedAt(
    decisionResult,
    currentEvidence,
    headSha,
    merge,
    evaluatedAt,
  );
  logVerdict(pullNumber, headSha, result, dryRun);
  if (dryRun) return;
  await publishResult({
    ...context,
    currentEvidence,
    headSha,
    producerAppId: context.producerAppId,
    pull,
    result,
  });
}

export async function run(env, options = {}) {
  const now = typeof options.now === "number" ? options.now : Date.now();
  const auth = resolveAuth(env);
  const identity = actionIdentity(env);
  const config = parseConfig(env);
  const { eventName, installationId, prNumbers } = resolvePulls(env, options, auth.producerAppId);
  if (prNumbers.length === 0) {
    console.log("keiko-for-quality-action: no pull requests to evaluate.");
    return;
  }
  const repoSlug = String(env.GITHUB_REPOSITORY ?? "");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repoSlug)) {
    throw new Error("GITHUB_REPOSITORY must be owner/repository.");
  }
  const [owner, repository] = repoSlug.split("/");
  const target = resolveTarget(owner, repository, config.targetEnv);
  if (target === undefined) {
    console.log(`keiko-for-quality-action: ${owner}/${repository} is not a quality target.`);
    return;
  }
  const token = await resolveToken(auth, owner, repository, installationId);
  const dryRun = isDryRun(env);
  // Injectable for deterministic tests; the runner path waits in real time.
  const delay = options.delay ?? ((ms) => sleep(ms));
  for (const pullNumber of prNumbers) {
    await evaluatePull({
      config,
      delay,
      dryRun,
      eventName,
      identity,
      now,
      owner,
      producerAppId: auth.producerAppId,
      pullNumber,
      repository,
      target,
      token,
    });
  }
}

async function main() {
  try {
    await run(process.env);
  } catch (error) {
    // Redacted, body-free diagnostic: only the error kind reaches the log, never the
    // (potentially user-controlled) message.
    console.error(`keiko-for-quality-action: FAIL errorKind=${reconciliationErrorKind(error)}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  await main();
}
