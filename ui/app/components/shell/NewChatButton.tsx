"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { ReactNode } from "react";
import { createChat, ApiError } from "@/lib/api";
import { useWorkspaceRouteHref } from "./navigation";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_MODEL = "Mistral-Small-3.1-24B-Instruct-2503";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface NewChatButtonProps {
  collapsed: boolean;
  /** Validated selected project path. Omit to fall back to the URL param for isolated tests. */
  projectPath?: string | null;
}

/**
 * Top-of-sidebar "New chat" button.
 * Disabled when no ?project= is active — prevents orphaned chats (D8).
 * On click: creates a chat with the default model, navigates to ?chat=<id>,
 * focusing the composer (handled by ChatView on mount).
 */
export function NewChatButton({ collapsed, projectPath }: NewChatButtonProps): ReactNode {
  const router = useRouter();
  const searchParams = useSearchParams();
  const workspaceHref = useWorkspaceRouteHref();
  const [loading, setLoading] = useState(false);

  const activeProjectPath = projectPath === undefined ? searchParams.get("project") : projectPath;
  const disabled = !activeProjectPath || loading;
  const disabledTitle = activeProjectPath
    ? undefined
    : "Select an available local project before starting a new chat.";

  async function handleClick(): Promise<void> {
    if (!activeProjectPath || loading) return;
    setLoading(true);
    try {
      const { chat } = await createChat({
        projectPath: activeProjectPath,
        title: "New chat",
        selectedModel: DEFAULT_MODEL,
      });
      const params = new URLSearchParams(searchParams.toString());
      params.set("chat", chat.id);
      router.replace(workspaceHref(params));
    } catch (err: unknown) {
      // Best-effort — log only in dev
      if (process.env.NODE_ENV !== "production" && err instanceof ApiError) {
        console.error("Failed to create chat:", err.message);
      }
    } finally {
      setLoading(false);
    }
  }

  if (collapsed) {
    return (
      <button
        type="button"
        aria-label="New chat"
        title={disabledTitle}
        disabled={disabled}
        onClick={() => { void handleClick(); }}
        className="flex w-full items-center justify-center rounded py-1.5 text-ink-muted
          hover:bg-elevated hover:text-ink
          focus:outline-none focus-visible:ring-2 focus-visible:ring-focus
          disabled:cursor-not-allowed disabled:opacity-40"
      >
        ✎
      </button>
    );
  }

  return (
    <button
      type="button"
      title={disabledTitle}
      disabled={disabled}
      onClick={() => { void handleClick(); }}
      className="w-full rounded px-2 py-1.5 text-left text-xs text-ink-muted
        hover:bg-elevated hover:text-ink
        focus:outline-none focus-visible:ring-2 focus-visible:ring-focus
        disabled:cursor-not-allowed disabled:opacity-40"
    >
      {loading ? "Creating…" : "+ New chat"}
    </button>
  );
}

export default NewChatButton;
