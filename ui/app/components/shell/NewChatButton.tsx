"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { ReactNode } from "react";
import { createChat, ApiError } from "@/lib/api";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_MODEL = "Mistral-Small-3.1-24B-Instruct-2503";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface NewChatButtonProps {
  collapsed: boolean;
}

/**
 * Top-of-sidebar "New chat" button.
 * Disabled when no ?project= is active — prevents orphaned chats (D8).
 * On click: creates a chat with the default model, navigates to ?chat=<id>,
 * focusing the composer (handled by ChatView on mount).
 */
export function NewChatButton({ collapsed }: NewChatButtonProps): ReactNode {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [loading, setLoading] = useState(false);

  const rawProject = searchParams.get("project");
  const projectPath = rawProject ? decodeURIComponent(rawProject) : null;
  const disabled = !projectPath || loading;

  async function handleClick(): Promise<void> {
    if (!projectPath || loading) return;
    setLoading(true);
    try {
      const { chat } = await createChat({
        projectPath,
        title: "New chat",
        selectedModel: DEFAULT_MODEL,
      });
      const params = new URLSearchParams(searchParams.toString());
      params.set("chat", chat.id);
      router.replace(`/?${params.toString()}`);
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
