"use client";

// Figma Snapshot Workspace window (Epic #750, Issue #756).
//
// Surface: paste a board link → trigger a server-side snapshot-build → view the captured
// screens (IR summary + metadata) → surface the reduction ("N screens from M detected") →
// re-snapshot on demand. The window stores the resulting snapshotRunId in its cfg so a
// connected QI hub can read it via the relationship edge.
//
// Security invariant: the PAT is resolved server-side only. The board link travels to the BFF;
// the BFF resolves the token from vault/config/env, builds the snapshot, and returns a
// token-free summary. This component NEVER holds or transmits the PAT.
//
// No page route — this is a Workspace window only (consistent with the QI hub architecture).
//
// Accessibility:
//   - <form> with a <label> for the board-link input (id association).
//   - Progress and error states live in an aria-live="polite" region.
//   - The trigger button carries aria-busy during the build.
//   - Screen gallery items are <article> elements with a visible heading.
//   - Re-snapshot button has an explicit aria-label.
//   - Focus-visible is delegated to the design system (outline tokens).
//   - All interactive targets are ≥ 24 × 24 px (WCAG 2.5.8).

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import Image from "next/image";
import { ApiError } from "@/lib/api";
import { formatBytes, formatDate } from "@/lib/format";
import {
  triggerFigmaSnapshot,
  loadFigmaSnapshotSummary,
  listFigmaSnapshots,
  figmaSnapshotScreenImageUrl,
  generateFigmaCode,
  revokeFigmaToken,
} from "@/lib/figma-snapshot-api";
import type {
  FigmaSnapshotSummary,
  FigmaSnapshotListEntry,
  FigmaCodegenResponse,
  FigmaRevokeTokenResult,
} from "@/lib/figma-snapshot-api";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const INITIAL_GALLERY_LIMIT = 24;

/**
 * Client-side Figma URL validator. Accepts:
 *   https://www.figma.com/design/{key}/{name}?node-id={id}
 *   https://www.figma.com/file/{key}/{name}?node-id={id}
 *
 * The node-id param is REQUIRED — a whole-file link would pull too many nodes
 * and the server's parseFigmaTarget would reject it anyway.
 */
