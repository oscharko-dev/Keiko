"use client";

// Issue #3400 (epic #3384) — git-change scope pills for the chat header.
//
// A chat connects at most one Git-change comparison in V1 practice (gitChangeScopes); this
// renders ONE pill per connected comparison, mirroring ConnectedScopePill (folders) and
// ConnectorScopePill (connectors) — a third, sibling scope kind, never overloaded onto either.
// Renders nothing when gitChangeScopes is empty. Every field is server-issued (contract
// correction 2): comparisonLabel, counts and descriptionStatus — never a raw path, revision, or
// diff the browser could have authored.
//
// The trailing × detaches the scope via PATCH /api/chats (gitChangeScopes), exactly like the
// sibling pills. The ↻ action re-checks the comparison against the live repository
// (POST /api/git-change/refresh); `reads-context` is immutable and non-reconnectable, so a
// drifted comparison archives the old relationship and connects a new one server-side — the
// chat's scope entry here is simply replaced with the fresh (possibly "stale") projection.
//
// Accessibility: pill body announces through the shared sr-only polite region; both actions are
// real <button type="button">s with disambiguating aria-labels and a 24×24 minimum target
// (WCAG 2.5.8), matching the sibling pills exactly.

import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { refreshGitChangeScope, updateChatGitChangeScopes } from "@/lib/api";
import { useTranslate, type I18nTranslate } from "@/lib/i18n";
import type { MessageKey } from "@/lib/i18n-messages.en";
import { restoreScopeHeaderFocus } from "./ConnectedScopePill";
import { formatUserError } from "./format-error";
import type { Chat, ChatGitChangeDescriptionStatus, ChatGitChangeScope } from "@/lib/types";
import type { GitChangeBlockedReason } from "@/lib/api";

export interface GitChangeScopePillProps {
  readonly chat: Chat;
  readonly onDisconnect?: (chat: Chat) => void;
  readonly onRefreshed?: (chat: Chat) => void;
  /** Injectable wire seams for tests. Default to the real BFF helpers. */
  readonly updateScopes?: typeof updateChatGitChangeScopes;
  readonly refreshScope?: typeof refreshGitChangeScope;
}

const STATUS_BADGE_CLASS: Readonly<Record<ChatGitChangeDescriptionStatus, string>> = {
  current: "cmp-budget-badge cmp-budget-badge-low",
  stale: "cmp-budget-badge cmp-budget-badge-high",
  partial: "cmp-budget-badge cmp-budget-badge-moderate",
  fallback: "cmp-budget-badge cmp-budget-badge-moderate",
  blocked: "cmp-budget-badge cmp-budget-badge-exceeded",
  failed: "cmp-budget-badge cmp-budget-badge-exceeded",
};

const STATUS_LABEL_KEY: Readonly<Record<ChatGitChangeDescriptionStatus, MessageKey>> = {
  current: "gitChangeScope.status.current",
  stale: "gitChangeScope.status.stale",
  partial: "gitChangeScope.status.partial",
  fallback: "gitChangeScope.status.fallback",
  blocked: "gitChangeScope.status.blocked",
  failed: "gitChangeScope.status.failed",
};

const BLOCKED_REASON_KEY: Readonly<Record<GitChangeBlockedReason, MessageKey>> = {
  "detached-head": "gitChangeScope.blocked.detachedHead",
  "unborn-head": "gitChangeScope.blocked.unbornHead",
  "missing-ref": "gitChangeScope.blocked.missingRef",
  "no-pull-request": "gitChangeScope.blocked.noPullRequest",
  "ambiguous-pull-request": "gitChangeScope.blocked.ambiguousPullRequest",
  "reader-unauthorized": "gitChangeScope.blocked.readerUnauthorized",
  "remote-unresolved": "gitChangeScope.blocked.remoteUnresolved",
  "repository-unavailable": "gitChangeScope.blocked.repositoryUnavailable",
  "snapshot-unavailable": "gitChangeScope.blocked.snapshotUnavailable",
  "snapshot-failed": "gitChangeScope.blocked.snapshotFailed",
  "chat-project-unavailable": "gitChangeScope.blocked.chatProjectUnavailable",
};

