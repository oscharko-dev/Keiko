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
  approveGitChangeChatDescription,
  refreshGitChangeScope,
  reviewGitChangeChatDescription,
  updateChatGitChangeScopes,
} from "@/lib/api";
import { useTranslate, type I18nTranslate } from "@/lib/i18n";
import type { MessageKey } from "@/lib/i18n-messages.en";
import { restoreScopeHeaderFocus } from "./ConnectedScopePill";
import { formatUserError } from "./format-error";
import type { Chat, ChatGitChangeDescriptionStatus, ChatGitChangeScope } from "@/lib/types";
import type {
  GitChangeBlockedReason,
  GitDeliveryPrDescriptionApproveResponse,
  PrDescriptionApplicationResultWire,
} from "@/lib/api";

// #3400 final-audit F5 — the ONLY write action a Chat-connected git-change scope offers beyond
// disconnect/refresh (Frozen Product Decision 6): a normal-chat-refined description is applied
// through the SAME governed preview -> approve -> apply lifecycle GovernedPullRequestCard uses,
// never a second free-text composer (Frozen Decision 5) and never a raw browser-authored
// `ownerAndRepo` -- `applyGitChangeChatDescription` names only the chat/relationship/proposal ids,
// letting the server re-derive the repository from the SAME trusted checkout the scope was
// connected against. Approval and apply both name only the Chat-held proposal; the server
// re-derives the live repository identity and snapshot-bound service instance.
type ApproveGitChangeDescriptionFn = (
  chat: Chat,
  scope: ChatGitChangeScope,
  proposalId: string,
) => Promise<GitDeliveryPrDescriptionApproveResponse>;

type ApplyGitChangeDescriptionFn = (
  chat: Chat,
  relationshipId: string,
  proposalId: string,
) => Promise<PrDescriptionApplicationResultWire>;

export type ReviewGitChangeDescriptionFn = (
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
  readonly approveDescription?: ApproveGitChangeDescriptionFn;
  readonly applyDescription?: ApplyGitChangeDescriptionFn;
  readonly reviewDescription?: ReviewGitChangeDescriptionFn;
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

// ─── #3400 — approve/apply the exact Chat-generated artifact for a PR-bound scope ──────────────
const defaultApproveDescription: ApproveGitChangeDescriptionFn = async (chat, scope, proposalId) =>
  approveGitChangeChatDescription({
    chatId: chat.id,
    relationshipId: scope.relationshipId,
    proposalId,
  });

const defaultApplyDescription: ApplyGitChangeDescriptionFn = (chat, relationshipId, proposalId) =>
  applyGitChangeChatDescription({ chatId: chat.id, relationshipId, proposalId });

const defaultReviewDescription: ReviewGitChangeDescriptionFn = (chat, relationshipId, proposalId) =>
  reviewGitChangeChatDescription({ chatId: chat.id, relationshipId, proposalId });

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
  readonly approveDescription: ApproveGitChangeDescriptionFn;
  readonly applyDescription: ApplyGitChangeDescriptionFn;
  readonly reviewDescription: ReviewGitChangeDescriptionFn;
  readonly t: I18nTranslate;
}

interface GitChangeDescriptionActionsState {
  readonly busy: boolean;
  readonly error: string | null;
  readonly result: PrDescriptionApplicationResultWire | undefined;
  readonly canReview: boolean;
  readonly canApprove: boolean;
  readonly canApply: boolean;
  readonly runApprove: () => void;
  readonly runApply: () => void;
  readonly runReview: () => void;
}

interface DescriptionRunnerFns {
  readonly approve: ApproveGitChangeDescriptionFn;
  readonly apply: ApplyGitChangeDescriptionFn;
  readonly review: ReviewGitChangeDescriptionFn;
}

interface DescriptionRunnerState {
  readonly busy: boolean;
  // Preview stays available while stale (it is how a stale description gets refreshed); approve
  // and apply must refuse a stale proposal even if a stray click reaches the handler, not just
  // report canApprove/canApply as false for rendering (mirrors GovernedPullRequestCard's own
  // `state !== "stale"` gate on the underlying action, not only on the button's disabled state).
  readonly stale: boolean;
  readonly proposalId: string | undefined;
  readonly approvedProposalId: string | undefined;
  readonly reviewedProposalId: string | undefined;
  readonly setResult: (result: PrDescriptionApplicationResultWire) => void;
  readonly setApprovedProposalId: (id: string | undefined) => void;
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
  readonly runApprove: () => void;
  readonly runApply: () => void;
  readonly runReview: () => void;
} {
  const { chat, scope } = ctx;
  const runReview = (): void => {
    const proposalId = state.proposalId;
    if (state.busy || state.stale || proposalId === undefined) return;
    void runDescriptionAction(
      ctx,
      () => fns.review(chat, scope.relationshipId, proposalId),
      state.setResult,
    );
  };
  const runApprove = (): void => {
    const proposalId = state.proposalId;
    if (
      state.busy ||
      state.stale ||
      proposalId === undefined ||
      state.reviewedProposalId !== proposalId ||
      state.approvedProposalId !== undefined
    )
      return;
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
        state.setApprovedProposalId(undefined);
      },
    );
  };
  return { runApprove, runApply, runReview };
}