function isValidFigmaLink(raw: string): boolean {
  try {
    const url = new URL(raw.trim());
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:") return false;
    if (host !== "figma.com" && host !== "www.figma.com") return false;
    if (!/^\/(design|file)\//u.test(url.pathname)) return false;
    const nodeId = url.searchParams.get("node-id");
    return nodeId !== null && nodeId.length > 0;
  } catch {
    return false;
  }
}

interface FigmaSnapshotScope {
  readonly fileKey: string;
  readonly nodeId: string;
}

function parseFigmaScope(raw: string): FigmaSnapshotScope | null {
  try {
    const url = new URL(raw.trim());
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:") return null;
    if (host !== "figma.com" && host !== "www.figma.com") return null;
    const [, kind, fileKey] = url.pathname.split("/");
    if ((kind !== "design" && kind !== "file") || fileKey === undefined || fileKey.length === 0) {
      return null;
    }
    const nodeId = url.searchParams.get("node-id");
    if (nodeId === null || nodeId.length === 0) return null;
    return { fileKey, nodeId };
  } catch {
    return null;
  }
}

function boardLinkFromSnapshot(snapshot: {
  readonly fileKey: string;
  readonly nodeId: string;
  readonly version?: string | undefined;
}): string {
  const url = new URL(`https://www.figma.com/design/${snapshot.fileKey}/board`);
  url.searchParams.set("node-id", snapshot.nodeId);
  if (snapshot.version !== undefined && snapshot.version.length > 0) {
    url.searchParams.set("version", snapshot.version);
  }
  return url.toString();
}

interface SnapshotErrorNotice {
  readonly title: string;
  readonly detail: string;
  readonly status?: string | undefined;
  readonly remediation?: string | undefined;
  readonly assertive?: boolean | undefined;
}

interface DetachedBuild {
  readonly link: string;
  readonly isResnapshot: boolean;
}

type SnapshotDashboardTab = "board" | "recent";

// ── Fix #8: full external-dependency error taxonomy (including new codes from the
// parallel agent landing FIGMA_NETWORK_UNREACHABLE / FIGMA_EGRESS_TIMEOUT /
// FIGMA_EGRESS_FAILED / FIGMA_PROXY_AUTH_REQUIRED / FIGMA_PROXY_BLOCKED_BY_POLICY).
// FIGMA_UPSTREAM_UNAVAILABLE is intentionally NOT in this set (fix #4 below).
const FIGMA_PROXY_ERRORS: ReadonlySet<string> = new Set([
  "FIGMA_PROXY_EGRESS_FAILED",
  "FIGMA_PROXY_UNREACHABLE",
  "FIGMA_PROXY_AUTH_REQUIRED",
  "FIGMA_PROXY_BLOCKED_BY_POLICY",
]);

const FIGMA_CA_ERRORS: ReadonlySet<string> = new Set(["FIGMA_TLS_CA_FAILURE"]);

// Direct network/timeout errors — no proxy involvement.
const FIGMA_NETWORK_ERRORS: ReadonlySet<string> = new Set([
  "FIGMA_NETWORK_UNREACHABLE",
  "FIGMA_EGRESS_TIMEOUT",
  "FIGMA_EGRESS_FAILED",
]);

function formatSnapshotError(err: unknown): SnapshotErrorNotice {
  if (err instanceof ApiError) {
    // Fix #4: FIGMA_UPSTREAM_UNAVAILABLE is a plain Figma outage — not a proxy/CA issue.
    if (err.code === "FIGMA_UPSTREAM_UNAVAILABLE") {
      return {
        title: "Figma is currently unavailable",
        detail: `${err.code}: ${err.message}`,
        status: `HTTP ${err.status.toString()}`,
        remediation: "Retry later — no snapshot was stored.",
        assertive: true,
      };
    }
    if (FIGMA_PROXY_ERRORS.has(err.code)) {
      return {
        title: "Figma snapshot blocked by outbound egress",
        detail: `${err.code}: ${err.message}`,
        status: `HTTP ${err.status.toString()}`,
        remediation:
          "Check the configured proxy, NO_PROXY rules, and CA bundle, then retry. No snapshot was stored.",
        assertive: true,
      };
    }
    if (FIGMA_CA_ERRORS.has(err.code)) {
      return {
        title: "Figma snapshot blocked by outbound egress",
        detail: `${err.code}: ${err.message}`,
        status: `HTTP ${err.status.toString()}`,
        remediation:
          "A TLS certificate verification failure blocked the request. Check the CA bundle configuration, then retry. No snapshot was stored.",
        assertive: true,
      };
    }
    if (FIGMA_NETWORK_ERRORS.has(err.code)) {
      return {
        title: "Figma snapshot blocked by outbound egress",
        detail: `${err.code}: ${err.message}`,
        status: `HTTP ${err.status.toString()}`,
        remediation:
          "The outbound network request to Figma failed. Check DNS resolution and network connectivity, then retry. No snapshot was stored.",
        assertive: true,
      };
    }
    return {
      title: "Figma snapshot failed",
      detail: err.message,
    };
  }
  if (err instanceof Error) {
    return { title: "Figma snapshot failed", detail: err.message };
  }
  return { title: "Figma snapshot failed", detail: "An unexpected error occurred." };
}

function formatError(err: unknown): string {
  const notice = formatSnapshotError(err);
  return notice.status === undefined ? notice.detail : `${notice.detail} (${notice.status})`;
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${String(hours)}h ${String(minutes)}m ${String(seconds)}s`;
  if (minutes > 0) return `${String(minutes)}m ${String(seconds)}s`;
  return `${String(seconds)}s`;
}

/**
 * Differentiated validation microcopy (WCAG 3.3.1 Error Identification) for a
 * non-empty, invalid board link. Returns null when the link is empty or valid.
 */
function figmaLinkValidationMessage(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || isValidFigmaLink(trimmed)) return null;
  try {
    const url = new URL(trimmed);
    const host = url.hostname.toLowerCase();
    if (
      url.protocol === "https:" &&
      (host === "figma.com" || host === "www.figma.com") &&
      /^\/(design|file)\//u.test(url.pathname)
    ) {
      return "Add a node-id by selecting a frame or section in Figma and copying its link (Copy link to selection).";
    }
  } catch {
    // not parseable as a URL — fall through to the generic message
  }
  return "This doesn't look like a Figma board link. Use a figma.com design/file link that includes a node-id parameter.";
}

// ─── Sub-components ────────────────────────────────────────────────────────────

interface ScreenCardProps {
  readonly index: number;
  readonly screenId: string;
  readonly name: string;
  readonly irSummary: string;
  readonly imageSrc: string;
  readonly imageByteLength: number;
}

function ScreenCard({
  index,
  screenId,
  name,
  irSummary,
  imageSrc,
  imageByteLength,
}: ScreenCardProps): ReactNode {
  return (
    <article
      className="figma-snapshot-screen-card"
      aria-label={`Screen ${String(index + 1)}: ${name}`}
    >
      <Image
        className="figma-snapshot-screen-image"
        src={imageSrc}
        alt={`Captured preview for ${name}`}
        loading="lazy"
        width={72}
        height={54}
        unoptimized
      />
      <div className="figma-snapshot-screen-meta">
        {/* uiux-fix F045 C252: the name is ellipsised user content — title makes the
            full name reachable on hover for mouse users. */}
        <h3 className="figma-snapshot-screen-name" title={name}>
          {name}
        </h3>
        <p className="figma-snapshot-screen-summary">{irSummary}</p>
        {/* uiux-fix F045 C313: app-wide byte convention via lib/format (B/KB/MB) instead
            of an ad-hoc "KiB" — the only surface that used that spelling. */}
        <p className="figma-snapshot-screen-size">{formatBytes(imageByteLength)}</p>
        <p className="figma-snapshot-screen-id">{screenId}</p>
      </div>
    </article>
  );
}

// ─── Props ─────────────────────────────────────────────────────────────────────

export interface FigmaSnapshotWindowProps {
  /**
   * Current snapshotRunId from the window's cfg. Populated by the window itself after a
   * successful build via updateCfg; read by the QI hub via linkedFigmaSnapshotRunIds.
   */
  readonly snapshotRunId?: string | undefined;
  /**
   * Persists a patch into the window's cfg. Used to store snapshotRunId after a
   * successful snapshot-build so the relationship edge can propagate it to QI.
   */
  readonly updateCfg: (patch: Record<string, string | number | boolean | undefined>) => void;
  /** Injectable for tests — defaults to the real BFF call. */
  readonly triggerImpl?: typeof triggerFigmaSnapshot;
  /** Injectable for tests — defaults to the real BFF call. */
  readonly loadImpl?: typeof loadFigmaSnapshotSummary;
  /** Injectable for tests — defaults to the real list BFF call. */
  readonly listImpl?: typeof listFigmaSnapshots;
  /** Injectable for tests — defaults to the real design-to-code BFF call (#755). */
  readonly codegenImpl?: typeof generateFigmaCode;
  /** Injectable for tests — defaults to the real PAT revoke call (#758). */
  readonly revokeImpl?: typeof revokeFigmaToken;
}

// ─── Component ────────────────────────────────────────────────────────────────

// "loading" is the stored-snapshot read path — it never contacts Figma and must not
// reuse the "building" copy ("fetching screens from Figma…").
type BuildState = "idle" | "loading" | "building" | "done" | "error";

export function FigmaSnapshotWindow({
  snapshotRunId,
  updateCfg,
  triggerImpl = triggerFigmaSnapshot,
  loadImpl = loadFigmaSnapshotSummary,
  listImpl = listFigmaSnapshots,
  codegenImpl = generateFigmaCode,
  revokeImpl = revokeFigmaToken,
}: FigmaSnapshotWindowProps): ReactNode {
  const inputId = useId();
  const statusId = useId();
  const validationId = useId();
  const dashboardId = useId();

  const [boardLink, setBoardLink] = useState("");
  const [buildState, setBuildState] = useState<BuildState>("idle");
  const [summary, setSummary] = useState<FigmaSnapshotSummary | null>(null);
  const [errorNotice, setErrorNotice] = useState<SnapshotErrorNotice | null>(null);
  const [detachedBuild, setDetachedBuild] = useState<DetachedBuild | null>(null);
  const [buildStartedAt, setBuildStartedAt] = useState<number | null>(null);
  const [buildElapsedMs, setBuildElapsedMs] = useState(0);
  const [dashboardTab, setDashboardTab] = useState<SnapshotDashboardTab>("recent");
  const [boardSnapshots, setBoardSnapshots] = useState<readonly FigmaSnapshotListEntry[]>([]);
  const [recentSnapshots, setRecentSnapshots] = useState<readonly FigmaSnapshotListEntry[]>([]);
  const [boardSnapshotsLoading, setBoardSnapshotsLoading] = useState(false);
  const [recentSnapshotsLoading, setRecentSnapshotsLoading] = useState(false);
  const [boardSnapshotsError, setBoardSnapshotsError] = useState<string | null>(null);
  const [recentSnapshotsError, setRecentSnapshotsError] = useState<string | null>(null);
  // Explicit read-only-scope acknowledgement (#760) — recorded server-side before the first build.
  const [consentChecked, setConsentChecked] = useState(false);
  // uiux-fix F038 C210: when consent blocks a snapshot (inline pre-check OR the server's 428
  // FIGMA_CONSENT_REQUIRED), the error must point AT the checkbox — mark it invalid and move
  // focus to it instead of leaving the user to connect message and control themselves.
  const [consentInvalid, setConsentInvalid] = useState(false);
  const consentRef = useRef<HTMLInputElement | null>(null);

  // Fix #7: AbortController for the active build/load fetch.
  const abortRef = useRef<AbortController | null>(null);
  const codeAbortRef = useRef<AbortController | null>(null);
  const dashboardAbortRef = useRef<AbortController | null>(null);
  const activeBuildRef = useRef<DetachedBuild | null>(null);

  const flagConsentRequired = useCallback((): void => {
    setConsentInvalid(true);
  }, []);

  // Design-to-code (#755) state — a reviewable artifact generated from the stored snapshot.
  const [codeState, setCodeState] = useState<"idle" | "generating" | "done" | "error">("idle");
  const [code, setCode] = useState<FigmaCodegenResponse | null>(null);
  const [codeError, setCodeError] = useState<string | null>(null);

  // Fix #3: PAT revoke state — two-step inline confirm (mirrors ContextBudget pattern).
  const [revokeConfirming, setRevokeConfirming] = useState(false);
  const [revokeStatus, setRevokeStatus] = useState<string | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const revokeConfirmRef = useRef<HTMLButtonElement | null>(null);
  const revokeTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [visibleScreenCount, setVisibleScreenCount] = useState(INITIAL_GALLERY_LIMIT);

  const linkValid = isValidFigmaLink(boardLink);
  const linkError = figmaLinkValidationMessage(boardLink);
  const currentScope = useMemo(
    () =>
      summary !== null
        ? { fileKey: summary.fileKey, nodeId: summary.nodeId }
        : parseFigmaScope(boardLink),
    [boardLink, summary],
  );
  const currentScopeFileKey = currentScope?.fileKey;
  const currentScopeNodeId = currentScope?.nodeId;
  const isBuilding = buildState === "building";
  const isLoading = buildState === "loading";
  const busy = isBuilding || isLoading;
  const buildElapsedLabel =
    isBuilding && buildStartedAt !== null ? formatElapsed(buildElapsedMs) : null;

  // uiux-fix F038 C210: move focus onto the consent checkbox once a consent-blocked error has
  // rendered. An effect (not an inline .focus() in the handler) because in the server-428 path
  // the checkbox is still disabled={isBuilding} when the error is caught — focusing must wait
  // for the re-render that re-enables it.
  useEffect(() => {
    if (consentInvalid && buildState === "error") consentRef.current?.focus();
  }, [consentInvalid, buildState]);

  // Fix #3: focus the confirm button when the revoke confirm step opens.
  useEffect(() => {
    if (revokeConfirming) revokeConfirmRef.current?.focus();
  }, [revokeConfirming]);

  useEffect(() => {
    if (!isBuilding || buildStartedAt === null) return;
    setBuildElapsedMs(Date.now() - buildStartedAt);
    const timer = window.setInterval(() => {
      setBuildElapsedMs(Date.now() - buildStartedAt);
    }, 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, [isBuilding, buildStartedAt]);

  // Fix #7: abort in-flight fetch on unmount.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      codeAbortRef.current?.abort();
      dashboardAbortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (currentScope === null && dashboardTab === "board") setDashboardTab("recent");
  }, [currentScope, dashboardTab]);

  const refreshDashboard = useCallback((): void => {
    dashboardAbortRef.current?.abort();
    const controller = new AbortController();
    dashboardAbortRef.current = controller;

    setRecentSnapshotsLoading(true);
    setRecentSnapshotsError(null);
    void listImpl({ limit: 12, signal: controller.signal })
      .then((snapshots) => {
        setRecentSnapshots(snapshots);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setRecentSnapshots([]);
        setRecentSnapshotsError(formatError(err));
      })
      .finally(() => {
        if (dashboardAbortRef.current === controller) setRecentSnapshotsLoading(false);
      });

    if (currentScopeFileKey === undefined || currentScopeNodeId === undefined) {
      setBoardSnapshots([]);
      setBoardSnapshotsError(null);
      setBoardSnapshotsLoading(false);
      return;
    }

    setBoardSnapshotsLoading(true);
    setBoardSnapshotsError(null);
    void listImpl({
      fileKey: currentScopeFileKey,
      nodeId: currentScopeNodeId,
      limit: 12,
      signal: controller.signal,
    })
      .then((snapshots) => {
        setBoardSnapshots(snapshots);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setBoardSnapshots([]);
        setBoardSnapshotsError(formatError(err));
      })
      .finally(() => {
        if (dashboardAbortRef.current === controller) setBoardSnapshotsLoading(false);
      });
  }, [currentScopeFileKey, currentScopeNodeId, listImpl]);

  useEffect(() => {
    refreshDashboard();
  }, [refreshDashboard, summary?.runId]);

  const loadSnapshotByRunId = useCallback(
    (runId: string): void => {
      if (runId.length === 0 || busy) return;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setBuildState("loading");
      setErrorNotice(null);
      setDetachedBuild(null);
      setCodeState("idle");
      setCode(null);
      setCodeError(null);

      loadImpl(runId, controller.signal)
        .then((result) => {
          setSummary(result);
          setBoardLink(boardLinkFromSnapshot(result));
          updateCfg({ snapshotRunId: result.runId });
          setBuildState("done");
        })
        .catch((err: unknown) => {
          if (err instanceof DOMException && err.name === "AbortError") return;
          if (err instanceof ApiError && err.code === "FIGMA_SNAPSHOT_NOT_FOUND") {
            if (snapshotRunId === runId) updateCfg({ snapshotRunId: undefined });
            setErrorNotice({
              ...formatSnapshotError(err),
              detail:
                snapshotRunId === runId
                  ? `${err.message} The stored run ID has been cleared.`
                  : err.message,
            });
          } else {
            setErrorNotice(formatSnapshotError(err));
          }
          setBuildState("error");
        });
    },
    [busy, loadImpl, snapshotRunId, updateCfg],
  );

  const runBuild = useCallback(
    async (link: string, isResnapshot: boolean): Promise<void> => {
      // Abort any previous in-flight request before starting a new one.
      abortRef.current?.abort();
      codeAbortRef.current?.abort();
      codeAbortRef.current = null;
      const controller = new AbortController();
      abortRef.current = controller;
      activeBuildRef.current = { link, isResnapshot };

      setBuildState("building");
      setErrorNotice(null);
      setDetachedBuild(null);
      setBuildStartedAt(Date.now());
      setBuildElapsedMs(0);
      setCodeState("idle");
      setCode(null);
      try {
        const result = await triggerImpl(link, {
          acknowledgeReadOnly: consentChecked,
          isResnapshot,
          signal: controller.signal,
        });
        setSummary(result);
        setBoardLink(boardLinkFromSnapshot(result));
        updateCfg({ snapshotRunId: result.runId });
        setBuildState("done");
        setBuildStartedAt(null);
        setBuildElapsedMs(0);
        activeBuildRef.current = null;
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          return;
        }
        setBuildStartedAt(null);
        setBuildElapsedMs(0);
        // uiux-fix F038 C210: the server's 428 message names the policy but not the control —
        // extend it with an instruction that points at the checkbox, and highlight + focus it.
        if (err instanceof ApiError && err.code === "FIGMA_CONSENT_REQUIRED") {
          const notice = formatSnapshotError(err);
          setErrorNotice({
            ...notice,
            detail: `${notice.detail} Tick the acknowledgement checkbox below, then snapshot again.`,
          });
          flagConsentRequired();
        } else if (err instanceof ApiError && err.code === "FIGMA_BUILD_TIMEOUT") {
          setDetachedBuild({ link, isResnapshot });
          setErrorNotice({
            title: "Figma snapshot is still running",
            detail:
              "This window stopped waiting for the snapshot result. The server may still finish the build in the background.",
            status: `HTTP ${err.status.toString()}`,
            remediation:
              "Reconnect to the same board to keep waiting, or close this window and return later.",
          });
        } else {
          setErrorNotice(formatSnapshotError(err));
        }
        setBuildState("error");
        activeBuildRef.current = null;
      }
    },
    [triggerImpl, updateCfg, consentChecked, flagConsentRequired],
  );

  const handleSubmit = useCallback(
    (e: FormEvent<HTMLFormElement>): void => {
      e.preventDefault();
      if (!linkValid || busy) return;
      if (!consentChecked) {
        // The server enforces the acknowledgement with FIGMA_CONSENT_REQUIRED (HTTP 428)
        // on the first build for a board — fail inline instead of letting the first-run
        // happy path end in a guaranteed server-error roundtrip.
        setErrorNotice({
          title: "Figma snapshot failed",
          detail: "Tick the read-only acknowledgement checkbox below, then snapshot again.",
        });
        setBuildState("error");
        // uiux-fix F038 C210: point at the control, don't just describe it — highlight the
        // checkbox and move focus onto it so the fix is one keypress away.
        flagConsentRequired();
        return;
      }
      void runBuild(boardLink, false);
    },
    [boardLink, busy, consentChecked, linkValid, runBuild, flagConsentRequired],
  );

  const handleResnapshot = useCallback((): void => {
    // Fix #2: aria-disabled guard — the button stays mounted so focus is never dropped.
    if (busy) return;
    if (summary === null) return;
    void runBuild(boardLinkFromSnapshot(summary), true);
  }, [busy, runBuild, summary]);

  // Fix #7: Cancel the in-flight build and return to idle with a status note.
  const handleCancel = useCallback((): void => {
    abortRef.current?.abort();
    abortRef.current = null;
    setBuildStartedAt(null);
    setBuildElapsedMs(0);
    if (activeBuildRef.current !== null) setDetachedBuild(activeBuildRef.current);
    activeBuildRef.current = null;
    setBuildState("idle");
    setErrorNotice(null);
  }, []);

  const handleReconnect = useCallback((): void => {
    if (busy || detachedBuild === null) return;
    void runBuild(detachedBuild.link, detachedBuild.isResnapshot);
  }, [busy, detachedBuild, runBuild]);

  const handleGenerateCode = useCallback((): void => {
    const runId = summary?.runId ?? snapshotRunId;
    if (runId === undefined || runId.length === 0 || codeState === "generating") return;
    const controller = new AbortController();
    codeAbortRef.current = controller;
    setCodeState("generating");
    setCodeError(null);
    codegenImpl(runId, controller.signal)
      .then((result) => {
        setCode(result);
        setCodeState("done");
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") {
          setCodeState("idle");
          return;
        }
        setCodeError(formatError(err));
        setCodeState("error");
      })
      .finally(() => {
        if (codeAbortRef.current === controller) codeAbortRef.current = null;
      });
  }, [codegenImpl, codeState, snapshotRunId, summary]);

  const handleCancelCodegen = useCallback((): void => {
    codeAbortRef.current?.abort();
    codeAbortRef.current = null;
    setCodeState("idle");
    setCodeError(null);
  }, []);

  // Load a previously stored snapshot (e.g. after window re-open) when runId is in cfg but no
  // in-memory summary is present.
  const handleLoadStored = useCallback((): void => {
    if (snapshotRunId === undefined || snapshotRunId.length === 0 || busy) return;
    loadSnapshotByRunId(snapshotRunId);
  }, [busy, loadSnapshotByRunId, snapshotRunId]);

  useEffect(() => {
    setVisibleScreenCount(INITIAL_GALLERY_LIMIT);
  }, [summary?.runId]);

  useEffect(() => {
    setVisibleScreenCount(INITIAL_GALLERY_LIMIT);
  }, [summary?.runId]);

  const handleRevokeConfirmed = useCallback((): void => {
    setRevokeConfirming(false);
    setRevokeError(null);
    setRevokeStatus(null);
    revokeImpl()
      .then((result: FigmaRevokeTokenResult) => {
        setRevokeStatus(result.message);
        requestAnimationFrame(() => revokeTriggerRef.current?.focus());
      })
      .catch((err: unknown) => {
        setRevokeError(formatError(err));
        requestAnimationFrame(() => revokeTriggerRef.current?.focus());
      });
  }, [revokeImpl]);

  const handleRevokeCancel = useCallback((): void => {
    setRevokeConfirming(false);
    requestAnimationFrame(() => revokeTriggerRef.current?.focus());
  }, []);

  // Fix #1: keep the Load button mounted when buildState==="error" && summary===null so
  // it acts as a retry affordance. The original condition excluded "error" state.
  const showLoadStored =
    snapshotRunId !== undefined &&
    snapshotRunId.length > 0 &&
    summary === null &&
    (buildState === "idle" || buildState === "loading" || buildState === "error");

  const renderDashboardList = (
    snapshots: readonly FigmaSnapshotListEntry[],
    loading: boolean,
    error: string | null,
    emptyTitle: string,
    emptyDetail: string,
    showScope: boolean,
  ): ReactNode => {
    if (loading) {
      return <p className="figma-snapshot-dashboard-status">Loading snapshots…</p>;
    }
    if (error !== null) {
      return (
        <p className="figma-snapshot-dashboard-status figma-snapshot-dashboard-status-error">
          {error}
        </p>
      );
    }
    if (snapshots.length === 0) {
      return (
        <div className="figma-snapshot-dashboard-empty">
          <p className="figma-snapshot-dashboard-empty-title">{emptyTitle}</p>
          <p className="figma-snapshot-dashboard-empty-detail">{emptyDetail}</p>
        </div>
      );
    }
    return (
      <div className="figma-snapshot-dashboard-list" role="list">
        {snapshots.map((snapshot) => {
          const isCurrent = summary?.runId === snapshot.runId;
          return (
            <button
              key={snapshot.runId}
              type="button"
              className="figma-snapshot-dashboard-item"
              onClick={() => {
                loadSnapshotByRunId(snapshot.runId);
              }}
              aria-current={isCurrent ? "true" : undefined}
              aria-busy={isLoading && snapshotRunId === snapshot.runId ? "true" : undefined}
            >
              <span className="figma-snapshot-dashboard-item-head">
                <span className="figma-snapshot-dashboard-item-date">
                  {formatDate(snapshot.fetchedAt)}
                </span>
                {isCurrent && (
                  <span className="figma-snapshot-dashboard-item-badge">Current</span>
                )}
              </span>
              <span className="figma-snapshot-dashboard-item-hint">{snapshot.reductionHint}</span>
              <span className="figma-snapshot-dashboard-item-meta">
                {snapshot.screenCount.toString()} screen{snapshot.screenCount !== 1 ? "s" : ""}
                {snapshot.skippedCount > 0
                  ? `, ${snapshot.skippedCount.toString()} skipped`
                  : ", no skipped renders"}
              </span>
              {showScope && (
                <span className="figma-snapshot-dashboard-item-scope">
                  {snapshot.fileKey} · {snapshot.nodeId}
                </span>
              )}
            </button>
          );
        })}
      </div>
    );
  };

  return (
    <section className="figma-snapshot-window" aria-label="Figma Snapshot">
      {/* ── Board link input ────────────────────────────────────────────── */}
      <form className="figma-snapshot-form" onSubmit={handleSubmit} noValidate>
        <label className="figma-snapshot-label" htmlFor={inputId}>
          Board link
        </label>
        <div className="figma-snapshot-input-row">
          <input
            id={inputId}
            type="url"
            className="figma-snapshot-input"
            placeholder="https://www.figma.com/design/…?node-id=…"
            value={boardLink}
            onChange={(e) => {
              setBoardLink(e.target.value);
              // Editing the link invalidates any previous error — clear it so stale
              // and current feedback never contradict each other.
              if (errorNotice !== null) setErrorNotice(null);
              if (buildState === "error") setBuildState("idle");
              if (detachedBuild !== null) setDetachedBuild(null);
              if (consentInvalid) setConsentInvalid(false);
            }}
            aria-describedby={linkError !== null ? `${validationId} ${statusId}` : statusId}
            aria-invalid={linkError !== null ? "true" : undefined}
            readOnly={busy}
            autoComplete="off"
            spellCheck={false}
          />
          {/* While busy the button stays enabled (aria-disabled + handler guard) so the
              browser does not drop focus of the just-activated control to <body>. */}
          <button
            type="submit"
            className="figma-snapshot-trigger-btn"
            disabled={!linkValid && !busy}
            aria-disabled={!linkValid || busy ? "true" : undefined}
            aria-busy={isBuilding}
          >
            {isBuilding ? "Building…" : "Snapshot"}
          </button>
        </div>
        {linkError !== null && (
          <p id={validationId} className="figma-snapshot-link-error" role="alert">
            {linkError}
          </p>
        )}
        {/* Explicit read-only-scope acknowledgement (#760): recorded server-side before the first
            fetch for a board. The connector reads files + renders images — it never writes. */}
        <label className="figma-snapshot-consent">
          <input
            type="checkbox"
            className="figma-snapshot-consent-checkbox"
            ref={consentRef}
            checked={consentChecked}
            // uiux-fix F038 C210: a consent-blocked snapshot marks THIS control invalid so the
            // error visibly points at the checkbox (focus moves here too, see flagConsentRequired).
            aria-invalid={consentInvalid ? "true" : undefined}
            onChange={(e) => {
              setConsentChecked(e.target.checked);
              // Checking the box answers a consent error — clear stale feedback.
              if (errorNotice !== null) setErrorNotice(null);
              if (buildState === "error") setBuildState("idle");
              setConsentInvalid(false);
            }}
            disabled={isBuilding}
          />
          <span>
            I acknowledge the configured Figma PAT is read-only and least-privilege (
            <code>file_content:read</code>).{" "}
            <span className="figma-snapshot-consent-required">
              Required before the first snapshot of a board.
            </span>
          </span>
        </label>
        <p className="figma-snapshot-hint">
          Paste a Figma board link with a node-id param (section or frame anchor). The access token
          is resolved server-side — it never reaches this page.
        </p>
      </form>

      {/* ── Fix #5: assertive egress alert is a SIBLING of the status region, not nested ── */}
      {buildState === "error" && errorNotice !== null && errorNotice.assertive === true && (
        <div
          className="figma-snapshot-error-card"
          role="alert"
          aria-labelledby={`${statusId}-error-title`}
        >
          <p id={`${statusId}-error-title`} className="figma-snapshot-error-title">
            {errorNotice.title}
          </p>
          <p className="figma-snapshot-error-detail">{errorNotice.detail}</p>
          {errorNotice.status !== undefined && (
            <p className="figma-snapshot-error-status">{errorNotice.status}</p>
          )}
          {errorNotice.remediation !== undefined && (
            <p className="figma-snapshot-error-remediation">{errorNotice.remediation}</p>
          )}
        </div>
      )}

      {/* ── Status / progress ─────────────────────────────────────────────── */}
      <div
        id={statusId}
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="figma-snapshot-status"
      >
        {isBuilding && (
          <p className="figma-snapshot-progress">
            Building snapshot — fetching screens from Figma…{" "}
            {buildElapsedLabel !== null ? `${buildElapsedLabel} elapsed.` : ""} Large boards can
            take several minutes.
          </p>
        )}
        {isLoading && <p className="figma-snapshot-progress">Loading stored snapshot…</p>}
        {/* WCAG 4.1.3: completion is announced here (visually hidden — the visible
            result renders below, outside this live region). */}
        {buildState === "done" && summary !== null && (
          <p className="sr-only">Snapshot complete — {summary.reductionHint}.</p>
        )}
        {codeState === "done" && code !== null && (
          <p className="sr-only">
            Code generated — {String(code.fileCount)} file{code.fileCount !== 1 ? "s" : ""} ready
            for review.
          </p>
        )}
        {/* Fix #7: status note when a cancel brings us back to idle. */}
        {buildState === "idle" && (
          <p className="sr-only" aria-live="polite">
            {/* intentionally empty when idle — screen reader sees nothing */}
          </p>
        )}
        {/* uiux-fix F045 C375 / Fix #5: no role="alert" inside this polite atomic live region —
            the assertive egress card was moved above as a sibling. Non-assertive errors render
            here as plain text; the live region itself announces them. */}
        {buildState === "error" && errorNotice !== null && errorNotice.assertive !== true && (
          <p className="figma-snapshot-error">{errorNotice.detail}</p>
        )}
      </div>

      {/* ── Fix #7: Cancel button during build ────────────────────────────── */}
      {isBuilding && (
        <div className="figma-snapshot-cancel-row">
          <button type="button" className="figma-snapshot-cancel-btn" onClick={handleCancel}>
            Cancel
          </button>
          <p className="figma-snapshot-cancel-note" role="status" aria-live="polite">
            Cancelling stops this window from waiting — the server-side build continues on demand.
          </p>
        </div>
      )}

      {detachedBuild !== null && !busy && (
        <div className="figma-snapshot-stored-notice">
          <p className="figma-snapshot-stored-text">
            This window is no longer waiting. The server may still be building the snapshot in the
            background. You can close this window safely.
          </p>
          <button
            type="button"
            className="figma-snapshot-load-btn"
            onClick={handleReconnect}
          >
            Reconnect build
          </button>
        </div>
      )}

      {/* ── First-run guidance (nothing captured or stored yet) ───────────── */}
      {buildState === "idle" && summary === null && detachedBuild === null && !showLoadStored && (
        <div className="figma-snapshot-empty">
          <p className="figma-snapshot-empty-title">Capture screens from a Figma board</p>
          <ol className="figma-snapshot-empty-steps">
            <li>In Figma, select the frame or section you want to capture.</li>
            <li>Copy its link (Copy link to selection) — it contains the node-id.</li>
            <li>Paste it above, acknowledge the read-only scope, then take the snapshot.</li>
          </ol>
          <p className="figma-snapshot-empty-note">
            The snapshot stores the captured screens and their structure as immutable evidence —
            connect this window to Quality Intelligence to ground generated tests in the design.
            Requires a Figma access token configured on the server.
          </p>
        </div>
      )}

      {/* ── Load stored snapshot ──────────────────────────────────────────── */}
      {/* Fix #1: showLoadStored now includes buildState==="error" so the Load button
          stays mounted after a load failure — it is the retry affordance. */}
      {showLoadStored && (
        <div className="figma-snapshot-stored-notice">
          <p className="figma-snapshot-stored-text">A stored snapshot is available.</p>
          <button
            type="button"
            className="figma-snapshot-load-btn"
            onClick={handleLoadStored}
            aria-disabled={isLoading ? "true" : undefined}
            aria-busy={isLoading}
          >
            {isLoading ? "Loading…" : "Load snapshot"}
          </button>
        </div>
      )}

      <section className="figma-snapshot-dashboard" aria-label="Snapshot dashboard">
        <div className="figma-snapshot-dashboard-header">
          <div>
            <p className="figma-snapshot-dashboard-eyebrow">Snapshot dashboard</p>
            <h2 className="figma-snapshot-dashboard-title">Stored snapshots</h2>
          </div>
          <button
            type="button"
            className="figma-snapshot-dashboard-refresh"
            onClick={refreshDashboard}
          >
            Refresh
          </button>
        </div>
        <div className="figma-snapshot-dashboard-tabs" role="tablist" aria-label="Snapshot views">
          <button
            type="button"
            className="figma-snapshot-dashboard-tab"
            role="tab"
            aria-selected={dashboardTab === "board"}
            aria-controls={`${dashboardId}-board-panel`}
            id={`${dashboardId}-board-tab`}
            onClick={() => {
              if (currentScope !== null) setDashboardTab("board");
            }}
            disabled={currentScope === null}
          >
            This board
          </button>
          <button
            type="button"
            className="figma-snapshot-dashboard-tab"
            role="tab"
            aria-selected={dashboardTab === "recent"}
            aria-controls={`${dashboardId}-recent-panel`}
            id={`${dashboardId}-recent-tab`}
            onClick={() => {
              setDashboardTab("recent");
            }}
          >
            Recent
          </button>
        </div>
        {dashboardTab === "board" ? (
          <div
            id={`${dashboardId}-board-panel`}
            className="figma-snapshot-dashboard-panel"
            role="tabpanel"
            aria-labelledby={`${dashboardId}-board-tab`}
          >
            {currentScope === null
              ? renderDashboardList(
                  [],
                  false,
                  null,
                  "No board selected yet",
                  "Paste a valid Figma board link or load a stored snapshot to see this board's history.",
                  false,
                )
              : renderDashboardList(
                  boardSnapshots,
                  boardSnapshotsLoading,
                  boardSnapshotsError,
                  "No snapshots stored for this board",
                  "Take the first snapshot for this board to make it available here.",
                  false,
                )}
          </div>
        ) : (
          <div
            id={`${dashboardId}-recent-panel`}
            className="figma-snapshot-dashboard-panel"
            role="tabpanel"
            aria-labelledby={`${dashboardId}-recent-tab`}
          >
            {renderDashboardList(
              recentSnapshots,
              recentSnapshotsLoading,
              recentSnapshotsError,
              "No snapshots stored yet",
              "Stored Figma snapshots will appear here once the first board capture completes.",
              true,
            )}
          </div>
        )}
      </section>

      {/* ── Snapshot summary ──────────────────────────────────────────────── */}
      {/* Fix #2: render the result section whenever summary !== null (not only when
          buildState==="done") so a failed re-snapshot does not orphan the previous result.
          Building/error overlay status is shown inside the result section itself. */}
      {summary !== null && (
        <div className="figma-snapshot-result">
          {/* Reduction info */}
          <div className="figma-snapshot-reduction">
            <p className="figma-snapshot-reduction-hint">{summary.reductionHint}</p>
            {/* uiux-fix F045 C250: snapshot age — the information the re-snapshot
                decision hinges on. Same date presenter as the rest of the app. */}
            <p className="figma-snapshot-captured-at">Captured {formatDate(summary.fetchedAt)}</p>
            {summary.skippedCount > 0 && (
              <p className="figma-snapshot-skipped-notice">
                {String(summary.skippedCount)} screen{summary.skippedCount !== 1 ? "s" : ""} could
                not be rendered and were skipped.
              </p>
            )}
          </div>

          {/* Fix #2: Re-snapshot uses aria-disabled + guard so it never unmounts mid-action. */}
          <button
            type="button"
            className="figma-snapshot-resnapshot-btn"
            onClick={handleResnapshot}
            aria-disabled={busy ? "true" : undefined}
            aria-busy={isBuilding}
            aria-label="Re-snapshot this board"
          >
            {isBuilding ? "Building…" : "Re-snapshot"}
          </button>

          {/* Design-to-code (#755): generate reviewable HTML/CSS + design tokens from the stored
              snapshot. Deterministic + model-free server-side; the result is a proposal for review. */}
          <div className="figma-snapshot-codegen">
            <div className="figma-snapshot-codegen-actions">
              <button
                type="button"
                className="figma-snapshot-codegen-btn"
                onClick={handleGenerateCode}
                aria-disabled={codeState === "generating" ? "true" : undefined}
                aria-busy={codeState === "generating"}
              >
                {codeState === "generating" ? "Generating code…" : "Generate code"}
              </button>
              {codeState === "generating" && (
                <button
                  type="button"
                  className="figma-snapshot-codegen-cancel-btn"
                  onClick={handleCancelCodegen}
                >
                  Cancel
                </button>
              )}
            </div>
            {codeState === "error" && codeError !== null && (
              <p className="figma-snapshot-error" role="alert">
                {codeError}
              </p>
            )}
            {codeState === "done" && code !== null && (
              <div className="figma-snapshot-code-result">
                <p className="figma-snapshot-code-summary">
                  {String(code.fileCount)} reviewable file{code.fileCount !== 1 ? "s" : ""} (
                  {String(code.screenCount)} screen{code.screenCount !== 1 ? "s" : ""},{" "}
                  {code.adapterName}) — proposal only, never auto-applied.
                </p>
                {code.files.map((file) => (
                  <details key={file.path} className="figma-snapshot-code-file">
                    <summary className="figma-snapshot-code-file-path">{file.path}</summary>
                    <pre className="figma-snapshot-code-file-contents">
                      <code>{file.contents}</code>
                    </pre>
                  </details>
                ))}
              </div>
            )}
          </div>

          {/* PAT scopes info + Fix #3: revoke action ─ operator-facing */}
          <details className="figma-snapshot-scopes">
            <summary className="figma-snapshot-scopes-summary">Required Figma PAT scopes</summary>
            <ul className="figma-snapshot-scopes-list">
              <li>
                <code>file_content:read</code> — read design file structure, node metadata, and
                rendered images
              </li>
            </ul>
            <p className="figma-snapshot-scopes-note">
              The token is read server-side from the vault, Keiko config, or{" "}
              <code>FIGMA_ACCESS_TOKEN</code> environment variable. This window never holds or
              transmits the token.
            </p>
            {/* Fix #3: two-step inline confirm for PAT revoke (mirrors ContextBudget pattern).
                Revoke removes the stored encrypted PAT from the server vault (#758). */}
            <div className="figma-snapshot-revoke-row">
              {revokeConfirming ? (
                <span className="figma-snapshot-revoke-confirm">
                  <span className="figma-snapshot-revoke-confirm-label">
                    Really revoke the stored token?
                  </span>
                  <button
                    ref={revokeConfirmRef}
                    type="button"
                    className="figma-snapshot-revoke-confirm-btn"
                    onClick={handleRevokeConfirmed}
                  >
                    Yes, revoke
                  </button>
                  <button
                    type="button"
                    className="figma-snapshot-revoke-cancel-btn"
                    onClick={handleRevokeCancel}
                  >
                    Cancel
                  </button>
                </span>
              ) : (
                <button
                  ref={revokeTriggerRef}
                  type="button"
                  className="figma-snapshot-revoke-btn"
                  onClick={() => {
                    setRevokeConfirming(true);
                    setRevokeStatus(null);
                    setRevokeError(null);
                  }}
                >
                  Revoke stored token
                </button>
              )}
              {/* aria-live status region for revoke outcome */}
              <p
                className="figma-snapshot-revoke-status"
                role="status"
                aria-live="polite"
                aria-atomic="true"
              >
                {revokeStatus ?? revokeError ?? ""}
              </p>
            </div>
          </details>

          {/* Screen gallery */}
          {summary.screens.length > 0 ? (
            <>
              <section
                className="figma-snapshot-gallery"
                aria-label={`${String(summary.screenCount)} captured screen${summary.screenCount !== 1 ? "s" : ""}`}
              >
                {summary.screens.slice(0, visibleScreenCount).map((screen, i) => (
                  <ScreenCard
                    key={screen.screenId}
                    index={i}
                    screenId={screen.screenId}
                    name={screen.name}
                    irSummary={screen.irSummary}
                    imageSrc={figmaSnapshotScreenImageUrl(summary.runId, i)}
                    imageByteLength={screen.imageByteLength}
                  />
                ))}
              </section>
              {visibleScreenCount < summary.screens.length ? (
                <button
                  type="button"
                  className="figma-snapshot-gallery-more"
                  onClick={() =>
                    setVisibleScreenCount((count) =>
                      Math.min(count + INITIAL_GALLERY_LIMIT, summary.screens.length),
                    )
                  }
                >
                  Show more screens
                </button>
              ) : null}
            </>
          ) : (
            <div className="lk-empty">
              <p className="lk-empty-body">No screens were captured from this board section.</p>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
