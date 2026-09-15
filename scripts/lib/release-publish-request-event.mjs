// Event-driven decision core (#3498, Epic #3495). Answers a single question for a given head sha:
// is every workflow that authorises publication now green on that sha? The wait-for-checks approach
// (release-verify polling for 90 minutes with a 60-second budget in the publish job) is replaced by
// this one-shot decision that reacts to workflow_run completion.
//
// Pure and seam-parameterised so every branch is reachable from a vitest test: `listWorkflowRuns`
// and `dispatchReleaseWorkflow` are injected. The workflow file
// (`.github/workflows/release-publish-request.yml`) wires them to `gh api`.
//
// Design notes:
//   * The list of workflows that must be green on the head is the same one workflow_run observes
//     in the yml (CI, CodeQL, Workflow hygiene, Portable assets), so the two lists never drift.
//     The workflow-file pin test (release-publish-request-workflow.test.mjs) enforces that.
//   * A head SHA that is not a v* tag never triggers a dispatch. workflow_run gates the trigger on
//     `startsWith(head_branch, 'v')`, and this decision core refuses again by tag lookup so a
//     manual workflow_dispatch on a non-tag SHA cannot bypass it.
//   * `mode: 'dry-run'` produces the decision without POSTing the dispatch. It is what the
//     manual-dispatch entry uses so an operator can classify a run without side effects.

const RELEASE_TRIGGERING_WORKFLOWS = /** @type {const} */ ([
  "CI",
  "CodeQL",
  "Workflow hygiene",
  "Portable assets",
]);

/** The names, exported so the workflow-yaml pin test can compare them against the yml `workflows:` list. */
export function releaseTriggeringWorkflows() {
  return RELEASE_TRIGGERING_WORKFLOWS;
}

/**
 * The pure decision. Every non-green case names WHY a publish request is not dispatched, so the
 * step summary can record it without a second GitHub query.
 *
 * @param headSha  the observed head SHA (must be v* tag).
 * @param workflowRunsForSha  the workflow_runs on that head as a map: workflow display name →
 *                            { status, conclusion, runId, updatedAt } for the latest run.
 * @returns { decision: 'dispatch' | 'not_ready' | 'refused', reason: string, missing?: string[] }
 */
export function evaluateRequest({ headSha, tagAtSha, workflowRunsForSha }) {
  const refusal = tagRefusal(headSha, tagAtSha);
  if (refusal !== undefined) return refusal;
  const workflowStatus = classifyWorkflowRuns(workflowRunsForSha);
  if (workflowStatus.missing.length > 0 || workflowStatus.pending.length > 0) {
    return notReadyVerdict(headSha, workflowStatus);
  }
  return {
    decision: "dispatch",
    reason: `every required workflow is green on ${headSha} (tag ${tagAtSha}); dispatching release.yml with publish=true`,
  };
}

function tagRefusal(headSha, tagAtSha) {
  if (typeof headSha !== "string" || !/^[0-9a-f]{40}$/u.test(headSha)) {
    return { decision: "refused", reason: "head SHA must be a 40-hex commit id" };
  }
  if (typeof tagAtSha !== "string" || tagAtSha.length === 0) {
    return {
      decision: "refused",
      reason: `no v* tag points at ${headSha}; a publish request is only allowed on a stable tag`,
    };
  }
  if (!/^v\d+\.\d+\.\d+$/u.test(tagAtSha)) {
    return {
      decision: "refused",
      reason: `${tagAtSha} is not a stable release tag (v<major>.<minor>.<patch>)`,
    };
  }
  return undefined;
}

function classifyWorkflowRuns(workflowRunsForSha) {
  const missing = [];
  const pending = [];
  for (const name of RELEASE_TRIGGERING_WORKFLOWS) {
    const run = workflowRunsForSha?.[name];
    if (run === undefined) missing.push(name);
    else if (run.status !== "completed") pending.push(name);
    else if (run.conclusion !== "success") missing.push(name);
  }
  return { missing, pending };
}

function notReadyVerdict(headSha, { missing, pending }) {
  const parts = [];
  if (missing.length > 0) parts.push(`missing or non-success: ${missing.join(", ")}`);
  if (pending.length > 0) parts.push(`still in progress: ${pending.join(", ")}`);
  return {
    decision: "not_ready",
    reason: `not every required workflow is green on ${headSha} — ${parts.join("; ")}`,
    missing: [...missing, ...pending],
  };
}

/**
 * Enacts the decision. Reads the latest run of each required workflow for the head sha, runs
 * `evaluateRequest`, and — in `enforce` mode with a dispatch decision — POSTs the release
 * workflow_dispatch.
 *
 * Seams:
 *   `listLatestRunForWorkflow(name, headSha) → { status, conclusion, runId, updatedAt } | undefined`
 *   `readTagAtSha(headSha) → string | undefined`
 *   `dispatchRelease(tag) → void  // throws on API failure`
 */
export async function requestPublishForHead({
  headSha,
  mode,
  listLatestRunForWorkflow,
  readTagAtSha,
  dispatchRelease,
}) {
  const tagAtSha = readTagAtSha(headSha);
  const workflowRunsForSha = Object.create(null);
  for (const name of RELEASE_TRIGGERING_WORKFLOWS) {
    workflowRunsForSha[name] = await listLatestRunForWorkflow(name, headSha);
  }
  const verdict = evaluateRequest({ headSha, tagAtSha, workflowRunsForSha });
  if (verdict.decision === "dispatch" && mode === "enforce") {
    await dispatchRelease(tagAtSha);
    return { ...verdict, dispatched: true };
  }
  return { ...verdict, dispatched: false };
}
