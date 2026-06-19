"use client";

// Quality Intelligence run launcher (Issue #280, Epic #270).
// Source input (requirements text + policy profile) → start a run → live SSE progress → on
// completion notify the panel to refresh + select the new run. Accessible: labelled inputs,
// aria-live progress region, focus-visible controls, 24×24 min targets.

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent,
} from "react";
import type { ReactNode } from "react";
import type {
  QualityIntelligenceFigmaSnapshotSource,
  QualityIntelligenceImageSource,
  QualityIntelligenceInlineSource,
  QualityIntelligenceRunStreamMessage,
  QualityIntelligenceSkippedSource,
  QualityIntelligenceStartRunRequest,
} from "@oscharko-dev/keiko-contracts";
import { fetchFilesTree, fetchProjects } from "@/lib/api";
import {
  dirname,
  displayLocalPath,
  LocalFileBrowserDialog,
} from "@/app/components/desktop/local-files/LocalFileBrowserDialog";
import { startQiRun } from "@/lib/quality-intelligence-api";
import {
  fetchCapsules,
  fetchCapsuleSets,
  type CapsuleListEntry,
  type CapsuleSetListEntry,
} from "@/lib/local-knowledge-api";
import { Icons } from "@/app/components/desktop/Icons";
import KeikoSelect from "../../KeikoSelect";
import { formatCodedError, formatError } from "./qiShared";
import { buildConnectedRunSources } from "./connectedSources";
import type { ConnectedRunSource } from "./connectedSources";

const PROFILES: ReadonlyArray<{ id: string; label: string }> = [
  { id: "regression-default", label: "Regression (default)" },
  { id: "banking-default", label: "Banking" },
  { id: "insurance-default", label: "Insurance" },
];

type ManualSourceKind = "requirements" | "workspace" | "file" | "capsule" | "capsule-set";
type FetchCapsulesFn = typeof fetchCapsules;
type FetchCapsuleSetsFn = typeof fetchCapsuleSets;
type FetchProjectsFn = typeof fetchProjects;
type FetchFilesTreeFn = typeof fetchFilesTree;

const SOURCE_KIND_OPTIONS: ReadonlyArray<{ id: ManualSourceKind; label: string; hint: string }> = [
  { id: "requirements", label: "Requirements", hint: "Paste text" },
  { id: "workspace", label: "Folder", hint: "Browse local" },
  { id: "file", label: "File", hint: "Browse local" },
  { id: "capsule", label: "Capsule", hint: "Local Knowledge" },
  { id: "capsule-set", label: "Capsule set", hint: "Local Knowledge" },
];

function SourceKindIcon({ kind }: { readonly kind: ManualSourceKind }): ReactNode {
  if (kind === "requirements") return <Icons.review size={15} />;
  if (kind === "workspace") return <Icons.folder size={15} />;
  if (kind === "file") return <Icons.file size={15} />;
  if (kind === "capsule-set") return <Icons.layers size={15} />;

  return (
    <svg aria-hidden="true" className="qi-source-kind-icon-svg" viewBox="0 0 24 24">
      <path d="M12 3.8 19 7.7v8.6L12 20.2 5 16.3V7.7z" />
    </svg>
  );
}

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

// Shown when a run finishes with a server-reported "failed" status (a `done` frame, distinct from a
// thrown `error` frame). Without this the launcher would clear the spinner and surface nothing.
const QI_RUN_FAILED_MESSAGE =
  "Der Lauf wurde nicht erfolgreich abgeschlossen. Passe die Quelle an und versuche es erneut.";

// Shown on a SUCCEEDED-but-degraded run: model generation failed, so Keiko delivered deterministic
// baseline test cases from the evidence. The user must be told the output is not model-backed so a
// degraded run is never mistaken for an authoritative model result (regulated-delivery audit).
function degradedMessageFromReason(reasonSummary: string | null | undefined): string {
  const base =
    "Die Modellgenerierung ist fehlgeschlagen — Keiko hat deterministische Baseline-Testfälle aus der " +
    "Evidenz erstellt. Diese sind nicht modellgestützt; prüfe das Modell-Gateway und starte den Lauf für " +
    "modellgestützte Testfälle erneut.";
  if (reasonSummary === undefined || reasonSummary === null || reasonSummary.trim().length === 0) {
    return base;
  }
  if (reasonSummary === "qi-error: UnparseableModelOutputError") {
    return `${base} (Modellausgabe nicht als JSON parsebar)`;
  }
  if (reasonSummary === "qi-error: QI_PROMPT_TOO_LARGE") {
    return `${base} (Quellkontext für das Modell zu groß)`;
  }
  const detail = reasonSummary.startsWith("qi-error: ")
    ? reasonSummary.slice("qi-error: ".length)
    : reasonSummary.startsWith("qi-safe-error: ")
      ? reasonSummary.slice("qi-safe-error: ".length)
      : reasonSummary;
  return `${base} (${detail})`;
}

