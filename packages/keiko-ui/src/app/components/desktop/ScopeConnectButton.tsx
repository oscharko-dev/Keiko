"use client";

// Issue #184 — small connector button that binds a Files-window selection (one or more
// workspace-relative paths) onto a chat via PATCH /api/chats. The button is purely a wire
// trigger: it does not own the file selection (the parent does) and it does not own the
// resulting Chat (the parent's onConnected callback feeds the cached store updater).
//
// WCAG 2.2 AA: native <button type="button">, accessible label that names the action, focus-
// visible ring (focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent), min
// 24×24 target via min-w/min-h utilities, disabled state announced via aria-disabled.

import { useState, type ReactNode } from "react";
import { ApiError, updateChatConnectedScope } from "@/lib/api";
import type { Chat } from "@/lib/types";

export interface ScopeConnectButtonProps {
  readonly chatId: string;
  // The chat's currently-bound paths (used to render the "Update connected scope" label when
  // the chat already has a binding). An empty array means "no binding yet".
  readonly currentScopePaths: readonly string[];
  // The Files-window selection the button will bind on click. The empty case disables the
  // button: the spec calls out "Select a folder or file first" so the user has a hint.
  readonly candidateRelativePaths: readonly string[];
  readonly onConnected?: (chat: Chat) => void;
  // Injectable wire seam for tests. Defaults to the real BFF helper.
  readonly updateScope?: typeof updateChatConnectedScope;
  // Injectable clock seam for tests. Defaults to Date.now.
  readonly now?: () => number;
}

function actionLabel(currentScopePaths: readonly string[]): string {
  return currentScopePaths.length > 0 ? "Update connected scope" : "Connect to chat";
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof ApiError) return `${error.code}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return "Unable to connect scope.";
}

export function ScopeConnectButton({
  chatId,
  currentScopePaths,
  candidateRelativePaths,
  onConnected,
  updateScope = updateChatConnectedScope,
  now = Date.now,
}: ScopeConnectButtonProps): ReactNode {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const empty = candidateRelativePaths.length === 0;
  const disabled = empty || busy;
  const label = actionLabel(currentScopePaths);
  const tooltip = empty ? "Select a folder or file first" : label;

  async function handleClick(): Promise<void> {
    if (disabled) return;
    setError(null);
    setBusy(true);
    try {
      const response = await updateScope(chatId, {
        relativePaths: candidateRelativePaths,
        connectedAtMs: now(),
      });
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
        aria-label={empty ? "Connect to chat (no selection)" : label}
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
      {error !== null ? (
        <span role="alert" className="scope-connect-error">
          {error}
        </span>
      ) : null}
    </>
  );
}
