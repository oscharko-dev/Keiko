"use client";

/**
 * Workspace Problems panel (Issue #2213, Epic #2092, ADR-0126).
 *
 * A bounded, filterable, keyboard-navigable list that aggregates two differently-scoped sources —
 * open-file language diagnostics and the latest verification run's failures — into one view, with
 * click/Enter jump-to-line through the existing `WorkspaceApi.openEditorFile` reveal flow. Aggregation
 * is bounded (per-file and total caps with a `truncated` signal, stable total ordering) via the
 * canonical `buildEditorProblemsSnapshot`, so a pathological workspace cannot flood the UI.
 *
 * Unlike the agent-audit panel, this surface intentionally shows the real diagnostic/failure message
 * (the developer needs it to fix the problem); the ordinary editor-content rules apply (no secrets, no
 * cross-workspace leakage), not redaction-before-display. Severity is conveyed by text AND colour
 * (WCAG 1.4.1); styling uses inline design-token custom properties, never globals.css (#1300).
 */
import type { CSSProperties, KeyboardEvent, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import type {
  EditorProblem,
  EditorProblemSeverity,
  EditorProblemSource,
} from "@oscharko-dev/keiko-contracts";
import type { OpenEditorFileRequest, OpenEditorFileResult } from "../../hooks/useWorkspace.types";
import { NATIVE_FIELDSET_RESET_STYLE } from "../../native-element-styles";
import {
  buildEditorProblemsSnapshot,
  getEditorProblemsStoreSnapshot,
  subscribeEditorProblems,
  type EditorProblemsSourceHealth,
} from "../cards/editorProblemsStore";
import {
  useProblemsTranslate,
  type ProblemsMessageKey,
  type ProblemsTranslate,
} from "./problems-i18n";

export interface ProblemsPanelProps {
  readonly root: string;
  readonly openEditorFile?: ((request: OpenEditorFileRequest) => OpenEditorFileResult) | undefined;
}

type SeverityFilter = "all" | EditorProblemSeverity;
type SourceFilter = "all" | EditorProblemSource;

const SEVERITY_LABEL: Record<EditorProblemSeverity, ProblemsMessageKey> = {
  error: "problems.severity.error",
  warning: "problems.severity.warning",
  info: "problems.severity.info",
};

// Colour reinforces the text label; it never carries the meaning alone (WCAG 1.4.1).
const SEVERITY_COLOR: Record<EditorProblemSeverity, string> = {
  error: "var(--feedback-danger)",
  warning: "var(--feedback-warning)",
  info: "var(--text-secondary)",
};

const PANEL_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  height: "100%",
  gap: "8px",
  padding: "8px",
};
const LIST_STYLE: CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  overflowY: "auto",
  flex: 1,
};
const ROW_BASE: CSSProperties = {
  display: "flex",
  gap: "8px",
  padding: "4px 8px",
  cursor: "default",
  alignItems: "baseline",
};
const FILTER_ROW_STYLE: CSSProperties = { display: "flex", gap: "8px", flexWrap: "wrap" };
const SOURCE_HEALTH_STYLE: CSSProperties = {
  display: "flex",
  gap: "6px",
  margin: 0,
  padding: "6px 8px",
  border: "1px solid var(--border-subtle)",
  borderRadius: "4px",
};

const SOURCE_HEALTH_MESSAGE: Record<
  Exclude<EditorProblemsSourceHealth, "healthy">,
  ProblemsMessageKey
> = {
  reconnecting: "problems.sourceHealth.reconnecting",
  failed: "problems.sourceHealth.failed",
};

function VerificationSourceHealth(props: {
  readonly health: EditorProblemsSourceHealth;
  readonly t: ProblemsTranslate;
}): ReactNode {
  if (props.health === "healthy") return null;
  const symbol = props.health === "reconnecting" ? "↻" : "!";
  return (
    <p
      role="status"
      aria-live="polite"
      data-testid="problems-source-health"
      data-source-health={props.health}
      style={SOURCE_HEALTH_STYLE}
    >
      <span aria-hidden="true">{symbol}</span>
      <span>{props.t(SOURCE_HEALTH_MESSAGE[props.health])}</span>
    </p>
  );
}

function matchesFilters(
  problem: EditorProblem,
  severity: SeverityFilter,
  source: SourceFilter,
): boolean {
  return (
    (severity === "all" || problem.severity === severity) &&
    (source === "all" || problem.source === source)
  );
}

