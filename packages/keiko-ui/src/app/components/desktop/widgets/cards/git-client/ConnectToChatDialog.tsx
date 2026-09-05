"use client";

// Issue #3400 (epic #3384) — "Connect to Chat" affordance for the Git window.
//
// Frozen Decision 5: the Git window only CONNECTS a comparison to a Chat; every refinement of the
// resulting pull-request description happens in normal Chat afterwards. This dialog therefore
// exposes exactly three inputs — which Chat, which comparison mode, and (for an exact comparison)
// which base branch — and one action. It introduces no branch, push, PR-create, or merge control;
// those already live in this window's Changes/Sync/Pull-Request/Merge surfaces and are untouched.
//
// The browser never sends a path, revision, diff, or provider parameter: only the target chat id
// and a ref/mode selection. The server (POST /api/git-change/connect) resolves the trusted
// repository, captures the immutable snapshot, and returns either the server-issued scope or a
// closed blocked reason — rendered here via the same vocabulary as GitChangeScopePill.

import { useEffect, useRef, useState } from "react";
import type { CSSProperties, SubmitEventHandler, ReactNode, RefObject } from "react";
import { createPortal } from "react-dom";
import { connectGitChangeToChat, fetchChats } from "@/lib/api";
import type { ConnectGitChangeInput, GitChangeConnectResponse } from "@/lib/api";
import { useTranslate, type I18nTranslate } from "@/lib/i18n";
import type { Chat } from "@/lib/types";
import { gitChangeBlockedReasonMessage } from "../../../GitChangeScopePill";
import { useDialogTabTrap } from "../../../hooks/useDialogTabTrap";
import { useModalInteractionLock } from "../../../hooks/useModalInteractionLock";
import { notifyChatUpsert } from "../../../hooks/useChatSession";
import { Icons } from "../../../Icons";
import KeikoSelect from "../../../KeikoSelect";
import { formatUserError } from "../../../format-error";
import {
  INPUT_STYLE,
  PRIMARY_BTN,
  SECONDARY_BTN,
  SUBTLE_TEXT_STYLE,
  disabledStyle,
} from "./git-client-styles";

const BranchIcon = Icons.branch;

const OVERLAY_STYLE: CSSProperties = {
  position: "fixed",
  inset: 0,
  width: "auto",
  maxWidth: "none",
  height: "auto",
  maxHeight: "none",
  margin: 0,
  padding: 0,
  border: 0,
  zIndex: 100,
  display: "grid",
  placeItems: "center",
  background: "color-mix(in oklch, var(--surface-primary) 45%, transparent)",
};

const FORM_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-4)",
  width: "min(440px, calc(100vw - 48px))",
  padding: "var(--space-5)",
  border: "1px solid var(--border-subtle)",
  borderRadius: "var(--radius-lg)",
  background: "var(--surface-primary)",
  boxShadow: "var(--shadow-pop)",
};

type ConnectMode = "comparison" | "pull-request";

export interface ConnectToChatDialogProps {
  /** Repository root whose chats are eligible connect targets. */
  readonly projectId: string;
  /** The branch that will become the comparison's head ref. */
  readonly currentBranch: string | undefined;
  /** Default base branch (inferred upstream/integration branch), preselected but editable. */
  readonly baseBranchName: string | undefined;
  readonly baseBranchChoices: readonly string[];
  readonly onClose: () => void;
  readonly onConnected?: ((chat: Chat) => void) | undefined;
  /** Injectable wire seams for tests. Default to the real BFF helpers. */
  readonly listChats?: typeof fetchChats;
  readonly connect?: typeof connectGitChangeToChat;
}

interface ChatCatalog {
  readonly chats: readonly Chat[];
  readonly loading: boolean;
  readonly error: string | null;
}

