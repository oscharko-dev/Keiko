"use client";

// Issue #184 — small connector button that binds a Files-window selection (one or more
// workspace-relative paths) onto a chat via PATCH /api/chats. The button is purely a wire
// trigger: it does not own the file selection (the parent does) and it does not own the
// resulting Chat (the parent's onConnected callback feeds the cached store updater).
//
// WCAG 2.2 AA: native <button type="button">, accessible label that names the action, focus-
// visible ring (focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent), min
// 24×24 target via min-w/min-h utilities, disabled state announced via aria-disabled.

import { useState, type ReactNode } from "react";
import { ApiError, updateChatConnectedScope } from "@/lib/api";
import type { Chat } from "@/lib/types";

export interface ScopeConnectButtonProps {
  readonly chatId: string;
  // The chat's currently-bound paths (used to render the "Update connected scope" label when
  // the chat already has a binding). An empty array means "no binding yet".
  readonly currentScopePaths: readonly string[];
  // The Files-window selection the button will bind on click. The empty case disables the
  // button: the spec calls out "Select a folder or file first" so the user has a hint.
  readonly candidateRelativePaths: readonly string[];
  readonly onConnected?: (chat: Chat) => void;
  // Injectable wire seam for tests. Defaults to the real BFF helper.
  readonly updateScope?: typeof updateChatConnectedScope;
  // Injectable clock seam for tests. Defaults to Date.now.
  readonly now?: () => number;
}

const BUTTON_BASE_CLASS =
  "inline-flex items-center justify-center gap-1.5 min-w-[24px] min-h-[24px] " +
  "rounded-md px-2.5 py-1 text-xs font-medium border border-[var(--accent)] " +
  "bg-[var(--accent)] text-[var(--ink-inverse)] " +
  "hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset " +
  "focus-visible:ring-[var(--accent)]";

function actionLabel(currentScopePaths: readonly string[]): string {
  return currentScopePaths.length > 0 ? "Update connected scope" : "Connect to chat";
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof ApiError) return `${error.code}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return "Unable to connect scope.";
}

export function ScopeConnectButton({
  chatId,
  currentScopePaths,
  candidateRelativePaths,
  onConnected,
  updateScope = updateChatConnectedScope,
  now = Date.now,
}: ScopeConnectButtonProps): ReactNode {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const empty = candidateRelativePaths.length === 0;
  const disabled = empty || busy;
  const label = actionLabel(currentScopePaths);
  const tooltip = empty ? "Select a folder or file first" : label;

  async function handleClick(): Promise<void> {
    if (disabled) return;
    setError(null);
    setBusy(true);
    try {
      const response = await updateScope(chatId, {
        relativePaths: candidateRelativePaths,
        connectedAtMs: now(),
      });
      onConnected?.(response.chat);
    } catch (caught) {
      setError(formatErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className={BUTTON_BASE_CLASS}
        disabled={disabled}
        aria-disabled={disabled}
        aria-label={empty ? "Connect to chat (no selection)" : label}
        title={tooltip}
        onClick={() => {
          void handleClick();
        }}
      >
        {busy ? "Connecting…" : label}
      </button>
      {error !== null ? (
        <span role="alert" className="ml-2 text-xs text-red-500">
          {error}
        </span>
      ) : null}
    </>
  );
}