function locationLabel(problem: EditorProblem): string {
  return problem.line === undefined ? problem.file : `${problem.file}:${String(problem.line)}`;
}

function jumpRequest(root: string, problem: EditorProblem): OpenEditorFileRequest {
  return { root, path: problem.file, lineStart: problem.line ?? 1, lineEnd: problem.line ?? 1 };
}

function ProblemRow(props: {
  readonly problem: EditorProblem;
  readonly focused: boolean;
  readonly canJump: boolean;
  readonly t: ProblemsTranslate;
  readonly rowRef: (node: HTMLDivElement | null) => void;
  readonly onFocus: () => void;
  readonly onActivate: () => void;
}): ReactNode {
  const { problem, focused, canJump, t } = props;
  return (
    <div
      ref={props.rowRef}
      role="option"
      aria-selected={focused}
      data-testid="problems-row"
      tabIndex={focused ? 0 : -1}
      onFocus={props.onFocus}
      onClick={canJump ? props.onActivate : undefined}
      onKeyDown={
        canJump
          ? (event): void => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                props.onActivate();
              }
            }
          : undefined
      }
      aria-label={
        canJump
          ? t("problems.jumpToWithDetails", {
              severity: t(SEVERITY_LABEL[problem.severity]),
              message: problem.message,
              file: problem.file,
              line: problem.line ?? 1,
            })
          : `${t(SEVERITY_LABEL[problem.severity])}: ${problem.message} (${t("problems.noLocation")})`
      }
      style={{ ...ROW_BASE, cursor: canJump ? "pointer" : "default" }}
    >
      <span style={{ color: SEVERITY_COLOR[problem.severity], fontWeight: 600, minWidth: "64px" }}>
        {t(SEVERITY_LABEL[problem.severity])}
      </span>
      <span style={{ flex: 1 }}>{problem.message}</span>
      <span style={{ color: "var(--text-secondary)", fontVariantNumeric: "tabular-nums" }}>
        {locationLabel(problem)}
      </span>
    </div>
  );
}

function nextFocusId(key: string, ids: readonly string[], current: string | null): string | null {
  if (ids.length === 0) return null;
  const index = current === null ? -1 : ids.indexOf(current);
  if (key === "Home") return ids[0] ?? null;
  if (key === "End") return ids[ids.length - 1] ?? null;
  if (key === "ArrowDown") return ids[Math.min(index + 1, ids.length - 1)] ?? ids[0] ?? null;
  if (key === "ArrowUp") return ids[Math.max(index - 1, 0)] ?? null;
  return current;
}

function SeverityFilterSelect(props: {
  readonly value: SeverityFilter;
  readonly t: ProblemsTranslate;
  readonly onChange: (value: SeverityFilter) => void;
}): ReactNode {
  const { t } = props;
  return (
    <label style={{ display: "flex", gap: "4px", alignItems: "center" }}>
      {t("problems.filter.severity")}
      <select
        data-testid="problems-filter-severity"
        value={props.value}
        onChange={(event) => props.onChange(event.target.value as SeverityFilter)}
      >
        <option value="all">{t("problems.severity.all")}</option>
        <option value="error">{t("problems.severity.error")}</option>
        <option value="warning">{t("problems.severity.warning")}</option>
        <option value="info">{t("problems.severity.info")}</option>
      </select>
    </label>
  );
}

function SourceFilterSelect(props: {
  readonly value: SourceFilter;
  readonly t: ProblemsTranslate;
  readonly onChange: (value: SourceFilter) => void;
}): ReactNode {
  const { t } = props;
  return (
    <label style={{ display: "flex", gap: "4px", alignItems: "center" }}>
      {t("problems.filter.source")}
      <select
        data-testid="problems-filter-source"
        value={props.value}
        onChange={(event) => props.onChange(event.target.value as SourceFilter)}
      >
        <option value="all">{t("problems.source.all")}</option>
        <option value="language-diagnostic">{t("problems.source.diagnostic")}</option>
        <option value="verification">{t("problems.source.verification")}</option>
      </select>
    </label>
  );
}

