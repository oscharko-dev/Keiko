"use client";

// Issue #184 — small status pill that surfaces a chat's connected Files-window scope. Renders
// nothing when the chat has no binding so the chat header stays clean. A trailing × button
// detaches the binding via PATCH /api/chats with `{connectedScope: null}`.
//
// Accessibility: the pill body is `role="status" aria-live="polite"` so screen readers announce
// the binding change when it appears. The × button is a real <button type="button"> with
// aria-label="Disconnect scope from chat" and the same 24×24 minimum target as the connector.
// Color contrast uses --ink-inverse on --accent (verified ≥4.5:1 in the Keiko palette per
// memory: ink-inverse #1a1e23 on accent #4EBA87 = 6.94:1).

import { useState, type ReactNode } from "react";
import { ApiError, updateChatConnectedScope } from "@/lib/api";
import type { Chat } from "@/lib/types";

export interface ConnectedScopePillProps {
  readonly chat: Chat;
  readonly onDisconnect?: (chat: Chat) => void;
  // Injectable wire seam for tests. Defaults to the real BFF helper.
  readonly updateScope?: typeof updateChatConnectedScope;
}

const PILL_CLASS =
  "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs " +
  "bg-[var(--accent)] text-[var(--ink-inverse)] " +
  "ring-1 ring-inset ring-[color-mix(in_oklab,var(--accent)_70%,#000_30%)]";

const DISCONNECT_BUTTON_CLASS =
  "inline-flex items-center justify-center min-w-[24px] min-h-[24px] " +
  "rounded-full p-0.5 text-[var(--ink-inverse)] hover:bg-black/15 " +
  "disabled:opacity-50 disabled:cursor-not-allowed " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset " +
  "focus-visible:ring-[var(--ink-inverse)]";

function lastSegment(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const slash = trimmed.lastIndexOf("/");
  return slash === -1 ? trimmed : trimmed.slice(slash + 1);
}

function pillLabel(relativePaths: readonly string[]): string {
  if (relativePaths.length === 1) {
    const first = relativePaths[0] ?? "";
    const segment = lastSegment(first);
    return segment.length === 0 ? "Connected scope" : segment;
  }
  return `Connected to ${String(relativePaths.length)} paths`;
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof ApiError) return `${error.code}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return "Unable to disconnect scope.";
}

export function ConnectedScopePill({
  chat,
  onDisconnect,
  updateScope = updateChatConnectedScope,
}: ConnectedScopePillProps): ReactNode {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scope = chat.connectedScope;
  if (scope === undefined) return null;
  const label = pillLabel(scope.relativePaths);

  async function handleDisconnect(): Promise<void> {
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      const response = await updateScope(chat.id, null);
      onDisconnect?.(response.chat);
    } catch (caught) {
      setError(formatErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      <span className={PILL_CLASS} role="status" aria-live="polite">
        <span aria-hidden="true">●</span>
        <span>{label}</span>
        <button
          type="button"
          className={DISCONNECT_BUTTON_CLASS}
          disabled={busy}
          aria-disabled={busy}
          aria-label="Disconnect scope from chat"
          title="Disconnect scope from chat"
          onClick={() => {
            void handleDisconnect();
          }}
        >
          {/* The visible × is decorative; the aria-label carries the action's meaning. */}
          <span aria-hidden="true">×</span>
        </button>
      </span>
      {error !== null ? (
        <span role="alert" className="text-xs text-red-500">
          {error}
        </span>
      ) : null}
    </span>
  );
}
