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
import {
  applyGitChangeChatDescription,
  fetchGitDeliveryPrDescriptionApprove,
  fetchGitDeliveryPrDescriptionPreview,
  fetchGitRemotes,
  refreshGitChangeScope,
  updateChatGitChangeScopes,
} from "@/lib/api";
import { useLocale, useTranslate, type I18nTranslate } from "@/lib/i18n";
import type { MessageKey } from "@/lib/i18n-messages.en";
import { restoreScopeHeaderFocus } from "./ConnectedScopePill";
import { formatUserError } from "./format-error";
import type { Chat, ChatGitChangeDescriptionStatus, ChatGitChangeScope } from "@/lib/types";
import type {
  GitChangeBlockedReason,
  GitDeliveryPrDescriptionApproveResponse,
  PrDescriptionApplicationResultWire,
  PrDescriptionLanguage,
} from "@/lib/api";

// #3400 final-audit F5 — the ONLY write action a Chat-connected git-change scope offers beyond
// disconnect/refresh (Frozen Product Decision 6): a normal-chat-refined description is applied
// through the SAME governed preview -> approve -> apply lifecycle GovernedPullRequestCard uses,
// never a second free-text composer (Frozen Decision 5) and never a raw browser-authored
// `ownerAndRepo` -- `applyGitChangeChatDescription` names only the chat/relationship/proposal ids,
// letting the server re-derive the repository from the SAME trusted checkout the scope was
// connected against. Preview/approve reuse the EXISTING `/api/git-delivery/pr-description/*`
// routes, so the browser resolves `ownerAndRepo` itself from the project's own remotes
// (`resolveGitChangeOwnerAndRepo` below) exactly the way GitClientWindow.tsx does for
// GovernedPullRequestCard.
export type PreviewGitChangeDescriptionFn = (
  chat: Chat,
  scope: ChatGitChangeScope,
  language: PrDescriptionLanguage,
) => Promise<PrDescriptionApplicationResultWire>;

export type ApproveGitChangeDescriptionFn = (
  chat: Chat,
  scope: ChatGitChangeScope,
  proposalId: string,
) => Promise<GitDeliveryPrDescriptionApproveResponse>;

export type ApplyGitChangeDescriptionFn = (
  chat: Chat,
  relationshipId: string,
  proposalId: string,
) => Promise<PrDescriptionApplicationResultWire>;