function useChatCatalog(
  projectId: string,
  listChats: typeof fetchChats,
  t: I18nTranslate,
): ChatCatalog {
  const [chats, setChats] = useState<readonly Chat[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    listChats(projectId)
      .then((response) => {
        if (!cancelled) setChats(response.chats);
      })
      .catch((error_: unknown) => {
        if (!cancelled) {
          setError(formatUserError(error_, t("gitChangeScope.connect.chatLoadError")));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return (): void => {
      cancelled = true;
    };
  }, [projectId, listChats, t]);
  return { chats, loading, error };
}

function buildConnectInput(
  chatId: string,
  mode: ConnectMode,
  headRef: string,
  baseRef: string,
): ConnectGitChangeInput {
  return mode === "pull-request"
    ? { chatId, mode: "pull-request", headRef }
    : { chatId, mode: "comparison", headRef, baseRef };
}

function ModeToggle({
  mode,
  onChange,
  t,
}: {
  readonly mode: ConnectMode;
  readonly onChange: (mode: ConnectMode) => void;
  readonly t: I18nTranslate;
}): ReactNode {
  return (
    <fieldset
      style={{ display: "flex", gap: "var(--space-3)", margin: 0, padding: 0, border: 0 }}
      aria-label={t("gitChangeScope.connect.modeLabel")}
    >
      <button
        type="button"
        aria-pressed={mode === "comparison"}
        style={{ ...SECONDARY_BTN, flex: 1 }}
        onClick={() => onChange("comparison")}
      >
        {t("gitChangeScope.connect.modeComparison")}
      </button>
      <button
        type="button"
        aria-pressed={mode === "pull-request"}
        style={{ ...SECONDARY_BTN, flex: 1 }}
        onClick={() => onChange("pull-request")}
      >
        {t("gitChangeScope.connect.modePullRequest")}
      </button>
    </fieldset>
  );
}

function ChatField({
  chatId,
  onChatIdChange,
  catalog,
  t,
}: {
  readonly chatId: string;
  readonly onChatIdChange: (id: string) => void;
  readonly catalog: ChatCatalog;
  readonly t: I18nTranslate;
}): ReactNode {
  const { chats, loading, error } = catalog;
  const empty = !loading && chats.length === 0;
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
      <span style={SUBTLE_TEXT_STYLE}>{t("gitChangeScope.connect.chatLabel")}</span>
      <KeikoSelect
        value={chatId}
        ariaLabel={t("gitChangeScope.connect.chatLabel")}
        menuTitle={t("gitChangeScope.connect.chatLabel")}
        placeholder={t("gitChangeScope.connect.chatPlaceholder")}
        disabled={loading || empty}
        sections={[{ options: chats.map((chat) => ({ value: chat.id, label: chat.title })) }]}
        onValueChange={onChatIdChange}
      />
      {error !== null ? (
        <span role="alert" className="scope-connect-error">
          {error}
        </span>
      ) : null}
      {empty ? <span style={SUBTLE_TEXT_STYLE}>{t("gitChangeScope.connect.noChats")}</span> : null}
    </label>
  );
}

function BaseBranchField({
  baseRef,
  onBaseRefChange,
  choices,
  t,
}: {
  readonly baseRef: string;
  readonly onBaseRefChange: (name: string) => void;
  readonly choices: readonly string[];
  readonly t: I18nTranslate;
}): ReactNode {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
      <span style={SUBTLE_TEXT_STYLE}>{t("gitChangeScope.connect.baseLabel")}</span>
      <KeikoSelect
        value={baseRef}
        ariaLabel={t("gitChangeScope.connect.baseLabel")}
        menuTitle={t("gitChangeScope.connect.baseLabel")}
        leadingVisual={<BranchIcon size={12} />}
        mono
        sections={[{ options: choices.map((name) => ({ value: name, label: name })) }]}
        onValueChange={onBaseRefChange}
      />
    </label>
  );
}

function HeadBranchField({
  currentBranch,
  t,
}: {
  readonly currentBranch: string | undefined;
  readonly t: I18nTranslate;
}): ReactNode {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
      <span style={SUBTLE_TEXT_STYLE}>{t("gitChangeScope.connect.headLabel")}</span>
      <input
        value={currentBranch ?? ""}
        readOnly
        style={{ ...INPUT_STYLE, ...disabledStyle(true) }}
        aria-label={t("gitChangeScope.connect.headLabel")}
      />
    </label>
  );
}

function ConnectDialogActions({
  busy,
  canSubmit,
  onCancel,
  t,
}: {
  readonly busy: boolean;
  readonly canSubmit: boolean;
  readonly onCancel: () => void;
  readonly t: I18nTranslate;
}): ReactNode {
  return (
    <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--space-3)" }}>
      <button type="button" style={SECONDARY_BTN} onClick={onCancel}>
        {t("gitChangeScope.connect.cancel")}
      </button>
      <button
        type="submit"
        disabled={!canSubmit}
        style={{ ...PRIMARY_BTN, ...disabledStyle(!canSubmit || busy) }}
      >
        {t("gitChangeScope.connect.submit")}
      </button>
    </div>
  );
}

