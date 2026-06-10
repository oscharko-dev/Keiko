"use client";

// Quality Intelligence run launcher (Issue #280, Epic #270).
// Source input (requirements text + policy profile) → start a run → live SSE progress → on
// completion notify the panel to refresh + select the new run. Accessible: labelled inputs,
// aria-live progress region, focus-visible controls, 24×24 min targets.

import { useCallback, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import type {
  QualityIntelligenceInlineSource,
  QualityIntelligenceRunStreamMessage,
  QualityIntelligenceSkippedSource,
  QualityIntelligenceStartRunRequest,
} from "@oscharko-dev/keiko-contracts";
import { startQiRun } from "@/lib/quality-intelligence-api";
import { formatCodedError, formatError } from "./qiShared";
import { buildConnectedRunSources } from "./connectedSources";
import type { ConnectedRunSource } from "./connectedSources";

const PROFILES: ReadonlyArray<{ id: string; label: string }> = [
  { id: "regression-default", label: "Regression (default)" },
  { id: "banking-default", label: "Banking" },
  { id: "insurance-default", label: "Insurance" },
];

interface Progress {
  readonly phase: string;
  readonly stageName: string | null;
  readonly candidates: number;
  readonly findings: number;
  readonly atomCount: number | null;
  // Coverage notice (Epic #729): sources dropped past the 16-source cap, and sources skipped because
  // they ingested to nothing usable while the healthy sources still produced the run.
  readonly droppedSourceCount: number;
  readonly skippedSources: readonly QualityIntelligenceSkippedSource[];
}

const INITIAL_PROGRESS: Progress = {
  phase: "Starting…",
  stageName: null,
  candidates: 0,
  findings: 0,
  atomCount: null,
  droppedSourceCount: 0,
  skippedSources: [],
};

function reduceProgress(prev: Progress, msg: QualityIntelligenceRunStreamMessage): Progress {
  if (msg.type === "accepted") {
    return {
      ...prev,
      phase: "Ingested sources",
      atomCount: msg.atomCount,
      droppedSourceCount: msg.droppedSourceCount ?? 0,
      skippedSources: msg.skippedSources ?? [],
    };
  }
  if (msg.type === "event") {
    const candidates = msg.kind === "candidate:proposed" ? prev.candidates + 1 : prev.candidates;
    const findings = msg.kind === "finding:recorded" ? prev.findings + 1 : prev.findings;
    const stageName = msg.kind === "stage:started" ? (msg.stageName ?? null) : prev.stageName;
    return { ...prev, phase: msg.kind, stageName, candidates, findings };
  }
  return prev;
}

export interface RunLauncherProps {
  readonly onRunCompleted?:
    | ((runId: string, recheckableSources: readonly QualityIntelligenceInlineSource[]) => void)
    | undefined;
  readonly startImpl?: typeof startQiRun;
  /**
   * Folder bound via a Workspace relationship edge to a Files window (Epic #270 Slice 1). When
   * present it is the default "Generate" source — so a knowledge worker connects a Fachkonzept
   * folder and generates from it without typing a path. Manual input (below) still overrides it.
   */
  readonly connectedRoot?: string | null;
  /**
   * Single active file in the connected Files window (Epic #709, Issue #714). When the connected
   * Files window has a focused file, it takes precedence over the folder root: Generate draws from
   * exactly that one Fachkonzept document. Manual input still overrides it.
   */
  readonly connectedFilePath?: string | null;
  /**
   * All connected Files window roots (Epic #729 N+1). When non-empty, Generate sends one workspace
   * source per root (deduped, capped at 16). Falls back to `connectedRoot` when empty/undefined.
   * Manual input and `connectedFilePath` both still take precedence.
   */
  readonly connectedRoots?: readonly string[] | undefined;
  /**
   * Capsule ids from connected Connector windows (Epic #710 #718). Each becomes one capsule source
   * appended after workspace sources. Manual input and connectedFilePath take precedence.
   */
  readonly connectedCapsuleIds?: readonly string[] | undefined;
  /**
   * Capsule-set ids from connected Connector windows (Epic #710 #718). Each becomes one capsule-set
   * source appended after the capsule sources; the server expands the set into its member capsules.
   * Manual input and connectedFilePath take precedence.
   */
  readonly connectedCapsuleSetIds?: readonly string[] | undefined;
  /**
   * Figma Snapshot run ids from connected Figma Snapshot windows (Epic #750 #756). Each becomes one
   * figma-snapshot source appended after capsule-set sources. The server loads the stored snapshot
   * and injects the IR into the QI generation context.
   */
  readonly connectedFigmaSnapshotRunIds?: readonly string[] | undefined;
}

// Human-readable kind name for a connected source, used in the accessible connected-source list.
function sourceKindLabel(source: ConnectedRunSource): string {
  switch (source.kind) {
    case "file":
      return "File";
    case "workspace":
      return "Folder";
    case "capsule":
      return "Capsule";
    case "capsule-set":
      return "Capsule set";
    case "figma-snapshot":
      return "Figma snapshot";
  }
}

// The displayable value (path or opaque id) for a connected source.
function sourceValue(source: ConnectedRunSource): string {
  switch (source.kind) {
    case "file":
    case "workspace":
      return source.path;
    case "capsule":
      return source.capsuleId;
    case "capsule-set":
      return source.capsuleSetId;
    case "figma-snapshot":
      return source.snapshotRunId;
  }
}

// Stable React key / dedupe key for a connected source (kind + path or id).
function sourceItemKey(source: ConnectedRunSource): string {
  return `${source.kind}:${sourceValue(source)}`;
}

function recheckableSourcesForWindow(
  sources: QualityIntelligenceStartRunRequest["sources"],
): readonly QualityIntelligenceInlineSource[] {
  return sources.filter((source) => source.kind !== "requirements");
}

export function RunLauncher({
  onRunCompleted,
  startImpl = startQiRun,
  connectedRoot = null,
  connectedFilePath = null,
  connectedRoots,
  connectedCapsuleIds,
  connectedCapsuleSetIds,
  connectedFigmaSnapshotRunIds,
}: RunLauncherProps): ReactNode {
  const [label, setLabel] = useState("");
  const [sourceKind, setSourceKind] = useState<"requirements" | "workspace">("requirements");
  const [text, setText] = useState("");
  const [path, setPath] = useState("");
  const [profileId, setProfileId] = useState("regression-default");
  const [seed, setSeed] = useState("");
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<Progress>(INITIAL_PROGRESS);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const completedRunIdRef = useRef<string | null>(null);

  // Fold EVERY connected Files/Connector/Figma window into one deduped, capped multi-source list
  // (Epic #729 N+1): a focused single file, connected folders, capsules, capsule-sets, AND figma
  // snapshots are aggregated together — the additive replacement for the old file-exclusive
  // precedence that suppressed the rest. Manual input (below) still overrides the connected sources.
  const connectedSources = buildConnectedRunSources({
    connectedRoot,
    connectedFilePath,
    connectedRoots,
    connectedCapsuleIds,
    connectedCapsuleSetIds,
    connectedFigmaSnapshotRunIds,
  });
  const hasConnected = connectedSources.length > 0;
  const manualReady =
    sourceKind === "requirements" ? text.trim().length > 0 : path.trim().length > 0;
  const ready = manualReady || hasConnected;
  const trimmedSeed = seed.trim();
  const parsedSeed =
    trimmedSeed.length === 0
      ? undefined
      : /^\d+$/u.test(trimmedSeed)
        ? Number(trimmedSeed)
        : Number.NaN;
  const seedValid =
    parsedSeed === undefined || (Number.isSafeInteger(parsedSeed) && Number.isFinite(parsedSeed));
  // Generate stays focusable when blocked (aria-disabled, not native disabled) so keyboard and
  // screen-reader users can reach it and hear WHY it is inactive via aria-describedby — the same
  // governance pattern as GovernedActionButton in CandidatesPane (Epic #712).
  const generateBlocked = !ready || !seedValid;
  const generateHintId = useId();
  const seedErrorId = useId();
  const labelHintId = useId();
  const generateDescribedBy = !ready ? generateHintId : !seedValid ? seedErrorId : undefined;

  const onMessage = useCallback((msg: QualityIntelligenceRunStreamMessage): void => {
    if (msg.type === "accepted") completedRunIdRef.current = msg.runId;
    if (msg.type === "error") setError(formatCodedError(msg.code, msg.message));
    setProgress((prev) => reduceProgress(prev, msg));
  }, []);

  const handleStart = useCallback(async (): Promise<void> => {
    // Defensive guard — the Generate button already no-ops while blocked (aria-disabled pattern),
    // and an invalid seed surfaces as an inline field error next to the input.
    if (!ready || running || !seedValid) return;
    setRunning(true);
    setError(null);
    setProgress(INITIAL_PROGRESS);
    completedRunIdRef.current = null;
    const controller = new AbortController();
    abortRef.current = controller;
    // Precedence: manual input (requirements text or a folder path) overrides everything; otherwise
    // ALL connected sources go together (Epic #729 N+1 — file + folders + capsules in one request).
    const sources: QualityIntelligenceStartRunRequest["sources"] =
      sourceKind === "requirements" && text.trim().length > 0
        ? [{ kind: "requirements", label: label.trim() || "Requirements", text }]
        : sourceKind === "workspace" && path.trim().length > 0
          ? [{ kind: "workspace", label: label.trim() || "Folder", path: path.trim() }]
          : (connectedSources as QualityIntelligenceStartRunRequest["sources"]);
    const request: QualityIntelligenceStartRunRequest = {
      sources,
      profileId,
      ...(parsedSeed !== undefined ? { seed: parsedSeed } : {}),
    };
    try {
      await startImpl(request, controller.signal, onMessage);
      const runId = completedRunIdRef.current;
      if (runId !== null) onRunCompleted?.(runId, recheckableSourcesForWindow(sources));
    } catch (err) {
      if (!controller.signal.aborted) setError(formatError(err));
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  }, [
    ready,
    sourceKind,
    text,
    path,
    label,
    profileId,
    running,
    connectedSources,
    onMessage,
    onRunCompleted,
    parsedSeed,
    seedValid,
    startImpl,
  ]);

  const handleCancel = useCallback((): void => {
    abortRef.current?.abort();
  }, []);

  // Coverage-notice sentences are built once and shared by the visible notice AND the persistent
  // sr-only live region (uiux-fix F047 C155: the notice was a role="status" element inserted
  // together with its content, which screen readers often skip).
  const droppedNotice =
    progress.droppedSourceCount > 0
      ? `${progress.droppedSourceCount.toString()} source${progress.droppedSourceCount !== 1 ? "s" : ""} over the 16-source limit ${progress.droppedSourceCount !== 1 ? "were" : "was"} not included.`
      : null;
  const skippedNotice =
    progress.skippedSources.length > 0
      ? `${progress.skippedSources.length.toString()} connected source${progress.skippedSources.length !== 1 ? "s" : ""} could not be read and ${progress.skippedSources.length !== 1 ? "were" : "was"} skipped: ${progress.skippedSources.map((s) => s.label).join(", ")}.`
      : null;
  const coverageAnnouncement = [droppedNotice, skippedNotice]
    .filter((line): line is string => line !== null)
    .join(" ");

  return (
    <section className="qi-launcher" aria-label="Start a Quality Intelligence run">
      <header className="qi-col-header">
        <h2 className="qi-col-title">New run</h2>
      </header>
      <div className="qi-launcher-body">
        {connectedSources.length === 1 && connectedSources[0] !== undefined ? (
          <div className="qi-connected-source" data-testid="qi-connected-source">
            <span className="qi-connected-kind">
              Connected {sourceKindLabel(connectedSources[0]).toLowerCase()}
            </span>
            <span
              className="qi-connected-path qi-monospace"
              title={sourceValue(connectedSources[0])}
            >
              {sourceValue(connectedSources[0])}
            </span>
            <span className="qi-connected-hint">
              {manualReady
                ? "Manual input below overrides the connected source for this run."
                : `Generate uses the connected ${sourceKindLabel(connectedSources[0]).toLowerCase()}.`}
            </span>
          </div>
        ) : connectedSources.length > 1 ? (
          <div className="qi-connected-source" data-testid="qi-connected-source">
            <span className="qi-connected-kind">
              Connected sources ({connectedSources.length.toString()})
            </span>
            <ul className="qi-connected-roots" aria-label="Connected sources">
              {connectedSources.map((s) => (
                <li key={sourceItemKey(s)} className="qi-connected-root-item">
                  <span className="qi-connected-root-name">{sourceKindLabel(s)}</span>
                  <span className="qi-connected-path qi-monospace" title={sourceValue(s)}>
                    {sourceValue(s)}
                  </span>
                </li>
              ))}
            </ul>
            <span className="qi-connected-hint">
              {manualReady
                ? "Manual input below overrides the connected sources for this run."
                : "Generate uses all connected sources."}
            </span>
          </div>
        ) : null}
        <div className="qi-launcher-row">
          <label className="qi-field">
            <span className="qi-field-label">Source label</span>
            <input
              type="text"
              className="qi-input"
              value={label}
              placeholder="e.g. Funds Transfer — acceptance criteria"
              disabled={running}
              aria-describedby={hasConnected && !manualReady ? labelHintId : undefined}
              onChange={(e) => {
                setLabel(e.target.value);
              }}
            />
            {hasConnected && !manualReady ? (
              <span className="qi-field-hint" id={labelHintId}>
                Applies to manual input only — connected sources use their own labels.
              </span>
            ) : null}
          </label>
          <label className="qi-field qi-field-kind">
            <span className="qi-field-label">Source type</span>
            <select
              className="qi-select"
              value={sourceKind}
              disabled={running}
              onChange={(e) => {
                setSourceKind(e.target.value === "workspace" ? "workspace" : "requirements");
                setError(null);
              }}
            >
              <option value="requirements">Requirements text</option>
              <option value="workspace">Local folder</option>
            </select>
          </label>
        </div>
        {sourceKind === "requirements" ? (
          <label className="qi-field">
            <span className="qi-field-label">Requirements</span>
            <textarea
              className="qi-textarea"
              value={text}
              rows={6}
              placeholder="Paste requirements or acceptance criteria, one statement per line."
              disabled={running}
              onChange={(e) => {
                setText(e.target.value);
              }}
            />
          </label>
        ) : (
          <label className="qi-field">
            <span className="qi-field-label">Folder path</span>
            <input
              type="text"
              className="qi-input"
              value={path}
              placeholder="/absolute/path/to/requirements-folder"
              disabled={running}
              onChange={(e) => {
                setPath(e.target.value);
              }}
            />
          </label>
        )}
        <div className="qi-launcher-controls">
          <label className="qi-field qi-field-inline">
            <span className="qi-field-label">Policy profile</span>
            <select
              className="qi-select"
              value={profileId}
              disabled={running}
              onChange={(e) => {
                setProfileId(e.target.value);
              }}
            >
              {PROFILES.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <label className="qi-field qi-field-inline">
            <span className="qi-field-label">Seed (optional)</span>
            <input
              type="number"
              min={0}
              step={1}
              className="qi-input"
              value={seed}
              placeholder="e.g. 42"
              disabled={running}
              aria-invalid={seedValid ? undefined : true}
              aria-describedby={seedValid ? undefined : seedErrorId}
              onChange={(e) => {
                setSeed(e.target.value);
                setError(null);
              }}
            />
            {!seedValid ? (
              <span className="qi-field-error" id={seedErrorId}>
                Seed must be a non-negative integer.
              </span>
            ) : null}
          </label>
          {/* ONE persistent button that swaps label/handler between Generate and Cancel: two
              conditionally-rendered buttons would unmount the focused element on every state
              change and drop keyboard focus onto <body> (WCAG 2.4.3, audit C031). */}
          <button
            type="button"
            className={running ? "qi-btn qi-btn-secondary" : "qi-btn qi-btn-primary"}
            aria-disabled={(!running && generateBlocked) || undefined}
            aria-describedby={running ? undefined : generateDescribedBy}
            onClick={() => {
              if (running) {
                handleCancel();
                return;
              }
              if (generateBlocked) return;
              void handleStart();
            }}
          >
            {running ? "Cancel" : "Generate test cases"}
          </button>
          {!running && !ready ? (
            <span className="qi-generate-hint" id={generateHintId}>
              Add requirements text, a folder path, or connect a source to generate.
            </span>
          ) : null}
        </div>
        {running ? (
          <div
            className="qi-progress"
            role="status"
            aria-live="polite"
            aria-label="Run progress"
            data-testid="qi-launch-progress"
          >
            <span className="qi-progress-spinner" aria-hidden="true" />
            <span className="qi-progress-text">
              {progress.stageName !== null ? `Stage: ${progress.stageName} · ` : ""}
              {progress.candidates.toString()} test case{progress.candidates !== 1 ? "s" : ""}
              {/* "1 finding", not "1 findings" — same singular/plural care as the test-case count
                  two tokens earlier (uiux-fix F047 C276). */}
              {progress.findings > 0
                ? ` · ${progress.findings.toString()} finding${progress.findings !== 1 ? "s" : ""}`
                : ""}
            </span>
          </div>
        ) : null}
        {/* Persistent live region for the coverage notice (uiux-fix F047 C155) — mounted from the
            first render; the visible notice below stays conditional and carries no live role. */}
        <p className="sr-only" role="status" aria-live="polite">
          {coverageAnnouncement}
        </p>
        {droppedNotice !== null || skippedNotice !== null ? (
          <div className="qi-coverage-notice" data-testid="qi-coverage-notice">
            {droppedNotice !== null ? <p className="qi-coverage-line">{droppedNotice}</p> : null}
            {skippedNotice !== null ? <p className="qi-coverage-line">{skippedNotice}</p> : null}
          </div>
        ) : null}
        {error !== null ? (
          <p className="lk-alert" role="alert" data-testid="qi-launch-error">
            {error}
          </p>
        ) : null}
      </div>
    </section>
  );
}
