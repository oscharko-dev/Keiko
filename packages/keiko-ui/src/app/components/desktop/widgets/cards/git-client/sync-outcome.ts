"use client";

// Presentation of a SETTLED sync/push result: severity + human message.
//
// A settled response is not a success. The Git window used to format every settled response with the
// same neutral template and the same neutral pill, printing the raw wire token ("Pull: auth-failed")
// in the success colour with role=status. Two rules follow, and they are enforced structurally here:
//
//   1. Severity comes from a TOTAL Record over the wire union. A member added to `GitSyncOutcome` or
//      to `GitDeliveryMutationStatus` is a compile error in this file, so no new failure mode can
//      inherit "ok" by falling through a default branch.
//   2. Every token is rendered through the message catalog. The UI never prints a wire token, and it
//      never prints provider text — the server's rejection/recovery vocabulary is closed and each
//      member maps to a catalog key.

import type { I18nTranslate } from "@/lib/i18n";
import type { MessageKey } from "@/lib/i18n-messages.en";
import type { GitSyncOutcome } from "@/lib/types";
import type { GitDeliveryMutationStatus } from "@/lib/api";
import { isGitDeliveryRecoveryActionHint } from "@oscharko-dev/keiko-contracts/runtime/git-delivery-action-sheet";
import type { GitMutationOutcome } from "./git-client-seam";

export interface SyncOutcomeView {
  readonly message: string;
  // Drives BOTH the colour and the live-region role, so a failure can never be announced as a status.
  readonly failed: boolean;
}

interface OutcomePresentation {
  readonly labelKey: MessageKey;
  readonly failed: boolean;
}

// Labels are sentence fragments because they are substituted into "{label}: {status}".
const SYNC_OUTCOME: Readonly<Record<GitSyncOutcome, OutcomePresentation>> = {
  succeeded: { labelKey: "gitClientWindow.sync.result.succeeded", failed: false },
  "up-to-date": { labelKey: "gitClientWindow.sync.result.upToDate", failed: false },
  "no-remote": { labelKey: "gitClientWindow.sync.result.noRemote", failed: true },
  "no-upstream": { labelKey: "gitClientWindow.sync.result.noUpstream", failed: true },
  "detached-head": { labelKey: "gitClientWindow.sync.result.detachedHead", failed: true },
  "dirty-worktree": { labelKey: "gitClientWindow.sync.result.dirtyWorktree", failed: true },
  "not-fast-forward": { labelKey: "gitClientWindow.sync.result.notFastForward", failed: true },
  "authority-denied": { labelKey: "gitClientWindow.sync.result.blockedByPolicy", failed: true },
  "auth-failed": { labelKey: "gitClientWindow.sync.result.authFailed", failed: true },
  "untrusted-host-key": { labelKey: "gitClientWindow.sync.result.untrustedHostKey", failed: true },
  "remote-unavailable": { labelKey: "gitClientWindow.sync.result.remoteUnavailable", failed: true },
  timeout: { labelKey: "gitClientWindow.sync.result.timeout", failed: true },
  "output-truncated": { labelKey: "gitClientWindow.sync.result.outputTruncated", failed: true },
  "git-missing": { labelKey: "gitClientWindow.sync.result.gitMissing", failed: true },
  "unsafe-repository": { labelKey: "gitClientWindow.sync.result.unsafeRepository", failed: true },
  "git-error": { labelKey: "gitClientWindow.sync.result.gitError", failed: true },
};

const PUSH_STATUS: Readonly<Record<GitDeliveryMutationStatus, OutcomePresentation>> = {
  succeeded: { labelKey: "gitClientWindow.sync.result.succeeded", failed: false },
  blocked: { labelKey: "gitClientWindow.sync.result.blockedByPolicy", failed: true },
  "approval-required": { labelKey: "gitClientWindow.sync.result.approvalRequired", failed: true },
  failed: { labelKey: "gitClientWindow.sync.result.failed", failed: true },
  "recovery-required": { labelKey: "gitClientWindow.sync.result.recoveryRequired", failed: true },
};

