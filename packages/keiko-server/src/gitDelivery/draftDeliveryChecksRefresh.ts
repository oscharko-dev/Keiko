// Keeps the server-owned Checks section of a delivered pull request describing the commit the
// delivery last pushed to it (owner review on PR #3452). The section is composed when the pull
// request is created; when a later verified commit reaches the same pull request (a CI-repair push),
// this recomposes it for that commit and replaces only the framed section, as its own governed
// pull-request update (ADR-0174 D4): under policy authority only, against a live body re-read
// immediately before the write, and logged body-free whatever the outcome. A refresh that cannot run
// leaves the section as it was: it names its own commit and says later commits are not covered.
import { canonicalise } from "@oscharko-dev/keiko-security";
import type { DraftDeliveryRecord } from "@oscharko-dev/keiko-contracts/runtime/draft-delivery";
import type { GitPullRequestIdentity } from "@oscharko-dev/keiko-contracts/runtime/git-pull-request";
import {
  validGitPrBodyText,
  type GitPrBody,
  type GitPrExecResult,
  type GitPrUpdateCommand,
  type GitPullRequestAdapter,
  type GitPullRequestBodyAdapter,
} from "@oscharko-dev/keiko-tools";
import { readGitRawWorktreeSnapshot } from "@oscharko-dev/keiko-tools/internal/git-mutation";
import { describeError } from "../diagnostics-log.js";
import { processServerLogSink } from "../process-log-sink.js";
import { basePinnedPrPolicyPacks } from "./basePinnedPrPolicy.js";
import {
  frameDraftChecksSection,
  readDraftDeliveryChecks,
  renderDraftDeliveryChecks,
  spliceDraftChecksSection,
  type DraftChecksSplice,
  type RenderedDraftDeliveryChecks,
} from "./draftDeliveryChecks.js";
import type { DraftDeliveryRunContext, DraftDeliveryServiceOptions } from "./draftDeliveryTypes.js";
import { executeGovernedPullRequest } from "./prExecution.js";
import { runtimeGitReadDeps } from "./runtimeGitRead.js";

export interface DraftChecksRefreshInput {
  readonly options: DraftDeliveryServiceOptions;
  readonly context: DraftDeliveryRunContext;
  /** The record the push just advanced: its binding names the commit the section must describe. */
  readonly record: DraftDeliveryRecord;
  /** The delivery's pull request, as read right after the push. */
  readonly pullRequest: GitPullRequestIdentity;
}

type SkipReason =
  | "approval-required"
  | "adapter-unavailable"
  | "identity-mismatch"
  | "section-absent"
  | "section-malformed"
  | "unchanged";
type FailReason = "read-failed" | "body-invalid" | "body-changed" | "update-failed" | "internal";
type RefreshOutcome =
  | { readonly state: "refreshed"; readonly checkRowCount: number }
  | { readonly state: "skipped"; readonly reason: SkipReason }
  | { readonly state: "failed"; readonly reason: FailReason; readonly error?: unknown };

interface Progress {
  dispatched: boolean;
  refusal?: FailReason;
}

const SPLICE_SKIP: Readonly<Record<Exclude<DraftChecksSplice["status"], "replaced">, SkipReason>> =
  {
    absent: "section-absent",
    malformed: "section-malformed",
    unchanged: "unchanged",
  };

function skipped(reason: SkipReason): RefreshOutcome {
  return { state: "skipped", reason };
}

function failed(reason: FailReason, error?: unknown): RefreshOutcome {
  return error === undefined ? { state: "failed", reason } : { state: "failed", reason, error };
}

/** Never throws: the push it follows has already succeeded, and every outcome is logged. */
export async function refreshDraftChecksSection(input: DraftChecksRefreshInput): Promise<void> {
  let outcome: RefreshOutcome;
  try {
    outcome = await attemptRefresh(input);
  } catch (error) {
    outcome = failed("internal", error);
  }
  logRefresh(input, outcome);
}

// The live pull request must still be the delivery's own, open, on the pushed commit.
function deliveredPullRequest(
  live: GitPullRequestIdentity,
  expected: GitPullRequestIdentity,
  record: DraftDeliveryRecord,
): boolean {
  return (
    live.state === "open" &&
    live.number === expected.number &&
    live.externalId === expected.externalId &&
    live.repository.toLowerCase() === record.binding.repository.toLowerCase() &&
    live.headRef === record.binding.headRef &&
    live.baseRef === record.binding.baseRef &&
    live.headSha === record.binding.headSha
  );
}

// The section for the pushed commit, read from that commit's own receipt and evidence.
function composedSection(input: DraftChecksRefreshInput): RenderedDraftDeliveryChecks {
  const { options, context, record } = input;
  return renderDraftDeliveryChecks(
    readDraftDeliveryChecks({
      snapshots: options.snapshots,
      evidenceStore: options.mutationDeps.evidenceStore,
      record,
      correlationId: context.correlationId,
      activityLog: options.execution?.activityLog ?? processServerLogSink(),
    }),
  );
}

