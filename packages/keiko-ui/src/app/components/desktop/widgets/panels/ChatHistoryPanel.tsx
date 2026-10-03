"use client";

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import type { Chat } from "@/lib/types";
import { updateChat } from "@/lib/api";
import { useTranslate } from "@/lib/i18n";
import { useOptionalWidgetTranslate } from "@/lib/optional-widget-i18n";
import { Icons } from "../../Icons";
import { useChatSessionActions, useChatSessionCatalog } from "../../context/ChatSessionContext";
import { effectiveLocalKnowledgeScopes, effectiveScopes } from "../../hooks/workspaceActions";
import { ChatHistorySelectionToolbar } from "./ChatHistorySelectionToolbar";
import { useChatHistoryDeletion, useChatHistorySelection } from "./useChatHistorySelection";
import styles from "./ChatHistorySelection.module.css";

// PascalCase aliases so the JSX tag itself signals "component", not member access (S6770).
const RestoreIcon = Icons.restore;
const NewChatIcon = Icons.newChat;
const SearchIcon = Icons.search;

interface ChatHistoryPanelProps {
  readonly openChatWindow: (chat: Chat) => void;
}

type HistoryView = "active" | "deleted";

// GEN-PERF-PANEL-001 — one shared formatter: constructing an Intl.DateTimeFormat builds
// a locale collator each time, and this ran once PER ROW PER RENDER (every search
// keystroke re-renders every visible row). Module-scope reuse is the documented Intl
// pattern; the locale/options never change at runtime.
const CHAT_HISTORY_DATE_FORMAT = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

function formatDate(ms: number): string {
  return CHAT_HISTORY_DATE_FORMAT.format(new Date(ms));
}

function sourceCount(chat: Chat): number {
  return effectiveScopes(chat).length + effectiveLocalKnowledgeScopes(chat).length;
}

// #2723 (S3358): the roving-tablist "from" index used a nested ternary
// (current < 0 ? (view === "active" ? 0 : 1) : current); extracted to a plain if/else chain.
// Exported (pure visibility change, no behavior change) for a focused unit test.
export function initialTabIndex(view: HistoryView, current: number): number {
  if (current >= 0) return current;
  if (view === "active") return 0;
  return 1;
}

function chatMatches(chat: Chat, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return true;
  return (
    chat.title.toLowerCase().includes(q) ||
    chat.selectedModel.toLowerCase().includes(q) ||
    (chat.branchLabel?.toLowerCase().includes(q) ?? false)
  );
}

function createdChatMatchesCurrentProject(
  created: Chat,
  requestedProjectPath: string | undefined,
  currentProjectPath: string | undefined,
): boolean {
  if (requestedProjectPath === undefined) {
    return currentProjectPath === undefined || currentProjectPath === created.projectPath;
  }
  return (
    created.projectPath === requestedProjectPath && currentProjectPath === requestedProjectPath
  );
}

