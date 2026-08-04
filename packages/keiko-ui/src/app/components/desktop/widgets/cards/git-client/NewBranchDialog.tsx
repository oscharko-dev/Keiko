"use client";

import { useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import type { GitBranchListEntry } from "@/lib/api";
import KeikoSelect from "../../../KeikoSelect";
import { Icons } from "../../../Icons";
import { useDialogTabTrap } from "../../../hooks/useDialogTabTrap";
import { useModalInteractionLock } from "../../../hooks/useModalInteractionLock";
import type { GitMutationOutcome } from "./git-client-seam";
import { MutationOutcome } from "./git-client-ui";
import {
  INPUT_STYLE,
  PRIMARY_BTN,
  SECONDARY_BTN,
  SUBTLE_TEXT_STYLE,
  disabledStyle,
} from "./git-client-styles";

// PascalCase aliases so the JSX tag itself signals "component", not member access (S6770).
const BranchIcon = Icons.branch;

interface NewBranchDialogProps {
  readonly branches: readonly GitBranchListEntry[];
  readonly currentBranch: string;
  readonly busy: boolean;
  // The create-then-switch chain runs through the same mutation flow as a direct branch switch
  // (GitClientWindow#createBranch): a rejected create OR a rejected switch of the newly created
  // branch must be classified and shown here, not just a transport-level error.
  readonly outcome: GitMutationOutcome | null;
  readonly error: string | null;
  readonly onCreate: (input: {
    readonly branchName: string;
    readonly baseBranchName: string;
  }) => void;
  readonly onClose: () => void;
}

export function NewBranchDialog({
  branches,
  currentBranch,
  busy,
  outcome,
  error,
  onCreate,
  onClose,
}: NewBranchDialogProps): ReactNode {
  const initialBase =
    branches.find((branch) => branch.name === currentBranch)?.name ?? branches[0]?.name ?? "";
  const [branchName, setBranchName] = useState("");
  const [baseBranchName, setBaseBranchName] = useState(initialBase);
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  useDialogTabTrap(dialogRef);
  useModalInteractionLock({ initialFocusRef: inputRef, restoreFocus: false });

  const trimmed = branchName.trim();
  const canSubmit = trimmed.length > 0 && baseBranchName.length > 0 && !busy;

  const dialog = (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- the native dialog owns Escape handling while the shared hook owns Tab containment.
    <dialog
      open
      ref={dialogRef}
      aria-modal="true"
      aria-label="New branch"
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          onClose();
          event.preventDefault();
        }
      }}
      style={{
        position: "fixed",
        inset: 0,
        width: "auto",
        maxWidth: "none",
        height: "auto",
        maxHeight: "none",
        margin: 0,
        padding: 0,
        border: 0,
        zIndex: 100,
        display: "grid",
        placeItems: "center",
        background: "color-mix(in oklch, var(--surface-primary) 45%, transparent)",
      }}
    >
      <form
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-4)",
          width: "min(420px, calc(100vw - 48px))",
          padding: "var(--space-5)",
          border: "1px solid var(--border-subtle)",
          borderRadius: "var(--radius-lg)",
          background: "var(--surface-primary)",
          boxShadow: "var(--shadow-pop)",
        }}
        onSubmit={(event) => {
          event.preventDefault();
          if (canSubmit) onCreate({ branchName: trimmed, baseBranchName });
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
          <BranchIcon size={16} />
          <h2 style={{ margin: 0, font: "var(--weight-semibold) var(--text-body) var(--font-ui)" }}>
            New branch
          </h2>
        </div>
        <label style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
          <span
            style={{
              font: "var(--weight-semibold) var(--text-caption) var(--font-ui)",
              color: "var(--text-faint)",
              textTransform: "uppercase",
            }}
          >
            Branch name
          </span>
          <input
            ref={inputRef}
            value={branchName}
            style={INPUT_STYLE}
            aria-label="Branch name"
            onChange={(event) => setBranchName(event.currentTarget.value)}
          />
        </label>
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
          <span
            style={{
              font: "var(--weight-semibold) var(--text-caption) var(--font-ui)",
              color: "var(--text-faint)",
              textTransform: "uppercase",
            }}
          >
            Base branch
          </span>
          <KeikoSelect
            value={baseBranchName}
            ariaLabel="Base branch"
            menuTitle="Base branch"
            leadingVisual={<BranchIcon size={12} />}
            mono
            sections={[
              {
                options: branches.map((branch) => ({
                  value: branch.name,
                  label: branch.name,
                  ...(branch.name === currentBranch ? { badge: "current" } : {}),
                })),
              },
            ]}
            onValueChange={setBaseBranchName}
          />
        </div>
        <p style={SUBTLE_TEXT_STYLE}>
          The branch starts from the selected base branch. Commit hashes stay internal.
        </p>
        {error !== null || (outcome !== null && outcome.status !== "succeeded") ? (
          <MutationOutcome outcome={outcome} error={error} testid="git-branch-outcome" />
        ) : null}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--space-3)" }}>
          <button type="button" style={SECONDARY_BTN} onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            disabled={!canSubmit}
            style={{ ...PRIMARY_BTN, ...disabledStyle(!canSubmit) }}
          >
            Create branch
          </button>
        </div>
      </form>
    </dialog>
  );

  return typeof document === "undefined" ? dialog : createPortal(dialog, document.body);
}
