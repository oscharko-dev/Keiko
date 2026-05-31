"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { ReactNode } from "react";
import { createChat, fetchModels, ApiError } from "@/lib/api";
import { useWorkspaceRouteHref } from "./navigation";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_MODEL = "Mistral-Small-3.1-24B-Instruct-2503";
const DEFAULT_UNAVAILABLE_MESSAGE = "Default chat model is not available. Check the model registry.";

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
  const [error, setError] = useState<string | null>(null);

  const activeProjectPath = projectPath === undefined ? searchParams.get("project") : projectPath;
  const disabled = !activeProjectPath || loading;
  const disabledTitle = activeProjectPath
    ? undefined
    : "Select an available local project before starting a new chat.";

  async function handleClick(): Promise<void> {
    if (!activeProjectPath || loading) return;
    setLoading(true);
    setError(null);
    try {
      const { models } = await fetchModels();
      const defaultAvailable = models.some((model) =>
        model.kind === "chat" && model.id === DEFAULT_MODEL
      );
      if (!defaultAvailable) {
        setError(DEFAULT_UNAVAILABLE_MESSAGE);
        return;
      }
      const { chat } = await createChat({
        projectPath: activeProjectPath,
        title: "New chat",
        selectedModel: DEFAULT_MODEL,
      });
      const params = new URLSearchParams(searchParams.toString());
      params.set("chat", chat.id);
      router.replace(workspaceHref(params));
    } catch (err: unknown) {
      const message = err instanceof ApiError ? err.message : "Failed to create chat.";
      setError(message);
    } finally {
      setLoading(false);
    }
  }

  if (collapsed) {
    return (
      <>
        <button
          type="button"
          aria-label="New chat"
          title={disabledTitle ?? error ?? undefined}
          disabled={disabled}
          onClick={() => { void handleClick(); }}
          className="flex w-full items-center justify-center rounded py-1.5 text-ink-muted
            hover:bg-elevated hover:text-ink
            focus:outline-none focus-visible:ring-2 focus-visible:ring-focus
            disabled:cursor-not-allowed disabled:opacity-40"
        >
          ✎
        </button>
        {error !== null && (
          <span role="alert" className="sr-only">
            {error}
          </span>
        )}
      </>
    );
  }

  return (
    <div>
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
      {error !== null && (
        <p role="alert" className="mt-1 px-2 text-[11px] leading-snug text-red-300">
          {error}
        </p>
      )}
    </div>
  );
}

export default NewChatButton;
