"use client";

// Issue #184 — small connector button that binds a Files-window selection (one or more
// workspace-relative paths) onto a chat via PATCH /api/chats. The button is purely a wire
// trigger: it does not own the file selection (the parent does) and it does not own the
// resulting Chat (the parent's onConnected callback feeds the cached store updater).
//
// WCAG 2.2 AA: native <button type="button">, accessible label that names the action, focus-
// visible ring (focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent), min
// 24×24 target via min-w/min-h utilities, disabled state announced via aria-disabled.

import { useEffect, useId, useState, type ReactNode } from "react";
import { fetchConfig, updateChatConnectedScopes } from "@/lib/api";
import { formatUserError } from "./format-error";
import { DEFAULT_GROUNDING_LIMITS } from "@/lib/types";
import type { Chat, ChatConnectedScope, GroundingLimits, SelectedScopeKind } from "@/lib/types";
import {
  effectiveLocalKnowledgeScopes,
  effectiveScopes,
  totalSourceCap,
} from "./hooks/workspaceActions";

export interface ScopeConnectButtonProps {
  readonly chatId: string;
  readonly scopeKind: SelectedScopeKind;
  readonly scopeRoot?: string | undefined;
  // The chat's currently-bound kind (used to render the "Update connected scope" label when the
  // chat already has a binding). Repository-root bindings intentionally have an empty path array.
  readonly currentScopeKind: SelectedScopeKind | undefined;
  // The Files-window selection the button will bind on click. The empty case disables the
  // button: the spec calls out "Select a folder or file first" so the user has a hint.
  readonly candidateRelativePaths: readonly string[];
  readonly onConnected?: (chat: Chat) => void;
  // The active chat object, used to read the current connectedScopes list so the bind is
  // additive (N+1 model). When omitted the button connects a fresh single-scope list.
  readonly chat?: Chat;
  // Injectable wire seam for tests. Defaults to the real BFF helper.
  readonly updateScope?: typeof updateChatConnectedScopes;
  // Injectable config seam for tests (Release 0.2.0 — operator-tuned source limits for the
  // at-limit affordance). Defaults to the real /api/config helper.
  readonly limitsSource?: typeof fetchConfig;
  // Injectable clock seam for tests. Defaults to Date.now.
  readonly now?: () => number;
  // Human-readable name of the bind target (e.g. the folder name). Folded into the
  // accessible name so multiple pills in the Files tree are distinguishable for
  // screen readers (audit C214 — six identical "Update connected scope" names).
  // `| undefined` keeps explicit pass-through of optional values legal under
  // exactOptionalPropertyTypes (FilesWidget passes `targetName?: string` straight in).
  readonly targetName?: string | undefined;
}

function actionLabel(
  scopeKind: SelectedScopeKind,
  currentScopeKind: SelectedScopeKind | undefined,
): string {
  if (currentScopeKind !== undefined) return "Update connected scope";
  if (scopeKind === "workspace-root") return "Connect repository";
  if (scopeKind === "directory") return "Connect folder";
  return "Connect to chat";
}

function formatErrorMessage(error: unknown): string {
  // uiux-fix F041 (C171) — message first, machine code as trailing detail.
  return formatUserError(error, "Unable to connect scope.");
}

function sameRelativePaths(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((path, index) => path === right[index]);
}

function sameScopeIdentity(left: ChatConnectedScope, right: ChatConnectedScope): boolean {
  return (
    left.kind === right.kind &&
    (left.root ?? null) === (right.root ?? null) &&
    sameRelativePaths(left.relativePaths, right.relativePaths)
  );
}

