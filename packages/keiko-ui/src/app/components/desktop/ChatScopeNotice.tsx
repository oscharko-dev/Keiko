"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { updateChatConnectedScopes } from "@/lib/api";
import { replaceGroundingScopeList } from "@/lib/chat-grounding-mutation";
import { newClientCorrelationId } from "@/lib/bff-correlation";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { useTranslate } from "@/lib/i18n";
import type { ClientDiagnosticScopeNotice } from "@oscharko-dev/keiko-contracts/runtime/diagnostics";
import type { Chat, ChatConnectedScope } from "@/lib/types";
import { effectiveScopes } from "./hooks/workspaceActions";
import { connectedScopeLabel, connectedScopeSignature } from "./connectedScopePresentation";
import { restoreScopeHeaderFocus } from "./ConnectedScopePill";
import { formatUserError } from "./format-error";
import styles from "./ChatScopeNotice.module.css";

export interface ChatScopeNoticeProps {
  readonly chat: Chat;
  readonly onChatChanged: (chat: Chat) => void;
  readonly onKeepFolderChange?: ((keep: boolean) => void) | undefined;
  readonly updateScopes?: typeof updateChatConnectedScopes;
}

interface ScopeTransition {
  readonly scope: ChatConnectedScope;
  readonly folder: ChatConnectedScope | undefined;
  readonly reason: ClientDiagnosticScopeNotice["reason"];
}

export function reportScopeNotice(
  reason: ClientDiagnosticScopeNotice["reason"],
  scope: ChatConnectedScope,
): void {
  reportClientDiagnostic("client.scope.notice", {
    correlationId: newClientCorrelationId(),
    scopeNotice: { reason, scopeKind: scope.kind, pathCount: scope.relativePaths.length },
  });
}

function transitionReason(
  previous: ChatConnectedScope,
  scope: ChatConnectedScope,
): ScopeTransition["reason"] {
  if (scope.kind === "workspace-root" || (previous.kind === "files" && scope.kind !== "files"))
    return "widened";
  return scope.kind === "files" ? "narrowed-to-file" : "narrowed-to-directory";
}

function changedScope(
  previous: readonly ChatConnectedScope[],
  next: readonly ChatConnectedScope[],
): ChatConnectedScope | undefined {
  return next.find(
    (scope) =>
      !previous.some((old) => connectedScopeSignature([old]) === connectedScopeSignature([scope])),
  );
}

interface ScopeTransitionHistory {
  id: string;
  scopes: readonly ChatConnectedScope[];
  folder: ChatConnectedScope | undefined;
  represented: ChatConnectedScope | undefined;
}

function resetScopeHistory(
  history: ScopeTransitionHistory,
  releasePin: ChatScopeNoticeProps["onKeepFolderChange"],
): null {
  history.folder = undefined;
  history.represented = undefined;
  releasePin?.(false);
  return null;
}

function trackedScopeRemoved(history: ScopeTransitionHistory): boolean {
  if (history.scopes.length === 0) return true;
  const represented = history.represented;
  return (
    represented !== undefined &&
    !history.scopes.some(
      (scope) => connectedScopeSignature([scope]) === connectedScopeSignature([represented]),
    )
  );
}

function evaluateScopeTransition(
  history: ScopeTransitionHistory,
  chat: Chat,
  releasePin: ChatScopeNoticeProps["onKeepFolderChange"],
): ScopeTransition | null | undefined {
  const oldId = history.id;
  const oldScopes = history.scopes;
  history.id = chat.id;
  history.scopes = effectiveScopes(chat);
  if (oldId !== chat.id) return resetScopeHistory(history, releasePin);
  const scope = changedScope(oldScopes, history.scopes);
  if (scope === undefined)
    return trackedScopeRemoved(history) ? resetScopeHistory(history, releasePin) : undefined;
  const prior = oldScopes.find((candidate) => candidate.root === scope.root);
  if (prior === undefined) resetScopeHistory(history, releasePin);
  else if (prior.kind !== "files") history.folder = prior;
  history.represented = scope;
  return {
    scope,
    folder: history.folder?.root === scope.root ? history.folder : undefined,
    reason: transitionReason(prior ?? scope, scope),
  };
}

