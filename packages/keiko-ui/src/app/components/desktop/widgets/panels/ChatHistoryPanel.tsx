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
import { deleteChat, updateChat } from "@/lib/api";
import { useTranslate } from "@/lib/i18n";
import { useOptionalWidgetTranslate } from "@/lib/optional-widget-i18n";
import { Icons } from "../../Icons";
import { useChatSessionActions, useChatSessionCatalog } from "../../context/ChatSessionContext";
import { effectiveLocalKnowledgeScopes, effectiveScopes } from "../../hooks/workspaceActions";
import { notifyChatDeleted } from "../../hooks/useChatSession";

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
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const tablistRef = useRef<HTMLDivElement | null>(null);
  const confirmDeleteRef = useRef<HTMLButtonElement | null>(null);
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

  // GEN-UI-FOCUS-016: when a row enters inline delete-confirm mode, move focus onto
  // the destructive Delete button so keyboard users land on the confirmation.
  useEffect(() => {
    if (deleteConfirmId !== null) confirmDeleteRef.current?.focus({ preventScroll: true });
  }, [deleteConfirmId]);

  // GEN-UI-KEYBOARD-008: roving tablist keyboard nav (WAI-ARIA APG tabs pattern).
  // ArrowLeft/Right wrap between the two tabs; Home/End jump to first/last. Focus and
  // selection move together (automatic activation), mirroring ProjectPanel's roving nav.
  const handleTablistKey = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const key = event.key;
    if (key !== "ArrowLeft" && key !== "ArrowRight" && key !== "Home" && key !== "End") return;
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
    let next = from;
    if (key === "ArrowRight") next = (from + 1) % tabs.length;
    else if (key === "ArrowLeft") next = (from - 1 + tabs.length) % tabs.length;
    else if (key === "Home") next = 0;
    else if (key === "End") next = tabs.length - 1;
    setView(next === 0 ? "active" : "deleted");
    setDeleteConfirmId(null);
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
    setDeleteConfirmId(null);
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

  const moveToTrash = async (chat: Chat): Promise<void> => {
    setBusyId(chat.id);
    setError(null);
    try {
      const response = await updateChat(chat.id, { status: "closed" });
      actions.replaceChat(response.chat);
      setDeleteConfirmId(null);
    } catch (caughtError) {
      const detail = caughtError instanceof Error ? caughtError.message : "Request failed.";
      setError(optionalT("chat.history.deleteFailed", { detail }));
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
      setDeleteConfirmId(null);
    } catch (caughtError) {
      const detail = caughtError instanceof Error ? caughtError.message : "Request failed.";
      setError(optionalT("chat.history.restoreFailed", { detail }));
    } finally {
      setBusyId(null);
    }
  };

  const purgeChat = async (chat: Chat): Promise<void> => {
    setBusyId(chat.id);
    setError(null);
    try {
      await deleteChat(chat.id, chat.projectPath);
      notifyChatDeleted(chat.id);
      setDeleteConfirmId(null);
    } catch (caughtError) {
      const detail = caughtError instanceof Error ? caughtError.message : "Request failed.";
      setError(optionalT("chat.history.purgeFailed", { detail }));
    } finally {
      setBusyId(null);
    }
  };

  // #2723 (S3358): the row-actions block was a four-way nested ternary chain
  // (editing ? … : confirmingDelete ? … : deleted ? … : …); first extracted to a single
  // named render function with early returns, then split further (CodeRabbit #3655533401)
  // into one small renderer per branch so each stays well under the 50-line limit. Each
  // renderer closes over the row action handlers above (a closure over per-row state
  // passed as params, not the whole component) so every call site stays flat.
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

  // GEN-UI-FOCUS-016: Escape on either confirm button cancels the
  // destructive confirmation and returns to the row's default actions.
  const renderConfirmingDeleteRowActions = (
    chat: Chat,
    busy: boolean,
    deleted: boolean,
  ): ReactNode => (
    <>
      {deleted ? (
        <output className="chat-history-purge-warning">
          {optionalT("chat.history.purgeWarning")}
        </output>
      ) : null}
      <button
        ref={confirmDeleteRef}
        type="button"
        className="lk-btn lk-btn-danger"
        disabled={busy}
        aria-label={
          deleted
            ? t("chat.history.action.deleteConfirm", { title: chat.title })
            : t("chat.history.action.delete", { title: chat.title })
        }
        onClick={() => void (deleted ? purgeChat(chat) : moveToTrash(chat))}
        onKeyDown={(event) => {
          if (event.key === "Escape") setDeleteConfirmId(null);
        }}
      >
        {deleted ? optionalT("chat.history.purgeConfirm") : t("common.delete")}
      </button>
      <button
        type="button"
        className="lk-btn lk-btn-ghost"
        disabled={busy}
        aria-label={t("chat.history.action.cancel", { title: chat.title })}
        onClick={() => setDeleteConfirmId(null)}
        onKeyDown={(event) => {
          if (event.key === "Escape") setDeleteConfirmId(null);
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
        onClick={() => {
          setDeleteConfirmId(chat.id);
          setEditingId(null);
        }}
      >
        {optionalT("chat.history.purge")}
      </button>
    </>
  );

  const renderDefaultRowActions = (chat: Chat): ReactNode => (
    <>
      <button
        type="button"
        className="lk-btn lk-btn-ghost"
        aria-label={t("chat.history.action.rename", { title: chat.title })}
        onClick={() => startRename(chat)}
      >
        {t("chat.history.action.renameLabel")}
      </button>
      <button
        type="button"
        className="lk-btn lk-btn-ghost"
        aria-label={t("chat.history.action.delete", { title: chat.title })}
        onClick={() => {
          setDeleteConfirmId(chat.id);
          setEditingId(null);
        }}
      >
        {t("common.delete")}
      </button>
    </>
  );

  const renderRowActions = ({
    chat,
    editing,
    confirmingDelete,
    deleted,
    busy,
  }: {
    readonly chat: Chat;
    readonly editing: boolean;
    readonly confirmingDelete: boolean;
    readonly deleted: boolean;
    readonly busy: boolean;
  }): ReactNode => {
    if (editing) return renderEditingRowActions(chat, busy);
    if (confirmingDelete) return renderConfirmingDeleteRowActions(chat, busy, deleted);
    if (deleted) return renderDeletedRowActions(chat, busy);
    return renderDefaultRowActions(chat);
  };

  return (
    <div className="chat-history">
      <div className="chat-history-head">
        <div>
          <p className="chat-history-kicker">Conversations</p>
          <h2>Chat History</h2>
        </div>
        <button type="button" className="lk-btn lk-btn-primary" onClick={() => void createNew()}>
          <NewChatIcon size={15} />
          New
        </button>
      </div>
      <label className="chat-history-search">
        <SearchIcon size={15} />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
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
          aria-selected={view === "active"}
          aria-controls={panelId}
          // Roving tabindex: only the selected tab is a Tab stop; arrows move the rest.
          tabIndex={view === "active" ? 0 : -1}
          className="chat-history-tab"
          onClick={() => {
            setView("active");
            setDeleteConfirmId(null);
          }}
        >
          {t("chat.history.tab.active")} <span>{activeCount}</span>
        </button>
        <button
          type="button"
          id={tabDeletedId}
          role="tab"
          aria-selected={view === "deleted"}
          aria-controls={panelId}
          tabIndex={view === "deleted" ? 0 : -1}
          className="chat-history-tab"
          onClick={() => {
            setView("deleted");
            setDeleteConfirmId(null);
          }}
        >
          {t("chat.history.tab.deleted")} <span>{deletedCount}</span>
        </button>
      </div>
      {error !== null ? (
        <div className="lk-alert" role="alert">
          {error}
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
            const confirmingDelete = deleteConfirmId === chat.id;
            const busy = busyId === chat.id;
            const deleted = chat.status === "closed";
            return (
              <article
                key={chat.id}
                className="chat-history-row"
                data-chat-id={chat.id}
                data-state={deleted ? "deleted" : "active"}
                aria-label={chat.title}
              >
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
                <div className="chat-history-actions">
                  {renderRowActions({ chat, editing, confirmingDelete, deleted, busy })}
                </div>
              </article>
            );
          })
        )}
      </div>
    </div>
  );
}