// The publish rejection vocabulary is owned by the publish gateway (keiko-tools) and reaches the UI as
// an opaque wire string, so this lookup is keyed by string with an explicit fallback: an unrecognized
// token degrades to the generic rejection sentence rather than being printed raw.
const PUBLISH_REJECTION_LABEL: Readonly<Record<string, MessageKey>> = {
  "non-fast-forward": "gitClientWindow.sync.rejection.nonFastForward",
  "fetch-first": "gitClientWindow.sync.rejection.fetchFirst",
  "no-upstream": "gitClientWindow.sync.rejection.noUpstream",
  "auth-failed": "gitClientWindow.sync.rejection.authFailed",
  "permission-denied": "gitClientWindow.sync.rejection.permissionDenied",
  "protected-ref": "gitClientWindow.sync.rejection.protectedRef",
  "remote-unavailable": "gitClientWindow.sync.rejection.remoteUnavailable",
  unknown: "gitClientWindow.sync.rejection.unknown",
};

// Total over the contract's recovery-hint union; the wire string is narrowed by the contract guard
// first, so an unknown token contributes no hint instead of leaking.
const RECOVERY_HINT_LABEL: Readonly<Record<string, MessageKey>> = {
  retry: "gitClientWindow.sync.hint.retry",
  "stage-changes": "gitClientWindow.sync.hint.stageChanges",
  "configure-upstream": "gitClientWindow.sync.hint.configureUpstream",
  "resolve-conflicts": "gitClientWindow.sync.hint.resolveConflicts",
  "abort-in-progress-operation": "gitClientWindow.sync.hint.abortInProgress",
  "request-approval": "gitClientWindow.sync.hint.requestApproval",
  "adjust-policy-target": "gitClientWindow.sync.hint.adjustPolicyTarget",
  "recover-via-strategy": "gitClientWindow.sync.hint.recoverViaStrategy",
  "wait-for-provider": "gitClientWindow.sync.hint.waitForProvider",
};

function statusSentence(
  label: string,
  presentation: OutcomePresentation,
  t: I18nTranslate,
): string {
  return t("gitClientWindow.sync.operationStatus", { label, status: t(presentation.labelKey) });
}

export function syncOutcomePresentation(
  operationLabel: string,
  outcome: GitSyncOutcome,
  t: I18nTranslate,
): SyncOutcomeView {
  const presentation = SYNC_OUTCOME[outcome];
  return { message: statusSentence(operationLabel, presentation, t), failed: presentation.failed };
}

function rejectionSuffix(reason: string | undefined, t: I18nTranslate): string {
  if (reason === undefined) return "";
  const key = PUBLISH_REJECTION_LABEL[reason] ?? "gitClientWindow.sync.rejection.unknown";
  return t("gitClientWindow.sync.rejectionSuffix", { reason: t(key) });
}

function hintSuffix(hint: string | undefined, t: I18nTranslate): string {
  if (hint === undefined || !isGitDeliveryRecoveryActionHint(hint)) return "";
  const key = RECOVERY_HINT_LABEL[hint];
  return key === undefined ? "" : t("gitClientWindow.sync.hintSuffix", { hint: t(key) });
}

export function pushOutcomePresentation(
  operationLabel: string,
  outcome: GitMutationOutcome,
  t: I18nTranslate,
): SyncOutcomeView {
  const presentation = PUSH_STATUS[outcome.status];
  const base = statusSentence(operationLabel, presentation, t);
  if (!presentation.failed) return { message: base, failed: false };
  // The server computes the precise rejection reason and the recovery hint for a rejected push; both
  // are the point of the failure message, so neither is dropped here.
  return {
    message: `${base}${rejectionSuffix(outcome.publishRejectionReason, t)}${hintSuffix(
      outcome.recoveryActionHint,
      t,
    )}`,
    failed: true,
  };
}
