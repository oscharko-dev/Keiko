"use client";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import type { CodingWorkbenchMode } from "@oscharko-dev/keiko-contracts";
import type { Chat } from "@/lib/types";
import { fetchChats, type UpdateChatInput } from "@/lib/api";
import {
  listAtlassianConnectors,
  type AtlassianConnectorMetadata,
} from "@/lib/atlassian-connectors-api";
import {
  connectionRequest,
  JIRA_CHAT_CONNECTION_REQUEST_EVENT,
  type JiraChatConnectionRequest,
} from "./jira-chat-connection-request";
import { updateGroundingScopes } from "@/lib/chat-grounding-mutation";
import { useOptionalWidgetTranslate as useTranslate } from "@/lib/optional-widget-i18n";
import { useConnectorRefresh } from "./useConnectorRefresh";
import { AutonomyModeSelect } from "./AutonomyModeSelect";
import styles from "./JiraChatConnection.module.css";

interface PodChoice {
  readonly id: string;
  readonly name: string;
  readonly ready: boolean;
}
interface Draft {
  readonly revision: string;
  readonly podId: string;
  readonly mode: CodingWorkbenchMode;
  readonly confirmed: boolean;
}
interface ConnectionProps {
  readonly chat: Chat;
  readonly onChatChanged: (chat: Chat) => void;
  readonly list?: typeof listAtlassianConnectors;
  readonly persist?: typeof updateGroundingScopes;
}
function revision(chat: Chat): string {
  return JSON.stringify([chat.id, chat.groundingScopeIdentity]);
}
function initialDraft(chat: Chat): Draft {
  return {
    revision: revision(chat),
    podId: chat.jiraPodBinding?.podId ?? "",
    mode: chat.toolMode ?? "governed-assist",
    confirmed: false,
  };
}
function choices(metadata: readonly AtlassianConnectorMetadata[]): readonly PodChoice[] {
  return metadata.flatMap((item) =>
    item.deployment !== "data-center" || item.livePod === undefined
      ? []
      : [
          {
            id: item.livePod.podId,
            name: item.displayName,
            ready:
              item.livePod.verificationStatus === "ok" &&
              !item.livePod.verificationInProgress &&
              item.livePod.capabilities.includes("live-read"),
          },
        ],
  );
}
function usePodChoices(list: typeof listAtlassianConnectors): {
  pods: readonly PodChoice[];
  loading: boolean;
  failed: boolean;
  reload: () => void;
} {
  const [pods, setPods] = useState<readonly PodChoice[]>([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (version === 0) return;
    let active = true;
    void list()
      .then((items) => {
        if (active) setPods(choices(items));
      })
      .catch(() => {
        if (active) setFailed(true);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return (): void => {
      active = false;
    };
  }, [list, version]);
  useConnectorRefresh(() => {
    setLoading(true);
    setFailed(false);
    setVersion((value) => value + 1);
  });
  return {
    pods,
    loading,
    failed,
    reload: (): void => {
      setLoading(true);
      setFailed(false);
      setVersion((value) => value + 1);
    },
  };
}
function useChatPatch(
  chat: Chat,
  onChanged: ConnectionProps["onChatChanged"],
  persist: typeof updateGroundingScopes,
  requestGeneration: JiraChatConnectionRequest | undefined,
): {
  busy: boolean;
  failed: boolean;
  submit: (patch: UpdateChatInput) => Promise<void>;
} {
  const view = useRef<object | undefined>(undefined);
  const locked = useRef(false);
  const [busy, setBusy] = useState(false);
  const [failedRevision, setFailedRevision] = useState<string>();
  const currentRevision = revision(chat);
  useLayoutEffect(() => {
    view.current = {};
    return (): void => {
      view.current = undefined;
    };
  }, [currentRevision, requestGeneration]);
  const submit = async (patch: UpdateChatInput): Promise<void> => {
    if (requestGeneration !== undefined && !requestGeneration.isCurrent()) {
      requestGeneration.settle(false);
      return;
    }
    const admitted = view.current;
    if (locked.current || admitted === undefined) return;
    locked.current = true;
    setBusy(true);
    setFailedRevision(undefined);
    const publish = (updated: Chat): void => {
      if (view.current === admitted) onChanged(updated);
    };
    try {
      publish(await persist(chat, patch, publish));
    } catch {
      if (view.current === admitted) setFailedRevision(currentRevision);
    } finally {
      locked.current = false;
      if (view.current !== undefined) setBusy(false);
    }
  };
  return { busy, failed: failedRevision === currentRevision, submit };
}
function PodSelect({
  pods,
  value,
  current,
  onChange,
}: {
  readonly pods: readonly PodChoice[];
  readonly value: string;
  readonly current: string;
  readonly onChange: (value: string) => void;
}): ReactNode {
  const t = useTranslate();
  const id = useId();
  return (
    <label htmlFor={id}>
      {t("chat.jira.podLabel")}
      <select
        id={id}
        className="scope-grounding-select"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">{t("chat.jira.noPod")}</option>
        {current !== "" && !pods.some((pod) => pod.id === current) ? (
          <option value={current} disabled>
            {t("chat.jira.podUnavailable")}
          </option>
        ) : null}
        {pods.map((pod) => (
          <option key={pod.id} value={pod.id} disabled={!pod.ready}>
            {pod.name}
            {pod.ready ? "" : ` — ${t("chat.jira.verifyRequired")}`}
          </option>
        ))}
      </select>
    </label>
  );
}
function selectionPlan(
  chat: Chat,
  draft: Draft,
  pods: readonly PodChoice[],
): {
  current: string;
  replacement: boolean;
  unchanged: boolean;
  unavailable: boolean;
} {
  const current = chat.jiraPodBinding?.podId ?? "";
  const replacement = current !== "" && draft.podId !== "" && current !== draft.podId;
  const unchanged = current === draft.podId && (chat.toolMode ?? "governed-assist") === draft.mode;
  const unavailable =
    draft.podId !== "" &&
    draft.podId !== current &&
    !pods.some((pod) => pod.id === draft.podId && pod.ready);
  return { current, replacement, unchanged, unavailable };
}
function ReplacementConfirmation({
  required,
  draft,
  setDraft,
}: {
  readonly required: boolean;
  readonly draft: Draft;
  readonly setDraft: (draft: Draft) => void;
}): ReactNode {
  const t = useTranslate();
  return required ? (
    <label>
      <input
        type="checkbox"
        checked={draft.confirmed}
        onChange={(event) => setDraft({ ...draft, confirmed: event.target.checked })}
      />{" "}
      {t("chat.jira.replaceConfirm")}
    </label>
  ) : null;
}
interface ConnectionFormProps {
  readonly chat: Chat;
  readonly draft: Draft;
  readonly setDraft: (draft: Draft) => void;
  readonly catalog: ReturnType<typeof usePodChoices>;
  readonly mutation: ReturnType<typeof useChatPatch>;
  readonly acknowledgementRequested: boolean;
}
function ConnectionMode({
  chat,
  draft,
  setDraft,
}: Pick<ConnectionFormProps, "chat" | "draft" | "setDraft">): ReactNode {
  const t = useTranslate();
  return (
    <>
      <AutonomyModeSelect
        label={t("chat.jira.modeLabel")}
        value={draft.mode}
        ceiling={chat.toolModeCeiling ?? "governed-assist"}
        onChange={(mode) => setDraft({ ...draft, mode })}
      />
      <p>{t("chat.jira.modeHelp")}</p>
      <p role="status">
        {t("chat.jira.effectiveMode", {
          mode: t(`codingWorkbench.mode.${chat.effectiveToolMode ?? "governed-assist"}.label`),
        })}
      </p>
    </>
  );
}

function ConnectionForm({
  chat,
  draft,
  setDraft,
  catalog,
  mutation,
  acknowledgementRequested,
}: ConnectionFormProps): ReactNode {
  const t = useTranslate();
  const plan = selectionPlan(chat, draft, catalog.failed ? [] : catalog.pods);
  const blocked =
    mutation.busy ||
    catalog.loading ||
    plan.unavailable ||
    (plan.unchanged && !acknowledgementRequested) ||
    (plan.replacement && !draft.confirmed);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (!blocked)
          void mutation.submit({ jiraPodId: draft.podId || null, toolMode: draft.mode });
      }}
    >
      <fieldset className={styles.cmpFields} disabled={mutation.busy}>
        <PodSelect
          pods={catalog.pods}
          value={draft.podId}
          current={plan.current}
          onChange={(podId) => setDraft({ ...draft, podId, confirmed: false })}
        />
        <ConnectionMode chat={chat} draft={draft} setDraft={setDraft} />
        <ReplacementConfirmation required={plan.replacement} draft={draft} setDraft={setDraft} />
        <button className="lk-btn" type="submit" disabled={blocked}>
          {t("chat.jira.apply")}
        </button>
      </fieldset>
      {mutation.failed || catalog.failed ? (
        <p role="alert">{t("chat.jira.connectionFailed")}</p>
      ) : null}
    </form>
  );
}
function useDisclosureEscape(ref: RefObject<HTMLDetailsElement | null>, open: boolean): void {
  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent): void => {
      const node = ref.current;
      if (event.key !== "Escape" || node === null || !node.contains(document.activeElement)) return;
      if (node.querySelector('[role="combobox"][aria-expanded="true"]') !== null) return;
      event.stopPropagation();
      event.preventDefault();
      node.open = false;
      node.querySelector<HTMLElement>("summary")?.focus();
    };
    document.addEventListener("keydown", close, true);
    return (): void => document.removeEventListener("keydown", close, true);
  }, [ref, open]);
}

