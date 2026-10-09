"use client";

import { replaceGroundingScopeList } from "@/lib/chat-grounding-mutation";

// Issue #184 / Epic #532 — chat-header connected-scope pills. A chat may bind 1+N sources
// (connectedScopes); this renders ONE pill per connected source and renders nothing when the chat
// has no binding so the header stays clean. Each pill's trailing × detaches just THAT source via
// PATCH /api/chats with the remaining `connectedScopes` array (or null when it was the last one).
//
// Accessibility: each pill body is `role="status" aria-live="polite"` so screen readers announce a
// binding change. The × is a real <button type="button"> whose aria-label names the specific source
// it removes, with a 24×24 minimum target. Color contrast uses --ink-inverse on --accent
// (ink-inverse #1a1e23 on accent #4EBA87 = 6.94:1, ≥4.5:1).

import { useEffect, useRef, useState, type ReactNode } from "react";
import { updateChatConnectedScopes } from "@/lib/api";
import { useTranslate, type I18nTranslate } from "@/lib/i18n";
import { formatUserError } from "./format-error";
import type { Chat, ChatConnectedScope, GroundedAnswerContextPackSummary } from "@/lib/types";
import { useScopePillError, ScopePillError, emptyScopePill } from "./hooks/useScopePillError";
import { effectiveScopes } from "./hooks/workspaceActions";
import {
  connectedScopeBoundary,
  connectedScopeFullPath,
  connectedScopeLabel,
  connectedScopeSignature,
} from "./connectedScopePresentation";

export interface ConnectedScopePillProps {
  readonly chat: Chat;
  readonly onDisconnect?: (chat: Chat) => void;
  readonly lastGroundedBudgetStatus?: LastGroundedBudgetStatus | undefined;
  // Injectable wire seam for tests. Defaults to the real BFF helper.
  readonly updateScopes?: typeof updateChatConnectedScopes;
}

type GroundedBudgetPressure = "low" | "moderate" | "high" | "exceeded";

const PRESSURE_CLASS: Readonly<Record<GroundedBudgetPressure, string>> = {
  low: "cmp-budget-badge cmp-budget-badge-low",
  moderate: "cmp-budget-badge cmp-budget-badge-moderate",
  high: "cmp-budget-badge cmp-budget-badge-high",
  exceeded: "cmp-budget-badge cmp-budget-badge-exceeded",
};

// Counts and a closed pressure only: the pill renders them in the user's language (the badge and
// the summary are catalog entries), so no English text is carried here.
export interface LastGroundedBudgetStatus {
  readonly pressure: GroundedBudgetPressure;
  readonly totalTokens: number;
  readonly filesRead: number;
}

function formatTokenCount(tokens: number): string {
  if (tokens >= 1000) {
    return `${(tokens / 1000).toFixed(1)}k`;
  }
  return tokens.toString();
}

function finiteRatio(used: number, budget: number | null): number | undefined {
  if (budget === null || !Number.isFinite(budget) || budget <= 0) {
    return undefined;
  }
  return used / budget;
}

function pressureFromRatio(maxRatio: number): GroundedBudgetPressure {
  if (maxRatio > 1) return "exceeded";
  if (maxRatio >= 0.85) return "high";
  if (maxRatio >= 0.6) return "moderate";
  return "low";
}

export function buildLastGroundedBudgetStatus(
  contextPack: GroundedAnswerContextPackSummary | undefined,
): LastGroundedBudgetStatus | undefined {
  if (contextPack === undefined) {
    return undefined;
  }
  const { usage, budget } = contextPack;
  const ratios = [
    finiteRatio(usage.searchCalls, budget.searchCallsMax),
    finiteRatio(usage.filesRead, budget.filesReadMax),
    finiteRatio(usage.excerptBytes, budget.excerptBytesMax),
    finiteRatio(usage.modelInputTokens, budget.modelInputTokensMax),
    finiteRatio(usage.modelOutputTokens, budget.modelOutputTokensMax),
    finiteRatio(contextPack.elapsedMs, budget.elapsedMsMax),
    finiteRatio(usage.rerankCalls, budget.rerankCallsMax),
  ].filter((ratio): ratio is number => ratio !== undefined);
  const maxRatio = ratios.length === 0 ? 0 : Math.max(...ratios);
  const pressure: GroundedBudgetPressure = pressureFromRatio(maxRatio);
  const totalTokens = usage.modelInputTokens + usage.modelOutputTokens;
  return { pressure, totalTokens, filesRead: usage.filesRead };
}

