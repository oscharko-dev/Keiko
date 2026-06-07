"use client";

// Issue #184 / Epic #532 — chat-header connected-scope pills. A chat may bind 1+N sources
// (connectedScopes); this renders ONE pill per connected source and renders nothing when the chat
// has no binding so the header stays clean. Each pill's trailing × detaches just THAT source via
// PATCH /api/chats with the remaining `connectedScopes` array (or null when it was the last one).
//
// Accessibility: each pill body is `role="status" aria-live="polite"` so screen readers announce a
// binding change. The × is a real <button type="button"> whose aria-label names the specific source
// it removes, with a 24×24 minimum target. Color contrast uses --ink-inverse on --accent
// (ink-inverse #1a1e23 on accent #4EBA87 = 6.94:1, ≥4.5:1).

import { useState, type ReactNode } from "react";
import { ApiError, updateChatConnectedScopes } from "@/lib/api";
import { effectiveScopes } from "./hooks/workspaceActions";
import type { Chat, ChatConnectedScope } from "@/lib/types";

export interface ConnectedScopePillProps {
  readonly chat: Chat;
  readonly onDisconnect?: (chat: Chat) => void;
  // Injectable wire seam for tests. Defaults to the real BFF helper.
  readonly updateScopes?: typeof updateChatConnectedScopes;
}

function lastSegment(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const slash = trimmed.lastIndexOf("/");
  return slash === -1 ? trimmed : trimmed.slice(slash + 1);
}

// Epic #532 — when a source carries its own external root, label it by the folder name so several
// connected folders stay distinguishable. Otherwise fall back to the Issue #184 kind-based label.
function pillLabel(scope: ChatConnectedScope): string {
  if (typeof scope.root === "string" && scope.root.length > 0) {
    const segment = lastSegment(scope.root);
    return segment.length === 0 ? "Connected folder" : `Folder: ${segment}`;
  }
  if (scope.kind === "workspace-root") return "Repository scope";
  if (scope.kind === "directory") {
    const segment = lastSegment(scope.relativePaths[0] ?? "");
    return segment.length === 0 ? "Connected folder" : `Folder: ${segment}`;
  }
  if (scope.relativePaths.length === 1) {
    const segment = lastSegment(scope.relativePaths[0] ?? "");
    return segment.length === 0 ? "Connected file" : `File: ${segment}`;
  }
  return `${String(scope.relativePaths.length)} files connected`;
}

function scopeBoundaryText(scope: ChatConnectedScope): string {
  const noun =
    scope.kind === "workspace-root"
      ? "the connected repository"
      : scope.kind === "directory"
        ? "the connected folder"
        : "the connected file scope";
  return `Keiko may inspect only ${noun}; safe-read exclusions and context budget limits apply before each answer.`;
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof ApiError) return `${error.code}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return "Unable to disconnect scope.";
}

interface ScopePillItemProps {
  readonly chat: Chat;
  readonly scope: ChatConnectedScope;
  readonly index: number;
  readonly allScopes: readonly ChatConnectedScope[];
  readonly onDisconnect?: ((chat: Chat) => void) | undefined;
  readonly updateScopes: typeof updateChatConnectedScopes;
}

function ScopePillItem({
  chat,
  scope,
  index,
  allScopes,
  onDisconnect,
  updateScopes,
}: ScopePillItemProps): ReactNode {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = pillLabel(scope);

  async function handleDisconnect(): Promise<void> {
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      // Remove THIS source by position; clear the binding entirely when it was the last one.
      const remaining = allScopes.filter((_, i) => i !== index);
      const response = await updateScopes(chat.id, remaining.length > 0 ? remaining : null);
      onDisconnect?.(response.chat);
    } catch (caught) {
      setError(formatErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  // The status/live region is text-only (Copilot PR #254 finding: interactive controls inside a
  // status region produce inconsistent screen-reader announcements). The × button is a SIBLING.
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
          aria-label={`Disconnect ${label} from chat`}
          title={`Disconnect ${label} from chat`}
          onClick={() => {
            void handleDisconnect();
          }}
        >
          {/* The visible × is decorative; the aria-label carries the action's meaning. */}
          <span aria-hidden="true">×</span>
        </button>
      </span>
      <span className="scope-pill-detail">{scopeBoundaryText(scope)}</span>
      {error !== null ? (
        <span role="alert" className="scope-connect-error">
          {error}
        </span>
      ) : null}
    </span>
  );
}

export function ConnectedScopePill({
  chat,
  onDisconnect,
  updateScopes = updateChatConnectedScopes,
}: ConnectedScopePillProps): ReactNode {
  const scopes = effectiveScopes(chat);
  if (scopes.length === 0) return null;
  return (
    <span className="scope-pill-group">
      {scopes.map((scope, index) => (
        <ScopePillItem
          key={`${scope.root ?? scope.kind}-${String(scope.connectedAtMs)}-${String(index)}`}
          chat={chat}
          scope={scope}
          index={index}
          allScopes={scopes}
          onDisconnect={onDisconnect}
          updateScopes={updateScopes}
        />
      ))}
    </span>
  );
}
