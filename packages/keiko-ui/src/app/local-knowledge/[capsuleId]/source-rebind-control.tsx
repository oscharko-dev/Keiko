"use client";

import { useId, useState, type ChangeEvent, type ReactNode } from "react";
import type { KnowledgeCapsuleId } from "@oscharko-dev/keiko-contracts";
import { rebindCapsuleSourceRoot, type SourceIndexStats } from "@/lib/local-knowledge-api";
import { useNativeFileDialogCapability } from "@/app/components/desktop/hooks/useNativeFileDialogCapability";
import { pickWithNativeDialog } from "@/lib/native-file-dialog";
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

function scopeLabel(scope: SourceIndexStats["scope"]): string {
  if (scope.kind === "repository") return "Replacement repository root";
  if (scope.kind === "files") return "Replacement shared root";
  return "Replacement folder root";
}

export function SourceRebindControl({
  capsuleId,
  source,
  onRebound,
  rebindImpl = rebindCapsuleSourceRoot,
}: SourceRebindControlProps): ReactNode {
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
      title: "Choose replacement root",
      ...(trimmedRoot.length > 0 ? { defaultPath: trimmedRoot } : {}),
    }).then((outcome) => {
      if (outcome.kind === "picked" && outcome.paths[0] !== undefined) {
        setRootPath(outcome.paths[0]);
        setError(null);
        return;
      }
      if (outcome.kind === "busy") setError("A native dialog is already open. Close it first.");
      if (outcome.kind === "unsupported") {
        setError("Native dialogs are unavailable on this platform. Enter the path manually.");
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
      setError(formatError(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="lkd-source-rebind">
      {!editing ? (
        <button type="button" className="lk-btn lk-btn-ghost" onClick={openEditor}>
          Rebind
        </button>
      ) : (
        <div className="lkd-rebind-form">
          <label htmlFor={inputId} className="dlg-label">
            {scopeLabel(source.scope)}
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
              Browse
            </button>
          </div>
          {!nativeDialogSupported ? (
            <span id={nativeNoteId} className="dlg-note">
              Native dialogs are unavailable on this platform. Enter the path manually.
            </span>
          ) : null}
          <div className="lkd-rebind-actions">
            <button
              type="button"
              className="lk-btn lk-btn-ghost"
              disabled={busy}
              onClick={closeEditor}
            >
              Cancel
            </button>
            <button
              type="button"
              className="lk-btn lk-btn-primary"
              disabled={busy || trimmedRoot.length === 0}
              aria-busy={busy}
              onClick={() => void submit()}
            >
              {busy ? "Rebinding..." : "Save root"}
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