function failureMessageFromReason(reasonSummary: string | null | undefined): string {
  if (reasonSummary === undefined || reasonSummary === null || reasonSummary.trim().length === 0) {
    return QI_RUN_FAILED_MESSAGE;
  }
  if (reasonSummary === "qi-run-error") {
    return (
      "Die Modellgenerierung ist fehlgeschlagen, bevor nutzbare Testfälle zurückgegeben wurden. " +
      "Versuche es mit einer kleineren Quelle oder prüfe das ausgewählte Modell-Gateway."
    );
  }
  if (reasonSummary === "qi-error: UnparseableModelOutputError") {
    return (
      "Das Modell hat eine Ausgabe geliefert, die nicht zu Testfällen geparst werden konnte. " +
      "Versuche es erneut oder nutze ein Modell mit strukturierter JSON-Ausgabe."
    );
  }
  if (reasonSummary === "qi-error: QI_PROMPT_TOO_LARGE") {
    return "Der zusammengestellte Quellkontext ist für das Modell zu groß. Reduziere die Quelle und versuche es erneut.";
  }
  if (reasonSummary.startsWith("qi-error: ")) {
    return `${QI_RUN_FAILED_MESSAGE} (${reasonSummary.slice("qi-error: ".length)})`;
  }
  if (reasonSummary.startsWith("qi-safe-error: ")) {
    return `${QI_RUN_FAILED_MESSAGE} (${reasonSummary.slice("qi-safe-error: ".length)})`;
  }
  return `${QI_RUN_FAILED_MESSAGE} (${reasonSummary})`;
}

// Screen-reader announcement for the always-mounted progress live region (a11y M-01). The visible
// spinner+text stays conditional, but the announcement region is mounted from first render and only
// its text changes — the reliable aria-live pattern. Empty while idle so nothing is announced.
function progressAnnouncement(running: boolean, progress: Progress): string {
  if (!running) return "";
  if (progress.stageName === null && progress.candidates === 0 && progress.findings === 0) {
    return "Generating test cases…";
  }
  const stage = progress.stageName !== null ? `Stage: ${progress.stageName}. ` : "";
  const cases = `${progress.candidates.toString()} test case${progress.candidates !== 1 ? "s" : ""}`;
  const findings =
    progress.findings > 0
      ? `, ${progress.findings.toString()} finding${progress.findings !== 1 ? "s" : ""}`
      : "";
  return `${stage}${cases}${findings}`;
}

function skippedSourceDetail(source: QualityIntelligenceSkippedSource): string {
  switch (source.code) {
    case "QI_IMAGE_DESCRIPTION_UNAVAILABLE":
      return `${source.label} (image was readable, but the image model produced no usable description)`;
    case "QI_IMAGE_UNAVAILABLE":
      return `${source.label} (stored image could not be found or read)`;
    case "QI_FIGMA_SNAPSHOT_UNAVAILABLE":
      return `${source.label} (stored Figma snapshot could not be found or read)`;
    case "QI_SOURCE_EMPTY":
      return `${source.label} (source produced no usable evidence)`;
    case "QI_SOURCE_DENIED":
      return `${source.label} (source is in a protected location)`;
    case "QI_SOURCE_TOO_LARGE":
      return `${source.label} (source is too large for this run)`;
    case "QI_SOURCE_UNSUPPORTED":
      return `${source.label} (source format is not supported)`;
    case "QI_WORKSPACE_NOT_FOUND":
      return `${source.label} (workspace path could not be read)`;
    case "QI_CAPSULE_UNAVAILABLE":
      return `${source.label} (knowledge source is unavailable)`;
    default:
      return `${source.label} (could not be read)`;
  }
}

