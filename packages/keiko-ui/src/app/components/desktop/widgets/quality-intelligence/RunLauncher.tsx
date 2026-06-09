"use client";

// Quality Intelligence run launcher (Issue #280, Epic #270).
// Source input (requirements text + policy profile) → start a run → live SSE progress → on
// completion notify the panel to refresh + select the new run. Accessible: labelled inputs,
// aria-live progress region, focus-visible controls, 24×24 min targets.

import { useCallback, useRef, useState } from "react";
import type { ReactNode } from "react";
import type {
  QualityIntelligenceCapsuleSource,
  QualityIntelligenceCapsuleSetSource,
  QualityIntelligenceFigmaSnapshotSource,
  QualityIntelligenceRunStreamMessage,
  QualityIntelligenceStartRunRequest,
  QualityIntelligenceWorkspaceSource,
} from "@oscharko-dev/keiko-contracts";
import { startQiRun } from "@/lib/quality-intelligence-api";
import { ApiError } from "@/lib/api";
import { MAX_SCOPES } from "../../hooks/workspaceActions";

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
}

const INITIAL_PROGRESS: Progress = {
  phase: "Starting…",
  stageName: null,
  candidates: 0,
  findings: 0,
  atomCount: null,
};

function formatError(err: unknown): string {
  if (err instanceof ApiError) return `${err.code}: ${err.message}`;
  if (err instanceof Error) return err.message;
  return "An unexpected error occurred.";
}

