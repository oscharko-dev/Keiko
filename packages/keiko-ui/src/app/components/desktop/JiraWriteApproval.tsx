"use client";
import { useCallback, type ReactNode } from "react";
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
import { JiraDecisionActions } from "./JiraDecisionActions";
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
}: {
  readonly state: ReturnType<typeof useJiraDecision<ChatToolWriteApprovalView>>;
  readonly turnState: ChatTurnState | undefined;
}): ReactNode {
  const t = useTranslate();
  const pending = state.view.state === "pending" && turnState === "pending";
  return (
    <>
      {state.failed ? <p role="alert">{t("chat.jira.writeApproval.failed")}</p> : null}
      {pending ? (
        <JiraDecisionActions
          disabled={!state.verified || state.busy || state.uncertain}
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
export function JiraWriteApproval({
  approval,
  call,
  turnState,
  decide = decideJiraChatWriteApproval,
  observe = getJiraChatWriteApproval,
}: ApprovalProps): ReactNode {
  const t = useTranslate();
  const refresh = useCallback(() => observe(approval.approvalId), [observe, approval.approvalId]);
  const state = useJiraDecision({
    key: `${approval.approvalId}:${approval.actionDigest}`,
    current: approval,
    decide: (decision) => decide(approval, decision),
    observe: refresh,
  });
  const status = state.verified
    ? APPROVAL_KEYS[state.view.state]
    : "chat.jira.writeApproval.unavailable";
  const statusText = t(state.busy ? "chat.jira.writeApproval.working" : status);
  const title =
    approval.kind === "mcp-chat-write"
      ? "chat.mcp.writeApproval.title"
      : "chat.jira.writeApproval.title";
  return (
    <section className={styles.cmpCard} aria-label={t(title)}>
      <strong>{t(title)}</strong>
      <p>
        {approval.kind === "mcp-chat-write"
          ? approval.operation
          : t(actionTypeLabelKey(JIRA_MANAGED_ACTION_TYPES[approval.operation]))}
      </p>
      <p>
        {t(
          approval.kind === "mcp-chat-write"
            ? "chat.mcp.writeApproval.disclosure"
            : "chat.jira.writeApproval.disclosure",
        )}
      </p>
      <textarea
        className={`${styles.cmpResult} ${styles.cmpPreview}`}
        readOnly
        rows={8}
        aria-label={t("chat.jira.writeApproval.preview")}
        value={JSON.stringify(call.arguments, null, 2)}
      />
      <output aria-live="polite">{statusText}</output>
      <WriteApprovalActions state={state} turnState={turnState} />
    </section>
  );
}
