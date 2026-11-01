import type { ChatToolExchange } from "@oscharko-dev/keiko-contracts/bff-wire";
import type {
  ChatToolWriteApprovalState,
  ChatToolWriteApprovalView,
} from "@oscharko-dev/keiko-contracts";
import { parseJiraDraft, parseJiraDraftReference } from "@oscharko-dev/keiko-connectors";
import {
  isJiraDraftRef,
  JIRA_DRAFT_ITEMS_MAX,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { canonicalise } from "@oscharko-dev/keiko-security";

const APPROVAL_STATES: Readonly<
  Record<ChatToolWriteApprovalState, ReadonlySet<ChatToolWriteApprovalState>>
> = {
  pending: new Set(["pending", "approved", "claimed", "rejected", "expired", "revoked"]),
  approved: new Set(["approved", "claimed", "expired", "revoked"]),
  claimed: new Set(["claimed", "expired", "revoked"]),
  rejected: new Set(["rejected"]),
  expired: new Set(["expired"]),
  revoked: new Set(["revoked"]),
};

/** Everything an approval is, except the two members a transition may legitimately change. */
function approvalIdentity(view: ChatToolWriteApprovalView): string {
  return canonicalise(
    Object.fromEntries(
      Object.entries(view).filter(([key]) => key !== "state" && key !== "excludedItemRefs"),
    ),
  );
}

function exclusionsOf(view: ChatToolWriteApprovalView): readonly string[] {
  return view.kind === "jira-chat-write" ? (view.excludedItemRefs ?? []) : [];
}

/** The deselection is a unique, non-empty subset of the refs of the draft that was reviewed. */
function validDeselection(excluded: readonly string[], call: ChatToolExchange["call"]): boolean {
  // A call that names a staged draft carries no items here: the registry compared the deselection
  // with the refs of the draft it digest-bound at the request, so only its form is checked.
  if (parseJiraDraftReference(call.arguments) !== undefined)
    return (
      excluded.length > 0 &&
      excluded.length <= JIRA_DRAFT_ITEMS_MAX &&
      new Set(excluded).size === excluded.length &&
      excluded.every(isJiraDraftRef)
    );
  const draft = parseJiraDraft(call.arguments);
  if (draft === undefined || excluded.length === 0) return false;
  const refs = new Set(draft.items.map((item) => item.ref));
  return new Set(excluded).size === excluded.length && excluded.every((ref) => refs.has(ref));
}

/**
 * The one authorized change to a stored approval besides its state: the human's decision on a
 * pending `jira.draft` adds the deselection, once. It never appears at another transition and
 * never changes afterwards (#4178, ADR-0128 D4).
 */
function exclusionsAdmitted(
  previous: ChatToolWriteApprovalView,
  next: ChatToolWriteApprovalView,
  call: ChatToolExchange["call"],
): boolean {
  const before = exclusionsOf(previous);
  const after = exclusionsOf(next);
  if (canonicalise(before) === canonicalise(after)) return true;
  return (
    previous.state === "pending" &&
    next.state === "approved" &&
    next.operation === "jira.draft" &&
    before.length === 0 &&
    validDeselection(after, call)
  );
}

/** A first save is always the pending request: no decision, so no deselection yet. */
export function admitsFirstApproval(next: ChatToolWriteApprovalView): boolean {
  return exclusionsOf(next).length === 0;
}

/** Same action, a permitted state move, and no exclusion change except the approving one. */
export function admitsApprovalTransition(
  previous: ChatToolWriteApprovalView,
  next: ChatToolWriteApprovalView,
  call: ChatToolExchange["call"],
): boolean {
  return (
    approvalIdentity(previous) === approvalIdentity(next) &&
    APPROVAL_STATES[previous.state].has(next.state) &&
    exclusionsAdmitted(previous, next, call)
  );
}