interface WorkspaceConnectionRequestState {
  pending: RefObject<JiraChatConnectionRequest | undefined>;
  generation: JiraChatConnectionRequest | undefined;
  settle: (accepted: boolean) => void;
}

function useJiraWorkspaceRequest(
  chat: Chat,
  detailsRef: RefObject<HTMLDetailsElement | null>,
  reveal: (request: JiraChatConnectionRequest) => void,
): WorkspaceConnectionRequestState {
  const pending = useRef<JiraChatConnectionRequest | undefined>(undefined);
  const [accepted, setAccepted] = useState<{
    revision: string;
    request: JiraChatConnectionRequest;
  }>();
  const currentRevision = revision(chat);
  const latestReveal = useRef(reveal);
  latestReveal.current = reveal;
  const settle = (result: boolean): void => {
    pending.current?.settle(result);
    pending.current = undefined;
    setAccepted(undefined);
  };
  useLayoutEffect(() => {
    const receive = (event: Event): void => {
      const request = connectionRequest(event);
      if (
        request === undefined ||
        request.chatId !== chat.id ||
        detailsRef.current?.closest("[data-window-id]")?.getAttribute("data-window-id") !==
          request.chatWindowId ||
        !request.accept()
      )
        return;
      pending.current?.settle(false);
      pending.current = request;
      setAccepted({ revision: currentRevision, request });
      latestReveal.current(request);
    };
    window.addEventListener(JIRA_CHAT_CONNECTION_REQUEST_EVENT, receive);
    return (): void => {
      window.removeEventListener(JIRA_CHAT_CONNECTION_REQUEST_EVENT, receive);
      pending.current?.settle(false);
      pending.current = undefined;
    };
  }, [chat.id, currentRevision, detailsRef]);
  return {
    pending,
    generation: accepted?.revision === currentRevision ? accepted.request : undefined,
    settle,
  };
}

