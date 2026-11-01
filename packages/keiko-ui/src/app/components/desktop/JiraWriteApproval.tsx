"use client";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import type { ChatToolWriteApprovalView } from "@oscharko-dev/keiko-contracts";
import type { ChatToolExchange, ChatTurnState } from "@oscharko-dev/keiko-contracts/bff-wire";
import { JIRA_MANAGED_ACTION_TYPES } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  decideJiraChatWriteApproval,
  getJiraChatWriteApproval,
  getJiraStagedDraft,
} from "@/lib/atlassian-connectors-api";
import {
  useOptionalWidgetTranslate as useTranslate,
  type WidgetMessageKey,
} from "@/lib/optional-widget-i18n";
import { actionTypeLabelKey } from "./widgets/connectors/connector-labels";
import { JiraAttachmentReview } from "./JiraAttachmentReview";
import { JiraDecisionActions } from "./JiraDecisionActions";
import { DraftFields, JiraDraftPreview } from "./JiraDraftPreview";
import { jiraActionFacts } from "./jiraActionFacts";
import { jiraDraftExcluded, jiraDraftTree } from "./jiraDraftTree";
import { useJiraDecision } from "./useJiraDecision";
import { useStagedJiraDraft, type StagedJiraDraft } from "./useStagedJiraDraft";
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
  readonly loadDraft?: typeof getJiraStagedDraft;
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
/**
 * What the human approves, read from the exact request as named facts - never as JSON. A readable
 * backlog draft is shown by its tree alone; a draft that cannot be laid out as a tree is shown
 * field by field under a note, so the approval still names everything it covers.
 */
function ActionDetails({
  args,
  managed,
  note,
}: {
  readonly args: unknown;
  readonly managed: boolean;
  readonly note?: WidgetMessageKey;
}): ReactNode {
  const t = useTranslate();
  // Not memoized: the translator keeps its identity while a late-loading catalog refreshes it.
  const facts = jiraActionFacts(args, managed, t);
  return (
    <fieldset className={styles.cmpFactsGroup} aria-label={t("chat.jira.writeApproval.preview")}>
      {note === undefined ? null : <p className={styles.cmpDraftNote}>{t(note)}</p>}
      <DraftFields fields={facts} />
    </fieldset>
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

function approvalTitleKey(approval: ChatToolWriteApprovalView): WidgetMessageKey {
  return approval.kind === "mcp-chat-write"
    ? "chat.mcp.writeApproval.title"
    : "chat.jira.writeApproval.title";
}

function ApprovalHeader({ approval }: { readonly approval: ChatToolWriteApprovalView }): ReactNode {
  const t = useTranslate();
  const mcp = approval.kind === "mcp-chat-write";
  return (
    <>
      <strong>{t(approvalTitleKey(approval))}</strong>
      <p>
        {approval.kind === "mcp-chat-write"
          ? approval.operation
          : t(actionTypeLabelKey(JIRA_MANAGED_ACTION_TYPES[approval.operation]))}
      </p>
      <p>{t(mcp ? "chat.mcp.writeApproval.disclosure" : "chat.jira.writeApproval.disclosure")}</p>
    </>
  );
}

/** A staged draft that is not shown cannot be approved: the human would not see what it covers. */
function StagedDraftNote({ status }: { readonly status: "loading" | "unavailable" }): ReactNode {
  const t = useTranslate();
  if (status === "loading")
    return <output className={styles.cmpDraftNote}>{t("chat.jira.draft.loading")}</output>;
  return (
    <p role="alert" className={styles.cmpDraftNote}>
      {t("chat.jira.draft.unavailable")}
    </p>
  );
}

/** The draft's tree when it is readable as one, otherwise the request's facts. */
function ApprovalContent({
  approval,
  staged,
  draft,
  editable,
  toggle,
}: {
  readonly approval: ChatToolWriteApprovalView;
  readonly staged: StagedJiraDraft;
  readonly draft: ReturnType<typeof useDraftSelection>;
  readonly editable: boolean;
  readonly toggle: (ref: string) => void;
}): ReactNode {
  if (staged.status === "loading" || staged.status === "unavailable")
    return <StagedDraftNote status={staged.status} />;
  if (draft.tree !== undefined)
    return (
      <JiraDraftPreview
        tree={draft.tree}
        deselected={draft.deselected}
        excluded={draft.excluded}
        editable={editable}
        toggle={toggle}
      />
    );
  return (
    <ActionDetails
      args={staged.args}
      managed={approval.kind === "jira-chat-write"}
      {...(isDraft(approval) ? { note: "chat.jira.draft.unreadable" as const } : {})}
    />
  );
}

/** What is shown of the request, and whether the human can approve it as it is shown (#4178). */
function useDraftReview(
  approval: ChatToolWriteApprovalView,
  view: ChatToolWriteApprovalView,
  input: Pick<ApprovalProps, "call" | "loadDraft"> & { readonly deselection: readonly string[] },
): {
  readonly staged: StagedJiraDraft;
  readonly draft: ReturnType<typeof useDraftSelection>;
  readonly blocked: boolean;
} {
  const staged = useStagedJiraDraft({
    enabled: isDraft(approval),
    chatId: approval.chatId,
    args: input.call.arguments,
    load: input.loadDraft ?? getJiraStagedDraft,
  });
  const shown =
    staged.status === "loading" || staged.status === "unavailable" ? undefined : staged.args;
  const draft = useDraftSelection(approval, view, shown, input.deselection);
  // Nothing to approve: the items are not shown (yet) or the human left every one of them out.
  return {
    staged,
    draft,
    blocked: shown === undefined || draft.excluded.size === draft.tree?.refs.length,
  };
}

export function JiraWriteApproval({
  approval,
  call,
  turnState,
  decide = decideJiraChatWriteApproval,
  observe = getJiraChatWriteApproval,
  loadDraft,
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
  const { staged, draft, blocked } = useDraftReview(approval, state.view, {
    call,
    ...(loadDraft === undefined ? {} : { loadDraft }),
    deselection,
  });
  const status = state.verified
    ? APPROVAL_KEYS[state.view.state]
    : "chat.jira.writeApproval.unavailable";
  return (
    <section className={styles.cmpCard} aria-label={t(approvalTitleKey(approval))}>
      <ApprovalHeader approval={approval} />
      <ApprovalContent
        approval={approval}
        staged={staged}
        draft={draft}
        editable={state.view.state === "pending" && turnState === "pending" && !state.busy}
        toggle={toggle}
      />
      <JiraAttachmentReview approval={approval} />
      <output aria-live="polite">
        {t(state.busy ? "chat.jira.writeApproval.working" : status)}
      </output>
      <WriteApprovalActions state={state} turnState={turnState} empty={blocked} />
    </section>
  );
}
