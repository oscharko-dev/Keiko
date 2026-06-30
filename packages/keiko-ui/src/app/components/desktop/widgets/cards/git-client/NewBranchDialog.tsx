"use client";

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import type { GitBranchListEntry } from "@/lib/api";
import KeikoSelect from "../../../KeikoSelect";
import { Icons } from "../../../Icons";
import {
  INPUT_STYLE,
  PRIMARY_BTN,
  SECONDARY_BTN,
  SUBTLE_TEXT_STYLE,
  disabledStyle,
} from "./git-client-styles";

interface NewBranchDialogProps {
  readonly branches: readonly GitBranchListEntry[];
  readonly currentBranch: string;
  readonly busy: boolean;
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
  error,
  onCreate,
  onClose,
}: NewBranchDialogProps): ReactNode {
  const initialBase =
    branches.find((branch) => branch.name === currentBranch)?.name ?? branches[0]?.name ?? "";
  const [branchName, setBranchName] = useState("");
  const [baseBranchName, setBaseBranchName] = useState(initialBase);
  const formRef = useRef<HTMLFormElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const trimmed = branchName.trim();
  const canSubmit = trimmed.length > 0 && baseBranchName.length > 0 && !busy;

  const dialog = (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- modal dialog needs Escape/Tab key handling.
    <div
      role="dialog"
      aria-modal="true"
      aria-label="New branch"
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          onClose();
          return;
        }
        if (event.key !== "Tab") return;
        const focusables = Array.from(
          formRef.current?.querySelectorAll<HTMLElement>(
            'button:not([disabled]), input:not([disabled]), [role="combobox"]:not([aria-disabled="true"])',
          ) ?? [],
        );
        if (focusables.length === 0) return;
        const first = focusables[0]!;
        const last = focusables[focusables.length - 1]!;
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 100,
        display: "grid",
        placeItems: "center",
        background: "color-mix(in oklch, var(--surface-primary) 45%, transparent)",
      }}
    >
      <form
        ref={formRef}
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-4)",
          width: "min(420px, calc(100vw - 48px))",
          padding: "var(--space-5)",
          border: "1px solid var(--border-subtle)",
          borderRadius: "var(--radius-card)",
          background: "var(--surface-primary)",
          boxShadow: "var(--shadow-popover)",
        }}
        onSubmit={(event) => {
          event.preventDefault();
          if (canSubmit) onCreate({ branchName: trimmed, baseBranchName });
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
          <Icons.branch size={16} />
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
            leadingVisual={<Icons.branch size={12} />}
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
        {error !== null ? (
          <p role="alert" style={{ ...SUBTLE_TEXT_STYLE, color: "var(--feedback-danger)" }}>
            {error}
          </p>
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
    </div>
  );

  return typeof document === "undefined" ? dialog : createPortal(dialog, document.body);
}
