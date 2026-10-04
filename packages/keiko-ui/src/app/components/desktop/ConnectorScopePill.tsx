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
//  - one always-mounted sr-only polite region announces a genuine binding change (GEN-UI-STATE-001)
//  - × is a real <button type="button"> with aria-label naming the specific connector removed
//  - minimum 24×24 target (WCAG 2.5.8)
//  - stable keys derived from kind+id, not array indices

import { useEffect, useRef, useState, type ReactNode } from "react";
import { updateChatLocalKnowledgeScopes } from "@/lib/api";
import {
  useLocalKnowledgeTranslate,
  type I18nTranslate,
} from "@/app/local-knowledge/local-knowledge-i18n";
import { restoreScopeHeaderFocus } from "./ConnectedScopePill";
import { formatUserError } from "./format-error";
import { effectiveLocalKnowledgeScopes } from "./hooks/workspaceActions";
import type { Chat, ChatLocalKnowledgeScope } from "@/lib/types";

export interface ConnectorScopePillProps {
  readonly chat: Chat;
  readonly onDisconnect?: (chat: Chat) => void;
  /** Injectable wire seam for tests. Defaults to the real BFF helper. */
  readonly updateScopes?: typeof updateChatLocalKnowledgeScopes;
  /** Optional label lookup map: scope key → display name. */
  readonly labels?: ReadonlyMap<string, string>;
  /**
   * The catalog behind `labels` has answered. A scope it does not name then reads as unavailable;
   * until it answers (or while it failed) the pill names only the kind. Never the raw id.
   */
  readonly labelsSettled?: boolean;
}

function scopeKey(scope: ChatLocalKnowledgeScope): string {
  return scope.kind === "capsule" ? `capsule:${scope.capsuleId}` : `set:${scope.capsuleSetId}`;
}

// The display name the catalog gave the scope. A scope it does not name reads as unavailable once
// the catalog answered, and by its kind until then — never by its raw id (PR #3678, as the picker).
function scopeLabel(
  scope: ChatLocalKnowledgeScope,
  labels: ReadonlyMap<string, string>,
  labelsSettled: boolean,
  t: I18nTranslate,
): string {
  const resolved = labels.get(scopeKey(scope));
  if (resolved !== undefined && resolved.length > 0) return resolved;
  const pod = scope.kind === "capsule";
  if (!labelsSettled) {
    return t(pod ? "localKnowledge.scopePill.pendingPod" : "localKnowledge.scopePill.pendingSet");
  }
  return t(pod ? "localKnowledge.picker.unavailablePod" : "localKnowledge.picker.unavailableSet");
}

function formatErrorMessage(error: unknown, t: I18nTranslate): string {
  // uiux-fix F041 (C171) — message first, machine code as trailing detail.
  return formatUserError(error, t("localKnowledge.scopePill.disconnectError"));
}

interface ConnectorPillItemProps {
  readonly chat: Chat;
  readonly scope: ChatLocalKnowledgeScope;
  readonly allScopes: readonly ChatLocalKnowledgeScope[];
  readonly onDisconnect?: ((chat: Chat) => void) | undefined;
  readonly updateScopes: typeof updateChatLocalKnowledgeScopes;
  readonly label: string;
  readonly t: I18nTranslate;
}

function ConnectorPillItem({
  chat,
  scope,
  allScopes,
  onDisconnect,
  updateScopes,
  label,
  t,
}: ConnectorPillItemProps): ReactNode {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const disconnectRef = useRef<HTMLButtonElement | null>(null);
  const key = scopeKey(scope);
  const disconnectLabel = t("localKnowledge.scopePill.disconnect", { label });

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
    } catch (error_) {
      setError(formatErrorMessage(error_, t));
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="scope-pill-wrap">
      <span className="scope-pill scope-pill--connector">
        <span aria-hidden="true">◆</span>
        {/* GEN-UI-STATE-001 (WCAG 4.1.3): plain label span — NOT a live region. A per-pill
            role="status" re-announced the unchanged label on every routine re-render / chat switch.
            The genuine binding-change announcement lives in one always-mounted sr-only region at the
            group level (ConnectorScopePill), firing only when the connector set actually changes. */}
        <span aria-label={label}>{label}</span>
        {/* aria-disabled (not native disabled) while busy: native disabled drops keyboard
            focus mid-request (C169); the handleDisconnect busy guard blocks re-activation. */}
        <button
          type="button"
          ref={disconnectRef}
          className="scope-pill-disconnect"
          aria-disabled={busy}
          aria-label={disconnectLabel}
          title={disconnectLabel}
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

// Content-free signature of the connector-scope set: the ordered scope keys. Two chats binding the
// same connectors produce the same signature (routine re-render, no re-announce); a connect/disconnect
// changes the key set and does.
function connectorScopesSignature(scopes: readonly ChatLocalKnowledgeScope[]): string {
  return scopes.map((scope) => scopeKey(scope)).join(" ");
}

// The "removed" and "updated" announcements are distinct sentences in every language, each with
// its own singular and plural catalog entry.
function connectorScopesAnnouncement(count: number, t: I18nTranslate): string {
  if (count === 0) return t("localKnowledge.scopePill.removed");
  if (count === 1) return t("localKnowledge.scopePill.updated.one");
  return t("localKnowledge.scopePill.updated.other", { count });
}

export function ConnectorScopePill({
  chat,
  onDisconnect,
  updateScopes = updateChatLocalKnowledgeScopes,
  labels = new Map(),
  labelsSettled = true,
}: ConnectorScopePillProps): ReactNode {
  const t = useLocalKnowledgeTranslate();
  const scopes = effectiveLocalKnowledgeScopes(chat);
  const signature = connectorScopesSignature(scopes);

  // GEN-UI-STATE-001 (WCAG 4.1.3): ONE always-mounted sr-only polite region announces a genuine
  // binding change. It stays empty until the connector signature actually changes after mount, so a
  // chat switch to the same-shaped connectors — or any routine re-render — never re-announces.
  // Mirrors WorkflowHandoff's prevRef/useEffect guard.
  const [announcement, setAnnouncement] = useState("");
  const prevSignatureRef = useRef(signature);
  useEffect(() => {
    if (prevSignatureRef.current !== signature) {
      prevSignatureRef.current = signature;
      setAnnouncement(connectorScopesAnnouncement(scopes.length, t));
    }
  }, [signature, scopes.length, t]);

  const announcer = (
    <span
      className="sr-only"
      role="status"
      aria-live="polite"
      data-testid="connector-scope-announcer"
    >
      {announcement}
    </span>
  );

  // Keep the header clean when the chat never had a connector binding: with no scopes AND no pending
  // announcement, render nothing. After the last connector is disconnected the effect populates
  // `announcement`, so the polite region re-mounts with content and the removal is still announced.
  if (scopes.length === 0) {
    return announcement === "" ? null : announcer;
  }
  return (
    <span className="scope-pill-group scope-pill-group--connector">
      {announcer}
      {scopes.map((scope) => (
        <ConnectorPillItem
          key={scopeKey(scope)}
          chat={chat}
          scope={scope}
          allScopes={scopes}
          onDisconnect={onDisconnect}
          updateScopes={updateScopes}
          label={scopeLabel(scope, labels, labelsSettled, t)}
          t={t}
        />
      ))}
    </span>
  );
}
