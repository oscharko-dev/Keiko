"use client";

// Epic #189 Slice 3 M4 — connector-scope pills for the chat header.
//
// A chat may bind 1+N Local Knowledge connector sources (localKnowledgeScopes); this renders
// ONE pill per connector source alongside the folder pills from ConnectedScopePill. Renders
// nothing when localKnowledgeScopes is empty, so the header stays clean.
//
// Each pill's trailing × detaches just THAT source via
// PATCH /api/chats with the remaining `localKnowledgeScopes` array (or null when it was the last).
//
// Accessibility:
//  - pill body is role="status" aria-live="polite" — screen readers announce binding changes
//  - × is a real <button type="button"> with aria-label naming the specific connector removed
//  - minimum 24×24 target (WCAG 2.5.8)
//  - stable keys derived from kind+id, not array indices

import { useState, type ReactNode } from "react";
import { ApiError, updateChatLocalKnowledgeScopes } from "@/lib/api";
import { effectiveLocalKnowledgeScopes } from "./hooks/workspaceActions";
import type { Chat, ChatLocalKnowledgeScope } from "@/lib/types";

export interface ConnectorScopePillProps {
  readonly chat: Chat;
  readonly onDisconnect?: (chat: Chat) => void;
  /** Injectable wire seam for tests. Defaults to the real BFF helper. */
  readonly updateScopes?: typeof updateChatLocalKnowledgeScopes;
  /** Optional label lookup map: scope key → display name. When absent, falls back to the id. */
  readonly labels?: ReadonlyMap<string, string>;
}

function scopeKey(scope: ChatLocalKnowledgeScope): string {
  return scope.kind === "capsule" ? `capsule:${scope.capsuleId}` : `set:${scope.capsuleSetId}`;
}

function scopeLabel(scope: ChatLocalKnowledgeScope, labels: ReadonlyMap<string, string>): string {
  const key = scopeKey(scope);
  const resolved = labels.get(key);
  if (resolved !== undefined && resolved.length > 0) return resolved;
  if (scope.kind === "capsule") return `Connector: ${scope.capsuleId}`;
  return `Connector set: ${scope.capsuleSetId}`;
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof ApiError) return `${error.code}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return "Unable to disconnect connector.";
}

interface ConnectorPillItemProps {
  readonly chat: Chat;
  readonly scope: ChatLocalKnowledgeScope;
  readonly allScopes: readonly ChatLocalKnowledgeScope[];
  readonly onDisconnect?: ((chat: Chat) => void) | undefined;
  readonly updateScopes: typeof updateChatLocalKnowledgeScopes;
  readonly labels: ReadonlyMap<string, string>;
}

function ConnectorPillItem({
  chat,
  scope,
  allScopes,
  onDisconnect,
  updateScopes,
  labels,
}: ConnectorPillItemProps): ReactNode {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = scopeLabel(scope, labels);
  const key = scopeKey(scope);

  async function handleDisconnect(): Promise<void> {
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      const remaining = allScopes.filter((s) => scopeKey(s) !== key);
      const response = await updateScopes(chat.id, remaining.length > 0 ? remaining : null);
      onDisconnect?.(response.chat);
    } catch (caught) {
      setError(formatErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="scope-pill-wrap">
      <span className="scope-pill scope-pill--connector">
        <span aria-hidden="true">◆</span>
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

export function ConnectorScopePill({
  chat,
  onDisconnect,
  updateScopes = updateChatLocalKnowledgeScopes,
  labels = new Map(),
}: ConnectorScopePillProps): ReactNode {
  const scopes = effectiveLocalKnowledgeScopes(chat);
  if (scopes.length === 0) return null;
  return (
    <span className="scope-pill-group scope-pill-group--connector">
      {scopes.map((scope) => (
        <ConnectorPillItem
          key={scopeKey(scope)}
          chat={chat}
          scope={scope}
          allScopes={scopes}
          onDisconnect={onDisconnect}
          updateScopes={updateScopes}
          labels={labels}
        />
      ))}
    </span>
  );
}
