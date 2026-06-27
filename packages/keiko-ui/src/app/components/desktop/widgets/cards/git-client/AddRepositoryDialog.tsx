"use client";

import { useEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import type { ProjectWithAvailability } from "@/lib/types";
import { Icons } from "../../../Icons";
import type { GitClientSeam } from "./git-client-seam";
import { formatGitError } from "./git-client-seam";
import {
  INPUT_STYLE,
  PRIMARY_BTN,
  SECONDARY_BTN,
  SUBTLE_TEXT_STYLE,
  disabledStyle,
} from "./git-client-styles";

const OVERLAY_STYLE: CSSProperties = {
  position: "fixed",
  inset: 0,
  display: "grid",
  placeItems: "center",
  padding: "var(--space-5)",
  background: "color-mix(in oklch, var(--surface-backdrop, #000) 55%, transparent)",
  zIndex: 1000,
};

const DIALOG_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-5)",
  width: "min(440px, 100%)",
  maxHeight: "100%",
  overflow: "auto",
  padding: "var(--space-6)",
  border: "1px solid var(--border-default)",
  borderRadius: "var(--radius-surface)",
  background: "var(--surface-primary)",
};

const FIELD_LABEL_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-3)",
  font: "var(--weight-semibold) var(--text-caption) var(--font-ui)",
  textTransform: "uppercase",
  letterSpacing: "0.02em",
  color: "var(--text-faint)",
};

const MODE_TAB_STYLE: CSSProperties = {
  ...SECONDARY_BTN,
  flex: 1,
};

const MODE_TAB_ACTIVE_STYLE: CSSProperties = {
  border: "1px solid var(--border-accent)",
  background: "var(--surface-inset)",
  color: "var(--text-primary)",
};

type AddMode = "clone" | "open";

interface AddRepositoryDialogProps {
  readonly client: GitClientSeam;
  readonly onAdded: (project: ProjectWithAvailability) => void;
  readonly onClose: () => void;
}

function focusableInside(root: HTMLElement): readonly HTMLElement[] {
  const nodes = root.querySelectorAll<HTMLElement>("button,input,textarea");
  return Array.from(nodes).filter((node) => !node.hasAttribute("disabled"));
}

export function AddRepositoryDialog({
  client,
  onAdded,
  onClose,
}: AddRepositoryDialogProps): ReactNode {
  const [mode, setMode] = useState<AddMode>("clone");
  const [repositoryUrl, setRepositoryUrl] = useState("");
  const [destinationPath, setDestinationPath] = useState("");
  const [localPath, setLocalPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const firstFieldRef = useRef<HTMLInputElement | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  // Capture the opener once on mount and restore focus to it when the dialog closes,
  // so keyboard users return to where they were (WCAG 2.4.3 / EV4 modal-control).
  useEffect(() => {
    triggerRef.current = document.activeElement as HTMLElement | null;
    return () => {
      const trigger = triggerRef.current;
      if (trigger !== null && trigger.isConnected) trigger.focus();
    };
  }, []);

  // Move initial focus into the dialog (first field, or the dialog container itself when a
  // mode has no field yet) so the Tab trap and Escape handler — both bound to the dialog —
  // start receiving keys immediately. Re-runs on mode switch because the field changes.
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      (firstFieldRef.current ?? dialogRef.current)?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [mode]);

  const canSubmit =
    mode === "clone"
      ? repositoryUrl.trim() !== "" && destinationPath.trim() !== ""
      : localPath.trim() !== "";

  const submit = (): void => {
    if (busy || !canSubmit) return;
    setBusy(true);
    setError(null);
    const op =
      mode === "clone"
        ? client.cloneRepository({
            repositoryUrl: repositoryUrl.trim(),
            destinationPath: destinationPath.trim(),
          })
        : client.registerRepository({ path: localPath.trim() });
    void op.then(
      (res) => {
        setBusy(false);
        onAdded(res.project);
        onClose();
      },
      (err: unknown) => {
        setBusy(false);
        setError(formatGitError(err));
      },
    );
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const dialog = event.currentTarget;
    const focusable = focusableInside(dialog);
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    const active = document.activeElement;
    // Keep focus inside the dialog. Wrap at the boundaries; and when focus has escaped the
    // dialog entirely (e.g. a disabled control was activated and left focus on <body>), pull
    // it back to the appropriate end so Tab can never tab out of an aria-modal dialog.
    const escaped = !(active instanceof HTMLElement) || !dialog.contains(active);
    if (event.shiftKey && (escaped || active === first)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (escaped || active === last)) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div style={OVERLAY_STYLE} onPointerDown={onClose}>
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- modal dialog needs Escape/Tab key handling */}
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Add repository"
        tabIndex={-1}
        style={DIALOG_STYLE}
        onPointerDown={(event) => event.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-4)" }}>
          <h2
            style={{
              margin: 0,
              font: "var(--weight-semibold) var(--text-heading) var(--font-ui)",
              color: "var(--text-primary)",
            }}
          >
            Add repository
          </h2>
          <span style={{ flex: 1 }} />
          <button
            type="button"
            style={{ ...SECONDARY_BTN, padding: "0 var(--space-3)" }}
            onClick={onClose}
            aria-label="Close"
            title="Close"
          >
            <Icons.close size={14} />
          </button>
        </div>

        <div style={{ display: "flex", gap: "var(--space-3)" }} role="group" aria-label="Add mode">
          <button
            type="button"
            aria-pressed={mode === "clone"}
            style={{ ...MODE_TAB_STYLE, ...(mode === "clone" ? MODE_TAB_ACTIVE_STYLE : {}) }}
            onClick={() => setMode("clone")}
          >
            Clone repository
          </button>
          <button
            type="button"
            aria-pressed={mode === "open"}
            style={{ ...MODE_TAB_STYLE, ...(mode === "open" ? MODE_TAB_ACTIVE_STYLE : {}) }}
            onClick={() => setMode("open")}
          >
            Open local repository
          </button>
        </div>

        {mode === "clone" ? (
          <>
            <label style={FIELD_LABEL_STYLE}>
              Repository URL
              <input
                ref={firstFieldRef}
                style={INPUT_STYLE}
                value={repositoryUrl}
                onChange={(event) => setRepositoryUrl(event.target.value)}
                aria-label="Repository URL"
                placeholder="https://github.com/org/repo.git"
              />
            </label>
            <label style={FIELD_LABEL_STYLE}>
              Clone to folder
              <input
                style={INPUT_STYLE}
                value={destinationPath}
                onChange={(event) => setDestinationPath(event.target.value)}
                aria-label="Clone to folder"
                placeholder="/Users/me/Work/repo"
              />
            </label>
          </>
        ) : (
          <label style={FIELD_LABEL_STYLE}>
            Local repository path
            <input
              ref={firstFieldRef}
              style={INPUT_STYLE}
              value={localPath}
              onChange={(event) => setLocalPath(event.target.value)}
              aria-label="Local repository path"
              placeholder="/Users/me/Work/existing-repo"
            />
          </label>
        )}

        {error !== null ? (
          <p role="alert" style={{ ...SUBTLE_TEXT_STYLE, color: "var(--text-primary)" }}>
            {error}
          </p>
        ) : null}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--space-4)" }}>
          <button type="button" style={SECONDARY_BTN} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            style={{ ...PRIMARY_BTN, ...disabledStyle(busy || !canSubmit) }}
            disabled={busy || !canSubmit}
            onClick={submit}
          >
            {busy ? "Adding…" : mode === "clone" ? "Clone repository" : "Open repository"}
          </button>
        </div>
      </div>
    </div>
  );
}