function canReviewDescription(state: {
  readonly busy: boolean;
  readonly stale: boolean;
  readonly proposalId: string | undefined;
  readonly reviewedProposalId: string | undefined;
}): boolean {
  return (
    !state.busy &&
    !state.stale &&
    state.proposalId !== undefined &&
    state.reviewedProposalId !== state.proposalId
  );
}

function canApproveDescription(state: {
  readonly busy: boolean;
  readonly stale: boolean;
  readonly proposalId: string | undefined;
  readonly reviewedProposalId: string | undefined;
  readonly approvedProposalId: string | undefined;
}): boolean {
  return (
    !state.busy &&
    !state.stale &&
    state.proposalId !== undefined &&
    state.reviewedProposalId === state.proposalId &&
    state.approvedProposalId === undefined
  );
}

function canApplyDescription(state: {
  readonly busy: boolean;
  readonly stale: boolean;
  readonly approvedProposalId: string | undefined;
}): boolean {
  return !state.busy && !state.stale && state.approvedProposalId !== undefined;
}

interface ScopedDescriptionState {
  readonly result: PrDescriptionApplicationResultWire | undefined;
  readonly approvedProposalId: string | undefined;
  readonly setResult: (result: PrDescriptionApplicationResultWire) => void;
  readonly setApprovedProposalId: (id: string | undefined) => void;
}

function useScopedDescriptionState(scope: ChatGitChangeScope): ScopedDescriptionState {
  const scopeKey = `${scope.relationshipId}:${scope.snapshotDigest}:${scope.descriptionProposalId ?? ""}:${scope.descriptionStatus}`;
  const [observed, setObserved] = useState<
    { readonly scopeKey: string; readonly result: PrDescriptionApplicationResultWire } | undefined
  >(undefined);
  const [approval, setApproval] = useState<
    { readonly scopeKey: string; readonly proposalId: string } | undefined
  >(undefined);
  return {
    result: observed?.scopeKey === scopeKey ? observed.result : undefined,
    approvedProposalId: approval?.scopeKey === scopeKey ? approval.proposalId : undefined,
    setResult: (result): void => setObserved({ scopeKey, result }),
    setApprovedProposalId: (proposalId): void =>
      setApproval(proposalId === undefined ? undefined : { scopeKey, proposalId }),
  };
}

// Extracted from GitChangePillItem so it stays under the max-lines-per-function bar; mirrors
// useGitChangePillActions' busy/error shape one level up.
function useGitChangeDescriptionActions(
  props: GitChangeDescriptionActionsProps,
): GitChangeDescriptionActionsState {
  const { chat, scope, approveDescription, applyDescription, reviewDescription, t } = props;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { result, approvedProposalId, setResult, setApprovedProposalId } =
    useScopedDescriptionState(scope);
  const ctx: DescriptionRunContext = { chat, scope, t, setBusy, setError };
  const proposalId = scope.descriptionProposalId ?? descriptionProposalId(result);
  const reviewedProposalId = descriptionProposalId(result);
  const stale = scope.descriptionStatus === "stale" || descriptionResultState(result) === "stale";
  const { runApprove, runApply, runReview } = buildDescriptionRunners(
    ctx,
    { approve: approveDescription, apply: applyDescription, review: reviewDescription },
    {
      busy,
      stale,
      proposalId,
      approvedProposalId,
      reviewedProposalId,
      setResult,
      setApprovedProposalId,
    },
  );
  const actionState = { busy, stale, proposalId, reviewedProposalId, approvedProposalId };

  return {
    busy,
    error,
    result,
    canReview: canReviewDescription(actionState),
    canApprove: canApproveDescription(actionState),
    canApply: canApplyDescription(actionState),
    runApprove,
    runApply,
    runReview,
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
        disabled={!actions.canReview}
        aria-label={t("gitChangeScope.description.previewAria", { label })}
        onClick={actions.runReview}
      >
        {t("gitChangeScope.description.preview")}
      </button>
      <button
        type="button"
        data-testid="git-change-description-approve"
        disabled={!actions.canApprove}
        aria-disabled={!actions.canApprove}
        aria-label={t("gitChangeScope.description.approveAria", { label })}
        onClick={actions.runApprove}
      >
        {t("gitChangeScope.description.approve")}
      </button>
      <button
        type="button"
        data-testid="git-change-description-apply"
        disabled={!actions.canApply}
        aria-disabled={!actions.canApply}
        aria-label={t("gitChangeScope.description.applyAria", { label })}
        onClick={actions.runApply}
      >
        {t("gitChangeScope.description.apply")}
      </button>
    </span>
  );
}