export { stripTrailingSlashes } from "./connectedScopePresentation";

function formatErrorMessage(error: unknown, t: I18nTranslate): string {
  // uiux-fix F041 (C171) — message first, machine code as trailing detail.
  return formatUserError(error, t("scope.disconnect.error"));
}

// uiux-fix F010 (C169, WCAG 2.4.3): after a successful disconnect the focused × button
// unmounts together with its pill and keyboard focus silently drops to <body>. Re-anchor
// focus on the next remaining disconnect button inside the scope header — or, when the
// last pill is gone, on any other control left in the header (e.g. the grounding control).
// The header element must be captured BEFORE the pill unmounts. Shared with
// ConnectorScopePill (same pattern, same header).
export function restoreScopeHeaderFocus(
  header: Element | null | undefined,
  previous?: HTMLElement | null,
): void {
  if (header === null || header === undefined) return;
  // Defer until React has committed the unmount that follows onDisconnect.
  window.setTimeout(() => {
    if (previous?.isConnected === true) return;
    const next =
      header.querySelector<HTMLElement>(".scope-pill-disconnect") ??
      header.querySelector<HTMLElement>("button, select, input, [href], [tabindex]");
    next?.focus();
  }, 0);
}

interface ScopePillItemProps {
  readonly chat: Chat;
  readonly scope: ChatConnectedScope;
  readonly allScopes: readonly ChatConnectedScope[];
  readonly onDisconnect?: ((chat: Chat) => void) | undefined;
  readonly updateScopes: typeof updateChatConnectedScopes;
  readonly t: I18nTranslate;
  readonly setError: (message: string | null) => void;
}

function ScopePillItem({
  chat,
  scope,
  allScopes,
  onDisconnect,
  updateScopes,
  setError,
  t,
}: ScopePillItemProps): ReactNode {
  const [busy, setBusy] = useState(false);
  const disconnectRef = useRef<HTMLButtonElement | null>(null);
  const label = connectedScopeLabel(scope, t);
  // uiux-fix F010 (C174): the basename label collides for same-named folders
  // (~/kunde-a/docs vs ~/kunde-b/docs) — surface the full path via title so it
  // stays reachable on both the label and the disconnect target.
  const fullPath = connectedScopeFullPath(scope);
  const accessibleLabel =
    fullPath === undefined ? label : t("scope.pill.accessibleWithPath", { label, path: fullPath });

  async function handleDisconnect(): Promise<void> {
    if (busy) return;
    setError(null);
    setBusy(true);
    // Capture the stable header ancestor before this pill unmounts (C169).
    const button = disconnectRef.current;
    const header = button?.closest(".chat-scope-header");
    try {
      // The selected object belongs to this versioned snapshot; display reordering cannot retarget it.
      const remaining = allScopes.filter((candidate) => candidate !== scope);
      const response = await replaceGroundingScopeList(
        chat,
        remaining.length > 0 ? remaining : null,
        updateScopes,
        onDisconnect,
      );
      onDisconnect?.(response.chat);
    } catch (error_) {
      setError(formatErrorMessage(error_, t));
    } finally {
      setBusy(false);
      restoreScopeHeaderFocus(header, button);
    }
  }

  // GEN-UI-STATE-001 (WCAG 4.1.3): the visible label is a PLAIN span — it must NOT be a live region.
  // A per-pill `role="status" aria-live="polite"` re-announced the (unchanged) label on every routine
  // re-render / chat switch, producing announcement bursts. The genuine binding-change announcement
  // lives in a single always-mounted sr-only polite region at the group level (ConnectedScopePill),
  // which fires only when the connected-scope set actually changes. The aria-label still carries the
  // disambiguated accessible name and the title still carries the full path for the tooltip.
  return (
    <span className="scope-pill-wrap">
      <span className="scope-pill">
        <span aria-hidden="true">●</span>
        <span aria-label={accessibleLabel} title={fullPath}>
          {label}
        </span>
        {/* aria-disabled (not native disabled) while busy: native disabled drops keyboard
            focus mid-request (C169); the handleDisconnect busy guard blocks re-activation. */}
        <button
          type="button"
          ref={disconnectRef}
          className="scope-pill-disconnect"
          aria-disabled={busy}
          aria-label={t("scope.disconnect.aria", { label: accessibleLabel })}
          title={
            fullPath === undefined
              ? t("scope.disconnect.title", { label })
              : t("scope.disconnect.titleWithPath", { label, path: fullPath })
          }
          onClick={() => {
            void handleDisconnect();
          }}
        >
          {/* The visible × is decorative; the aria-label carries the action's meaning. */}
          <span aria-hidden="true">×</span>
        </button>
      </span>
      <span className="scope-pill-detail">{connectedScopeBoundary(scope, t)}</span>
    </span>
  );
}