function useCanonicalChatRefresh(
  chat: Chat,
  onChanged: (chat: Chat) => void,
  cancelRequest: () => void,
): boolean {
  const [failed, setFailed] = useState(false);
  const current = useRef<object | undefined>(undefined);
  const currentRevision = revision(chat);
  useLayoutEffect(() => {
    current.current = {};
    return (): void => {
      current.current = undefined;
    };
  }, [currentRevision, chat.updatedAt]);
  useConnectorRefresh(() => {
    cancelRequest();
    const expected = {};
    current.current = expected;
    void fetchChats(chat.projectPath, undefined, chat.id)
      .then((response) => {
        if (current.current !== expected) return;
        const updated = response.chats.find((item) => item.id === chat.id);
        if (updated !== undefined && updated.updatedAt >= chat.updatedAt) onChanged(updated);
        setFailed(updated === undefined);
      })
      .catch(() => {
        if (current.current === expected) setFailed(true);
      });
  });
  return failed;
}

interface ConnectionState {
  open: boolean;
  toggle: (open: boolean) => void;
  detailsRef: RefObject<HTMLDetailsElement | null>;
  draft: Draft;
  setDraft: (draft: Draft) => void;
  catalog: ReturnType<typeof usePodChoices>;
  mutation: ReturnType<typeof useChatPatch>;
  refreshFailed: boolean;
  acknowledgementRequested: boolean;
}

