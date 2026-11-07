"use client";
import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import type { ChatToolWriteApprovalView } from "@oscharko-dev/keiko-contracts";
import type { ChatToolExchange, ChatTurnState } from "@oscharko-dev/keiko-contracts/bff-wire";
import {
  decideJiraChatWriteApproval,
  getJiraChatWriteApproval,
  getJiraStagedDraft,
} from "@/lib/atlassian-connectors-api";
import {
  useOptionalWidgetTranslate as useTranslate,
  type WidgetMessageKey,
} from "@/lib/optional-widget-i18n";
import { jiraCallLabel } from "./jira-tool-presentation";
import { JiraAttachmentReview } from "./JiraAttachmentReview";
import { JiraDecisionActions } from "./JiraDecisionActions";
import { DraftFields, JiraDraftPreview } from "./JiraDraftPreview";
import { jiraActionFacts } from "./jiraActionFacts";
import { jiraDraftExcluded, jiraDraftTree } from "./jiraDraftTree";
import { JiraNamesContext, type JiraNames } from "./jiraNames";
import { jiraNamesBinding } from "./jiraFieldChoices";
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
  operation,
}: {
  readonly args: unknown;
  readonly managed: boolean;
  readonly note?: WidgetMessageKey;
  readonly operation?: string;
}): ReactNode {
  const t = useTranslate();
  const names = useContext(JiraNamesContext);
  // Not memoized: the translator keeps its identity while a late-loading catalog refreshes it.
  const facts = jiraActionFacts(args, managed, t, names, operation);
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

function ApprovalHeader({
  approval,
  call,
}: {
  readonly approval: ChatToolWriteApprovalView;
  readonly call: ChatToolExchange["call"];
}): ReactNode {
  const t = useTranslate();
  return (
    <>
      <strong>{t(approvalTitleKey(approval))}</strong>
      <p>{approvalOperationLabel(approval, call, t)}</p>
    </>
  );
}

function approvalOperationLabel(
  approval: ChatToolWriteApprovalView,
  call: ChatToolExchange["call"],
  t: ReturnType<typeof useTranslate>,
): string {
  return approval.kind === "mcp-chat-write"
    ? approval.operation
    : t(jiraCallLabel(approval.operation, call.arguments));
}

/** A decision waits on the human, who may have scrolled away while the turn worked. */
function useRevealWhileDecidable(decidable: boolean): RefObject<HTMLElement | null> {
  const card = useRef<HTMLElement>(null);
  useEffect(() => {
    const element = card.current;
    if (decidable && typeof element?.scrollIntoView === "function")
      element.scrollIntoView({ block: "start" });
  }, [decidable]);
  return card;
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
const ATTACHMENT_FILE_ARGS = new Set(["name", "source"]);
/** The file named by these arguments is shown once, as the server read it. */
function shownArgs(approval: ChatToolWriteApprovalView, args: unknown): unknown {
  if (approval.kind !== "jira-chat-write" || approval.attachment === undefined) return args;
  if (typeof args !== "object" || args === null) return args;
  return Object.fromEntries(Object.entries(args).filter(([key]) => !ATTACHMENT_FILE_ARGS.has(key)));
}

function ApprovalContent({
  approval,
  staged,
  draft,
  decidable,
  editable,
  toggle,
}: {
  readonly approval: ChatToolWriteApprovalView;
  readonly staged: StagedJiraDraft;
  readonly draft: ReturnType<typeof useDraftSelection>;
  readonly decidable: boolean;
  readonly editable: boolean;
  readonly toggle: (ref: string) => void;
}): ReactNode {
  // A settled draft is deleted; saying it cannot be approved any more would only confuse its outcome.
  if (staged.status === "unavailable" && !decidable) return null;
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
      args={shownArgs(approval, staged.args)}
      managed={approval.kind === "jira-chat-write"}
      operation={approval.operation}
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

function approvalStatusKey(
  verified: boolean,
  state: ChatToolWriteApprovalView["state"],
  ended: boolean,
): WidgetMessageKey {
  if (!verified) return "chat.jira.writeApproval.unavailable";
  return APPROVAL_KEYS[ended && state === "pending" ? "expired" : state];
}

function useApprovalNames(approval: ChatToolWriteApprovalView): JiraNames {
  const names = useContext(JiraNamesContext);
  const binding = jiraNamesBinding(approval);
  return useMemo(() => ({ ...names, binding }), [names, binding]);
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
  // A finished turn has no decision left to make, and its stored state is the whole story.
  const ended = turnState !== undefined && turnState !== "pending";
  const state = useJiraDecision({
    key: `${approval.approvalId}:${approval.actionDigest}`,
    current: approval,
    decide: (decision) =>
      isDraft(approval) ? decide(approval, decision, deselection) : decide(approval, decision),
    ...(ended ? {} : { observe: refresh }),
  });
  const decidable = state.view.state === "pending" && turnState === "pending";
  const card = useRevealWhileDecidable(decidable);
  const { staged, draft, blocked } = useDraftReview(approval, state.view, {
    call,
    ...(loadDraft === undefined ? {} : { loadDraft }),
    deselection,
  });
  const status = approvalStatusKey(state.verified, state.view.state, ended);
  const boundNames = useApprovalNames(approval);
  return (
    <JiraNamesContext.Provider value={boundNames}>
      <section ref={card} className={styles.cmpCard} aria-label={t(approvalTitleKey(approval))}>
        <ApprovalHeader approval={approval} call={call} />
        <ApprovalContent
          approval={approval}
          staged={staged}
          draft={draft}
          decidable={decidable}
          editable={decidable && !state.busy}
          toggle={toggle}
        />
        <JiraAttachmentReview approval={approval} />
        <output aria-live="polite">
          {t(state.busy ? "chat.jira.writeApproval.working" : status)}
        </output>
        <WriteApprovalActions state={state} turnState={turnState} empty={blocked} />
      </section>
    </JiraNamesContext.Provider>
  );
}
