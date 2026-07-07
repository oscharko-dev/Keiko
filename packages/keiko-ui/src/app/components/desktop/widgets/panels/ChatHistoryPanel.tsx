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
import { Icons } from "../../Icons";
import { useChatSessionActions, useChatSessionCatalog } from "../../context/ChatSessionContext";
import { effectiveLocalKnowledgeScopes, effectiveScopes } from "../../hooks/workspaceActions";

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

function chatMatches(chat: Chat, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return true;
  return (
    chat.title.toLowerCase().includes(q) ||
    chat.selectedModel.toLowerCase().includes(q) ||
    (chat.branchLabel?.toLowerCase().includes(q) ?? false)
  );
}

export function ChatHistoryPanel({ openChatWindow }: ChatHistoryPanelProps): ReactNode {
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
    const current = tabs.findIndex((tab) => tab === document.activeElement);
    const from = current < 0 ? (view === "active" ? 0 : 1) : current;
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
    const created = await actions.openNewChat(undefined, "New chat");
    if (created !== undefined) openChatWindow(created);
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
      setRenameError("Title cannot be empty.");
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
      setError("Rename failed.");
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
    } catch (caught) {
      const detail = caught instanceof Error ? caught.message : "Request failed.";
      setError(`Delete failed: ${detail}`);
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
    } catch (caught) {
      const detail = caught instanceof Error ? caught.message : "Request failed.";
      setError(`Restore failed: ${detail}`);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="chat-history">
      <div className="chat-history-head">
        <div>
          <p className="chat-history-kicker">Conversations</p>
          <h2>Chat History</h2>
        </div>
        <button type="button" className="lk-btn lk-btn-primary" onClick={() => void createNew()}>
          <Icons.newChat size={15} />
          New
        </button>
      </div>
      <label className="chat-history-search">
        <Icons.search size={15} />
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
          Active <span>{activeCount}</span>
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
          Deleted <span>{deletedCount}</span>
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
                  {editing ? (
                    <>
                      <button
                        type="button"
                        className="lk-btn lk-btn-primary"
                        disabled={busy}
                        onClick={() => void commitRename(chat)}
                      >
                        Save
                      </button>
                      <button
                        type="button"
                        className="lk-btn lk-btn-ghost"
                        disabled={busy}
                        onClick={() => {
                          setEditingId(null);
                          setRenameError(null);
                        }}
                      >
                        Cancel
                      </button>
                    </>
                  ) : confirmingDelete ? (
                    // GEN-UI-FOCUS-016: Escape on either confirm button cancels the
                    // destructive confirmation and returns to the row's default actions.
                    <>
                      <button
                        ref={confirmDeleteRef}
                        type="button"
                        className="lk-btn lk-btn-danger"
                        disabled={busy}
                        onClick={() => void moveToTrash(chat)}
                        onKeyDown={(event) => {
                          if (event.key === "Escape") setDeleteConfirmId(null);
                        }}
                      >
                        Delete
                      </button>
                      <button
                        type="button"
                        className="lk-btn lk-btn-ghost"
                        disabled={busy}
                        onClick={() => setDeleteConfirmId(null)}
                        onKeyDown={(event) => {
                          if (event.key === "Escape") setDeleteConfirmId(null);
                        }}
                      >
                        Cancel
                      </button>
                    </>
                  ) : deleted ? (
                    <>
                      <button
                        type="button"
                        className="lk-btn lk-btn-primary"
                        disabled={busy}
                        onClick={() => void restoreChat(chat)}
                      >
                        <Icons.restore size={14} />
                        Restore
                      </button>
                      <button
                        type="button"
                        className="lk-btn lk-btn-ghost"
                        onClick={() => startRename(chat)}
                      >
                        Rename
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="lk-btn lk-btn-ghost"
                        onClick={() => startRename(chat)}
                      >
                        Rename
                      </button>
                      <button
                        type="button"
                        className="lk-btn lk-btn-ghost"
                        onClick={() => {
                          setDeleteConfirmId(chat.id);
                          setEditingId(null);
                        }}
                      >
                        Delete
                      </button>
                    </>
                  )}
                </div>
              </article>
            );
          })
        )}
      </div>
    </div>
  );
}
