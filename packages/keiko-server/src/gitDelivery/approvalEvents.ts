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
import type { ServerLogSink } from "../observability/server-log.js";

// A caller-supplied, already-verified commit SHA a governed push / PR create / PR update request MAY
// carry: a full Git object id when the client states which commit it previewed/approved, or nothing
// when it relies on today's branch-name-only binding. Consumed by `pushRoutes.ts`'s
// `pushApprovalBinding` and `prRoutes.ts`'s `prApprovalBinding`, which each hash the WHOLE typed
// command — carrying this value makes the approval binding content-sensitive to the exact commit,
// not merely to branch names/flags/title/body, so an approval minted for one `verifiedCommitSha` no
// longer matches a request that later names a different one however far the branch has since moved.
//
// Optional, like `mergeRoutes.ts`'s own `expectedHeadRefHash` — but NOT unified with it: that field
// accepts an abbreviated, case-insensitive hex SHA (7-64 chars) to match a live provider-reported
// head, a different acceptance shape from this one, which requires a complete, canonical
// (`isGitObjectId`) object id.
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
  | "git.delivery.pr.approval.minted";

// #3387 (ADR-0138 D2): shared by the push and PR execute/approve routes' approval-required and
// approval-minted lines — see `pushApprovalRequiredBlock`/`prApprovalRequiredBlock` for why the
// mandatory consumed-approval gate this logs cannot be substituted by policy-pack disposition alone.
// `commitPinned` (#3394 review) is body-free evidence (a boolean, never the SHA itself) that lets
// `keiko support analyze` distinguish a content-pinned mint/require from a branch-name-only one
// directly from the activity log, without re-deriving it from the (redacted) command shape.
export function logGitDeliveryApprovalEvent(
  activityLog: ServerLogSink,
  op: GitDeliveryApprovalEventOp,
  operation: "push" | "pr",
  correlationId: string,
  runId: string,
  commitPinned: boolean,
): void {
  activityLog.write({
    category: "security",
    op,
    correlationId,
    status: 200,
    extra: { operation, runId, commitPinned },
  });
}