export interface GitChangeScopePillProps {
  readonly chat: Chat;
  readonly onDisconnect?: (chat: Chat) => void;
  readonly onRefreshed?: (chat: Chat) => void;
  /** Injectable wire seams for tests. Default to the real BFF helpers. */
  readonly updateScopes?: typeof updateChatGitChangeScopes;
  readonly refreshScope?: typeof refreshGitChangeScope;
  readonly previewDescription?: PreviewGitChangeDescriptionFn;
  readonly approveDescription?: ApproveGitChangeDescriptionFn;
  readonly applyDescription?: ApplyGitChangeDescriptionFn;
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

// ─── #3400 final-audit F5 — description preview/approve/apply for a connected, PR-resolved scope

// Duplicated from GitClientWindow.tsx's own private `ownerRepoFromRemoteUrl` (GitHub-only,
// https or ssh) rather than imported: that module is a concurrently-edited, out-of-scope file for
// this item, and the browser here only ever needs a read-only hint for the EXISTING
// pr-description preview/approve routes' `ownerAndRepo` field -- the apply action above never
// trusts it. Flagged for consolidation once that file's own edits land.
function ownerRepoFromRemoteUrl(value: string | undefined): string | undefined {
  if (value === undefined || value === "") return undefined;
  const trimmed = value.replace(/\.git$/u, "");
  const sshMatch = /^git@github\.com:([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)$/u.exec(trimmed);
  if (sshMatch?.[1] !== undefined) return sshMatch[1];
  try {
    const url = new URL(trimmed);
    if (url.hostname !== "github.com") return undefined;
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length >= 2) return `${parts[0]}/${parts[1]}`;
  } catch {
    return undefined;
  }
  return undefined;
}

async function resolveGitChangeOwnerAndRepo(projectPath: string): Promise<string | undefined> {
  const { remotes } = await fetchGitRemotes(projectPath);
  for (const remote of remotes) {
    const ownerAndRepo =
      ownerRepoFromRemoteUrl(remote.fetchUrl) ?? ownerRepoFromRemoteUrl(remote.pushUrl);
    if (ownerAndRepo !== undefined) return ownerAndRepo;
  }
  return undefined;
}

function requireDescriptionTarget(
  chat: Chat,
  scope: ChatGitChangeScope,
  ownerAndRepo: string | undefined,
): { readonly projectId: string; readonly ownerAndRepo: string; readonly prNumber: number } {
  if (ownerAndRepo === undefined || scope.pullRequestNumber === undefined) {
    throw new Error("Could not determine the GitHub repository for this connected comparison.");
  }
  return { projectId: chat.projectPath, ownerAndRepo, prNumber: scope.pullRequestNumber };
}

const defaultPreviewDescription: PreviewGitChangeDescriptionFn = async (chat, scope, language) => {
  const target = requireDescriptionTarget(
    chat,
    scope,
    await resolveGitChangeOwnerAndRepo(chat.projectPath),
  );
  return fetchGitDeliveryPrDescriptionPreview({
    ...target,
    language,
    snapshotDigest: scope.snapshotDigest,
  });
};

const defaultApproveDescription: ApproveGitChangeDescriptionFn = async (
  chat,
  scope,
  proposalId,
) => {
  const target = requireDescriptionTarget(
    chat,
    scope,
    await resolveGitChangeOwnerAndRepo(chat.projectPath),
  );
  return fetchGitDeliveryPrDescriptionApprove({ ...target, proposalId });
};

const defaultApplyDescription: ApplyGitChangeDescriptionFn = (chat, relationshipId, proposalId) =>
  applyGitChangeChatDescription({ chatId: chat.id, relationshipId, proposalId });

function descriptionResultState(
  result: PrDescriptionApplicationResultWire | undefined,
): ChatGitChangeDescriptionStatus | undefined {
  if (result === undefined) return undefined;
  if (result.outcome === "preview") return result.preview.status.state;
  if (result.outcome === "observed") return result.status.state;
  return "blocked";
}

function descriptionResultReason(
  result: PrDescriptionApplicationResultWire | undefined,
): string | undefined {
  if (result === undefined) return undefined;
  if (result.outcome === "preview") return result.preview.status.reason;
  if (result.outcome === "observed") return result.status.reason;
  return result.reason;
}

function descriptionProposalId(
  result: PrDescriptionApplicationResultWire | undefined,
): string | undefined {
  return result?.outcome === "preview" ? result.preview.proposalId : undefined;
}

function formatDescriptionErrorMessage(error: unknown, t: I18nTranslate): string {
  return formatUserError(error, t("gitChangeScope.description.error"));
}

function countsLabel(scope: ChatGitChangeScope, t: I18nTranslate): string {
  if (scope.omittedFiles > 0) {
    return t("gitChangeScope.counts.withOmitted", {
      shown: scope.fileCount,
      total: scope.totalFiles,
    });
  }
  const key = scope.fileCount === 1 ? "gitChangeScope.counts.file" : "gitChangeScope.counts.files";
  return t(key, { count: scope.fileCount });
}

function formatDisconnectErrorMessage(error: unknown, t: I18nTranslate): string {
  return formatUserError(error, t("gitChangeScope.disconnect.error"));
}

function formatRefreshErrorMessage(error: unknown, t: I18nTranslate): string {
  return formatUserError(error, t("gitChangeScope.refresh.error"));
}

interface DescriptionRunContext {
  readonly chat: Chat;
  readonly scope: ChatGitChangeScope;
  readonly t: I18nTranslate;
  readonly setBusy: (busy: boolean) => void;
  readonly setError: (error: string | null) => void;
}

// Shared busy/error wrapping for the preview/approve/apply calls below — the same try/finally
// shape `useGitChangePillActions`' runDisconnect/runRefresh already use, generalised over the
// result type so each action stays a one-line call site.
async function runDescriptionAction<TResult>(
  ctx: DescriptionRunContext,
  action: () => Promise<TResult>,
  onSuccess: (result: TResult) => void,
): Promise<void> {
  ctx.setError(null);
  ctx.setBusy(true);
  try {
    onSuccess(await action());
  } catch (error_) {
    ctx.setError(formatDescriptionErrorMessage(error_, ctx.t));
  } finally {
    ctx.setBusy(false);
  }
}

interface GitChangeDescriptionActionsProps {
  readonly chat: Chat;
  readonly scope: ChatGitChangeScope;
  readonly language: PrDescriptionLanguage;
  readonly previewDescription: PreviewGitChangeDescriptionFn;
  readonly approveDescription: ApproveGitChangeDescriptionFn;
  readonly applyDescription: ApplyGitChangeDescriptionFn;
  readonly t: I18nTranslate;
}

interface GitChangeDescriptionActionsState {
  readonly busy: boolean;
  readonly error: string | null;
  readonly result: PrDescriptionApplicationResultWire | undefined;
  readonly applied: boolean;
  readonly canApprove: boolean;
  readonly canApply: boolean;
  readonly runPreview: () => void;
  readonly runApprove: () => void;
  readonly runApply: () => void;
}

interface DescriptionRunnerFns {
  readonly preview: PreviewGitChangeDescriptionFn;
  readonly approve: ApproveGitChangeDescriptionFn;
  readonly apply: ApplyGitChangeDescriptionFn;
}

interface DescriptionRunnerState {
  readonly busy: boolean;
  // Preview stays available while stale (it is how a stale description gets refreshed); approve
  // and apply must refuse a stale proposal even if a stray click reaches the handler, not just
  // report canApprove/canApply as false for rendering (mirrors GovernedPullRequestCard's own
  // `state !== "stale"` gate on the underlying action, not only on the button's disabled state).
  readonly stale: boolean;
  readonly language: PrDescriptionLanguage;
  readonly proposalId: string | undefined;
  readonly approvedProposalId: string | undefined;
  readonly setResult: (result: PrDescriptionApplicationResultWire) => void;
  readonly setApprovedProposalId: (id: string | undefined) => void;
  readonly setApplied: (applied: boolean) => void;
}

// Extracted so useGitChangeDescriptionActions stays under the max-lines-per-function bar. The
// preview -> approve -> apply chain is a strict, one-use-approval sequence, never a free-text
// composer (Frozen Decisions 5/6): each runner only advances from the state the PREVIOUS step
// produced (a fresh proposalId from preview, an approved proposalId from approve).
function buildDescriptionRunners(
  ctx: DescriptionRunContext,
  fns: DescriptionRunnerFns,
  state: DescriptionRunnerState,
): {
  readonly runPreview: () => void;
  readonly runApprove: () => void;
  readonly runApply: () => void;
} {
  const { chat, scope } = ctx;
  const runPreview = (): void => {
    if (state.busy) return;
    void runDescriptionAction(
      ctx,
      () => fns.preview(chat, scope, state.language),
      (next) => {
        state.setResult(next);
        state.setApprovedProposalId(undefined);
        state.setApplied(false);
      },
    );
  };
  const runApprove = (): void => {
    const proposalId = state.proposalId;
    if (state.busy || state.stale || proposalId === undefined) return;
    void runDescriptionAction(
      ctx,
      () => fns.approve(chat, scope, proposalId),
      () => state.setApprovedProposalId(proposalId),
    );
  };
  const runApply = (): void => {
    const proposalId = state.approvedProposalId;
    if (state.busy || state.stale || proposalId === undefined) return;
    void runDescriptionAction(
      ctx,
      () => fns.apply(chat, scope.relationshipId, proposalId),
      (next) => {
        state.setResult(next);
        state.setApplied(true);
        state.setApprovedProposalId(undefined);
      },
    );
  };
  return { runPreview, runApprove, runApply };
}

// Extracted from GitChangePillItem so it stays under the max-lines-per-function bar; mirrors
// useGitChangePillActions' busy/error shape one level up.
function useGitChangeDescriptionActions(
  props: GitChangeDescriptionActionsProps,
): GitChangeDescriptionActionsState {
  const { chat, scope, language, previewDescription, approveDescription, applyDescription, t } =
    props;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PrDescriptionApplicationResultWire | undefined>(undefined);
  const [approvedProposalId, setApprovedProposalId] = useState<string | undefined>(undefined);
  const [applied, setApplied] = useState(false);
  const ctx: DescriptionRunContext = { chat, scope, t, setBusy, setError };
  const proposalId = descriptionProposalId(result);
  const stale = scope.descriptionStatus === "stale" || descriptionResultState(result) === "stale";
  const { runPreview, runApprove, runApply } = buildDescriptionRunners(
    ctx,
    { preview: previewDescription, approve: approveDescription, apply: applyDescription },
    {
      busy,
      stale,
      language,
      proposalId,
      approvedProposalId,
      setResult,
      setApprovedProposalId,
      setApplied,
    },
  );

  return {
    busy,
    error,
    result,
    applied,
    canApprove: !busy && !stale && proposalId !== undefined && approvedProposalId === undefined,
    canApply: !busy && !stale && approvedProposalId !== undefined,
    runPreview,
    runApprove,
    runApply,
  };
}

function DescriptionActionButtons({
  actions,
  scope,
  t,
}: {
  readonly actions: GitChangeDescriptionActionsState;
  readonly scope: ChatGitChangeScope;
  readonly t: I18nTranslate;
}): ReactNode {
  const label = scope.comparisonLabel;
  return (
    <span style={{ display: "inline-flex", gap: 4 }}>
      <button
        type="button"
        data-testid="git-change-description-preview"
        aria-disabled={actions.busy}
        aria-label={t("gitChangeScope.description.previewAria", { label })}
        onClick={actions.runPreview}
      >
        {t("gitChangeScope.description.preview")}
      </button>
      <button
        type="button"
        data-testid="git-change-description-approve"
        aria-disabled={!actions.canApprove}
        aria-label={t("gitChangeScope.description.approveAria", { label })}
        onClick={actions.runApprove}
      >
        {t("gitChangeScope.description.approve")}
      </button>
      <button
        type="button"
        data-testid="git-change-description-apply"
        aria-disabled={!actions.canApply}
        aria-label={t("gitChangeScope.description.applyAria", { label })}
        onClick={actions.runApply}
      >
        {t("gitChangeScope.description.apply")}
      </button>
    </span>
  );
}

function DescriptionResultStatus({
  result,
  t,
}: {
  readonly result: PrDescriptionApplicationResultWire | undefined;
  readonly t: I18nTranslate;
}): ReactNode {
  const state = descriptionResultState(result);
  if (state === undefined) return null;
  const reason = descriptionResultReason(result);
  return (
    <span
      className={STATUS_BADGE_CLASS[state]}
      data-testid="git-change-description-state"
      data-state={state}
    >
      {t(STATUS_LABEL_KEY[state])}
      {reason !== undefined ? ` (${reason})` : ""}
    </span>
  );
}

/**
 * The apply affordance for a connected, PR-resolved git-change scope: Preview -> Approve ->
 * Apply to PR, rendering the SAME closed current|stale|partial|fallback|blocked|failed vocabulary
 * (and reason codes) GovernedPullRequestCard renders for the sibling #3399 routes — never a
 * second vocabulary. Renders nothing for a comparison-only scope (no pull request to describe).
 */
function GitChangeDescriptionPanel({
  chat,
  scope,
  previewDescription,
  approveDescription,
  applyDescription,
  t,
}: {
  readonly chat: Chat;
  readonly scope: ChatGitChangeScope;
  readonly previewDescription: PreviewGitChangeDescriptionFn;
  readonly approveDescription: ApproveGitChangeDescriptionFn;
  readonly applyDescription: ApplyGitChangeDescriptionFn;
  readonly t: I18nTranslate;
}): ReactNode {
  const language = useLocale();
  const actions = useGitChangeDescriptionActions({
    chat,
    scope,
    language,
    previewDescription,
    approveDescription,
    applyDescription,
    t,
  });
  if (scope.pullRequestNumber === undefined) return null;
  return (
    <span
      data-testid="git-change-description-panel"
      style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6 }}
    >
      <DescriptionActionButtons actions={actions} scope={scope} t={t} />
      <DescriptionResultStatus result={actions.result} t={t} />
      {actions.error !== null ? (
        <span role="alert" className="scope-connect-error">
          {actions.error}
        </span>
      ) : null}
    </span>
  );
}

