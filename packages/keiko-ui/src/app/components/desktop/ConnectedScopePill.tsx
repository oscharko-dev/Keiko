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

import { useRef, useState, type ReactNode } from "react";
import { updateChatConnectedScopes } from "@/lib/api";
import { formatUserError } from "./format-error";
import type { GroundedAnswerContextPackSummary } from "@/lib/types";
import { effectiveScopes } from "./hooks/workspaceActions";
import type { Chat, ChatConnectedScope } from "@/lib/types";

export interface ConnectedScopePillProps {
  readonly chat: Chat;
  readonly onDisconnect?: (chat: Chat) => void;
  readonly lastGroundedBudgetStatus?: LastGroundedBudgetStatus | undefined;
  // Injectable wire seam for tests. Defaults to the real BFF helper.
  readonly updateScopes?: typeof updateChatConnectedScopes;
}

type GroundedBudgetPressure = "low" | "moderate" | "high" | "exceeded";

const PRESSURE_LABEL: Readonly<Record<GroundedBudgetPressure, string>> = {
  low: "Low",
  moderate: "Moderate",
  high: "High",
  exceeded: "Exceeded",
};

const PRESSURE_CLASS: Readonly<Record<GroundedBudgetPressure, string>> = {
  low: "cmp-budget-badge cmp-budget-badge-low",
  moderate: "cmp-budget-badge cmp-budget-badge-moderate",
  high: "cmp-budget-badge cmp-budget-badge-high",
  exceeded: "cmp-budget-badge cmp-budget-badge-exceeded",
};

export interface LastGroundedBudgetStatus {
  readonly pressure: GroundedBudgetPressure;
  readonly label: string;
  readonly summary: string;
}

function formatTokenCount(tokens: number): string {
  if (tokens >= 1000) {
    return `${(tokens / 1000).toFixed(1)}k`;
  }
  return tokens.toString();
}

function finiteRatio(used: number, budget: number): number | undefined {
  if (!Number.isFinite(budget) || budget <= 0) {
    return undefined;
  }
  return used / budget;
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
  const pressure: GroundedBudgetPressure =
    maxRatio > 1 ? "exceeded" : maxRatio >= 0.85 ? "high" : maxRatio >= 0.6 ? "moderate" : "low";
  const totalTokens = usage.modelInputTokens + usage.modelOutputTokens;
  return {
    pressure,
    label: PRESSURE_LABEL[pressure],
    summary: `Last grounded run: ${formatTokenCount(totalTokens)} tokens, ${String(usage.filesRead)} files`,
  };
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
  // uiux-fix F041 (C171) — message first, machine code as trailing detail.
  return formatUserError(error, "Unable to disconnect scope.");
}

// uiux-fix F010 (C169, WCAG 2.4.3): after a successful disconnect the focused × button
// unmounts together with its pill and keyboard focus silently drops to <body>. Re-anchor
// focus on the next remaining disconnect button inside the scope header — or, when the
// last pill is gone, on any other control left in the header (e.g. the grounding control).
// The header element must be captured BEFORE the pill unmounts. Shared with
// ConnectorScopePill (same pattern, same header).
export function restoreScopeHeaderFocus(header: Element | null | undefined): void {
  if (header === null || header === undefined) return;
  // Defer until React has committed the unmount that follows onDisconnect.
  window.setTimeout(() => {
    const next =
      header.querySelector<HTMLElement>(".scope-pill-disconnect") ??
      header.querySelector<HTMLElement>("button, select, input, [href], [tabindex]");
    next?.focus();
  }, 0);
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
  const disconnectRef = useRef<HTMLButtonElement | null>(null);
  const label = pillLabel(scope);
  // uiux-fix F010 (C174): the basename label collides for same-named folders
  // (~/kunde-a/docs vs ~/kunde-b/docs) — surface the full path via title so it
  // stays reachable on both the label and the disconnect target.
  const fullPath = scope.root ?? scope.relativePaths[0];
  const accessibleLabel = fullPath === undefined ? label : `${label} (${fullPath})`;

  async function handleDisconnect(): Promise<void> {
    if (busy) return;
    setError(null);
    setBusy(true);
    // Capture the stable header ancestor before this pill unmounts (C169).
    const header = disconnectRef.current?.closest(".chat-scope-header");
    try {
      // Remove THIS source by position; clear the binding entirely when it was the last one.
      const remaining = allScopes.filter((_, i) => i !== index);
      const response = await updateScopes(chat.id, remaining.length > 0 ? remaining : null);
      onDisconnect?.(response.chat);
      restoreScopeHeaderFocus(header);
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
        <span role="status" aria-live="polite" aria-label={accessibleLabel} title={fullPath}>
          {label}
        </span>
        {/* aria-disabled (not native disabled) while busy: native disabled drops keyboard
            focus mid-request (C169); the handleDisconnect busy guard blocks re-activation. */}
        <button
          type="button"
          ref={disconnectRef}
          className="scope-pill-disconnect"
          aria-disabled={busy}
          aria-label={`Disconnect ${accessibleLabel} from chat`}
          title={
            fullPath === undefined
              ? `Disconnect ${label} from chat`
              : `Disconnect ${label} from chat (${fullPath})`
          }
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
  lastGroundedBudgetStatus,
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
      {lastGroundedBudgetStatus !== undefined ? (
        <span className="scope-pill-wrap">
          <span
            className="scope-pill-detail"
            style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}
          >
            <span className={PRESSURE_CLASS[lastGroundedBudgetStatus.pressure]}>
              {lastGroundedBudgetStatus.label}
            </span>
            <span>{lastGroundedBudgetStatus.summary}</span>
          </span>
        </span>
      ) : null}
    </span>
  );
}
