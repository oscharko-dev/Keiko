"use client";

/**
 * Recent agent editor actions panel (Issues #1395 and #2120, ADR-0062 D3).
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
import { useTranslate } from "@/lib/i18n";
import {
  useEditorAgentTranslate,
  type EditorAgentMessageKey,
  type EditorAgentTranslate,
} from "./editor-agent-i18n";

const DISPOSITION_LABEL_KEY: Record<EditorAgentActionDisposition, EditorAgentMessageKey> = {
  allowed: "actions.disposition.allowed",
  "review-required": "actions.disposition.reviewRequired",
  denied: "actions.disposition.denied",
};

// Disposition is signalled by the text label above; colour only reinforces it (WCAG 1.4.1).
const DISPOSITION_COLOR: Record<EditorAgentActionDisposition, string> = {
  allowed: "var(--feedback-success)",
  "review-required": "var(--feedback-warning)",
  denied: "var(--feedback-danger)",
};

type AuditActionType = EditorAgentActionAuditRecord["actionType"];
type ActionTypeFilter = "all" | AuditActionType;
type DispositionFilter = "all" | EditorAgentActionDisposition;
type TimeRangeFilter = "all" | "past-hour" | "past-day" | "past-week";

interface AuditFilters {
  readonly actionType: ActionTypeFilter;
  readonly disposition: DispositionFilter;
  readonly timeRange: TimeRangeFilter;
}

interface FilterOption<T extends string> {
  readonly value: T;
  readonly label: string;
}

interface FilterOptionDefinition<T extends string> {
  readonly value: T;
  readonly labelKey: EditorAgentMessageKey;
}

const ACTION_TYPE_OPTIONS = [
  { value: "all", labelKey: "actions.action.all" },
  { value: "openFile", labelKey: "actions.action.openFile" },
  { value: "focusTab", labelKey: "actions.action.focusTab" },
  { value: "moveTab", labelKey: "actions.action.moveTab" },
  { value: "splitPane", labelKey: "actions.action.splitPane" },
  { value: "setSelection", labelKey: "actions.action.setSelection" },
  { value: "format", labelKey: "actions.action.format" },
  { value: "save", labelKey: "actions.action.save" },
  { value: "applyTextEdits", labelKey: "actions.action.applyTextEdits" },
  { value: "applyPatch", labelKey: "actions.action.applyPatch" },
  { value: "applyChangeset", labelKey: "actions.action.applyChangeset" },
  { value: "requestVerification", labelKey: "actions.action.requestVerification" },
] as const satisfies readonly FilterOptionDefinition<ActionTypeFilter>[];

const DISPOSITION_OPTIONS = [
  { value: "all", labelKey: "actions.disposition.all" },
  { value: "allowed", labelKey: "actions.disposition.allowed" },
  { value: "review-required", labelKey: "actions.disposition.reviewRequired" },
  { value: "denied", labelKey: "actions.disposition.denied" },
] as const satisfies readonly FilterOptionDefinition<DispositionFilter>[];

const TIME_RANGE_OPTIONS = [
  { value: "all", labelKey: "actions.timeRange.all" },
  { value: "past-hour", labelKey: "actions.timeRange.pastHour" },
  { value: "past-day", labelKey: "actions.timeRange.pastDay" },
  { value: "past-week", labelKey: "actions.timeRange.pastWeek" },
] as const satisfies readonly FilterOptionDefinition<TimeRangeFilter>[];

const HOUR_MS = 60 * 60 * 1000;
const TIME_RANGE_MS: Record<Exclude<TimeRangeFilter, "all">, number> = {
  "past-hour": HOUR_MS,
  "past-day": HOUR_MS * 24,
  "past-week": HOUR_MS * 24 * 7,
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

const FILTER_GROUP_STYLE: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "6px",
};

const FILTER_LABEL_STYLE: CSSProperties = {
  display: "flex",
  flex: "1 1 132px",
  minWidth: 0,
  flexDirection: "column",
  gap: "2px",
  color: "var(--text-secondary)",
  fontSize: "var(--text-caption)",
};

const FILTER_SELECT_STYLE: CSSProperties = {
  width: "100%",
  minWidth: 0,
  minHeight: "28px",
  padding: "4px 6px",
  border: "1px solid var(--border-default)",
  borderRadius: "var(--radius-control)",
  background: "var(--background-secondary)",
  color: "var(--text-primary)",
  fontSize: "var(--text-body-sm)",
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

function translateOptions<T extends string>(
  definitions: readonly FilterOptionDefinition<T>[],
  t: EditorAgentTranslate,
): readonly FilterOption<T>[] {
  return definitions.map((definition) => ({
    value: definition.value,
    label: t(definition.labelKey),
  }));
}

function FilterSelect<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  readonly label: string;
  readonly value: T;
  readonly options: readonly FilterOption<T>[];
  readonly onChange: (value: T) => void;
}): ReactNode {
  return (
    <label style={FILTER_LABEL_STYLE}>
      <span>{label}</span>
      <select
        style={FILTER_SELECT_STYLE}
        value={value}
        onChange={(event) => {
          const next = options.find((option) => option.value === event.currentTarget.value);
          if (next !== undefined) onChange(next.value);
        }}
      >
        {options.map((option) => (
          <option
            key={option.value}
            value={option.value}
            label={option.label}
            aria-label={option.label}
          />
        ))}
      </select>
    </label>
  );
}

function AuditFilterControls({
  filters,
  onActionTypeChange,
  onDispositionChange,
  onTimeRangeChange,
  saveLabel,
  t,
}: {
  readonly filters: AuditFilters;
  readonly onActionTypeChange: (value: ActionTypeFilter) => void;
  readonly onDispositionChange: (value: DispositionFilter) => void;
  readonly onTimeRangeChange: (value: TimeRangeFilter) => void;
  readonly saveLabel: string;
  readonly t: EditorAgentTranslate;
}): ReactNode {
  const actionTypeOptions = translateOptions(ACTION_TYPE_OPTIONS, t).map((option) =>
    option.value === "save" ? { ...option, label: saveLabel } : option,
  );
  return (
    <div style={FILTER_GROUP_STYLE} role="group" aria-label={t("actions.filterGroup")}>
      <FilterSelect
        label={t("actions.filter.actionType")}
        value={filters.actionType}
        options={actionTypeOptions}
        onChange={onActionTypeChange}
      />
      <FilterSelect
        label={t("actions.filter.disposition")}
        value={filters.disposition}
        options={translateOptions(DISPOSITION_OPTIONS, t)}
        onChange={onDispositionChange}
      />
      <FilterSelect
        label={t("actions.filter.timeRange")}
        value={filters.timeRange}
        options={translateOptions(TIME_RANGE_OPTIONS, t)}
        onChange={onTimeRangeChange}
      />
    </div>
  );
}

function matchesTimeRange(occurredAt: number, timeRange: TimeRangeFilter, now: number): boolean {
  if (timeRange === "all") return true;
  return occurredAt >= now - TIME_RANGE_MS[timeRange] && occurredAt <= now;
}

function matchesFilters(
  record: EditorAgentActionAuditRecord,
  filters: AuditFilters,
  now: number,
): boolean {
  const matchesAction = filters.actionType === "all" || record.actionType === filters.actionType;
  const matchesDisposition =
    filters.disposition === "all" || record.disposition === filters.disposition;
  return (
    matchesAction &&
    matchesDisposition &&
    matchesTimeRange(record.occurredAt, filters.timeRange, now)
  );
}

function filterRecords(
  records: readonly EditorAgentActionAuditRecord[],
  filters: AuditFilters,
): readonly EditorAgentActionAuditRecord[] {
  // Issue #2120 (ADR-0062 D3): compose filters only over the already-bounded, content-free feed.
  const noFilters =
    filters.actionType === "all" && filters.disposition === "all" && filters.timeRange === "all";
  if (noFilters) return records;
  const now = Date.now();
  return records.filter((record) => matchesFilters(record, filters, now));
}

function rowSummary(record: EditorAgentActionAuditRecord, t: EditorAgentTranslate): string {
  const target =
    record.targetPath === undefined ? "" : t("actions.rowTarget", { path: record.targetPath });
  const reason = record.denyReason ?? record.reviewReason;
  const because = reason === undefined ? "" : t("actions.rowReason", { reason });
  return t("actions.rowSummary", {
    action: record.actionType,
    target,
    disposition: t(DISPOSITION_LABEL_KEY[record.disposition]),
    outcome: record.outcome,
    reason: because,
  });
}

function AuditRow({
  record,
  t,
}: {
  readonly record: EditorAgentActionAuditRecord;
  readonly t: EditorAgentTranslate;
}): ReactNode {
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
        {t(DISPOSITION_LABEL_KEY[record.disposition])}
      </span>
      <span style={{ color: "var(--text-caption-color, var(--text-secondary))" }}>
        {record.outcome}
      </span>
      <time dateTime={occurredAt.toISOString()} style={{ color: "var(--text-secondary)" }}>
        {occurredAt.toLocaleTimeString()}
      </time>
      <span className="sr-only">{rowSummary(record, t)}</span>
    </li>
  );
}

interface AuditLoadState {
  readonly records: readonly EditorAgentActionAuditRecord[];
  readonly errored: boolean;
}

function useAuditRecords(agentSessionId: string, refreshNonce: number): AuditLoadState {
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

  return { records, errored };
}

function AuditFeed({
  records,
  visibleRecords,
  errored,
  t,
}: {
  readonly records: readonly EditorAgentActionAuditRecord[];
  readonly visibleRecords: readonly EditorAgentActionAuditRecord[];
  readonly errored: boolean;
  readonly t: EditorAgentTranslate;
}): ReactNode {
  if (errored) {
    return (
      // aria-live (not role="status") avoids colliding with status queries elsewhere in the editor.
      <p
        style={{ ...ROW_STYLE, color: "var(--feedback-danger)", margin: 0 }}
        aria-live="polite"
        data-testid="agent-actions-error"
      >
        {t("actions.loadError")}
      </p>
    );
  }
  if (records.length === 0) {
    return (
      <p style={{ ...ROW_STYLE, color: "var(--text-secondary)", margin: 0 }}>
        {t("actions.empty")}
      </p>
    );
  }
  if (visibleRecords.length === 0) {
    return (
      <p
        style={{ ...ROW_STYLE, color: "var(--text-secondary)", margin: 0 }}
        aria-live="polite"
        aria-atomic="true"
        data-testid="agent-actions-no-match"
      >
        {t("actions.noMatch")}
      </p>
    );
  }
  return (
    <ul style={LIST_STYLE} aria-live="polite" aria-relevant="additions">
      {visibleRecords.map((record) => (
        <AuditRow key={record.auditId} record={record} t={t} />
      ))}
    </ul>
  );
}

export function EditorAgentActionsPanel({
  agentSessionId,
  refreshNonce,
}: EditorAgentActionsPanelProps): ReactNode {
  const agentT = useEditorAgentTranslate();
  const t = useTranslate();
  const saveLabel = t("common.save");
  const { records, errored } = useAuditRecords(agentSessionId, refreshNonce);
  const [actionType, setActionType] = useState<ActionTypeFilter>("all");
  const [disposition, setDisposition] = useState<DispositionFilter>("all");
  const [timeRange, setTimeRange] = useState<TimeRangeFilter>("all");
  const filters: AuditFilters = { actionType, disposition, timeRange };
  const visibleRecords = filterRecords(records, filters);

  return (
    <section
      style={PANEL_STYLE}
      aria-label={agentT("actions.panelLabel")}
      data-testid="agent-actions-panel"
    >
      <h3 style={TITLE_STYLE}>{agentT("actions.title")}</h3>
      <AuditFilterControls
        filters={filters}
        onActionTypeChange={setActionType}
        onDispositionChange={setDisposition}
        onTimeRangeChange={setTimeRange}
        saveLabel={saveLabel}
        t={agentT}
      />
      <AuditFeed records={records} visibleRecords={visibleRecords} errored={errored} t={agentT} />
    </section>
  );
}
