"use client";

// Shared presentational primitives for the Git client staging + commit surface (Issue #1575,
// Epic #1571). Carried forward verbatim in behaviour from the removed GovernedGitFlowCard
// (contract §2 "replace"): the status pill, the uppercase field label, the typed-code list, and
// the mutation-outcome banner. Every primitive conveys state through text + icon, never colour
// alone (WCAG 1.4.1), and styles compose existing globals.css tokens via inline styles (ADR-0051).

import type { CSSProperties, ReactNode } from "react";
import { Icons } from "../../../Icons";
import { STATUS_LABEL, violationLabel } from "./git-client-seam";
import type { GitMutationOutcome } from "./git-client-seam";
import { PREVIEW_STYLE, SUBTLE_TEXT_STYLE } from "./git-client-styles";

export type PillTone = "neutral" | "accent" | "success" | "warning" | "danger" | "info";

function toneColor(tone: PillTone): string {
  switch (tone) {
    case "success":
      return "var(--feedback-success)";
    case "warning":
      return "var(--feedback-warning)";
    case "danger":
      return "var(--feedback-danger)";
    case "info":
      return "var(--feedback-info)";
    case "accent":
      return "var(--text-accent)";
    case "neutral":
      return "var(--text-secondary)";
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
        gap: "var(--space-3)",
        width: "fit-content",
        padding: "3px 10px",
        borderRadius: "var(--radius-pill)",
        border: `1px solid color-mix(in oklch, ${color} 42%, transparent)`,
        background:
          tone === "neutral"
            ? "var(--surface-inset)"
            : `color-mix(in oklch, ${color} 12%, transparent)`,
        color,
        font: "var(--weight-semibold) var(--text-caption) var(--font-ui)",
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

export function FieldLabel({
  label,
  htmlFor,
  children,
}: {
  readonly label: string;
  readonly htmlFor: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)", minWidth: 0 }}>
      <label
        htmlFor={htmlFor}
        style={{
          font: "var(--weight-semibold) var(--text-caption) var(--font-ui)",
          letterSpacing: "0.02em",
          textTransform: "uppercase",
          color: "var(--text-faint)",
        }}
      >
        {label}
      </label>
      {children}
    </div>
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
          margin: "0 0 var(--space-2)",
          font: "var(--weight-semibold) var(--text-caption) var(--font-ui)",
          color: "var(--text-faint)",
          textTransform: "uppercase",
          letterSpacing: "0.03em",
        }}
      >
        {label}
      </p>
      <ul
        style={{
          margin: 0,
          paddingLeft: "var(--space-7)",
          font: "var(--text-body-sm) var(--font-ui)",
        }}
      >
        {items.map((item) => (
          <li
            key={item.key}
            style={{ color: "var(--text-primary)", lineHeight: "var(--leading-normal)" }}
          >
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
          borderColor: "color-mix(in oklch, var(--feedback-danger) 48%, var(--border-default))",
          background: "color-mix(in oklch, var(--feedback-danger) 10%, var(--surface-primary))",
        }}
      >
        <StatusPill tone="danger">
          <Icons.info size={11} /> Error
        </StatusPill>
        <p style={{ ...SUBTLE_TEXT_STYLE, color: "var(--text-primary)" }}>{error}</p>
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
  const borderColor: CSSProperties["borderColor"] =
    tone === "success"
      ? "color-mix(in oklch, var(--feedback-success) 42%, var(--border-default))"
      : tone === "warning"
        ? "color-mix(in oklch, var(--feedback-warning) 42%, var(--border-default))"
        : tone === "danger"
          ? "color-mix(in oklch, var(--feedback-danger) 42%, var(--border-default))"
          : "var(--border-subtle)";
  return (
    <div
      data-testid={testid}
      role={tone === "danger" ? "alert" : "status"}
      style={{ ...PREVIEW_STYLE, borderColor }}
    >
      <StatusPill tone={tone}>
        <Icons.check size={11} /> {STATUS_LABEL[outcome.status]}
      </StatusPill>
      <p
        style={{
          margin: 0,
          font: "var(--weight-semibold) var(--text-body-sm) var(--font-ui)",
          color: "var(--text-primary)",
        }}
      >
        {outcome.actionKind}: {STATUS_LABEL[outcome.status]}
      </p>
      {codes.length > 0 ? (
        <ul
          style={{
            margin: 0,
            paddingLeft: "var(--space-7)",
            font: "var(--text-caption) var(--font-ui)",
          }}
        >
          {codes.map((code) => (
            <li
              key={code}
              style={{ color: "var(--text-secondary)", lineHeight: "var(--leading-normal)" }}
            >
              {code}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
