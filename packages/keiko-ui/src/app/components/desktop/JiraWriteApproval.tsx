"use client";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import type { ChatToolWriteApprovalView } from "@oscharko-dev/keiko-contracts";
import type { ChatToolExchange, ChatTurnState } from "@oscharko-dev/keiko-contracts/bff-wire";
import { JIRA_MANAGED_ACTION_TYPES } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  decideJiraChatWriteApproval,
  getJiraChatWriteApproval,
} from "@/lib/atlassian-connectors-api";
import {
  useOptionalWidgetTranslate as useTranslate,
  type WidgetMessageKey,
} from "@/lib/optional-widget-i18n";
import { actionTypeLabelKey } from "./widgets/connectors/connector-labels";
import { JiraAttachmentReview } from "./JiraAttachmentReview";
import { JiraDecisionActions } from "./JiraDecisionActions";
import { JiraDraftPreview } from "./JiraDraftPreview";
import { jiraDraftExcluded, jiraDraftTree } from "./jiraDraftTree";
import { useJiraDecision } from "./useJiraDecision";
import styles from "./JiraChatTools.module.css";

const APPROVAL_KEYS: Readonly<Record<ChatToolWriteApprovalView["state"], WidgetMessageKey>> = {
  pending: "chat.jira.writeApproval.pending",
  approved: "chat.jira.writeApproval.approved",
  claimed: "chat.jira.writeApproval.claimed",
  rejected: "chat.jira.writeApproval.rejected",
  expired: "chat.jira.writeApproval.expired",
  revoked: "chat.jira.writeApproval.revoked",
};
interface ApprovalProps {
  readonly approval: ChatToolWriteApprovalView;
  readonly call: ChatToolExchange["call"];
  readonly turnState: ChatTurnState | undefined;
  readonly decide?: typeof decideJiraChatWriteApproval;
  readonly observe?: typeof getJiraChatWriteApproval;
}
function WriteApprovalActions({
  state,
  turnState,
  empty = false,
}: {
  readonly state: ReturnType<typeof useJiraDecision<ChatToolWriteApprovalView>>;
  readonly turnState: ChatTurnState | undefined;
  /** A draft with every item left out has nothing to approve; it can still be declined. */
  readonly empty?: boolean;
}): ReactNode {
  const t = useTranslate();
  const pending = state.view.state === "pending" && turnState === "pending";
  return (
    <>
      {state.failed ? <p role="alert">{t("chat.jira.writeApproval.failed")}</p> : null}
      {pending ? (
        <JiraDecisionActions
          disabled={!state.verified || state.busy || state.uncertain}
          approveDisabled={empty}
          approve={t("chat.jira.writeApproval.allow")}
          reject={t("chat.jira.writeApproval.deny")}
          submit={state.submit}
        />
      ) : null}
      {state.uncertain ? (
        <button
          type="button"
          className="lk-btn"
          disabled={state.busy}
          onClick={() => {
            void state.refresh();
          }}
        >
          {t("chat.jira.writeApproval.refresh")}
        </button>
      ) : null}
    </>
  );
}
function ExactPreview({
  call,
  collapsed,
}: {
  readonly call: ChatToolExchange["call"];
  readonly collapsed: boolean;
}): ReactNode {
  const t = useTranslate();
  const preview = (
    <textarea
      className={`${styles.cmpResult} ${styles.cmpPreview}`}
      readOnly
      rows={8}
      aria-label={t("chat.jira.writeApproval.preview")}
      value={JSON.stringify(call.arguments, null, 2)}
    />
  );
  if (!collapsed) return preview;
  return (
    <details>
      <summary>{t("chat.jira.writeApproval.preview")}</summary>
      {preview}
    </details>
  );
}

function isDraft(approval: ChatToolWriteApprovalView): boolean {
  return approval.kind === "jira-chat-write" && approval.operation === "jira.draft";
}

