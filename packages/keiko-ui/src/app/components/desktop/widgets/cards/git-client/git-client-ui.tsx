"use client";

// Shared presentational primitives for the Git client staging + commit surface (Issue #1575,
// Epic #1571). Carried forward in behaviour from the removed GovernedGitFlowCard (contract §2
// "replace"): the status pill, the uppercase field label, the typed-code list, and the
// mutation-outcome banner. Every primitive conveys state through text + icon, never colour alone
// (WCAG 1.4.1), and styles compose existing globals.css tokens via inline styles (ADR-0051). The
// "Git Window" redesign migrated the palette to the design-system tokens (--ok/--warn/--danger/
// --info, --fg*, --inset, --line). See ADR-0098 for the git-client window conventions.

import type { ReactNode } from "react";
import { Icons } from "../../../Icons";
import { STATUS_LABEL, violationLabel } from "./git-client-seam";
import type { GitMutationOutcome } from "./git-client-seam";
import { PREVIEW_STYLE, SUBTLE_TEXT_STYLE } from "./git-client-styles";

export type PillTone = "neutral" | "accent" | "success" | "warning" | "danger" | "info";

function toneColor(tone: PillTone): string {
  switch (tone) {
    case "success":
      return "var(--ok)";
    case "warning":
      return "var(--warn)";
    case "danger":
      return "var(--danger)";
    case "info":
      return "var(--info)";
    case "accent":
      return "var(--accent-text)";
    case "neutral":
      return "var(--fg-muted)";
  }
}

export function StatusPill({
  children,
  tone = "neutral",
}: {
  readonly children: ReactNode;
  readonly tone?: PillTone;
}): ReactNode {
  const color = toneColor(tone);
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        width: "fit-content",
        padding: "3px 10px",
        borderRadius: 999,
        border: `1px solid color-mix(in oklch, ${color} 42%, transparent)`,
        background:
          tone === "neutral" ? "var(--inset)" : `color-mix(in oklch, ${color} 12%, transparent)`,
        color,
        font: "600 11px var(--font-ui)",
        whiteSpace: "nowrap",
      }}
    >
      <span
        aria-hidden="true"
        style={{ width: 6, height: 6, borderRadius: "50%", background: "currentColor" }}
      />
      {children}
    </span>
  );
}

// A labelled list of typed codes (quality warnings, message-policy violations, preflight findings).
// Renders nothing when empty so the policy preview stays compact.
export function CodeList({
  label,
  testid,
  items,
}: {
  readonly label: string;
  readonly testid: string;
  readonly items: readonly { readonly key: string; readonly text: string }[];
}): ReactNode {
  if (items.length === 0) return null;
  return (
    <div data-testid={testid}>
      <p
        style={{
          margin: "0 0 6px",
          font: "600 11px var(--font-ui)",
          color: "var(--fg-faint)",
          textTransform: "uppercase",
          letterSpacing: "0.03em",
        }}
      >
        {label}
      </p>
      <ul style={{ margin: 0, paddingLeft: 18, font: "400 12px var(--font-ui)" }}>
        {items.map((item) => (
          <li key={item.key} style={{ color: "var(--fg)", lineHeight: 1.5 }}>
            <Icons.info size={11} /> {item.text}
          </li>
        ))}
      </ul>
    </div>
  );
}

function outcomeTone(status: GitMutationOutcome["status"]): PillTone {
  if (status === "succeeded") return "success";
  if (status === "approval-required" || status === "recovery-required") return "warning";
  if (status === "blocked" || status === "failed") return "danger";
  return "neutral";
}

// Renders the result of a stage / unstage / commit mutation (or a transport error). Shows the
// action kind + outcome label and every typed reason/finding/approver code as text.
export function MutationOutcome({
  outcome,
  error,
  testid = "git-outcome",
}: {
  readonly outcome: GitMutationOutcome | null;
  readonly error: string | null;
  readonly testid?: string;
}): ReactNode {
  if (error !== null) {
    return (
      <div
        data-testid={testid}
        role="alert"
        style={{
          ...PREVIEW_STYLE,
          boxShadow: "inset 0 0 0 1px color-mix(in oklch, var(--danger) 48%, var(--line))",
          background: "color-mix(in oklch, var(--danger) 10%, var(--inset))",
        }}
      >
        <StatusPill tone="danger">
          <Icons.info size={11} /> Error
        </StatusPill>
        <p style={{ ...SUBTLE_TEXT_STYLE, color: "var(--fg)" }}>{error}</p>
      </div>
    );
  }
  if (outcome === null) return null;
  const tone = outcomeTone(outcome.status);
  const codes: readonly string[] = [
    ...(outcome.blockReason !== undefined ? [`reason: ${outcome.blockReason}`] : []),
    ...(outcome.preflightFindingCodes ?? []).map((c) => `preflight: ${c}`),
    ...(outcome.requiredApprovers ?? []).map((a) => `approver: ${a}`),
    ...(outcome.executionErrorCode !== undefined ? [`error: ${outcome.executionErrorCode}`] : []),
    ...(outcome.messageViolations ?? []).map((v) => violationLabel(v)),
  ];
  const ringColor =
    tone === "success"
      ? "color-mix(in oklch, var(--ok) 42%, var(--line))"
      : tone === "warning"
        ? "color-mix(in oklch, var(--warn) 42%, var(--line))"
        : tone === "danger"
          ? "color-mix(in oklch, var(--danger) 42%, var(--line))"
          : "var(--line)";
  return (
    <div
      data-testid={testid}
      role={tone === "danger" ? "alert" : "status"}
      style={{ ...PREVIEW_STYLE, boxShadow: `inset 0 0 0 1px ${ringColor}` }}
    >
      <StatusPill tone={tone}>
        <Icons.check size={11} /> {STATUS_LABEL[outcome.status]}
      </StatusPill>
      <p style={{ margin: 0, font: "600 13px var(--font-ui)", color: "var(--fg)" }}>
        {outcome.actionKind}: {STATUS_LABEL[outcome.status]}
      </p>
      {codes.length > 0 ? (
        <ul style={{ margin: 0, paddingLeft: 18, font: "400 11px var(--font-ui)" }}>
          {codes.map((code) => (
            <li key={code} style={{ color: "var(--fg-muted)", lineHeight: 1.5 }}>
              {code}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
