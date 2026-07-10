"use client";

import { useId, useState, type ChangeEvent, type ReactNode } from "react";
import type { KnowledgeCapsuleId } from "@oscharko-dev/keiko-contracts";
import { rebindCapsuleSourceRoot, type SourceIndexStats } from "@/lib/local-knowledge-api";
import { useNativeFileDialogCapability } from "@/app/components/desktop/hooks/useNativeFileDialogCapability";
import { pickWithNativeDialog } from "@/lib/native-file-dialog";
import {
  useLocalKnowledgeTranslate as useTranslate,
  type I18nTranslate,
} from "../local-knowledge-i18n";
import { formatError } from "../format-error";

interface SourceRebindControlProps {
  readonly capsuleId: KnowledgeCapsuleId;
  readonly source: SourceIndexStats;
  readonly onRebound: () => void;
  readonly rebindImpl?: typeof rebindCapsuleSourceRoot;
}

function scopeRoot(scope: SourceIndexStats["scope"]): string {
  if (scope.kind === "repository") return scope.repositoryRoot;
  return scope.rootPath;
}

function scopeLabel(scope: SourceIndexStats["scope"], t: I18nTranslate): string {
  if (scope.kind === "repository") return t("localKnowledge.detail.rebind.repositoryRoot");
  if (scope.kind === "files") return t("localKnowledge.detail.rebind.sharedRoot");
  return t("localKnowledge.detail.rebind.folderRoot");
}

export function SourceRebindControl({
  capsuleId,
  source,
  onRebound,
  rebindImpl = rebindCapsuleSourceRoot,
}: SourceRebindControlProps): ReactNode {
  const t = useTranslate();
  const inputId = useId();
  const currentRoot = scopeRoot(source.scope);
  const [editing, setEditing] = useState(false);
  const [rootPath, setRootPath] = useState(currentRoot);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nativeNoteId = useId();
  const nativeDialogSupported = useNativeFileDialogCapability();
  const trimmedRoot = rootPath.trim();

  // Epic #1941 (ADR-0118) — rebinding always targets a folder root (the old in-app picker's file
  // branch also collapsed to the shared root), so the native dialog is a plain folder pick.
  function openNativeRootPicker(): void {
    void pickWithNativeDialog({
      mode: "open-directory",
      title: t("localKnowledge.detail.rebind.chooseRoot"),
      ...(trimmedRoot.length > 0 ? { defaultPath: trimmedRoot } : {}),
    }).then((outcome) => {
      if (outcome.kind === "picked" && outcome.paths[0] !== undefined) {
        setRootPath(outcome.paths[0]);
        setError(null);
        return;
      }
      if (outcome.kind === "busy") setError(t("localKnowledge.nativeDialog.busy"));
      if (outcome.kind === "unsupported") {
        setError(t("localKnowledge.nativeDialog.unavailable"));
      }
      if (outcome.kind === "error") setError(outcome.message);
    });
  }

  function openEditor(): void {
    setRootPath(currentRoot);
    setError(null);
    setEditing(true);
  }

  function closeEditor(): void {
    if (busy) return;
    setEditing(false);
    setError(null);
  }

  async function submit(): Promise<void> {
    if (trimmedRoot.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      await rebindImpl(capsuleId, source.sourceId, trimmedRoot);
      setEditing(false);
      onRebound();
    } catch (cause) {
      setError(formatError(cause, t));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="lkd-source-rebind">
      {!editing ? (
        <button
          type="button"
          className="lk-btn lk-btn-ghost"
          title={t("localKnowledge.detail.help.rebind")}
          onClick={openEditor}
        >
          {t("localKnowledge.detail.rebind.button")}
        </button>
      ) : (
        <div className="lkd-rebind-form">
          <label
            htmlFor={inputId}
            className="dlg-label"
            title={t("localKnowledge.detail.help.rebind")}
          >
            {scopeLabel(source.scope, t)}
          </label>
          <div className="lkd-connect-path-group">
            <input
              id={inputId}
              type="text"
              className="dlg-input lkd-connect-input"
              value={rootPath}
              disabled={busy}
              autoComplete="off"
              onChange={(event: ChangeEvent<HTMLInputElement>) => setRootPath(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void submit();
              }}
            />
            <button
              type="button"
              className="lk-btn lk-btn-ghost"
              disabled={busy || !nativeDialogSupported}
              aria-describedby={nativeDialogSupported ? undefined : nativeNoteId}
              onClick={openNativeRootPicker}
            >
              {t("common.browse")}
            </button>
          </div>
          {!nativeDialogSupported ? (
            <span id={nativeNoteId} className="dlg-note">
              {t("localKnowledge.nativeDialog.unavailable")}
            </span>
          ) : null}
          <div className="lkd-rebind-actions">
            <button
              type="button"
              className="lk-btn lk-btn-ghost"
              disabled={busy}
              onClick={closeEditor}
            >
              {t("common.cancel")}
            </button>
            <button
              type="button"
              className="lk-btn lk-btn-primary"
              disabled={busy || trimmedRoot.length === 0}
              aria-busy={busy}
              onClick={() => void submit()}
            >
              {busy
                ? t("localKnowledge.detail.rebind.saving")
                : t("localKnowledge.detail.rebind.save")}
            </button>
          </div>
          {error !== null ? (
            <div role="alert" aria-live="assertive" className="lk-alert">
              {error}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
