"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Chat } from "@/lib/types";
import { updateChat } from "@/lib/api";
import { Icons } from "../../Icons";
import { useChatSessionContext } from "../../context/ChatSessionContext";
import { effectiveLocalKnowledgeScopes, effectiveScopes } from "../../hooks/workspaceActions";

interface ChatHistoryPanelProps {
  readonly openChatWindow: (chat: Chat) => void;
}

type HistoryView = "active" | "deleted";

function formatDate(ms: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(ms));
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
  const session = useChatSessionContext();
  const [query, setQuery] = useState("");
  const [view, setView] = useState<HistoryView>("active");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);

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

  const createNew = async (): Promise<void> => {
    setError(null);
    const created = await session.openNewChat(undefined, "New chat");
    if (created !== undefined) openChatWindow(created);
  };

  const startRename = (chat: Chat): void => {
    setEditingId(chat.id);
    setEditingTitle(chat.title);
    setDeleteConfirmId(null);
    setError(null);
  };

  const commitRename = async (chat: Chat): Promise<void> => {
    const title = editingTitle.trim();
    if (title.length === 0 || title === chat.title) {
      setEditingId(null);
      return;
    }
    setBusyId(chat.id);
    setError(null);
    try {
      const response = await updateChat(chat.id, { title });
      session.replaceChat(response.chat);
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
      session.replaceChat(response.chat);
      setDeleteConfirmId(null);
      setView("deleted");
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
      session.replaceChat(response.chat);
      setDeleteConfirmId(null);
      setView("active");
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
      <div className="chat-history-tabs" role="tablist" aria-label="Conversation state">
        <button
          type="button"
          role="tab"
          aria-selected={view === "active"}
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
          role="tab"
          aria-selected={view === "deleted"}
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
      <div className="chat-history-list">
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
                    <input
                      ref={renameInputRef}
                      className="chat-history-title-input"
                      value={editingTitle}
                      onChange={(event) => setEditingTitle(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") void commitRename(chat);
                        if (event.key === "Escape") setEditingId(null);
                      }}
                    />
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
                        onClick={() => setEditingId(null)}
                      >
                        Cancel
                      </button>
                    </>
                  ) : confirmingDelete ? (
                    <>
                      <button
                        type="button"
                        className="lk-btn lk-btn-danger"
                        disabled={busy}
                        onClick={() => void moveToTrash(chat)}
                      >
                        Delete
                      </button>
                      <button
                        type="button"
                        className="lk-btn lk-btn-ghost"
                        disabled={busy}
                        onClick={() => setDeleteConfirmId(null)}
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