/** Exported for the connect-dialog surface, which shares the same closed vocabulary. */
export function gitChangeBlockedReasonMessage(
  reason: GitChangeBlockedReason,
  t: I18nTranslate,
): string {
  return t(BLOCKED_REASON_KEY[reason]);
}

function countsLabel(scope: ChatGitChangeScope, t: I18nTranslate): string {
  return scope.omittedFiles > 0
    ? t("gitChangeScope.counts.withOmitted", { shown: scope.fileCount, total: scope.totalFiles })
    : t("gitChangeScope.counts.files", { count: scope.fileCount });
}

function formatDisconnectErrorMessage(error: unknown, t: I18nTranslate): string {
  return formatUserError(error, t("gitChangeScope.disconnect.error"));
}

function formatRefreshErrorMessage(error: unknown, t: I18nTranslate): string {
  return formatUserError(error, t("gitChangeScope.refresh.error"));
}

interface GitChangePillItemProps {
  readonly chat: Chat;
  readonly scope: ChatGitChangeScope;
  readonly allScopes: readonly ChatGitChangeScope[];
  readonly onDisconnect?: ((chat: Chat) => void) | undefined;
  readonly onRefreshed?: ((chat: Chat) => void) | undefined;
  readonly updateScopes: typeof updateChatGitChangeScopes;
  readonly refreshScope: typeof refreshGitChangeScope;
  readonly t: I18nTranslate;
}

function otherScopes(
  allScopes: readonly ChatGitChangeScope[],
  relationshipId: string,
): readonly ChatGitChangeScope[] {
  return allScopes.filter((entry) => entry.relationshipId !== relationshipId);
}

interface GitChangePillActions {
  readonly busy: boolean;
  readonly error: string | null;
  readonly disconnectRef: RefObject<HTMLButtonElement | null>;
  readonly handleDisconnect: () => void;
  readonly handleRefresh: () => void;
}

// Extracted from GitChangePillItem so the component body stays under the max-lines-per-function
// bar; both handlers share the same busy/error state and scope-list derivation.
function useGitChangePillActions(props: GitChangePillItemProps): GitChangePillActions {
  const { chat, scope, allScopes, onDisconnect, onRefreshed, updateScopes, refreshScope, t } =
    props;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const disconnectRef = useRef<HTMLButtonElement | null>(null);

  async function runDisconnect(): Promise<void> {
    setError(null);
    setBusy(true);
    // Capture the stable header ancestor before this pill unmounts (mirrors ConnectedScopePill).
    const header = disconnectRef.current?.closest(".chat-scope-header");
    try {
      const remaining = otherScopes(allScopes, scope.relationshipId);
      const response = await updateScopes(chat.id, remaining.length > 0 ? remaining : null);
      onDisconnect?.(response.chat);
      restoreScopeHeaderFocus(header);
    } catch (error_) {
      setError(formatDisconnectErrorMessage(error_, t));
    } finally {
      setBusy(false);
    }
  }

  async function runRefresh(): Promise<void> {
    setError(null);
    setBusy(true);
    try {
      const result = await refreshScope(chat.id, scope.relationshipId);
      if (result.status === "blocked") {
        setError(gitChangeBlockedReasonMessage(result.reason, t));
        return;
      }
      const remaining = otherScopes(allScopes, scope.relationshipId);
      onRefreshed?.({ ...chat, gitChangeScopes: [...remaining, result.scope] });
    } catch (error_) {
      setError(formatRefreshErrorMessage(error_, t));
    } finally {
      setBusy(false);
    }
  }

  return {
    busy,
    error,
    disconnectRef,
    handleDisconnect: (): void => {
      if (!busy) void runDisconnect();
    },
    handleRefresh: (): void => {
      if (!busy) void runRefresh();
    },
  };
}

