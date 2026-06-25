"use client";

/**
 * Recent agent editor actions panel (Issue #1395, ADR-0062 D3).
 *
 * A read-only governance surface that lists the bounded, content-free audit records for the active
 * editor session so a user can inspect what an agent changed or attempted (AC4). It fetches the
 * server's `GET /api/editor/agent/audit` feed on mount and re-fetches whenever the editor-agent
 * bridge observes activity (`refreshNonce`); it never widens the frozen `EditorAgentEvent` union and
 * issues no mutations of its own.
 *
 * The records carry no raw source text or secrets (guaranteed by the contract record shape and the
 * server-side redactor). The disposition is conveyed by a text label, not colour alone (WCAG 1.4.1),
 * and the list is an `aria-live` region so a newly recorded action is announced. Styling reuses the
 * existing design tokens via inline custom properties (CSP `style-src` permits inline styles); no
 * global stylesheet is modified.
 */
import type { CSSProperties, ReactNode } from "react";
import { useEffect, useState } from "react";

import { fetchEditorAgentAudit } from "../../../../../lib/api";
import type {
  EditorAgentActionAuditRecord,
  EditorAgentActionDisposition,
} from "../../../../../lib/types";

const DISPOSITION_LABEL: Record<EditorAgentActionDisposition, string> = {
  allowed: "Allowed",
  "review-required": "Review required",
  denied: "Denied",
};

// Disposition is signalled by the text label above; colour only reinforces it (WCAG 1.4.1).
const DISPOSITION_COLOR: Record<EditorAgentActionDisposition, string> = {
  allowed: "var(--feedback-success)",
  "review-required": "var(--feedback-warning)",
  denied: "var(--feedback-danger)",
};

export interface EditorAgentActionsPanelProps {
  readonly agentSessionId: string;
  /** Increments when the bridge observes agent activity; each change triggers a re-fetch. */
  readonly refreshNonce: number;
}

const PANEL_STYLE: CSSProperties = {
  borderTop: "1px solid color-mix(in oklch, var(--text-secondary) 18%, transparent)",
  padding: "8px 12px",
  display: "flex",
  flexDirection: "column",
  gap: "6px",
};

const TITLE_STYLE: CSSProperties = {
  fontSize: "var(--text-caption)",
  fontWeight: "var(--weight-semibold)",
  color: "var(--text-secondary)",
  margin: 0,
  textTransform: "uppercase",
  letterSpacing: "0.04em",
};

const LIST_STYLE: CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "flex",
  flexDirection: "column",
  gap: "4px",
  maxHeight: "180px",
  overflowY: "auto",
};

const ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  gap: "8px",
  fontSize: "var(--text-body-sm)",
  color: "var(--text-secondary)",
};

function rowSummary(record: EditorAgentActionAuditRecord): string {
  const target = record.targetPath === undefined ? "" : ` on ${record.targetPath}`;
  const reason = record.denyReason ?? record.reviewReason;
  const because = reason === undefined ? "" : ` (${reason})`;
  return `${record.actionType}${target}: ${DISPOSITION_LABEL[record.disposition]}, ${record.outcome}${because}`;
}

function AuditRow({ record }: { readonly record: EditorAgentActionAuditRecord }): ReactNode {
  const occurredAt = new Date(record.occurredAt);
  return (
    <li style={ROW_STYLE} data-testid="agent-action-row">
      <span className="mono" style={{ color: "var(--text-primary)" }}>
        {record.actionType}
      </span>
      {record.targetPath === undefined ? null : (
        <span
          className="mono"
          style={{ flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}
        >
          {record.targetPath}
        </span>
      )}
      <span
        style={{ color: DISPOSITION_COLOR[record.disposition], fontWeight: "var(--weight-medium)" }}
        data-disposition={record.disposition}
      >
        {DISPOSITION_LABEL[record.disposition]}
      </span>
      <span style={{ color: "var(--text-caption-color, var(--text-secondary))" }}>
        {record.outcome}
      </span>
      <time dateTime={occurredAt.toISOString()} style={{ color: "var(--text-secondary)" }}>
        {occurredAt.toLocaleTimeString()}
      </time>
      <span className="sr-only">{rowSummary(record)}</span>
    </li>
  );
}

export function EditorAgentActionsPanel({
  agentSessionId,
  refreshNonce,
}: EditorAgentActionsPanelProps): ReactNode {
  const [records, setRecords] = useState<readonly EditorAgentActionAuditRecord[]>([]);
  // Distinguish a load failure from a genuinely empty feed so the user is not told "no actions"
  // when the audit feed simply could not be reached (AC4 — the failure must be inspectable).
  const [errored, setErrored] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetchEditorAgentAudit(agentSessionId)
      .then((response) => {
        // Newest first for the panel; the server returns oldest-first insertion order.
        if (cancelled) return;
        setRecords([...response.records].reverse());
        setErrored(false);
      })
      .catch(() => {
        if (cancelled) return;
        setRecords([]);
        setErrored(true);
      });
    return () => {
      cancelled = true;
    };
  }, [agentSessionId, refreshNonce]);

  return (
    <section
      style={PANEL_STYLE}
      aria-label="Recent agent editor actions"
      data-testid="agent-actions-panel"
    >
      <h3 style={TITLE_STYLE}>Recent agent actions</h3>
      {errored ? (
        // aria-live (not role="status") announces the failure without registering a queryable
        // "status" role — the panel is mounted per pane, so a status role would collide with other
        // status queries in the editor surface.
        <p
          style={{ ...ROW_STYLE, color: "var(--feedback-danger)", margin: 0 }}
          aria-live="polite"
          data-testid="agent-actions-error"
        >
          Unable to load recent agent actions.
        </p>
      ) : records.length === 0 ? (
        <p style={{ ...ROW_STYLE, color: "var(--text-secondary)", margin: 0 }}>
          No recent agent editor actions.
        </p>
      ) : (
        <ul style={LIST_STYLE} aria-live="polite" aria-relevant="additions">
          {records.map((record) => (
            <AuditRow key={record.auditId} record={record} />
          ))}
        </ul>
      )}
    </section>
  );
}
