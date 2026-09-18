// Shared verified-commit-SHA parsing and approval-event activity-log writer for the governed
// git-delivery push and pull-request routes (#3394 review).
//
// `parseVerifiedCommitSha` was duplicated byte-for-byte across `pushRoutes.ts` and `prRoutes.ts`,
// and each route independently defined a pair of log-writer functions
// (`logPushApprovalRequired`/`logPushApprovalMinted`, `logPrApprovalRequired`/`logPrApprovalMinted`)
// that were structurally identical apart from the `op` literal and the `operation` field value, and
// each independently gained the same `commitPinned: boolean` parameter. This is the one shared home
// for both, so a future governed-mutation route is never tempted to add a third near-identical copy.
//
// `requestGuards.ts` is deliberately NOT extended for either symbol: its own header scopes it to the
// #473/#475 request-hardening boundary (bounded body read, allowed-key whitelist, credential-shape
// scan, unsafe-format-char scan) — a pure parsing/validation concern with no I/O. The log writer
// performs I/O (an activity-log write), which does not fit that charter, so both exports live
// together here instead of splitting one of them into a file whose stated purpose it does not share.
import { isGitObjectId } from "@oscharko-dev/keiko-contracts/runtime/git-repository";
import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import type { ServerLogSink } from "../observability/server-log.js";

// A caller-supplied commit SHA a governed push / PR create / PR update request carries: a full Git
// object id naming the commit the client previewed/approved. Consumed by `pushRoutes.ts`'s
// `pushApprovalBinding` and `prRoutes.ts`'s `prApprovalBinding`, which each hash the WHOLE typed
// command — carrying this value makes the approval binding content-sensitive to the exact commit,
// not merely to branch names/flags/title/body, so an approval minted for one `verifiedCommitSha` no
// longer matches a request that later names a different one however far the branch has since moved.
//
// #3394 review: mandatory for every push/pr-create/pr-update APPROVE and EXECUTE request — a missing
// or malformed value is `{ ok: false }` there, fail-closed, never a silent default (findings 1/2).
// The PREVIEW routes are the one exception: they never mutate or mint anything, so they parse the
// request WITHOUT requiring this field at all (see each route's own `validatePreview`) and instead
// always report the server's own freshly-read local head back to the caller (`headCommitSha` on the
// preview response) for it to capture and resubmit at approve/execute time — there is nothing to
// "drift" against on a single, self-contained preview read. This parser stays a plain shape check
// (present + a complete Git object id, or absent); presence is enforced by each strict call site, not
// by this function, so the one parser serves both the lenient preview path and the strict mutation
// path. Optional-when-absent, like `mergeRoutes.ts`'s own `expectedHeadRefHash` — but NOT unified
// with it: that field accepts an abbreviated, case-insensitive hex SHA (7-64 chars) to match a live
// provider-reported head, a different acceptance shape from this one, which requires a complete,
// canonical (`isGitObjectId`) object id.
export function parseVerifiedCommitSha(
  value: unknown,
): { ok: true; value?: string } | { ok: false } {
  if (value === undefined) return { ok: true };
  return isGitObjectId(value) ? { ok: true, value } : { ok: false };
}

// The four operations this parameterizes over — each still written as a literal string ARGUMENT at
// its own call site (never built dynamically), so `scripts/generate-op-catalog.mjs`'s generator can
// resolve it: this helper is registered in that generator's `POSITIONAL_OP_HELPERS` table (argIndex
// 1) so the catalog keeps attributing all four here instead of silently losing them the moment their
// call sites moved out of pushRoutes.ts/prRoutes.ts's own object-literal `activityLog.write({ op:
// "...", ... })` shape — the exact class of silent loss `op-catalog-drift.test.mjs`'s "retains every
// operation lost by the issue-to-PR catalog regression" pins against (PR #3394).
export type GitDeliveryApprovalEventOp =
  | "git.delivery.push.approval.required"
  | "git.delivery.push.approval.minted"
  | "git.delivery.pr.approval.required"
  | "git.delivery.pr.approval.minted"
  | "git.delivery.commit.approval.required"
  | "git.delivery.commit.approval.minted"
  | "git.delivery.sync.approval.minted"
  | "git.delivery.pr-mark-ready.approval.required"
  | "git.delivery.pr-mark-ready.approval.minted";

type GitDeliveryApprovalOperation = "push" | "pr" | "commit" | "fetch" | "pull" | "pr-mark-ready";

const APPROVAL_FIELDS = {
  operation: {
    type: "string",
    dataClass: "closed-enum",
    required: true,
    values: ["push", "pr", "commit", "fetch", "pull", "pr-mark-ready"],
  },
  runId: { type: "string", dataClass: "opaque-id", required: true, maxLength: 128 },
  prExternalId: { type: "string", dataClass: "opaque-id", required: false, maxLength: 128 },
} as const;