async function attemptRefresh(input: DraftChecksRefreshInput): Promise<RefreshOutcome> {
  const { options, context, record, pullRequest } = input;
  if (options.policyAllowsWithoutApproval?.("pull-request") !== true)
    return skipped("approval-required");
  const adapter = options.bodyAdapter?.(context);
  if (adapter === undefined) return skipped("adapter-unavailable");
  const live = await adapter.readPullRequestBody({
    ownerAndRepo: record.binding.repository,
    prExternalId: String(pullRequest.number),
  });
  if (!live.ok) return failed("read-failed");
  if (!deliveredPullRequest(live.value.identity, pullRequest, record))
    return skipped("identity-mismatch");
  const checks = composedSection(input);
  const splice = spliceDraftChecksSection(
    live.value.body,
    frameDraftChecksSection(checks.markdown),
  );
  if (splice.status !== "replaced") return skipped(SPLICE_SKIP[splice.status]);
  if (!validGitPrBodyText(splice.body)) return failed("body-invalid");
  return applyRefresh(input, adapter, live.value, splice.body, checks.rowCount);
}

async function applyRefresh(
  input: DraftChecksRefreshInput,
  adapter: GitPullRequestBodyAdapter,
  live: GitPrBody,
  body: string,
  checkRowCount: number,
): Promise<RefreshOutcome> {
  const { options, context, record } = input;
  // The lifecycle's pr-update carries the policy gate, the evidence and the policy authority; only
  // the section-only adapter below has an effect.
  const command: GitPrUpdateCommand = {
    kind: "pr-update",
    ownerAndRepo: record.binding.repository,
    prExternalId: String(input.pullRequest.number),
    headBranchName: record.binding.headRef,
    baseBranchName: record.binding.baseRef,
    title: "",
    body,
    convertToDraft: false,
    convertFromDraft: false,
    verifiedCommitSha: record.binding.headSha,
  };
  const progress: Progress = { dispatched: false };
  const seams = options.pullRequestSeams(context);
  const result = await executeGovernedPullRequest(
    command,
    { required: false },
    context.workspace,
    options.mutationDeps,
    {
      ...seams,
      policyPacks:
        seams.policyPacks ?? basePinnedPrPolicyPacks("pr-update", record.binding.baseRef),
      snapshotReader: () =>
        readGitRawWorktreeSnapshot(runtimeGitReadDeps(context, options.execution ?? {})),
      beforeRemoteDispatch: () => context.stillAuthorized() && context.signal?.aborted !== true,
      prAdapterFactory: () => sectionOnlyAdapter(command, adapter, live, progress),
    },
    context.correlationId,
  );
  if (progress.refusal !== undefined) return failed(progress.refusal);
  return progress.dispatched && result.lifecycle.outcome.status === "succeeded"
    ? { state: "refreshed", checkRowCount }
    : failed("update-failed");
}

// Writes the body alone, and only after re-reading it: a body that changed since it was read (a
// human edit, a description application) is never overwritten.
function sectionOnlyAdapter(
  expected: GitPrUpdateCommand,
  adapter: GitPullRequestBodyAdapter,
  live: GitPrBody,
  progress: Progress,
): GitPullRequestAdapter {
  const target = { ownerAndRepo: expected.ownerAndRepo, prExternalId: expected.prExternalId };
  return {
    createPullRequest: (): never => {
      throw new TypeError("A Checks refresh never creates a pull request");
    },
    updatePullRequest: async (request): Promise<GitPrExecResult> => {
      if (canonicalise({ kind: "pr-update", ...request }) !== canonicalise(expected))
        throw new TypeError("The Checks refresh request changed");
      const current = await adapter.readPullRequestBody(target);
      if (
        !current.ok ||
        current.value.body !== live.body ||
        current.value.updatedAt !== live.updatedAt
      ) {
        progress.refusal = current.ok ? "body-changed" : "read-failed";
        throw new TypeError("The pull request body changed since it was read");
      }
      progress.dispatched = true;
      return adapter.updatePullRequestBody({ ...target, body: expected.body });
    },
  };
}

function refreshFields(outcome: RefreshOutcome): Readonly<Record<string, unknown>> {
  if (outcome.state === "refreshed")
    return { checkRowCount: outcome.checkRowCount, authority: "policy-authorized" };
  if (outcome.state === "skipped" || outcome.error === undefined) return { reason: outcome.reason };
  return { reason: outcome.reason, ...describeError(outcome.error) };
}

function logRefresh(input: DraftChecksRefreshInput, outcome: RefreshOutcome): void {
  const { options, context, record, pullRequest } = input;
  (options.execution?.activityLog ?? processServerLogSink()).write({
    category: "process",
    op: "git.draft-checks",
    correlationId: context.correlationId,
    ...(outcome.state === "failed"
      ? ({
          level: "warn",
          errorKind: outcome.reason === "body-changed" ? "conflict" : "internal",
        } as const)
      : {}),
    extra: {
      runId: context.runId,
      phase: "refresh",
      state: outcome.state,
      prNumber: pullRequest.number,
      headSha: record.binding.headSha,
      ...refreshFields(outcome),
    },
  });
}
