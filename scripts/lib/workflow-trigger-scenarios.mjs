// Evaluates the release-workflow job graph for a single trigger scenario and pins the reality of
// GitHub's implicit `success()`. Incident-register row 10 (Epic #3495): the v1.0.0 tag build
// concluded `success` while its qualification, assembly and publish-request jobs were `skipped`
// because a downstream job with `needs: [<skipped-job>]` and no explicit status function evaluated
// as if `success()` were implied — GitHub inherits that condition from the needed job, so a
// `skipped` need silently made every dependent job skip too.
//
// This module answers two independent questions:
//
//   1. `neededJobsInDependencyChain(workflow, jobName)` — is this job downstream of a job that
//      has `if:` other than `success()` / `!cancelled()` (i.e. a job that can be `skipped` because
//      it is gated on the trigger)? If yes, and this job does not itself carry an explicit status
//      function, its skip is silent — an implicit-success trap.
//
//   2. `impliedSuccessTraps(workflow)` — the list of every such trap in a workflow. Empty means
//      every downstream job is armored against a skipped need.
//
// The check refuses to invent an if-expression evaluator; a workflow with `if:` on a needed job
// is treated as potentially skippable, without simulating branch/tag semantics. That is the
// conservative posture: a job may legitimately never be skipped by its `if:` in practice, but the
// dependent job still needs to say so.

const IMPLICIT_STATUS_TRIGGERING_TOKENS =
  /\bsuccess\(\)|\bfailure\(\)|\balways\(\)|\bcancelled\(\)/u;

/**
 * True when this expression carries a status function GitHub uses to override the implicit
 * `success()` gate a `needs:` chain otherwise applies. `!cancelled()` counts: it explicitly runs
 * on success and skipped predecessors.
 */
export function carriesExplicitStatusFunction(ifExpression) {
  if (typeof ifExpression !== "string") return false;
  return IMPLICIT_STATUS_TRIGGERING_TOKENS.test(ifExpression);
}

/**
 * Returns the direct `needs:` array for a workflow job as a normalized list of strings, regardless
 * of whether the YAML author wrote it as a scalar or a sequence.
 */
export function needsOf(job) {
  const raw = job?.needs;
  if (typeof raw === "string") return [raw];
  return Array.isArray(raw) ? raw.filter((entry) => typeof entry === "string") : [];
}

/**
 * True when this job carries an `if:` condition that GitHub evaluates before running it. Jobs
 * without an `if:` inherit the implicit `success()` gate over their `needs:` chain.
 */
export function hasIfCondition(job) {
  return typeof job?.if === "string" && job.if.trim().length > 0;
}

/**
 * The set of job ids that may be `skipped` by their own `if:` — direct or transitive. A job is
 * "potentially skippable" when it carries an `if:` at all, because the workflow author must expect
 * a legitimate skip path or the `if:` would not be there. Transitively, any job whose need is in
 * this set inherits the skip risk unless it carries its own explicit status function.
 */
export function skippableJobIds(workflow) {
  const jobs = workflow?.jobs ?? {};
  const skippable = new Set();
  for (const [jobId, job] of Object.entries(jobs)) {
    if (hasIfCondition(job)) skippable.add(jobId);
  }
  // A single fixed-point pass suffices: transitively add every job whose need is already skippable.
  // In practice a release workflow's `needs` DAG has at most a handful of levels; iterate up to the
  // job count so a cycle-free graph is guaranteed to reach the fixed point.
  const jobCount = Object.keys(jobs).length;
  for (let pass = 0; pass < jobCount; pass += 1) {
    for (const [jobId, job] of Object.entries(jobs)) {
      if (skippable.has(jobId)) continue;
      if (needsOf(job).some((need) => skippable.has(need))) skippable.add(jobId);
    }
  }
  return skippable;
}

/**
 * The workflow's implicit-success traps: every job that has a `needs:` chain reaching a
 * potentially-skippable job AND does not itself carry an explicit status function. Empty means
 * the workflow is armoured against the v1.0.0 class of failure.
 *
 * @returns Array of `{ jobId, missingStatusFunction: true, dependsOnSkippable: string[] }`.
 */
export function impliedSuccessTraps(workflow) {
  const jobs = workflow?.jobs ?? {};
  const skippable = skippableJobIds(workflow);
  const traps = [];
  for (const [jobId, job] of Object.entries(jobs)) {
    const needs = needsOf(job);
    if (needs.length === 0) continue;
    const skippableNeeds = needs.filter((need) => skippable.has(need));
    if (skippableNeeds.length === 0) continue;
    if (carriesExplicitStatusFunction(job.if)) continue;
    traps.push({ jobId, dependsOnSkippable: skippableNeeds, missingStatusFunction: true });
  }
  return traps;
}

/**
 * The jobs a cancellation cannot stop. To cancel a run, GitHub re-evaluates the `if:` of every
 * running job and keeps the job when it is still true — which `always()` always is. `!cancelled()`
 * runs a job after a failed need exactly as `always()` does and lets cancellation through
 * (ADR-0157).
 */
export function cancellationImmuneJobIds(workflow) {
  return Object.entries(workflow?.jobs ?? {})
    .filter(([, job]) => typeof job?.if === "string" && /\balways\(\)/u.test(job.if))
    .map(([jobId]) => jobId);
}