function useScopeTransition(
  chat: Chat,
  releasePin: ChatScopeNoticeProps["onKeepFolderChange"],
): {
  readonly notice: ScopeTransition | null;
  readonly dismiss: () => void;
} {
  const signature = connectedScopeSignature(effectiveScopes(chat));
  const latest = useRef({ chat, releasePin });
  useEffect(() => {
    latest.current = { chat, releasePin };
  }, [chat, releasePin]);
  const history = useRef<ScopeTransitionHistory>({
    id: chat.id,
    scopes: effectiveScopes(chat),
    folder: undefined,
    represented: undefined,
  });
  const [notice, setNotice] = useState<ScopeTransition | null>(null);
  useEffect(() => {
    const transition = evaluateScopeTransition(
      history.current,
      latest.current.chat,
      latest.current.releasePin,
    );
    if (transition === undefined) return;
    if (transition === null) {
      setNotice(null);
      return;
    }
    const timer = setTimeout(() => {
      setNotice(transition);
      reportScopeNotice(transition.reason, transition.scope);
    }, 100);
    return () => clearTimeout(timer);
  }, [chat.id, signature]);
  return { notice, dismiss: (): void => setNotice(null) };
}

async function restoreFolder(props: ChatScopeNoticeProps, notice: ScopeTransition): Promise<void> {
  if (notice.folder === undefined) return;
  const current = effectiveScopes(props.chat);
  const matching = current.filter(
    (scope) => connectedScopeSignature([scope]) === connectedScopeSignature([notice.scope]),
  );
  if (matching.length !== 1) throw new TypeError("SCOPE_NOTICE_STALE");
  const scopes = current.map((scope) => (scope === matching[0] ? (notice.folder ?? scope) : scope));
  props.onKeepFolderChange?.(true);
  try {
    const response = await replaceGroundingScopeList(
      props.chat,
      scopes,
      props.updateScopes ?? updateChatConnectedScopes,
      props.onChatChanged,
    );
    props.onChatChanged(response.chat);
    reportScopeNotice("pinned-folder", notice.folder);
  } catch (error) {
    props.onKeepFolderChange?.(false);
    throw error;
  }
}

function useFolderRestoration(
  props: ChatScopeNoticeProps,
  notice: ScopeTransition | null,
  dismiss: () => void,
): {
  readonly error: string | null;
  readonly busy: boolean;
  readonly keep: () => Promise<void>;
} {
  const t = useTranslate();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setError(null);
  }, [notice]);
  const keep = async (): Promise<void> => {
    if (busy || notice === null) return;
    setBusy(true);
    setError(null);
    try {
      await restoreFolder(props, notice);
      dismiss();
    } catch (failure) {
      setError(formatUserError(failure, t("scope.notice.failed")));
    } finally {
      setBusy(false);
    }
  };
  return { error, busy, keep };
}

function ScopeNoticeControls({
  allowPin,
  busy,
  keep,
  dismiss,
}: {
  readonly allowPin: boolean;
  readonly busy: boolean;
  readonly keep: () => Promise<void>;
  readonly dismiss: () => void;
}): ReactNode {
  const t = useTranslate();
  return (
    <>
      {allowPin ? (
        <button
          type="button"
          aria-disabled={busy}
          onClick={() => {
            void keep();
          }}
        >
          {t("scope.notice.keepFolder")}
        </button>
      ) : null}
      <button
        type="button"
        onClick={(event) => {
          restoreScopeHeaderFocus(
            event.currentTarget.closest(".chat-scope-header"),
            event.currentTarget,
          );
          dismiss();
        }}
      >
        {t("scope.notice.ok")}
      </button>
    </>
  );
}

export function ChatScopeNotice(props: ChatScopeNoticeProps): ReactNode {
  const t = useTranslate();
  const { notice, dismiss } = useScopeTransition(props.chat, props.onKeepFolderChange);
  const restoration = useFolderRestoration(props, notice, dismiss);
  if (notice === null) return null;
  return (
    <div className={styles.notice}>
      <span role="status" aria-live="polite">
        {t(notice.reason === "widened" ? "scope.notice.widened" : "scope.notice.narrowed", {
          scope: connectedScopeLabel(notice.scope, t),
        })}
      </span>
      <ScopeNoticeControls
        allowPin={
          notice.folder !== undefined &&
          notice.scope.kind === "files" &&
          props.onKeepFolderChange !== undefined
        }
        busy={restoration.busy}
        keep={restoration.keep}
        dismiss={dismiss}
      />
      {restoration.error === null ? null : <span role="alert">{restoration.error}</span>}
    </div>
  );
}
