"use client";

import { useId, useState, type ChangeEvent, type ReactNode } from "react";
import type { KnowledgeCapsuleId } from "@oscharko-dev/keiko-contracts";
import {
  rebindCapsuleSourceRoot,
  type SourceIndexStats,
} from "@/lib/local-knowledge-api";
import { LocalFileBrowserDialog } from "@/app/components/desktop/local-files/LocalFileBrowserDialog";
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
  const [pickerOpen, setPickerOpen] = useState(false);
  const trimmedRoot = rootPath.trim();

  function openEditor(): void {
    setRootPath(currentRoot);
    setError(null);
    setEditing(true);
  }

  function closeEditor(): void {
    if (busy) return;
    setEditing(false);
    setError(null);
    setPickerOpen(false);
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
              disabled={busy}
              onClick={() => setPickerOpen(true)}
            >
              Browse
            </button>
          </div>
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
      {pickerOpen ? (
        <LocalFileBrowserDialog
          mode="folder-or-files"
          title="Choose replacement root"
          description="Select the folder that now contains this source."
          initialRootPath={rootPath}
          initialFiles={[]}
          onApply={(selection) => {
            setRootPath(selection.files.length > 0 ? selection.rootPath : selection.folderPath);
            setError(null);
            setPickerOpen(false);
          }}
          onCancel={() => setPickerOpen(false)}
        />
      ) : null}
    </div>
  );
}