const PUSH_APPROVAL_REQUIRED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "git.delivery.push.approval.required",
  category: "security",
  owner: "keiko-server",
  emitter: "gitDelivery/approvalEvents.logGitDeliveryApprovalEvent",
  fields: APPROVAL_FIELDS,
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["git-delivery-approval"],
  proofIds: ["git.delivery.push.approval.required"],
  releaseImpact: "patch",
});
const PUSH_APPROVAL_MINTED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "git.delivery.push.approval.minted",
  category: "security",
  owner: "keiko-server",
  emitter: "gitDelivery/approvalEvents.logGitDeliveryApprovalEvent",
  fields: APPROVAL_FIELDS,
  causal: "correlation",
  lifecycle: "end",
  analyzerProjection: "timeline",
  failureClasses: ["git-delivery-approval"],
  proofIds: ["git.delivery.push.approval.minted"],
  releaseImpact: "patch",
});
const PR_APPROVAL_REQUIRED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "git.delivery.pr.approval.required",
  category: "security",
  owner: "keiko-server",
  emitter: "gitDelivery/approvalEvents.logGitDeliveryApprovalEvent",
  fields: APPROVAL_FIELDS,
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["git-delivery-approval"],
  proofIds: ["git.delivery.pr.approval.required"],
  releaseImpact: "patch",
});
const PR_APPROVAL_MINTED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "git.delivery.pr.approval.minted",
  category: "security",
  owner: "keiko-server",
  emitter: "gitDelivery/approvalEvents.logGitDeliveryApprovalEvent",
  fields: APPROVAL_FIELDS,
  causal: "correlation",
  lifecycle: "end",
  analyzerProjection: "timeline",
  failureClasses: ["git-delivery-approval"],
  proofIds: ["git.delivery.pr.approval.minted"],
  releaseImpact: "patch",
});
const COMMIT_APPROVAL_REQUIRED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "git.delivery.commit.approval.required",
  category: "security",
  owner: "keiko-server",
  emitter: "gitDelivery/approvalEvents.logGitDeliveryApprovalEvent",
  fields: APPROVAL_FIELDS,
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["git-delivery-approval"],
  proofIds: ["git.delivery.commit.approval.required"],
  releaseImpact: "patch",
});
const COMMIT_APPROVAL_MINTED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "git.delivery.commit.approval.minted",
  category: "security",
  owner: "keiko-server",
  emitter: "gitDelivery/approvalEvents.logGitDeliveryApprovalEvent",
  fields: APPROVAL_FIELDS,
  causal: "correlation",
  lifecycle: "end",
  analyzerProjection: "timeline",
  failureClasses: ["git-delivery-approval"],
  proofIds: ["git.delivery.commit.approval.minted"],
  releaseImpact: "patch",
});
const SYNC_APPROVAL_MINTED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "git.delivery.sync.approval.minted",
  category: "security",
  owner: "keiko-server",
  emitter: "gitDelivery/approvalEvents.logGitDeliveryApprovalEvent",
  fields: APPROVAL_FIELDS,
  causal: "correlation",
  lifecycle: "end",
  analyzerProjection: "timeline",
  failureClasses: ["git-delivery-approval"],
  proofIds: ["git.delivery.sync.approval.minted"],
  releaseImpact: "patch",
});
const PR_MARK_READY_APPROVAL_REQUIRED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "git.delivery.pr-mark-ready.approval.required",
  category: "security",
  owner: "keiko-server",
  emitter: "gitDelivery/approvalEvents.logGitDeliveryApprovalEvent",
  fields: APPROVAL_FIELDS,
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["git-delivery-approval"],
  proofIds: ["git.delivery.pr-mark-ready.approval.required"],
  releaseImpact: "patch",
});
const PR_MARK_READY_APPROVAL_MINTED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "git.delivery.pr-mark-ready.approval.minted",
  category: "security",
  owner: "keiko-server",
  emitter: "gitDelivery/approvalEvents.logGitDeliveryApprovalEvent",
  fields: APPROVAL_FIELDS,
  causal: "correlation",
  lifecycle: "end",
  analyzerProjection: "timeline",
  failureClasses: ["git-delivery-approval"],
  proofIds: ["git.delivery.pr-mark-ready.approval.minted"],
  releaseImpact: "patch",
});

interface ApprovalEventEnvelope {
  readonly correlationId: string;
  readonly status: 200;
}

interface ApprovalEventFields {
  readonly operation: GitDeliveryApprovalOperation;
  readonly runId: string;
  readonly prExternalId?: string;
}

type ApprovalEventWriter = (
  activityLog: ServerLogSink,
  envelope: ApprovalEventEnvelope,
  fields: ApprovalEventFields,
) => void;