interface ConnectDialogFieldsProps {
  readonly chatId: string;
  readonly onChatIdChange: (id: string) => void;
  readonly catalog: ChatCatalog;
  readonly mode: ConnectMode;
  readonly onModeChange: (mode: ConnectMode) => void;
  readonly currentBranch: string | undefined;
  readonly baseRef: string;
  readonly onBaseRefChange: (name: string) => void;
  readonly baseBranchChoices: readonly string[];
  readonly error: string | null;
  readonly busy: boolean;
  readonly canSubmit: boolean;
  readonly onCancel: () => void;
  readonly t: I18nTranslate;
}

// Everything the dialog's <form> contains. Extracted so ConnectToChatDialog itself stays under
// the max-lines-per-function bar; this is pure presentation over props the parent already owns.
function ConnectDialogFields(props: ConnectDialogFieldsProps): ReactNode {
  const {
    chatId,
    onChatIdChange,
    catalog,
    mode,
    onModeChange,
    currentBranch,
    baseRef,
    onBaseRefChange,
    baseBranchChoices,
    error,
    busy,
    canSubmit,
    onCancel,
    t,
  } = props;
  return (
    <>
      <h2 style={{ margin: 0, font: "var(--weight-semibold) var(--text-body) var(--font-ui)" }}>
        {t("gitChangeScope.connect.title")}
      </h2>
      <p style={SUBTLE_TEXT_STYLE}>{t("gitChangeScope.connect.description")}</p>
      <ChatField chatId={chatId} onChatIdChange={onChatIdChange} catalog={catalog} t={t} />
      <ModeToggle mode={mode} onChange={onModeChange} t={t} />
      <HeadBranchField currentBranch={currentBranch} t={t} />
      {mode === "comparison" ? (
        <BaseBranchField
          baseRef={baseRef}
          onBaseRefChange={onBaseRefChange}
          choices={baseBranchChoices}
          t={t}
        />
      ) : null}
      {error !== null ? (
        <span role="alert" className="scope-connect-error">
          {error}
        </span>
      ) : null}
      <ConnectDialogActions busy={busy} canSubmit={canSubmit} onCancel={onCancel} t={t} />
    </>
  );
}

function blockedOrNetworkError(error: unknown, t: I18nTranslate): string {
  return formatUserError(error, t("gitChangeScope.connect.error"));
}

interface SubmitState {
  readonly busy: boolean;
  readonly error: string | null;
  readonly canSubmit: boolean;
  readonly submit: () => void;
}

function useSubmit(
  chatId: string,
  mode: ConnectMode,
  currentBranch: string | undefined,
  baseRef: string,
  connect: typeof connectGitChangeToChat,
  onConnected: (chatId: string, result: GitChangeConnectResponse) => void,
  onClose: () => void,
  t: I18nTranslate,
): SubmitState {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canSubmit =
    !busy &&
    chatId !== "" &&
    currentBranch !== undefined &&
    (mode === "pull-request" || baseRef !== "");

  async function run(): Promise<void> {
    if (currentBranch === undefined) return;
    setBusy(true);
    setError(null);
    try {
      const result = await connect(buildConnectInput(chatId, mode, currentBranch, baseRef));
      if (result.status === "blocked") {
        setError(gitChangeBlockedReasonMessage(result.reason, t));
        return;
      }
      onConnected(chatId, result);
      onClose();
    } catch (error_) {
      setError(blockedOrNetworkError(error_, t));
    } finally {
      setBusy(false);
    }
  }

  return {
    busy,
    error,
    canSubmit,
    submit: (): void => {
      if (canSubmit) void run();
    },
  };
}

// The <dialog>/<form> chrome, extracted so ConnectToChatDialog itself stays under the
// max-lines-per-function bar. Owns only layout, the Escape handler, and the tab trap ref — every
// field lives in ConnectDialogFields.
function DialogChrome({
  dialogRef,
  title,
  onClose,
  onSubmit,
  children,
}: {
  readonly dialogRef: RefObject<HTMLDialogElement | null>;
  readonly title: string;
  readonly onClose: () => void;
  readonly onSubmit: SubmitEventHandler<HTMLFormElement>;
  readonly children: ReactNode;
}): ReactNode {
  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- the native dialog owns Escape handling while the shared hook owns Tab containment.
    <dialog
      open
      ref={dialogRef}
      aria-modal="true"
      aria-label={title}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          onClose();
          event.preventDefault();
        }
      }}
      style={OVERLAY_STYLE}
    >
      <form style={FORM_STYLE} onSubmit={onSubmit}>
        {children}
      </form>
    </dialog>
  );
}