function pressureLabel(pressure: GroundedBudgetPressure, t: I18nTranslate): string {
  if (pressure === "low") return t("scope.budget.pressure.low");
  if (pressure === "moderate") return t("scope.budget.pressure.moderate");
  if (pressure === "high") return t("scope.budget.pressure.high");
  return t("scope.budget.pressure.exceeded");
}

function scopeUpdatedAnnouncement(count: number, t: I18nTranslate): string {
  return count === 1
    ? t("scope.announcement.updated.one")
    : t("scope.announcement.updated.many", { count });
}

export function ConnectedScopePill({
  chat,
  onDisconnect,
  lastGroundedBudgetStatus,
  updateScopes = updateChatConnectedScopes,
}: ConnectedScopePillProps): ReactNode {
  const t = useTranslate();
  const { error, setError } = useScopePillError(chat);
  const scopes = effectiveScopes(chat);
  const signature = connectedScopeSignature(scopes);

  // GEN-UI-STATE-001 (WCAG 4.1.3): ONE always-mounted sr-only polite region announces a genuine
  // binding change (connect / disconnect). It stays empty until the scope signature actually changes
  // after mount, so switching to a chat with the same-shaped scopes — or any other routine re-render —
  // never fires a stale announcement burst. Mirrors WorkflowHandoff's prevRef/useEffect guard.
  const [announcement, setAnnouncement] = useState("");
  const prevSignatureRef = useRef(signature);
  useEffect(() => {
    if (prevSignatureRef.current !== signature) {
      prevSignatureRef.current = signature;
      setAnnouncement(
        scopes.length === 0
          ? t("scope.announcement.removed")
          : scopeUpdatedAnnouncement(scopes.length, t),
      );
    }
  }, [signature, scopes.length, t]);

  const announcer = (
    <span
      className="sr-only"
      role="status"
      aria-live="polite"
      data-testid="connected-scope-announcer"
    >
      {announcement}
    </span>
  );

  // Keep the header clean when the chat never had a binding: with no scopes AND no pending
  // announcement, render nothing (preserves the documented "renders nothing" contract). After the
  // last source is disconnected the effect populates `announcement`, so the polite region re-mounts
  // with content and the removal is still announced.
  if (scopes.length === 0) {
    return emptyScopePill(announcement, announcer, error);
  }
  return (
    <span className="scope-pill-group">
      {announcer}
      <ScopePillError error={error} />
      {scopes.map((scope, index) => (
        <ScopePillItem
          key={`${scope.root ?? scope.kind}-${String(scope.connectedAtMs)}-${String(index)}`}
          chat={chat}
          scope={scope}
          allScopes={scopes}
          onDisconnect={onDisconnect}
          updateScopes={updateScopes}
          setError={setError}
          t={t}
        />
      ))}
      {lastGroundedBudgetStatus !== undefined ? (
        <span className="scope-pill-wrap">
          <span
            className="scope-pill-detail"
            style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}
          >
            <span className={PRESSURE_CLASS[lastGroundedBudgetStatus.pressure]}>
              {pressureLabel(lastGroundedBudgetStatus.pressure, t)}
            </span>
            <span>
              {t("scope.budget.summary", {
                tokens: formatTokenCount(lastGroundedBudgetStatus.totalTokens),
                files: lastGroundedBudgetStatus.filesRead,
              })}
            </span>
          </span>
        </span>
      ) : null}
    </span>
  );
}
