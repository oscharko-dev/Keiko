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

  // The status/live region is text-only (Copilot PR #254 finding: interactive controls inside
  // a status region produce inconsistent screen-reader announcements). The disconnect button
  // sits as a SIBLING of the live region so its native disabled/onClick behaviour stays clean.
  return (
    <span className="scope-pill-wrap">
      <span className="scope-pill">
        <span aria-hidden="true">●</span>
        <span role="status" aria-live="polite">
          {label}
        </span>
        <button
          type="button"
          className="scope-pill-disconnect"
          disabled={busy}
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
        <span role="alert" className="scope-connect-error">
          {error}
        </span>
      ) : null}
    </span>
  );
}