interface GitChangePillItemProps {
  readonly chat: Chat;
  readonly scope: ChatGitChangeScope;
  readonly allScopes: readonly ChatGitChangeScope[];
  readonly onDisconnect?: ((chat: Chat) => void) | undefined;
  readonly onRefreshed?: ((chat: Chat) => void) | undefined;
  readonly updateScopes: typeof updateChatGitChangeScopes;
  readonly refreshScope: typeof refreshGitChangeScope;
  readonly previewDescription: PreviewGitChangeDescriptionFn;
  readonly approveDescription: ApproveGitChangeDescriptionFn;
  readonly applyDescription: ApplyGitChangeDescriptionFn;
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
  // Owner audit b1-6 — `chat`/`allScopes` are the render's props, closed over when `runRefresh`
  // starts. A refresh is a round trip; if the chat changes underneath it (title rename, connector
  // disconnect, model switch) before the response lands, building the merged chat from those
  // stale closures would revert every field the in-flight refresh did not itself touch. This ref
  // is kept current on every render (not only at click time), so the merge below always starts
  // from the latest committed chat instead of the one captured when the button was pressed.
  const latestChatRef = useRef(chat);
  latestChatRef.current = chat;

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
      // Merge onto the freshest chat, not the one captured when the button was clicked (b1-6):
      // every field the refresh itself did not change survives whatever landed while it was in
      // flight.
      const latestChat = latestChatRef.current;
      const remaining = otherScopes(latestChat.gitChangeScopes ?? allScopes, scope.relationshipId);
      onRefreshed?.({ ...latestChat, gitChangeScopes: [...remaining, result.scope] });
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

function GitChangePillRow({
  scope,
  busy,
  disconnectRef,
  handleDisconnect,
  handleRefresh,
  t,
}: {
  readonly scope: ChatGitChangeScope;
  readonly busy: boolean;
  readonly disconnectRef: RefObject<HTMLButtonElement | null>;
  readonly handleDisconnect: () => void;
  readonly handleRefresh: () => void;
  readonly t: I18nTranslate;
}): ReactNode {
  const accessibleLabel = t("gitChangeScope.pill.accessible", { label: scope.comparisonLabel });
  return (
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
  );
}

function GitChangePillItem(props: GitChangePillItemProps): ReactNode {
  const { chat, scope, t, previewDescription, approveDescription, applyDescription } = props;
  const { busy, error, disconnectRef, handleDisconnect, handleRefresh } =
    useGitChangePillActions(props);

  return (
    <span className="scope-pill-wrap">
      <GitChangePillRow
        scope={scope}
        busy={busy}
        disconnectRef={disconnectRef}
        handleDisconnect={handleDisconnect}
        handleRefresh={handleRefresh}
        t={t}
      />
      <span className="scope-pill-detail">{countsLabel(scope, t)}</span>
      {error !== null ? (
        <span role="alert" className="scope-connect-error">
          {error}
        </span>
      ) : null}
      <GitChangeDescriptionPanel
        chat={chat}
        scope={scope}
        previewDescription={previewDescription}
        approveDescription={approveDescription}
        applyDescription={applyDescription}
        t={t}
      />
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
  previewDescription = defaultPreviewDescription,
  approveDescription = defaultApproveDescription,
  applyDescription = defaultApplyDescription,
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
          previewDescription={previewDescription}
          approveDescription={approveDescription}
          applyDescription={applyDescription}
          t={t}
        />
      ))}
    </span>
  );
}
