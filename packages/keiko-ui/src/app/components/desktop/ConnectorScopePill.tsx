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

import { useRef, useState, type ReactNode } from "react";
import { updateChatLocalKnowledgeScopes } from "@/lib/api";
import { restoreScopeHeaderFocus } from "./ConnectedScopePill";
import { formatUserError } from "./format-error";
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
  // uiux-fix F041 (C173) — the entity is called "capsule" everywhere else
  // (grounding select, Local Knowledge UI); the pill must not call it "Connector".
  if (scope.kind === "capsule") return `Capsule: ${scope.capsuleId}`;
  return `Capsule set: ${scope.capsuleSetId}`;
}

function formatErrorMessage(error: unknown): string {
  // uiux-fix F041 (C171) — message first, machine code as trailing detail.
  return formatUserError(error, "Unable to disconnect capsule.");
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
  const disconnectRef = useRef<HTMLButtonElement | null>(null);
  const label = scopeLabel(scope, labels);
  const key = scopeKey(scope);

  async function handleDisconnect(): Promise<void> {
    if (busy) return;
    setError(null);
    setBusy(true);
    // uiux-fix F010 (C169): capture the stable header ancestor before this pill unmounts.
    const header = disconnectRef.current?.closest(".chat-scope-header");
    try {
      const remaining = allScopes.filter((s) => scopeKey(s) !== key);
      const response = await updateScopes(chat.id, remaining.length > 0 ? remaining : null);
      onDisconnect?.(response.chat);
      restoreScopeHeaderFocus(header);
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
        {/* aria-disabled (not native disabled) while busy: native disabled drops keyboard
            focus mid-request (C169); the handleDisconnect busy guard blocks re-activation. */}
        <button
          type="button"
          ref={disconnectRef}
          className="scope-pill-disconnect"
          aria-disabled={busy}
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