/** What a backlog draft's deselection leaves out, dependents included (#4178). */
function useDraftSelection(
  approval: ChatToolWriteApprovalView,
  view: ChatToolWriteApprovalView,
  args: unknown,
  pending: readonly string[],
): {
  readonly tree: ReturnType<typeof jiraDraftTree>;
  readonly deselected: ReadonlySet<string>;
  readonly excluded: ReadonlySet<string>;
} {
  const draft = isDraft(approval);
  const tree = useMemo(() => (draft ? jiraDraftTree(args) : undefined), [draft, args]);
  // Once decided, the server's record of the deselection is what was approved.
  const decided = view.state !== "pending" && view.kind === "jira-chat-write";
  const recorded = view.kind === "jira-chat-write" ? view.excludedItemRefs : undefined;
  const deselected = useMemo(
    () => new Set(decided ? (recorded ?? []) : pending),
    [decided, recorded, pending],
  );
  const excluded = useMemo(() => jiraDraftExcluded(args, deselected), [args, deselected]);
  return { tree, deselected, excluded };
}

function useDeselection(): readonly [readonly string[], (ref: string) => void] {
  const [deselection, setDeselection] = useState<readonly string[]>([]);
  const toggle = useCallback((ref: string): void => {
    setDeselection((current) =>
      current.includes(ref) ? current.filter((entry) => entry !== ref) : [...current, ref],
    );
  }, []);
  return [deselection, toggle];
}

function ApprovalHeader({ approval }: { readonly approval: ChatToolWriteApprovalView }): ReactNode {
  const t = useTranslate();
  const mcp = approval.kind === "mcp-chat-write";
  return (
    <>
      <strong>{t(mcp ? "chat.mcp.writeApproval.title" : "chat.jira.writeApproval.title")}</strong>
      <p>
        {approval.kind === "mcp-chat-write"
          ? approval.operation
          : t(actionTypeLabelKey(JIRA_MANAGED_ACTION_TYPES[approval.operation]))}
      </p>
      <p>{t(mcp ? "chat.mcp.writeApproval.disclosure" : "chat.jira.writeApproval.disclosure")}</p>
    </>
  );
}

export function JiraWriteApproval({
  approval,
  call,
  turnState,
  decide = decideJiraChatWriteApproval,
  observe = getJiraChatWriteApproval,
}: ApprovalProps): ReactNode {
  const t = useTranslate();
  const refresh = useCallback(() => observe(approval.approvalId), [observe, approval.approvalId]);
  const [deselection, toggle] = useDeselection();
  const state = useJiraDecision({
    key: `${approval.approvalId}:${approval.actionDigest}`,
    current: approval,
    decide: (decision) =>
      isDraft(approval) ? decide(approval, decision, deselection) : decide(approval, decision),
    observe: refresh,
  });
  const draft = useDraftSelection(approval, state.view, call.arguments, deselection);
  const status = state.verified
    ? APPROVAL_KEYS[state.view.state]
    : "chat.jira.writeApproval.unavailable";
  const title =
    approval.kind === "mcp-chat-write"
      ? "chat.mcp.writeApproval.title"
      : "chat.jira.writeApproval.title";
  return (
    <section className={styles.cmpCard} aria-label={t(title)}>
      <ApprovalHeader approval={approval} />
      {draft.tree === undefined ? null : (
        <JiraDraftPreview
          tree={draft.tree}
          deselected={draft.deselected}
          excluded={draft.excluded}
          editable={state.view.state === "pending" && turnState === "pending" && !state.busy}
          toggle={toggle}
        />
      )}
      <ExactPreview call={call} collapsed={draft.tree !== undefined} />
      <JiraAttachmentReview approval={approval} />
      <output aria-live="polite">
        {t(state.busy ? "chat.jira.writeApproval.working" : status)}
      </output>
      <WriteApprovalActions
        state={state}
        turnState={turnState}
        empty={draft.excluded.size === draft.tree?.refs.length}
      />
    </section>
  );
}