export function ProblemsPanel({ root, openEditorFile }: ProblemsPanelProps): ReactNode {
  const t = useProblemsTranslate();
  // Issue #2092 (epic-level fix-up) — problems are scoped per project root: a multi-window desktop
  // can have editor panes open for different projects simultaneously, and each project's Problems
  // panel must show only that project's diagnostics/failures.
  const subscribe = useCallback(
    (listener: () => void) => subscribeEditorProblems(root, listener),
    [root],
  );
  const getSnapshot = useCallback(() => getEditorProblemsStoreSnapshot(root), [root]);
  const storeSnapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const { problems: allProblems, verificationSourceHealth } = storeSnapshot;
  const [severity, setSeverity] = useState<SeverityFilter>("all");
  const [source, setSource] = useState<SourceFilter>("all");
  const [focusId, setFocusId] = useState<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());

  const snapshot = useMemo(
    () =>
      buildEditorProblemsSnapshot(allProblems.filter((p) => matchesFilters(p, severity, source))),
    [allProblems, severity, source],
  );
  const visibleIds = useMemo(() => snapshot.problems.map((p) => p.id), [snapshot]);
  const activeFocusId =
    focusId !== null && visibleIds.includes(focusId) ? focusId : (visibleIds[0] ?? null);

  // Roving tabindex is only half of the APG pattern: keyboard movement must also move DOM focus.
  // Keep refs keyed by stable problem id and focus after React commits the new active option.
  useEffect(() => {
    if (focusId !== null) rowRefs.current.get(focusId)?.focus();
  }, [focusId]);

  const activate = (problem: EditorProblem): void => {
    if (openEditorFile === undefined || problem.line === undefined) return;
    openEditorFile(jumpRequest(root, problem));
  };

  // The listbox container owns roving-tabindex movement; each option owns Enter/Space activation.
  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const next = nextFocusId(event.key, visibleIds, activeFocusId);
    if (next !== activeFocusId) {
      event.preventDefault();
      setFocusId(next);
    }
  };

  const emptyStateContent =
    verificationSourceHealth === "healthy" ? (
      <p data-testid="problems-empty">{t("problems.empty")}</p>
    ) : null;

  // #2723 (S3358): the allProblems/snapshot ternary chain nested a second ternary inside the
  // first branch; extracted to a named render function that early-returns each state instead.
  const renderProblemsBody = (): ReactNode => {
    if (allProblems.length === 0) return emptyStateContent;
    if (snapshot.problems.length === 0) {
      return <p data-testid="problems-no-match">{t("problems.noMatch")}</p>;
    }
    return (
      <div
        role="listbox"
        aria-label={t("problems.title")}
        aria-live="polite"
        aria-relevant="additions"
        data-testid="problems-list"
        tabIndex={-1}
        style={LIST_STYLE}
        onKeyDown={onListKeyDown}
      >
        {snapshot.problems.map((problem) => (
          <ProblemRow
            key={problem.id}
            problem={problem}
            focused={problem.id === activeFocusId}
            canJump={openEditorFile !== undefined && problem.line !== undefined}
            t={t}
            rowRef={(node) => {
              if (node === null) rowRefs.current.delete(problem.id);
              else rowRefs.current.set(problem.id, node);
            }}
            onFocus={() => {
              setFocusId(problem.id);
            }}
            onActivate={() => {
              activate(problem);
            }}
          />
        ))}
      </div>
    );
  };

  return (
    <section aria-label={t("problems.panelLabel")} style={PANEL_STYLE}>
      {/* #2721 — the filter row groups two real form controls, so it is a <fieldset> (the element
          that owns role="group") named by aria-label rather than a <legend>. The filter row sets
          neither padding nor border, so NATIVE_FIELDSET_RESET_STYLE drops all four user-agent
          defaults a <fieldset> arrives with. */}
      <fieldset
        aria-label={t("problems.filterGroup")}
        style={{ ...NATIVE_FIELDSET_RESET_STYLE, ...FILTER_ROW_STYLE }}
      >
        <SeverityFilterSelect value={severity} t={t} onChange={setSeverity} />
        <SourceFilterSelect value={source} t={t} onChange={setSource} />
        {snapshot.truncated ? (
          <span data-testid="problems-truncated">
            {t("problems.truncated", {
              shown: snapshot.problems.length,
              total: snapshot.totalCount,
            })}
          </span>
        ) : null}
      </fieldset>
      <p style={{ margin: 0, color: "var(--text-secondary)", fontSize: "0.85em" }}>
        {t("problems.openFilesOnly")}
      </p>
      <VerificationSourceHealth health={verificationSourceHealth} t={t} />
      {renderProblemsBody()}
    </section>
  );
}