function DescriptionPreview({
  result,
  label,
  t,
}: {
  readonly result: PrDescriptionApplicationResultWire | undefined;
  readonly label: string;
  readonly t: I18nTranslate;
}): ReactNode {
  if (result?.outcome !== "preview") return null;
  return (
    <span style={{ display: "grid", gap: 4, width: "100%" }}>
      <textarea
        data-testid="git-change-description-preview-body"
        readOnly
        rows={8}
        value={result.preview.finalBody}
        aria-label={t("gitChangeScope.description.previewAria", { label })}
        style={{
          width: "100%",
          whiteSpace: "pre-wrap",
          maxHeight: 220,
          overflow: "auto",
          resize: "vertical",
          margin: 0,
        }}
      />
      <span>{result.preview.concurrencyLimitation}</span>
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
  scope,
  actions,
  t,
}: {
  readonly scope: ChatGitChangeScope;
  readonly actions: GitChangeDescriptionActionsState;
  readonly t: I18nTranslate;
}): ReactNode {
  if (scope.pullRequestNumber === undefined || scope.descriptionProposalId === undefined)
    return null;
  return (
    <span
      data-testid="git-change-description-panel"
      style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6 }}
    >
      <DescriptionActionButtons actions={actions} scope={scope} t={t} />
      <DescriptionPreview result={actions.result} label={scope.comparisonLabel} t={t} />
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
  readonly onDisconnect: ((chat: Chat) => void) | undefined;
  readonly onRefreshed: ((chat: Chat) => void) | undefined;
  readonly updateScopes: typeof updateChatGitChangeScopes;
  readonly refreshScope: typeof refreshGitChangeScope;
  readonly approveDescription: ApproveGitChangeDescriptionFn;
  readonly applyDescription: ApplyGitChangeDescriptionFn;
  readonly reviewDescription: ReviewGitChangeDescriptionFn;
  readonly t: I18nTranslate;
}