function acknowledgesRequest(request: JiraChatConnectionRequest, chat: Chat): boolean {
  return (
    request.isCurrent() &&
    chat.id === request.chatId &&
    chat.jiraPodBinding?.podId === request.podId
  );
}

function useConnectionState({
  chat,
  onChatChanged,
  list = listAtlassianConnectors,
  persist = updateGroundingScopes,
}: ConnectionProps): ConnectionState {
  const [storedDraft, setDraft] = useState(() => initialDraft(chat));
  const [open, setOpen] = useState(false);
  const detailsRef = useRef<HTMLDetailsElement>(null);
  useDisclosureEscape(detailsRef, open);
  const draft = storedDraft.revision === revision(chat) ? storedDraft : initialDraft(chat);
  const catalog = usePodChoices(list);
  const request = useJiraWorkspaceRequest(chat, detailsRef, (pending) => {
    setDraft({ ...initialDraft(chat), podId: pending.podId });
    if (detailsRef.current !== null) detailsRef.current.open = true;
    setOpen(true);
    catalog.reload();
    detailsRef.current?.querySelector<HTMLElement>("summary")?.focus();
  });
  const refreshFailed = useCanonicalChatRefresh(chat, onChatChanged, () => request.settle(false));
  const mutation = useChatPatch(
    chat,
    (updated) => {
      const pending = request.pending.current;
      if (pending !== undefined) request.settle(acknowledgesRequest(pending, updated));
      onChatChanged(updated);
    },
    persist,
    request.generation,
  );
  const toggle = (next: boolean): void => {
    setOpen(next);
    if (next) catalog.reload();
    else request.settle(false);
  };
  return {
    open,
    toggle,
    detailsRef,
    draft,
    setDraft,
    catalog,
    mutation,
    refreshFailed,
    acknowledgementRequested: request.generation !== undefined,
  };
}

export function JiraChatConnection(props: ConnectionProps): ReactNode {
  const t = useTranslate();
  const state = useConnectionState(props);
  return (
    <details
      className={styles.cmpRoot}
      data-testid="jira-chat-connection"
      ref={state.detailsRef}
      onToggle={(event) => state.toggle(event.currentTarget.open)}
    >
      <summary className="lk-btn">{t("chat.jira.connection")}</summary>
      {state.open ? (
        <div className={styles.cmpPanel}>
          <output>
            {t(props.chat.jiraPodBinding === undefined ? "chat.jira.unbound" : "chat.jira.bound")}
          </output>
          {state.refreshFailed ? <p role="alert">{t("chat.jira.connectionFailed")}</p> : null}
          <ConnectionForm
            chat={props.chat}
            draft={state.draft}
            setDraft={state.setDraft}
            catalog={state.catalog}
            mutation={state.mutation}
            acknowledgementRequested={state.acknowledgementRequested}
          />
        </div>
      ) : null}
    </details>
  );
}