function reduceProgress(prev: Progress, msg: QualityIntelligenceRunStreamMessage): Progress {
  if (msg.type === "accepted") {
    return { ...prev, phase: "Ingested sources", atomCount: msg.atomCount };
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
  readonly onRunCompleted?: ((runId: string) => void) | undefined;
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

function baseName(p: string): string {
  const parts = p.split(/[\\/]/u).filter((s) => s.length > 0);
  return parts.length > 0 ? (parts[parts.length - 1] ?? p) : p;
}

function isAbsoluteBrowserPath(path: string): boolean {
  return (
    path.startsWith("/") ||
    /^[A-Za-z]:[/\\]/u.test(path) ||
    path.startsWith("\\\\") ||
    path.startsWith("//")
  );
}

function toPortablePath(path: string): string {
  return path.replaceAll("\\", "/");
}

function trimTrailingSeparators(path: string): string {
  if (/^[A-Za-z]:[/\\]?$/u.test(path)) return path.replaceAll("\\", "/");
  if (/^\/\/[^/]+\/[^/]+$/u.test(toPortablePath(path))) return toPortablePath(path);
  return toPortablePath(path).replace(/\/+$/u, "");
}

function resolveConnectedFilePath(
  connectedRoot: string | null,
  connectedFilePath: string | null,
): string | null {
  const candidate = connectedFilePath?.trim() ?? "";
  if (candidate.length === 0) return null;
  if (isAbsoluteBrowserPath(candidate)) return candidate;

  const root = connectedRoot?.trim() ?? "";
  if (root.length === 0) return null;
  const joinedRoot = trimTrailingSeparators(root);
  const relativePath = toPortablePath(candidate).replace(/^\/+/u, "");
  return `${joinedRoot}/${relativePath}`;
}

/**
 * Builds workspace sources from connected roots. Dedupes and caps at MAX_SCOPES.
 * Falls back to `fallbackRoot` when `roots` is empty/undefined (back-compat with single root).
 */
function buildConnectedSources(
  roots: readonly string[] | null | undefined,
  fallbackRoot: string | null,
): QualityIntelligenceWorkspaceSource[] {
  const effective =
    roots !== undefined && roots !== null && roots.length > 0
      ? roots
      : fallbackRoot !== null
        ? [fallbackRoot]
        : [];
  const seen = new Set<string>();
  const result: QualityIntelligenceWorkspaceSource[] = [];
  for (const root of effective) {
    if (result.length >= MAX_SCOPES) break;
    if (seen.has(root)) continue;
    seen.add(root);
    result.push({ kind: "workspace", label: baseName(root), path: root });
  }
  return result;
}

/**
 * Builds capsule sources from connected capsule ids. Dedupes and caps at MAX_SCOPES.
 * Label is the capsule id itself (opaque string — no filesystem baseName).
 */
function buildCapsuleSources(
  capsuleIds: readonly string[] | null | undefined,
): QualityIntelligenceCapsuleSource[] {
  if (capsuleIds === undefined || capsuleIds === null || capsuleIds.length === 0) return [];
  const seen = new Set<string>();
  const result: QualityIntelligenceCapsuleSource[] = [];
  for (const id of capsuleIds) {
    if (result.length >= MAX_SCOPES) break;
    if (seen.has(id)) continue;
    seen.add(id);
    result.push({ kind: "capsule", label: id, capsuleId: id });
  }
  return result;
}

/**
 * Builds capsule-set sources from connected capsule-set ids. Dedupes and caps at MAX_SCOPES.
 * Label is the capsule-set id itself (opaque string — no filesystem baseName).
 */
function buildCapsuleSetSources(
  capsuleSetIds: readonly string[] | null | undefined,
): QualityIntelligenceCapsuleSetSource[] {
  if (capsuleSetIds === undefined || capsuleSetIds === null || capsuleSetIds.length === 0)
    return [];
  const seen = new Set<string>();
  const result: QualityIntelligenceCapsuleSetSource[] = [];
  for (const id of capsuleSetIds) {
    if (result.length >= MAX_SCOPES) break;
    if (seen.has(id)) continue;
    seen.add(id);
    result.push({ kind: "capsule-set", label: id, capsuleSetId: id });
  }
  return result;
}

/**
 * Builds figma-snapshot sources from connected snapshot run ids (Epic #750 #756).
 * Dedupes and caps at MAX_SCOPES. Label is the run id itself (opaque string).
 */
function buildFigmaSnapshotSources(
  runIds: readonly string[] | null | undefined,
): QualityIntelligenceFigmaSnapshotSource[] {
  if (runIds === undefined || runIds === null || runIds.length === 0) return [];
  const seen = new Set<string>();
  const result: QualityIntelligenceFigmaSnapshotSource[] = [];
  for (const id of runIds) {
    if (result.length >= MAX_SCOPES) break;
    if (seen.has(id)) continue;
    seen.add(id);
    result.push({ kind: "figma-snapshot", label: id, snapshotRunId: id });
  }
  return result;
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

  // A connected Files window contributes a default Generate source. A focused file takes precedence
  // over the folder root, so connecting a single Fachkonzept document generates from that one file.
  // Connected Connector windows contribute capsule sources (appended after workspace sources).
  const connectedFile = resolveConnectedFilePath(connectedRoot, connectedFilePath);
  const connectedFolder = connectedRoot ?? null;
  const workspaceSources = buildConnectedSources(connectedRoots, connectedFolder);
  const capsuleSources = buildCapsuleSources(connectedCapsuleIds);
  const capsuleSetSources = buildCapsuleSetSources(connectedCapsuleSetIds);
  const figmaSnapshotSources = buildFigmaSnapshotSources(connectedFigmaSnapshotRunIds);
  const connectedSourceCount =
    workspaceSources.length +
    capsuleSources.length +
    capsuleSetSources.length +
    figmaSnapshotSources.length;
  const hasConnected = connectedFile !== null || connectedSourceCount > 0;
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

  const onMessage = useCallback((msg: QualityIntelligenceRunStreamMessage): void => {
    if (msg.type === "accepted") completedRunIdRef.current = msg.runId;
    if (msg.type === "error") setError(`${msg.code}: ${msg.message}`);
    setProgress((prev) => reduceProgress(prev, msg));
  }, []);

  const handleStart = useCallback(async (): Promise<void> => {
    if (!ready || running) return;
    if (!seedValid) {
      setError("Seed must be a non-negative integer.");
      return;
    }
    setRunning(true);
    setError(null);
    setProgress(INITIAL_PROGRESS);
    completedRunIdRef.current = null;
    const controller = new AbortController();
    abortRef.current = controller;
    // Precedence: manual input wins; then connected file (single); then folders + capsules combined.
    const sources: QualityIntelligenceStartRunRequest["sources"] =
      sourceKind === "requirements" && text.trim().length > 0
        ? [{ kind: "requirements", label: label.trim() || "Requirements", text }]
        : sourceKind === "workspace" && path.trim().length > 0
          ? [{ kind: "workspace", label: label.trim() || "Folder", path: path.trim() }]
          : connectedFile !== null
            ? [
                {
                  kind: "file",
                  label: label.trim() || baseName(connectedFile),
                  path: connectedFile,
                },
              ]
            : ([
                ...workspaceSources,
                ...capsuleSources,
                ...capsuleSetSources,
                ...figmaSnapshotSources,
              ] as QualityIntelligenceStartRunRequest["sources"]);
    const request: QualityIntelligenceStartRunRequest = {
      sources,
      profileId,
      ...(parsedSeed !== undefined ? { seed: parsedSeed } : {}),
    };
    try {
      await startImpl(request, controller.signal, onMessage);
      const runId = completedRunIdRef.current;
      if (runId !== null) onRunCompleted?.(runId);
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
    connectedFile,
    workspaceSources,
    capsuleSources,
    capsuleSetSources,
    figmaSnapshotSources,
    onMessage,
    onRunCompleted,
    parsedSeed,
    seedValid,
    startImpl,
  ]);

  const handleCancel = useCallback((): void => {
    abortRef.current?.abort();
  }, []);

  return (
    <section className="qi-launcher" aria-label="Start a Quality Intelligence run">
      <header className="qi-col-header">
        <h2 className="qi-col-title">New run</h2>
      </header>
      <div className="qi-launcher-body">
        {connectedFile !== null ? (
          <div className="qi-connected-source" data-testid="qi-connected-source">
            <span className="qi-connected-kind">Connected file</span>
            <span className="qi-connected-path qi-monospace" title={connectedFile}>
              {connectedFile}
            </span>
            <span className="qi-connected-hint">Generate uses the connected file.</span>
          </div>
        ) : connectedSourceCount > 1 ? (
          <div className="qi-connected-source" data-testid="qi-connected-source">
            <span className="qi-connected-kind">
              Connected sources ({connectedSourceCount.toString()})
            </span>
            <ul className="qi-connected-roots" aria-label="Connected sources">
              {workspaceSources.map((s) => (
                <li key={s.path} className="qi-connected-root-item">
                  <span className="qi-connected-root-name">{s.label}</span>
                  <span className="qi-connected-path qi-monospace" title={s.path}>
                    {s.path}
                  </span>
                </li>
              ))}
              {capsuleSources.map((s) => (
                <li key={s.capsuleId} className="qi-connected-root-item">
                  <span className="qi-connected-root-name">Capsule</span>
                  <span className="qi-connected-path qi-monospace" title={s.capsuleId}>
                    {s.capsuleId}
                  </span>
                </li>
              ))}
              {capsuleSetSources.map((s) => (
                <li key={s.capsuleSetId} className="qi-connected-root-item">
                  <span className="qi-connected-root-name">Capsule set</span>
                  <span className="qi-connected-path qi-monospace" title={s.capsuleSetId}>
                    {s.capsuleSetId}
                  </span>
                </li>
              ))}
            </ul>
            <span className="qi-connected-hint">Generate uses all connected sources.</span>
          </div>
        ) : workspaceSources.length === 1 ? (
          <div className="qi-connected-source" data-testid="qi-connected-source">
            <span className="qi-connected-kind">Connected folder</span>
            <span
              className="qi-connected-path qi-monospace"
              title={workspaceSources[0]?.path ?? ""}
            >
              {workspaceSources[0]?.path ?? ""}
            </span>
            <span className="qi-connected-hint">Generate uses the connected source.</span>
          </div>
        ) : capsuleSources.length === 1 ? (
          <div className="qi-connected-source" data-testid="qi-connected-source">
            <span className="qi-connected-kind">Connected capsule</span>
            <span
              className="qi-connected-path qi-monospace"
              title={capsuleSources[0]?.capsuleId ?? ""}
            >
              {capsuleSources[0]?.capsuleId ?? ""}
            </span>
            <span className="qi-connected-hint">Generate uses the connected capsule.</span>
          </div>
        ) : capsuleSetSources.length === 1 ? (
          <div className="qi-connected-source" data-testid="qi-connected-source">
            <span className="qi-connected-kind">Connected capsule set</span>
            <span
              className="qi-connected-path qi-monospace"
              title={capsuleSetSources[0]?.capsuleSetId ?? ""}
            >
              {capsuleSetSources[0]?.capsuleSetId ?? ""}
            </span>
            <span className="qi-connected-hint">Generate uses the connected capsule set.</span>
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
              onChange={(e) => {
                setLabel(e.target.value);
              }}
            />
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
              onChange={(e) => {
                setSeed(e.target.value);
                setError(null);
              }}
            />
          </label>
          {running ? (
            <button type="button" className="qi-btn qi-btn-secondary" onClick={handleCancel}>
              Cancel
            </button>
          ) : (
            <button
              type="button"
              className="qi-btn qi-btn-primary"
              disabled={!ready || !seedValid}
              onClick={() => {
                void handleStart();
              }}
            >
              Generate test cases
            </button>
          )}
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
              {progress.findings > 0 ? ` · ${progress.findings.toString()} findings` : ""}
            </span>
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