// Owner audit b1-6 — mirrors `value` on every render (not only at effect time), so an async
// callback started from an earlier render can still read the LATEST value once it resolves,
// instead of the one closed over when it started.
function useLatestRef<T>(value: T): RefObject<T> {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

function otherScopes(
  allScopes: readonly ChatGitChangeScope[],
  relationshipId: string,
): readonly ChatGitChangeScope[] {
  return allScopes.filter((entry) => entry.relationshipId !== relationshipId);
}

// Shared busy/error bracketing for both pill actions below — keeps `useGitChangePillActions`
// itself under the max-lines-per-function bar and removes the duplicated try/setBusy/setError
// scaffolding the two actions used to repeat.
async function runGuardedPillAction(
  setBusy: (busy: boolean) => void,
  setError: (error: string | null) => void,
  formatError: (error: unknown, t: I18nTranslate) => string,
  t: I18nTranslate,
  action: () => Promise<void>,
): Promise<void> {
  setError(null);
  setBusy(true);
  try {
    await action();
  } catch (error_) {
    setError(formatError(error_, t));
  } finally {
    setBusy(false);
  }
}

// Owner audit b1-6 — merges onto the freshest chat, not the one captured when the refresh button
// was clicked: every field the refresh itself did not change survives whatever landed (a title
// rename, a connector disconnect, a model switch) while the round trip was in flight.
function mergeRefreshedChat(
  latestChat: Chat,
  allScopes: readonly ChatGitChangeScope[],
  relationshipId: string,
  resultScope: ChatGitChangeScope,
): Chat {
  const remaining = otherScopes(latestChat.gitChangeScopes ?? allScopes, relationshipId);
  return { ...latestChat, gitChangeScopes: [...remaining, resultScope] };
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
  const latestChatRef = useLatestRef(chat);

  async function runDisconnect(): Promise<void> {
    await runGuardedPillAction(setBusy, setError, formatDisconnectErrorMessage, t, async () => {
      // Capture the stable header ancestor before this pill unmounts (mirrors ConnectedScopePill).
      const header = disconnectRef.current?.closest(".chat-scope-header");
      const remaining = otherScopes(allScopes, scope.relationshipId);
      const response = await updateScopes(chat.id, remaining.length > 0 ? remaining : null);
      onDisconnect?.(response.chat);
      restoreScopeHeaderFocus(header);
    });
  }

  async function runRefresh(): Promise<void> {
    await runGuardedPillAction(setBusy, setError, formatRefreshErrorMessage, t, async () => {
      const result = await refreshScope(chat.id, scope.relationshipId);
      if (result.status === "blocked") {
        setError(gitChangeBlockedReasonMessage(result.reason, t));
        return;
      }
      onRefreshed?.(
        mergeRefreshedChat(latestChatRef.current, allScopes, scope.relationshipId, result.scope),
      );
    });
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
  status,
  busy,
  disconnectRef,
  handleDisconnect,
  handleRefresh,
  t,
}: {
  readonly scope: ChatGitChangeScope;
  readonly status: ChatGitChangeDescriptionStatus;
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
      <span className={STATUS_BADGE_CLASS[status]}>{t(STATUS_LABEL_KEY[status])}</span>
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
  const { chat, scope, t, approveDescription, applyDescription, reviewDescription } = props;
  const { busy, error, disconnectRef, handleDisconnect, handleRefresh } =
    useGitChangePillActions(props);
  const descriptionActions = useGitChangeDescriptionActions({
    chat,
    scope,
    approveDescription,
    applyDescription,
    reviewDescription,
    t,
  });
  const displayedStatus =
    descriptionResultState(descriptionActions.result) ?? scope.descriptionStatus;

  return (
    <span className="scope-pill-wrap">
      <GitChangePillRow
        scope={scope}
        status={displayedStatus}
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
      <GitChangeDescriptionPanel scope={scope} actions={descriptionActions} t={t} />
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

// GEN-UI-STATE-001 (WCAG 4.1.3): ONE always-mounted sr-only polite region announces a genuine
// binding change (connect / disconnect / stale transition). It stays empty until the signature
// actually changes after mount, so a chat switch or routine re-render never re-announces on its
// own.
//
// B5-3 (epic #3384 audit): `GitChangeScopePill` is never remounted on a chat switch — an
// already-mounted chat window can be rebound to a different existing chat in place
// (SelectionAwareWorkspaceHosts.tsx's `updateCfg({ chatId })` handoff) — so tracking only the
// signature let a landing chat with a different scope signature announce as though the SAME chat
// had just gained/lost a scope. `prevChatIdRef` makes that reset silent: a changed `chatId`
// re-baselines both refs without calling `setAnnouncement`, so only a genuine signature change
// WITHIN one chat announces.
function useGitChangeScopeAnnouncement(
  chatId: string,
  signature: string,
  isEmpty: boolean,
  hasStale: boolean,
  t: I18nTranslate,
): string {
  const [announcement, setAnnouncement] = useState("");
  const prevSignatureRef = useRef(signature);
  const prevChatIdRef = useRef(chatId);
  useEffect(() => {
    if (prevChatIdRef.current !== chatId) {
      prevChatIdRef.current = chatId;
      prevSignatureRef.current = signature;
      return;
    }
    if (prevSignatureRef.current !== signature) {
      prevSignatureRef.current = signature;
      setAnnouncement(scopesAnnouncement(isEmpty, hasStale, t));
    }
  }, [chatId, signature, isEmpty, hasStale, t]);
  return announcement;
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
  approveDescription = defaultApproveDescription,
  applyDescription = defaultApplyDescription,
  reviewDescription = defaultReviewDescription,
}: GitChangeScopePillProps): ReactNode {
  const t = useTranslate();
  const scopes = chat.gitChangeScopes ?? [];
  const signature = scopesSignature(scopes);
  const isEmpty = scopes.length === 0;
  const hasStale = scopes.some((scope) => scope.descriptionStatus === "stale");
  // Deps are the primitives the announcement needs, never the `scopes` array itself (a fresh
  // `[]` reference every render for an unbound chat would otherwise re-fire on every render).
  const announcement = useGitChangeScopeAnnouncement(chat.id, signature, isEmpty, hasStale, t);
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
          approveDescription={approveDescription}
          applyDescription={applyDescription}
          reviewDescription={reviewDescription}
          t={t}
        />
      ))}
    </span>
  );
}