function skippedSourcesNotice(
  skippedSources: readonly QualityIntelligenceSkippedSource[],
): string | null {
  if (skippedSources.length === 0) return null;
  const count = skippedSources.length.toString();
  const noun = skippedSources.length !== 1 ? "sources were" : "source was";
  return `${count} connected ${noun} skipped: ${skippedSources.map(skippedSourceDetail).join(", ")}.`;
}

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
    const stageName = msg.stageName ?? prev.stageName;
    return { ...prev, phase: msg.kind, stageName, candidates, findings };
  }
  return prev;
}

export interface RunLauncherProps {
  readonly onRunCompleted?:
    | ((runId: string, recheckableSources: readonly QualityIntelligenceInlineSource[]) => void)
    | undefined;
  readonly startImpl?: typeof startQiRun;
  readonly fetchCapsulesImpl?: FetchCapsulesFn;
  readonly fetchCapsuleSetsImpl?: FetchCapsuleSetsFn;
  readonly fetchProjectsImpl?: FetchProjectsFn;
  readonly fetchFilesTreeImpl?: FetchFilesTreeFn;
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
  /**
   * Figma Snapshot sources from connected Figma windows. When present, it supersedes the run-id-only
   * list so selected screen ids can scope large boards to one or two masks.
   */
  readonly connectedFigmaSnapshotSources?:
    | readonly QualityIntelligenceFigmaSnapshotSource[]
    | undefined;
  /** Image-only sources from connected Figma Image windows. */
  readonly connectedImageSources?: readonly QualityIntelligenceImageSource[] | undefined;
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
      return source.label.startsWith("JSON ·") ? "Figma JSON" : "Figma snapshot";
    case "image":
      return "Image";
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
      return source.screenIds !== undefined && source.screenIds.length > 0
        ? `${source.snapshotRunId}#${source.screenIds.join(",")}`
        : source.snapshotRunId;
    case "image":
      return `${source.snapshotRunId}#${source.screenId}`;
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
  fetchCapsulesImpl = fetchCapsules,
  fetchCapsuleSetsImpl = fetchCapsuleSets,
  fetchProjectsImpl = fetchProjects,
  fetchFilesTreeImpl = fetchFilesTree,
  connectedRoot = null,
  connectedFilePath = null,
  connectedRoots,
  connectedCapsuleIds,
  connectedCapsuleSetIds,
  connectedFigmaSnapshotRunIds,
  connectedFigmaSnapshotSources,
  connectedImageSources,
}: RunLauncherProps): ReactNode {
  const [label, setLabel] = useState("");
  const [sourceKind, setSourceKind] = useState<ManualSourceKind>("requirements");
  const [text, setText] = useState("");
  const [path, setPath] = useState("");
  const [capsuleId, setCapsuleId] = useState("");
  const [capsuleSetId, setCapsuleSetId] = useState("");
  const [sourcePickerOpen, setSourcePickerOpen] = useState(false);
  const [capsules, setCapsules] = useState<readonly CapsuleListEntry[]>([]);
  const [capsuleSets, setCapsuleSets] = useState<readonly CapsuleSetListEntry[]>([]);
  const [connectorLoading, setConnectorLoading] = useState(false);
  const [connectorError, setConnectorError] = useState<string | null>(null);
  const [profileId, setProfileId] = useState("regression-default");
  const [seed, setSeed] = useState("");
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<Progress>(INITIAL_PROGRESS);
  const [error, setError] = useState<string | null>(null);
  const [degradedNotice, setDegradedNotice] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const completedRunIdRef = useRef<string | null>(null);
  const failureReasonRef = useRef<string | null>(null);
  // Synchronous double-submit guard: handleStart's `running` check reads a React state closure, so
  // two clicks dispatched before React commits setRunning(true) both see running===false and both
  // launch a run (doubling model-gateway cost). A ref closes that window before any state update.
  const isStartingRef = useRef(false);

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
    connectedFigmaSnapshotSources,
    connectedImageSources,
  });
  const hasConnected = connectedSources.length > 0;
  const selectedCapsule = capsules.find((c) => c.id === capsuleId);
  const selectedCapsuleSet = capsuleSets.find((s) => s.id === capsuleSetId);
  const pathReady = path.trim().length > 0;
  const manualReady =
    sourceKind === "requirements"
      ? text.trim().length > 0
      : sourceKind === "workspace" || sourceKind === "file"
        ? pathReady
        : sourceKind === "capsule"
          ? capsuleId.trim().length > 0
          : capsuleSetId.trim().length > 0;
  const connectedFallbackAllowed =
    sourceKind === "requirements"
      ? text.trim().length === 0
      : sourceKind === "workspace" || sourceKind === "file"
        ? !pathReady
        : false;
  const ready = manualReady || (connectedFallbackAllowed && hasConnected);
  const trimmedSeed = seed.trim();
  const parsedSeed =
    trimmedSeed.length === 0
      ? undefined
      : /^\d+$/u.test(trimmedSeed)
        ? Number(trimmedSeed)
        : Number.NaN;
  const seedValid =
    parsedSeed === undefined || (Number.isSafeInteger(parsedSeed) && Number.isFinite(parsedSeed));
  const handleSeedWheel = (event: WheelEvent<HTMLInputElement>): void => {
    if (running || event.deltaY === 0) return;
    event.preventDefault();
    const direction = event.deltaY < 0 ? 1 : -1;
    const current = Number.parseInt(seed.trim(), 10);
    const base = Number.isFinite(current) ? current : 0;
    setSeed(String(Math.max(0, base + direction)));
    setError(null);
  };
  // Generate stays focusable when blocked (aria-disabled, not native disabled) so keyboard and
  // screen-reader users can reach it and hear WHY it is inactive via aria-describedby — the same
  // governance pattern as GovernedActionButton in CandidatesPane (Epic #712).
  const generateBlocked = !ready || !seedValid;
  const generateHintId = useId();
  const seedErrorId = useId();
  const labelHintId = useId();
  const sourceTypeLabelId = useId();
  const sourcePathLabelId = useId();
  const generateDescribedBy = !ready ? generateHintId : !seedValid ? seedErrorId : undefined;
  const pickerMode = sourceKind === "workspace" || sourceKind === "file" ? sourceKind : null;

  const chooseSourceKind = useCallback((next: ManualSourceKind): void => {
    setSourceKind(next);
    setSourcePickerOpen(false);
    setError(null);
    setConnectorError(null);
  }, []);

  const onSourceKindPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>, next: ManualSourceKind): void => {
      if (running || event.button !== 0) return;
      chooseSourceKind(next);
    },
    [chooseSourceKind, running],
  );

  // APG radiogroup keyboard model (WCAG 2.1.1): arrow keys move the selection and roving focus
  // across the source-type radios — the native <select> this replaced had this for free.
  // The handler lives on each radio (which is a natively focusable <button>), not on the group
  // container — an interactive container would need its own tab stop, which the APG roving-tabindex
  // model deliberately avoids. The focused radio receives the arrow key and we move to its sibling.
  const onSourceKindKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
      if (running) return;
      const delta =
        event.key === "ArrowRight" || event.key === "ArrowDown"
          ? 1
          : event.key === "ArrowLeft" || event.key === "ArrowUp"
            ? -1
            : 0;
      if (delta === 0) return;
      event.preventDefault();
      const count = SOURCE_KIND_OPTIONS.length;
      const currentIndex = Math.max(
        0,
        SOURCE_KIND_OPTIONS.findIndex((option) => option.id === sourceKind),
      );
      const nextIndex = (currentIndex + delta + count) % count;
      const next = SOURCE_KIND_OPTIONS[nextIndex];
      if (next === undefined) return;
      chooseSourceKind(next.id);
      event.currentTarget.parentElement
        ?.querySelectorAll<HTMLButtonElement>('[role="radio"]')
        [nextIndex]?.focus();
    },
    [chooseSourceKind, running, sourceKind],
  );

  const onMessage = useCallback((msg: QualityIntelligenceRunStreamMessage): void => {
    if (
      msg.type === "event" &&
      (msg.kind === "stage:failed" || msg.kind === "run:failed") &&
      typeof msg.reasonSummary === "string"
    ) {
      failureReasonRef.current = msg.reasonSummary;
    }
    // Open the result card ONLY for a run that actually succeeded. The server always emits a
    // terminal `done` frame with the final status on the non-throwing path (runRoutes.ts
    // streamRunExecution); a thrown failure emits an `error` frame and no `done`. The old code
    // captured the runId on `accepted`, so EVERY run that started opened a result card — a failed
    // run then showed an error banner AND a spurious card for a run that produced nothing.
    if (msg.type === "done") {
      if (msg.status === "succeeded") {
        completedRunIdRef.current = msg.runId;
        // The run produced (baseline) test cases, so the result card still opens — but a degraded run
        // must be flagged so the user knows the model never ran (not a silent green success).
        if (msg.degraded === true) {
          setDegradedNotice(degradedMessageFromReason(msg.reasonSummary ?? null));
        }
      } else if (msg.status === "failed") {
        setError(failureMessageFromReason(msg.reasonSummary ?? failureReasonRef.current));
      }
      // "cancelled" is a user action — no error, no card.
    }
    if (msg.type === "error") setError(formatCodedError(msg.code, msg.message));
    setProgress((prev) => reduceProgress(prev, msg));
  }, []);

  const needsConnectorList = sourceKind === "capsule" || sourceKind === "capsule-set";

  useEffect(() => {
    if (!needsConnectorList) return;
    let cancelled = false;
    async function loadConnectors(): Promise<void> {
      setConnectorLoading(true);
      setConnectorError(null);
      try {
        const [capsuleResult, capsuleSetResult] = await Promise.allSettled([
          fetchCapsulesImpl(),
          fetchCapsuleSetsImpl(),
        ]);
        if (cancelled) return;
        if (capsuleResult.status === "fulfilled") {
          setCapsules(capsuleResult.value.capsules.filter((c) => c.lifecycleState === "ready"));
        } else {
          setCapsules([]);
          if (sourceKind === "capsule") setConnectorError(formatError(capsuleResult.reason));
        }
        if (capsuleSetResult.status === "fulfilled") {
          setCapsuleSets(capsuleSetResult.value.capsuleSets);
        } else {
          setCapsuleSets([]);
          if (sourceKind === "capsule-set") setConnectorError(formatError(capsuleSetResult.reason));
        }
      } finally {
        if (!cancelled) setConnectorLoading(false);
      }
    }
    void loadConnectors();
    return () => {
      cancelled = true;
    };
  }, [fetchCapsulesImpl, fetchCapsuleSetsImpl, needsConnectorList, sourceKind]);

  useEffect(() => {
    if (sourceKind === "capsule") {
      const next = capsules.some((c) => c.id === capsuleId) ? capsuleId : (capsules[0]?.id ?? "");
      if (next !== capsuleId) setCapsuleId(next);
    }
    if (sourceKind === "capsule-set") {
      const next = capsuleSets.some((s) => s.id === capsuleSetId)
        ? capsuleSetId
        : (capsuleSets[0]?.id ?? "");
      if (next !== capsuleSetId) setCapsuleSetId(next);
    }
  }, [capsuleId, capsuleSetId, capsuleSets, capsules, sourceKind]);

  const buildManualSources = useCallback(():
    | QualityIntelligenceStartRunRequest["sources"]
    | null => {
    const trimmedLabel = label.trim();
    if (sourceKind === "requirements" && text.trim().length > 0) {
      return [{ kind: "requirements", label: trimmedLabel || "Requirements", text }];
    }
    if (sourceKind === "workspace" && path.trim().length > 0) {
      return [{ kind: "workspace", label: trimmedLabel || "Folder", path: path.trim() }];
    }
    if (sourceKind === "file" && path.trim().length > 0) {
      return [{ kind: "file", label: trimmedLabel || "File", path: path.trim() }];
    }
    if (sourceKind === "capsule" && capsuleId.trim().length > 0) {
      return [
        {
          kind: "capsule",
          label: trimmedLabel || selectedCapsule?.displayName || "Knowledge capsule",
          capsuleId: capsuleId.trim(),
        },
      ];
    }
    if (sourceKind === "capsule-set" && capsuleSetId.trim().length > 0) {
      return [
        {
          kind: "capsule-set",
          label: trimmedLabel || selectedCapsuleSet?.displayName || "Capsule set",
          capsuleSetId: capsuleSetId.trim(),
        },
      ];
    }
    return null;
  }, [capsuleId, capsuleSetId, label, path, selectedCapsule, selectedCapsuleSet, sourceKind, text]);

  const handleStart = useCallback(async (): Promise<void> => {
    // Defensive guard — the Generate button already no-ops while blocked (aria-disabled pattern),
    // and an invalid seed surfaces as an inline field error next to the input.
    if (!ready || running || !seedValid) return;
    // Synchronous guard against a double-click race React state cannot close (see isStartingRef).
    if (isStartingRef.current) return;
    isStartingRef.current = true;
    setRunning(true);
    setError(null);
    setDegradedNotice(null);
    setProgress(INITIAL_PROGRESS);
    completedRunIdRef.current = null;
    failureReasonRef.current = null;
    const controller = new AbortController();
    abortRef.current = controller;
    // Precedence: manual input overrides everything; otherwise ALL connected sources go together
    // (Epic #729 N+1 — file + folders + capsules in one request).
    const sources: QualityIntelligenceStartRunRequest["sources"] =
      buildManualSources() ?? (connectedSources as QualityIntelligenceStartRunRequest["sources"]);
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
      isStartingRef.current = false;
    }
  }, [
    ready,
    profileId,
    running,
    connectedSources,
    buildManualSources,
    onMessage,
    onRunCompleted,
    parsedSeed,
    seedValid,
    startImpl,
  ]);

  const handleCancel = useCallback((): void => {
    abortRef.current?.abort();
  }, []);

  function renderSourceInput(): ReactNode {
    if (sourceKind === "requirements") {
      return (
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
      );
    }
    if (sourceKind === "workspace" || sourceKind === "file") {
      const isFile = sourceKind === "file";
      return (
        <div className="qi-field">
          <span className="qi-field-label" id={sourcePathLabelId}>
            {isFile ? "File path" : "Folder path"}
          </span>
          <div className="qi-path-picker">
            <div
              className="qi-path-value qi-monospace"
              role="textbox"
              aria-readonly="true"
              aria-labelledby={sourcePathLabelId}
              title={path}
              data-empty={path.trim().length === 0 ? "true" : undefined}
            >
              {path.trim().length > 0
                ? path
                : isFile
                  ? "Choose a local file…"
                  : "Choose a local folder…"}
            </div>
            <button
              type="button"
              className="qi-btn qi-btn-secondary qi-browse-btn"
              disabled={running}
              onClick={() => setSourcePickerOpen(true)}
            >
              Browse
            </button>
          </div>
        </div>
      );
    }
    const isCapsule = sourceKind === "capsule";
    const options = isCapsule ? capsules : capsuleSets;
    return (
      <label className="qi-field">
        <span className="qi-field-label">{isCapsule ? "Knowledge capsule" : "Capsule set"}</span>
        <select
          className="qi-select"
          value={isCapsule ? capsuleId : capsuleSetId}
          disabled={running || connectorLoading || connectorError !== null || options.length === 0}
          onChange={(e) => {
            if (isCapsule) setCapsuleId(e.target.value);
            else setCapsuleSetId(e.target.value);
          }}
        >
          {connectorLoading ? <option value="">Loading connectors...</option> : null}
          {!connectorLoading && options.length === 0 ? (
            <option value="">{isCapsule ? "No ready capsules" : "No capsule sets"}</option>
          ) : null}
          {isCapsule
            ? capsules.map((cap) => (
                <option key={cap.id} value={cap.id}>
                  {cap.displayName}
                </option>
              ))
            : capsuleSets.map((set) => (
                <option key={set.id} value={set.id}>
                  {`${set.displayName} (${String(set.capsuleCount)} capsules)`}
                </option>
              ))}
        </select>
      </label>
    );
  }

  // Coverage-notice sentences are built once and shared by the visible notice AND the persistent
  // sr-only live region (uiux-fix F047 C155: the notice was a role="status" element inserted
  // together with its content, which screen readers often skip).
  const droppedNotice =
    progress.droppedSourceCount > 0
      ? `${progress.droppedSourceCount.toString()} source${progress.droppedSourceCount !== 1 ? "s" : ""} over the 16-source limit ${progress.droppedSourceCount !== 1 ? "were" : "was"} not included.`
      : null;
  const skippedNotice = skippedSourcesNotice(progress.skippedSources);
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
          <div className="qi-field qi-field-kind">
            <span className="qi-field-label" id={sourceTypeLabelId}>
              Source type
            </span>
            <div
              className="qi-source-kind-grid"
              role="radiogroup"
              aria-labelledby={sourceTypeLabelId}
              aria-disabled={running || undefined}
            >
              {SOURCE_KIND_OPTIONS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className="qi-source-kind-option"
                  role="radio"
                  aria-label={option.label}
                  data-tip={option.label}
                  aria-checked={sourceKind === option.id}
                  tabIndex={sourceKind === option.id ? 0 : -1}
                  disabled={running}
                  onPointerDown={(event) => {
                    onSourceKindPointerDown(event, option.id);
                  }}
                  onClick={() => chooseSourceKind(option.id)}
                  onKeyDown={onSourceKindKeyDown}
                >
                  <span className="qi-source-kind-label">{option.label}</span>
                  <span className="qi-source-kind-icon" aria-hidden="true">
                    <SourceKindIcon kind={option.id} />
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
        {renderSourceInput()}
        {connectorError !== null ? (
          <p className="lk-alert" role="alert" data-testid="qi-connector-error">
            {connectorError}
          </p>
        ) : null}
        <div className="qi-launcher-controls">
          <div className="qi-field qi-field-inline qi-policy-profile-field">
            <span className="qi-field-label">Policy profile</span>
            <KeikoSelect
              triggerClassName="qi-select"
              value={profileId}
              ariaLabel="Policy profile"
              disabled={running}
              menuTitle="Policy"
              menuClassName="qi-policy-profile-menu"
              sections={[
                {
                  options: PROFILES.map((profile) => ({
                    value: profile.id,
                    label: profile.label,
                  })),
                },
              ]}
              onValueChange={setProfileId}
            />
          </div>
          <label className="qi-field qi-field-inline">
            <span className="qi-field-label">Seed (optional)</span>
            <span className="number-control qi-number-control">
              <input
                type="number"
                min={0}
                step={1}
                className="qi-input number-control-input"
                value={seed}
                placeholder="e.g. 42"
                disabled={running}
                aria-invalid={seedValid ? undefined : true}
                aria-describedby={seedValid ? undefined : seedErrorId}
                onChange={(e) => {
                  setSeed(e.target.value);
                  setError(null);
                }}
                onWheel={handleSeedWheel}
              />
              <span className="number-control-stepper" aria-hidden="true" />
            </span>
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
              Add requirements text, a folder path, a file path, select a capsule, select a capsule
              set, or connect a source to generate.
            </span>
          ) : null}
        </div>
        {running ? (
          // Visible-only progress block (aria-hidden): the announcement is owned by the persistent
          // sr-only region below (a11y M-01), so this block must not also be a live region or it
          // would double-announce. Kept conditional for layout.
          <div className="qi-progress" data-testid="qi-launch-progress" aria-hidden="true">
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
        {/* Always-mounted progress live region (a11y M-01): a region inserted together with its
            content is unreliably announced by AT, so the visible block above is aria-hidden and this
            persistent sr-only region carries the announcement — empty string while idle. */}
        <p className="sr-only" role="status" aria-live="polite" data-testid="qi-launch-progress-sr">
          {progressAnnouncement(running, progress)}
        </p>
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
        {degradedNotice !== null ? (
          <p className="qi-degraded-notice" role="status" data-testid="qi-launch-degraded">
            {degradedNotice}
          </p>
        ) : null}
        {error !== null ? (
          <p className="lk-alert" role="alert" data-testid="qi-launch-error">
            {error}
          </p>
        ) : null}
      </div>
      {sourcePickerOpen && pickerMode !== null ? (
        <LocalFileBrowserDialog
          mode={pickerMode === "file" ? "file" : "folder"}
          title={`Choose ${pickerMode === "file" ? "file" : "folder"} source`}
          description="Browse a registered local project or enter an absolute folder root."
          initialRootPath={pickerMode === "file" ? dirname(path) : path}
          fetchProjectsImpl={fetchProjectsImpl}
          fetchFilesTreeImpl={fetchFilesTreeImpl}
          onCancel={() => setSourcePickerOpen(false)}
          onApply={(selection) => {
            const nextPath =
              pickerMode === "file"
                ? displayLocalPath(selection.rootPath, selection.files[0] ?? null)
                : selection.folderPath;
            setPath(nextPath);
            setSourcePickerOpen(false);
            setError(null);
          }}
        />
      ) : null}
    </section>
  );
}