export function ScopeConnectButton({
  chatId,
  scopeKind,
  scopeRoot,
  currentScopeKind,
  candidateRelativePaths,
  onConnected,
  chat,
  updateScope = updateChatConnectedScopes,
  limitsSource = fetchConfig,
  now = Date.now,
  targetName,
}: ScopeConnectButtonProps): ReactNode {
  const hintId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Release 0.2.0 — operator-tuned source caps for the at-limit affordance. Compile-time
  // defaults apply until /api/config resolves (same pattern as AppShell).
  const [groundingLimits, setGroundingLimits] = useState<GroundingLimits>(DEFAULT_GROUNDING_LIMITS);
  useEffect(() => {
    let cancelled = false;
    limitsSource()
      .then((res) => {
        if (!cancelled) setGroundingLimits(res.effectiveGroundingLimits);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [limitsSource]);
  const empty = scopeKind !== "workspace-root" && candidateRelativePaths.length === 0;
  // Epic #532 made connectedScopes the canonical source list. Some call sites
  // still pass the legacy connectedScope kind for back-compat, so derive from
  // the chat when available to keep #184's "already connected" affordance true
  // for plural-only chats as well.
  const currentScopes = effectiveScopes(chat ?? {});
  const candidateScope: ChatConnectedScope = {
    kind: scopeKind,
    relativePaths: [...candidateRelativePaths],
    connectedAtMs: 0,
    ...(scopeRoot !== undefined && scopeRoot.length > 0 ? { root: scopeRoot } : {}),
  };
  // Release 0.2.0 — at-limit affordance: clicking would ADD a source (not update an existing
  // identity) while the chat is at the combined or the per-list cap. Mirrors the store-side
  // validateTotalSourceCap so the user learns about the limit BEFORE a doomed round-trip.
  const isUpdate = currentScopes.some((s) => sameScopeIdentity(s, candidateScope));
  const connectedTotal = currentScopes.length + effectiveLocalKnowledgeScopes(chat ?? {}).length;
  const cap = totalSourceCap(groundingLimits);
  const atLimit =
    !isUpdate &&
    (connectedTotal >= cap || currentScopes.length >= groundingLimits.maxConnectedSources);
  const limitHint = `Source limit reached (${String(connectedTotal)}/${String(cap)}). Disconnect a source first.`;
  const disabled = empty || busy || atLimit;
  const existingScopeKind = currentScopeKind ?? currentScopes[0]?.kind;
  const label = actionLabel(scopeKind, existingScopeKind);
  // Distinguishable accessible name per target (WCAG 2.4.6, audit C214); the
  // visible label stays generic — the row itself shows the folder name.
  const accessibleLabel = targetName !== undefined ? `${label}: ${targetName}` : label;
  const tooltip = empty ? "Select a folder or file first" : atLimit ? limitHint : accessibleLabel;

  async function handleClick(): Promise<void> {
    if (disabled) return;
    setError(null);
    setBusy(true);
    try {
      // Epic #532 / #189 — additive bind: append the new scope to the existing list
      // so connectedScopes grows (N+1 model) and localKnowledgeScopes is never touched.
      const newScope: ChatConnectedScope = { ...candidateScope, connectedAtMs: now() };
      // De-dupe by full scope identity: root is part of the key for external-folder binds.
      const filtered = currentScopes.filter((s) => !sameScopeIdentity(s, newScope));
      const next = [...filtered, newScope];
      const response = await updateScope(chatId, next);
      onConnected?.(response.chat);
    } catch (caught) {
      setError(formatErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  // Use aria-disabled + onClick guard rather than the native `disabled` attribute when the
  // button is empty-state or at the source limit. Native `disabled` removes the button from
  // the focus order, so the hint text ("Select a folder or file first" / the limit hint)
  // becomes unreachable for keyboard users (Copilot PR #254 finding). aria-disabled keeps the
  // button focusable so the screen reader announces the action AND the disabled state, while
  // the onClick guard short-circuits activation. Loading (`busy`) is still a native disabled
  // because the same button is the one in flight — activation while a request is in flight is
  // genuinely incoherent.
  const ariaDisabled = empty || atLimit;
  return (
    <>
      <button
        type="button"
        className="scope-connect-btn"
        disabled={busy}
        aria-disabled={ariaDisabled}
        aria-label={empty ? "Connect to chat (no selection)" : accessibleLabel}
        aria-describedby={ariaDisabled ? hintId : undefined}
        title={tooltip}
        onClick={() => {
          if (ariaDisabled) {
            return;
          }
          void handleClick();
        }}
      >
        {busy ? "Connecting…" : label}
      </button>
      {ariaDisabled ? (
        <span id={hintId} className="scope-connect-hint">
          {empty ? "Select a folder or file first." : limitHint}
        </span>
      ) : null}
      {error !== null ? (
        <span role="alert" className="scope-connect-error">
          {error}
        </span>
      ) : null}
    </>
  );
}