export function ChatHistoryPanel({ openChatWindow }: ChatHistoryPanelProps): ReactNode {
  const optionalT = useOptionalWidgetTranslate();
  const t = useTranslate();
  const session = useChatSessionCatalog();
  const actions = useChatSessionActions();
  const [query, setQuery] = useState("");
  const [view, setView] = useState<HistoryView>("active");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const tablistRef = useRef<HTMLDivElement | null>(null);
  const selectionRef = useRef<HTMLInputElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const focusedDeletionRef = useRef(0);
  const activeProjectPathRef = useRef(session.activeProject?.path);
  activeProjectPathRef.current = session.activeProject?.path;
  const tabActiveId = useId();
  const tabDeletedId = useId();
  const panelId = useId();
  const renameErrorId = useId();

  const activeCount = useMemo(
    () => session.chats.filter((chat) => chat.status !== "closed").length,
    [session.chats],
  );
  const deletedCount = session.chats.length - activeCount;
  const chats = useMemo(
    () =>
      [...session.chats]
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .filter((chat) =>
          view === "deleted" ? chat.status === "closed" : chat.status !== "closed",
        )
        .filter((chat) => chatMatches(chat, query)),
    [query, session.chats, view],
  );

  useEffect(() => {
    if (editingId !== null) renameInputRef.current?.focus({ preventScroll: true });
  }, [editingId]);

  const scope = JSON.stringify([session.activeProject?.path, view, query]);
  const selection = useChatHistorySelection(scope, chats);
  const deletion = useChatHistoryDeletion(scope);
  const busy = deletion.busy || busyId !== null;
  const selectedIds = new Set(selection.selectedChats.map((chat) => chat.id));
  const deletionFailureKey =
    deletion.failure?.requestedCount === 1
      ? "chat.history.deleteFailed"
      : "chat.history.bulkDeleteFailed";
  const deletionError =
    deletion.failure === null
      ? null
      : optionalT(deletionFailureKey, {
          count: deletion.failure.failedIds.length,
          detail: deletion.failure.detail ?? "Request failed.",
        });

  // GEN-UI-FOCUS-016: one-click deletion replaces the confirmation. Keep a stable keyboard
  // destination after the row disappears, rather than leaving focus on the document body.
  useEffect((): void => {
    if (deletion.completed === 0) return;
    const target = selectionRef.current;
    const lastRowRemoved =
      target?.disabled &&
      (document.activeElement === target || document.activeElement === document.body);
    if (focusedDeletionRef.current === deletion.completed && !lastRowRemoved) return;
    focusedDeletionRef.current = deletion.completed;
    if (target !== null && !target.disabled) target.focus({ preventScroll: true });
    else searchRef.current?.focus({ preventScroll: true });
  }, [chats.length, deletion.completed]);

  const removeChats = async (targets: readonly Chat[]): Promise<void> => {
    setEditingId(null);
    setRenameError(null);
    setError(null);
    const result = await deletion.remove(targets);
    if (result !== undefined) selection.retain(result.failedIds, scope);
  };

  // GEN-UI-KEYBOARD-008: roving tablist keyboard nav (WAI-ARIA APG tabs pattern).
  // ArrowLeft/Right wrap between the two tabs; Home/End jump to first/last. Focus and
  // selection move together (automatic activation), mirroring ProjectPanel's roving nav.
  const handleTablistKey = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (busy) return;
    const key = event.key;
    if (!HISTORY_TAB_KEYS.has(key)) return;
    const container = tablistRef.current;
    if (container === null) return;
    const tabs = Array.from(container.querySelectorAll<HTMLButtonElement>("button[role='tab']"));
    if (tabs.length === 0) return;
    const current =
      document.activeElement instanceof HTMLButtonElement
        ? tabs.indexOf(document.activeElement)
        : -1;
    const from = initialTabIndex(view, current);
    event.preventDefault();
    const next = historyNextTab(key, from, tabs.length);
    setView(next === 0 ? "active" : "deleted");
    selection.clear();
    tabs[next]?.focus();
  };

  const createNew = async (): Promise<void> => {
    setError(null);
    const requestedProjectPath = activeProjectPathRef.current;
    const created = await actions.openNewChat(undefined, "New chat");
    if (
      created !== undefined &&
      createdChatMatchesCurrentProject(created, requestedProjectPath, activeProjectPathRef.current)
    ) {
      openChatWindow(created);
    }
  };

  const startRename = (chat: Chat): void => {
    setEditingId(chat.id);
    setEditingTitle(chat.title);
    selection.clear();
    setError(null);
    setRenameError(null);
  };

  const commitRename = async (chat: Chat): Promise<void> => {
    const title = editingTitle.trim();
    // Empty input: keep edit mode open and surface an accessible error (PA-05).
    if (title.length === 0) {
      setRenameError(optionalT("chat.history.renameEmptyTitle"));
      renameInputRef.current?.focus({ preventScroll: true });
      return;
    }
    // Unchanged title: revert silently — no error, nothing to save.
    if (title === chat.title) {
      setEditingId(null);
      setRenameError(null);
      return;
    }
    setBusyId(chat.id);
    setError(null);
    setRenameError(null);
    try {
      const response = await updateChat(chat.id, { title });
      actions.replaceChat(response.chat);
      setEditingId(null);
    } catch {
      setError(optionalT("chat.history.renameFailed"));
    } finally {
      setBusyId(null);
    }
  };

  const restoreChat = async (chat: Chat): Promise<void> => {
    setBusyId(chat.id);
    setError(null);
    try {
      const response = await updateChat(chat.id, { status: "open" });
      actions.replaceChat(response.chat);
      selection.clear();
    } catch (caughtError) {
      const detail = caughtError instanceof Error ? caughtError.message : "Request failed.";
      setError(optionalT("chat.history.restoreFailed", { detail }));
    } finally {
      setBusyId(null);
    }
  };

  // KEIKO-0452: every row-scoped action button carries an accessible name that includes the
  // chat title, so no two rows' Rename/Delete/Save/Cancel/Restore/purge buttons share an
  // accessible name (which would leave a screen-reader user unable to distinguish which
  // Delete they're about to trigger — worst-case, the irreversible purge Delete). aria-label
  // wins over visible text; visible copy stays terse.
  const renderEditingRowActions = (chat: Chat, busy: boolean): ReactNode => (
    <>
      <button
        type="button"
        className="lk-btn lk-btn-primary"
        disabled={busy}
        aria-label={t("chat.history.action.save", { title: chat.title })}
        onClick={() => void commitRename(chat)}
      >
        {t("common.save")}
      </button>
      <button
        type="button"
        className="lk-btn lk-btn-ghost"
        disabled={busy}
        aria-label={t("chat.history.action.cancel", { title: chat.title })}
        onClick={() => {
          setEditingId(null);
          setRenameError(null);
        }}
      >
        {t("common.cancel")}
      </button>
    </>
  );

  const renderDeletedRowActions = (chat: Chat, busy: boolean): ReactNode => (
    <>
      <button
        type="button"
        className="lk-btn lk-btn-primary"
        disabled={busy}
        aria-label={t("chat.history.action.restore", { title: chat.title })}
        onClick={() => void restoreChat(chat)}
      >
        <RestoreIcon size={14} />
        {t("chat.history.action.restoreLabel")}
      </button>
      <button
        type="button"
        className="lk-btn lk-btn-ghost"
        disabled={busy}
        aria-label={t("chat.history.action.rename", { title: chat.title })}
        onClick={() => startRename(chat)}
      >
        {t("chat.history.action.renameLabel")}
      </button>
      <button
        type="button"
        className="lk-btn lk-btn-danger"
        disabled={busy}
        aria-label={t("chat.history.action.deletePermanent", { title: chat.title })}
        title={t("chat.history.selection.permanent")}
        onClick={() => void removeChats([chat])}
      >
        {optionalT("chat.history.purge")}
      </button>
    </>
  );

  const renderDefaultRowActions = (chat: Chat, rowBusy: boolean): ReactNode => (
    <>
      <button
        type="button"
        className="lk-btn lk-btn-ghost"
        disabled={rowBusy}
        aria-label={t("chat.history.action.rename", { title: chat.title })}
        onClick={() => startRename(chat)}
      >
        {t("chat.history.action.renameLabel")}
      </button>
      <button
        type="button"
        className="lk-btn lk-btn-ghost"
        disabled={rowBusy}
        aria-label={t("chat.history.action.delete", { title: chat.title })}
        title={t("chat.history.selection.permanent")}
        onClick={() => void removeChats([chat])}
      >
        {t("common.delete")}
      </button>
    </>
  );

  const renderRowActions = ({
    chat,
    editing,
    deleted,
    busy,
  }: {
    readonly chat: Chat;
    readonly editing: boolean;
    readonly deleted: boolean;
    readonly busy: boolean;
  }): ReactNode => {
    if (editing) return renderEditingRowActions(chat, busy);
    if (deleted) return renderDeletedRowActions(chat, busy);
    return renderDefaultRowActions(chat, busy);
  };

  return (
    <div className="chat-history">
      <div className="chat-history-head">
        <div>
          <p className="chat-history-kicker">Conversations</p>
          <h2>Chat History</h2>
        </div>
        {/* A new chat needs the session bootstrap (models, active project). A click before it
            settles created nothing and reported a false "no model configured" error. */}
        <button
          type="button"
          className="lk-btn lk-btn-primary"
          disabled={session.loading || busy}
          onClick={() => void createNew()}
        >
          <NewChatIcon size={15} />
          New
        </button>
      </div>
      <label className="chat-history-search">
        <SearchIcon size={15} />
        <input
          ref={searchRef}
          value={query}
          disabled={busy}
          onChange={(event) => {
            selection.clear();
            setQuery(event.target.value);
          }}
          placeholder="Search"
          aria-label="Search chat history"
        />
      </label>
      <div
        ref={tablistRef}
        className="chat-history-tabs"
        role="tablist"
        aria-label="Conversation state"
        // Programmatic focus target only (mirrors ProjectPanel's role=tree pattern); the tabs carry
        // the roving tabIndex (0/-1) per the WAI-ARIA APG tabs pattern.
        tabIndex={-1}
        onKeyDown={handleTablistKey}
      >
        <button
          type="button"
          id={tabActiveId}
          role="tab"
          disabled={busy}
          aria-selected={view === "active"}
          aria-controls={panelId}
          // Roving tabindex: only the selected tab is a Tab stop; arrows move the rest.
          tabIndex={view === "active" ? 0 : -1}
          className="chat-history-tab"
          onClick={() => {
            setView("active");
            selection.clear();
          }}
        >
          {t("chat.history.tab.active")} <span>{activeCount}</span>
        </button>
        <button
          type="button"
          id={tabDeletedId}
          role="tab"
          disabled={busy}
          aria-selected={view === "deleted"}
          aria-controls={panelId}
          tabIndex={view === "deleted" ? 0 : -1}
          className="chat-history-tab"
          onClick={() => {
            setView("deleted");
            selection.clear();
          }}
        >
          {t("chat.history.tab.deleted")} <span>{deletedCount}</span>
        </button>
      </div>
      <ChatHistorySelectionToolbar
        checkboxRef={selectionRef}
        visibleCount={chats.length}
        selectedCount={selection.selectedChats.length}
        busy={busy || session.loading}
        toggleAll={selection.toggleAll}
        clear={selection.clear}
        removeSelected={() => void removeChats(selection.selectedChats)}
      />
      {error !== null || deletionError !== null ? (
        <div className="lk-alert" role="alert">
          {error ?? deletionError}
        </div>
      ) : null}
      <div
        id={panelId}
        className="chat-history-list"
        role="tabpanel"
        aria-labelledby={view === "active" ? tabActiveId : tabDeletedId}
      >
        {chats.length === 0 ? (
          <div className="lk-empty">
            <p className="lk-empty-title">No conversations</p>
          </div>
        ) : (
          chats.map((chat) => {
            const sources = sourceCount(chat);
            const editing = editingId === chat.id;
            const deleted = chat.status === "closed";
            return (
              <article
                key={chat.id}
                className={`chat-history-row ${styles.cmpRow} ${selectedIds.has(chat.id) ? styles.cmpSelected : ""}`}
                data-chat-id={chat.id}
                data-state={deleted ? "deleted" : "active"}
                aria-label={chat.title}
              >
                <input
                  type="checkbox"
                  className={styles.cmpCheckbox}
                  checked={selectedIds.has(chat.id)}
                  disabled={busy || session.loading}
                  aria-label={t("chat.history.selection.chat", { title: chat.title })}
                  onChange={() => selection.toggleChat(chat.id)}
                  onKeyDown={(event): void => {
                    if (event.key === "Escape" && !busy) selection.clear();
                  }}
                />
                <div className="chat-history-row-main">
                  {editing ? (
                    <>
                      <input
                        ref={renameInputRef}
                        className="chat-history-title-input"
                        value={editingTitle}
                        aria-invalid={renameError !== null}
                        aria-describedby={renameError !== null ? renameErrorId : undefined}
                        onChange={(event) => {
                          setEditingTitle(event.target.value);
                          if (renameError !== null) setRenameError(null);
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") void commitRename(chat);
                          if (event.key === "Escape") {
                            setEditingId(null);
                            setRenameError(null);
                          }
                        }}
                      />
                      {renameError !== null ? (
                        <span id={renameErrorId} className="chat-history-rename-error" role="alert">
                          {renameError}
                        </span>
                      ) : null}
                    </>
                  ) : (
                    <button
                      type="button"
                      className="chat-history-open"
                      disabled={deleted}
                      onClick={() => openChatWindow(chat)}
                    >
                      <span className="chat-history-title">{chat.title}</span>
                      <span className="chat-history-meta">
                        {formatDate(chat.updatedAt)} / {chat.selectedModel}
                        {sources > 0 ? ` / ${String(sources)} sources` : ""}
                      </span>
                    </button>
                  )}
                </div>
                <div className={`chat-history-actions ${styles.cmpActions}`}>
                  {renderRowActions({ chat, editing, deleted, busy })}
                </div>
              </article>
            );
          })
        )}
      </div>
    </div>
  );
}

const HISTORY_TAB_KEYS = new Set(["ArrowLeft", "ArrowRight", "Home", "End"]);
function historyNextTab(key: string, from: number, length: number): number {
  if (key === "ArrowRight") return (from + 1) % length;
  if (key === "ArrowLeft") return (from - 1 + length) % length;
  return key === "Home" ? 0 : length - 1;
}
