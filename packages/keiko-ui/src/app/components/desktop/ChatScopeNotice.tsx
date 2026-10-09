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

function useScopeTransition(
  chat: Chat,
  releasePin: ChatScopeNoticeProps["onKeepFolderChange"],
): {
  readonly notice: ScopeTransition | null;
  readonly dismiss: () => void;
} {
  const scopes = effectiveScopes(chat);
  const signature = connectedScopeSignature(scopes);
  const previous = useRef({ id: chat.id, scopes });
  const folder = useRef<ChatConnectedScope | undefined>(undefined);
  const [notice, setNotice] = useState<ScopeTransition | null>(null);
  useEffect(() => {
    const old = previous.current;
    previous.current = { id: chat.id, scopes };
    if (old.id !== chat.id) {
      folder.current = undefined;
      setNotice(null);
      releasePin?.(false);
      return;
    }
    const scope = changedScope(old.scopes, scopes);
    if (scope === undefined) return;
    const prior = old.scopes.find((candidate) => candidate.root === scope.root);
    if (prior === undefined) {
      folder.current = undefined;
      releasePin?.(false);
    } else if (prior.kind !== "files") folder.current = prior;
    const transition = {
      scope,
      folder: folder.current?.root === scope.root ? folder.current : undefined,
      reason: transitionReason(prior ?? scope, scope),
    };
    const timer = setTimeout(() => {
      setNotice(transition);
      reportScopeNotice(transition.reason, scope);
    }, 100);
    return () => clearTimeout(timer);
    // Scope identity excludes timestamps and messages; unrelated chat updates keep the pending notice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat.id, signature, releasePin]);
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