function GitChangePillItem(props: GitChangePillItemProps): ReactNode {
  const { scope, t } = props;
  const { busy, error, disconnectRef, handleDisconnect, handleRefresh } =
    useGitChangePillActions(props);
  const accessibleLabel = t("gitChangeScope.pill.accessible", { label: scope.comparisonLabel });

  return (
    <span className="scope-pill-wrap">
      <span className="scope-pill">
        <span aria-hidden="true">⇄</span>
        <span aria-label={accessibleLabel}>{scope.comparisonLabel}</span>
        <span className={STATUS_BADGE_CLASS[scope.descriptionStatus]}>
          {t(STATUS_LABEL_KEY[scope.descriptionStatus])}
        </span>
        <button
          type="button"
          className="scope-pill-disconnect"
          aria-disabled={busy}
          aria-label={t("gitChangeScope.refresh.aria", { label: scope.comparisonLabel })}
          title={t("gitChangeScope.refresh.title")}
          onClick={handleRefresh}
        >
          <span aria-hidden="true">↻</span>
        </button>
        <button
          type="button"
          ref={disconnectRef}
          className="scope-pill-disconnect"
          aria-disabled={busy}
          aria-label={t("gitChangeScope.disconnect.aria", { label: scope.comparisonLabel })}
          title={t("gitChangeScope.disconnect.title", { label: scope.comparisonLabel })}
          onClick={handleDisconnect}
        >
          <span aria-hidden="true">×</span>
        </button>
      </span>
      <span className="scope-pill-detail">{countsLabel(scope, t)}</span>
      {error !== null ? (
        <span role="alert" className="scope-connect-error">
          {error}
        </span>
      ) : null}
    </span>
  );
}

function scopesSignature(scopes: readonly ChatGitChangeScope[]): string {
  return scopes.map((scope) => `${scope.relationshipId}:${scope.descriptionStatus}`).join(" ");
}

function scopesAnnouncement(isEmpty: boolean, hasStale: boolean, t: I18nTranslate): string {
  if (isEmpty) return t("gitChangeScope.announcement.removed");
  return hasStale
    ? t("gitChangeScope.announcement.stale")
    : t("gitChangeScope.announcement.connected");
}

function GitChangeScopeAnnouncer({ text }: { readonly text: string }): ReactNode {
  return (
    <span
      className="sr-only"
      role="status"
      aria-live="polite"
      data-testid="git-change-scope-announcer"
    >
      {text}
    </span>
  );
}

export function GitChangeScopePill({
  chat,
  onDisconnect,
  onRefreshed,
  updateScopes = updateChatGitChangeScopes,
  refreshScope = refreshGitChangeScope,
}: GitChangeScopePillProps): ReactNode {
  const t = useTranslate();
  const scopes = chat.gitChangeScopes ?? [];
  const signature = scopesSignature(scopes);
  const isEmpty = scopes.length === 0;
  const hasStale = scopes.some((scope) => scope.descriptionStatus === "stale");

  // GEN-UI-STATE-001 (WCAG 4.1.3): ONE always-mounted sr-only polite region announces a genuine
  // binding change (connect / disconnect / stale transition). It stays empty until the signature
  // actually changes after mount, so a chat switch or routine re-render never re-announces. Deps
  // are the primitives the announcement needs, never the `scopes` array itself (a fresh `[]`
  // reference every render for an unbound chat would otherwise re-fire on every render).
  const [announcement, setAnnouncement] = useState("");
  const prevSignatureRef = useRef(signature);
  useEffect(() => {
    if (prevSignatureRef.current !== signature) {
      prevSignatureRef.current = signature;
      setAnnouncement(scopesAnnouncement(isEmpty, hasStale, t));
    }
  }, [signature, isEmpty, hasStale, t]);

  const announcer = <GitChangeScopeAnnouncer text={announcement} />;

  if (scopes.length === 0) {
    return announcement === "" ? null : announcer;
  }
  return (
    <span className="scope-pill-group">
      {announcer}
      {scopes.map((scope) => (
        <GitChangePillItem
          key={scope.relationshipId}
          chat={chat}
          scope={scope}
          allScopes={scopes}
          onDisconnect={onDisconnect}
          onRefreshed={onRefreshed}
          updateScopes={updateScopes}
          refreshScope={refreshScope}
          t={t}
        />
      ))}
    </span>
  );
}