interface ConnectDialogState {
  readonly chatId: string;
  readonly setChatId: (id: string) => void;
  readonly mode: ConnectMode;
  readonly setMode: (mode: ConnectMode) => void;
  readonly baseRef: string;
  readonly setBaseRef: (name: string) => void;
  readonly busy: boolean;
  readonly error: string | null;
  readonly canSubmit: boolean;
  readonly submit: () => void;
}

// Consolidates the dialog's own form state with the submit flow so ConnectToChatDialog's body
// stays under the max-lines-per-function bar.
function useConnectDialogState(
  currentBranch: string | undefined,
  baseBranchName: string | undefined,
  connect: typeof connectGitChangeToChat,
  onConnected: (chatId: string, result: GitChangeConnectResponse) => void,
  onClose: () => void,
  t: I18nTranslate,
): ConnectDialogState {
  const [chatId, setChatId] = useState("");
  const [mode, setMode] = useState<ConnectMode>("comparison");
  const [baseRef, setBaseRef] = useState(baseBranchName ?? "");
  const { busy, error, canSubmit, submit } = useSubmit(
    chatId,
    mode,
    currentBranch,
    baseRef,
    connect,
    onConnected,
    onClose,
    t,
  );
  return { chatId, setChatId, mode, setMode, baseRef, setBaseRef, busy, error, canSubmit, submit };
}

function projectConnectedChat(
  chats: readonly Chat[],
  chatId: string,
  result: GitChangeConnectResponse,
): Chat | undefined {
  if (result.status !== "connected") return undefined;
  const chat = chats.find((candidate) => candidate.id === chatId);
  if (chat === undefined) return undefined;
  return {
    ...chat,
    gitChangeScopes: [...(chat.gitChangeScopes ?? []), result.scope],
    updatedAt: Date.now(),
  };
}

function ConnectDialogForm({
  dialogRef,
  state,
  catalog,
  currentBranch,
  baseBranchChoices,
  onClose,
  t,
}: {
  readonly dialogRef: RefObject<HTMLDialogElement | null>;
  readonly state: ConnectDialogState;
  readonly catalog: ReturnType<typeof useChatCatalog>;
  readonly currentBranch: string | undefined;
  readonly baseBranchChoices: ConnectToChatDialogProps["baseBranchChoices"];
  readonly onClose: () => void;
  readonly t: I18nTranslate;
}): ReactNode {
  return (
    <DialogChrome
      dialogRef={dialogRef}
      title={t("gitChangeScope.connect.title")}
      onClose={onClose}
      onSubmit={(event) => {
        event.preventDefault();
        state.submit();
      }}
    >
      <ConnectDialogFields
        chatId={state.chatId}
        onChatIdChange={state.setChatId}
        catalog={catalog}
        mode={state.mode}
        onModeChange={state.setMode}
        currentBranch={currentBranch}
        baseRef={state.baseRef}
        onBaseRefChange={state.setBaseRef}
        baseBranchChoices={baseBranchChoices}
        error={state.error}
        busy={state.busy}
        canSubmit={state.canSubmit}
        onCancel={onClose}
        t={t}
      />
    </DialogChrome>
  );
}

export function ConnectToChatDialog({
  projectId,
  currentBranch,
  baseBranchName,
  baseBranchChoices,
  onClose,
  onConnected = notifyChatUpsert,
  listChats = fetchChats,
  connect = connectGitChangeToChat,
}: ConnectToChatDialogProps): ReactNode {
  const t = useTranslate();
  const catalog = useChatCatalog(projectId, listChats, t);
  const recordConnection = (chatId: string, result: GitChangeConnectResponse): void => {
    const connected = projectConnectedChat(catalog.chats, chatId, result);
    if (connected !== undefined) onConnected(connected);
  };
  const state = useConnectDialogState(
    currentBranch,
    baseBranchName,
    connect,
    recordConnection,
    onClose,
    t,
  );
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  useDialogTabTrap(dialogRef);
  useModalInteractionLock({ initialFocusRef: dialogRef });

  const dialog = (
    <ConnectDialogForm
      dialogRef={dialogRef}
      state={state}
      catalog={catalog}
      currentBranch={currentBranch}
      baseBranchChoices={baseBranchChoices}
      onClose={onClose}
      t={t}
    />
  );

  return typeof document === "undefined" ? dialog : createPortal(dialog, document.body);
}
