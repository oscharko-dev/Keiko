"use client";

// Issue #184 — small connector button that binds a Files-window selection (one or more
// workspace-relative paths) onto a chat via PATCH /api/chats. The button is purely a wire
// trigger: it does not own the file selection (the parent does) and it does not own the
// resulting Chat (the parent's onConnected callback feeds the cached store updater).
//
// WCAG 2.2 AA: native <button type="button">, accessible label that names the action, focus-
// visible ring (focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent), min
// 24×24 target via min-w/min-h utilities, disabled state announced via aria-disabled.

import { useId, useState, type ReactNode } from "react";
import { updateChatConnectedScopes } from "@/lib/api";
import { formatUserError } from "./format-error";
import type { Chat, ChatConnectedScope, SelectedScopeKind } from "@/lib/types";
import { effectiveScopes } from "./hooks/workspaceActions";

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

export function ScopeConnectButton({
  chatId,
  scopeKind,
  scopeRoot,
  currentScopeKind,
  candidateRelativePaths,
  onConnected,
  chat,
  updateScope = updateChatConnectedScopes,
  now = Date.now,
  targetName,
}: ScopeConnectButtonProps): ReactNode {
  const hintId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const empty = scopeKind !== "workspace-root" && candidateRelativePaths.length === 0;
  const disabled = empty || busy;
  const label = actionLabel(scopeKind, currentScopeKind);
  // Distinguishable accessible name per target (WCAG 2.4.6, audit C214); the
  // visible label stays generic — the row itself shows the folder name.
  const accessibleLabel = targetName !== undefined ? `${label}: ${targetName}` : label;
  const tooltip = empty ? "Select a folder or file first" : accessibleLabel;

  async function handleClick(): Promise<void> {
    if (disabled) return;
    setError(null);
    setBusy(true);
    try {
      // Epic #532 / #189 — additive bind: append the new scope to the existing list
      // so connectedScopes grows (N+1 model) and localKnowledgeScopes is never touched.
      const newScope: ChatConnectedScope = {
        kind: scopeKind,
        relativePaths: [...candidateRelativePaths],
        connectedAtMs: now(),
        ...(scopeRoot !== undefined && scopeRoot.length > 0 ? { root: scopeRoot } : {}),
      };
      const current = effectiveScopes(chat ?? {});
      // De-dupe: replace an existing scope with the same kind+root+paths rather than duplicating.
      const filtered = current.filter(
        (s) =>
          !(
            s.kind === newScope.kind &&
            (s.root ?? undefined) === (newScope.root ?? undefined) &&
            JSON.stringify(s.relativePaths) === JSON.stringify(newScope.relativePaths)
          ),
      );
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
  // button is empty-state. Native `disabled` removes the button from the focus order, so the
  // hint text ("Select a folder or file first") becomes unreachable for keyboard users
  // (Copilot PR #254 finding). aria-disabled keeps the button focusable so the screen reader
  // announces the action AND the disabled state, while the onClick guard short-circuits
  // activation. Loading (`busy`) is still a native disabled because the same button is the
  // one in flight — activation while a request is in flight is genuinely incoherent.
  const ariaDisabled = empty;
  return (
    <>
      <button
        type="button"
        className="scope-connect-btn"
        disabled={busy}
        aria-disabled={ariaDisabled}
        aria-label={empty ? "Connect to chat (no selection)" : accessibleLabel}
        aria-describedby={empty ? hintId : undefined}
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
      {empty ? (
        <span id={hintId} className="scope-connect-hint">
          Select a folder or file first.
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