function writePushApprovalRequired(
  log: ServerLogSink,
  envelope: ApprovalEventEnvelope,
  fields: ApprovalEventFields,
): void {
  log.write(activityLogEvent(PUSH_APPROVAL_REQUIRED_OPERATION, envelope, fields));
}

function writePushApprovalMinted(
  log: ServerLogSink,
  envelope: ApprovalEventEnvelope,
  fields: ApprovalEventFields,
): void {
  log.write(activityLogEvent(PUSH_APPROVAL_MINTED_OPERATION, envelope, fields));
}

function writePrApprovalRequired(
  log: ServerLogSink,
  envelope: ApprovalEventEnvelope,
  fields: ApprovalEventFields,
): void {
  log.write(activityLogEvent(PR_APPROVAL_REQUIRED_OPERATION, envelope, fields));
}

function writePrApprovalMinted(
  log: ServerLogSink,
  envelope: ApprovalEventEnvelope,
  fields: ApprovalEventFields,
): void {
  log.write(activityLogEvent(PR_APPROVAL_MINTED_OPERATION, envelope, fields));
}

function writeCommitApprovalRequired(
  log: ServerLogSink,
  envelope: ApprovalEventEnvelope,
  fields: ApprovalEventFields,
): void {
  log.write(activityLogEvent(COMMIT_APPROVAL_REQUIRED_OPERATION, envelope, fields));
}

function writeCommitApprovalMinted(
  log: ServerLogSink,
  envelope: ApprovalEventEnvelope,
  fields: ApprovalEventFields,
): void {
  log.write(activityLogEvent(COMMIT_APPROVAL_MINTED_OPERATION, envelope, fields));
}

function writeSyncApprovalMinted(
  log: ServerLogSink,
  envelope: ApprovalEventEnvelope,
  fields: ApprovalEventFields,
): void {
  log.write(activityLogEvent(SYNC_APPROVAL_MINTED_OPERATION, envelope, fields));
}

function writePrMarkReadyApprovalRequired(
  log: ServerLogSink,
  envelope: ApprovalEventEnvelope,
  fields: ApprovalEventFields,
): void {
  log.write(activityLogEvent(PR_MARK_READY_APPROVAL_REQUIRED_OPERATION, envelope, fields));
}

function writePrMarkReadyApprovalMinted(
  log: ServerLogSink,
  envelope: ApprovalEventEnvelope,
  fields: ApprovalEventFields,
): void {
  log.write(activityLogEvent(PR_MARK_READY_APPROVAL_MINTED_OPERATION, envelope, fields));
}

const APPROVAL_EVENT_WRITERS: Readonly<Record<GitDeliveryApprovalEventOp, ApprovalEventWriter>> = {
  "git.delivery.push.approval.required": writePushApprovalRequired,
  "git.delivery.push.approval.minted": writePushApprovalMinted,
  "git.delivery.pr.approval.required": writePrApprovalRequired,
  "git.delivery.pr.approval.minted": writePrApprovalMinted,
  "git.delivery.commit.approval.required": writeCommitApprovalRequired,
  "git.delivery.commit.approval.minted": writeCommitApprovalMinted,
  "git.delivery.sync.approval.minted": writeSyncApprovalMinted,
  "git.delivery.pr-mark-ready.approval.required": writePrMarkReadyApprovalRequired,
  "git.delivery.pr-mark-ready.approval.minted": writePrMarkReadyApprovalMinted,
};

// #3387 (ADR-0138 D2): shared by the push and PR execute/approve routes' approval-required and
// approval-minted lines — see `pushApprovalRequiredBlock`/`prApprovalRequiredBlock` for why the
// mandatory consumed-approval gate this logs cannot be substituted by policy-pack disposition alone.
// #3394 review: this line used to also carry `commitPinned`, a boolean that told `keiko support
// analyze` whether the mint/require was content-pinned or branch-name-only. Once `verifiedCommitSha`
// is mandatory and validated at the request boundary (see `parseVerifiedCommitSha` above), the route
// cannot reach this call with an unpinned command — `commitPinned` would be `true` at every single
// call site, unconditionally, by construction. AGENTS.md §7: a parameter whose value is provably
// constant carries zero information and is dead code, not merely simplifiable — worse, leaving it in
// as a hardcoded `true` would invite a future log reader to believe a `false` case is still
// reachable. Removed rather than hardcoded.
export function logGitDeliveryApprovalEvent(
  activityLog: ServerLogSink,
  op: GitDeliveryApprovalEventOp,
  operation: GitDeliveryApprovalOperation,
  correlationId: string,
  runId: string,
  evidence: { readonly prExternalId?: string } = {},
): void {
  const fields = {
    operation,
    runId,
    ...(evidence.prExternalId === undefined ? {} : { prExternalId: evidence.prExternalId }),
  };
  const envelope = { correlationId, status: 200 } as const;
  APPROVAL_EVENT_WRITERS[op](activityLog, envelope, fields);
}
