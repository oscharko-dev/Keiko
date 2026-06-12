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
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { ApiError } from "@/lib/api";
import { formatBytes, formatDate } from "@/lib/format";
import {
  triggerFigmaSnapshot,
  loadFigmaSnapshotSummary,
  generateFigmaCode,
  revokeFigmaToken,
} from "@/lib/figma-snapshot-api";
import type {
  FigmaSnapshotSummary,
  FigmaCodegenResponse,
  FigmaRevokeTokenResult,
} from "@/lib/figma-snapshot-api";

// ─── Helpers ──────────────────────────────────────────────────────────────────

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
    if (host !== "figma.com" && !host.endsWith(".figma.com")) return false;
    if (!/^\/(design|file)\//u.test(url.pathname)) return false;
    const nodeId = url.searchParams.get("node-id");
    return nodeId !== null && nodeId.length > 0;
  } catch {
    return false;
  }
}

interface SnapshotErrorNotice {
  readonly title: string;
  readonly detail: string;
  readonly status?: string | undefined;
  readonly remediation?: string | undefined;
  readonly assertive?: boolean | undefined;
}

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

/**
 * Differentiated validation microcopy (WCAG 3.3.1 Error Identification) for a
 * non-empty, invalid board link. Returns null when the link is empty or valid.
 */
function figmaLinkValidationMessage(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || isValidFigmaLink(trimmed)) return null;
  try {
    const host = new URL(trimmed).hostname.toLowerCase();
    if (host === "figma.com" || host.endsWith(".figma.com")) {
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
  readonly imageByteLength: number;
}

function ScreenCard({
  index,
  screenId,
  name,
  irSummary,
  imageByteLength,
}: ScreenCardProps): ReactNode {
  return (
    <article
      className="figma-snapshot-screen-card"
      aria-label={`Screen ${String(index + 1)}: ${name}`}
    >
      {/* uiux-fix F045 C378: the tile is a deliberate thumbnail surrogate (no image-serving
          endpoint yet) — a frame glyph above the index reads as "screen N", not as a
          failed image load. */}
      <div className="figma-snapshot-screen-placeholder" aria-hidden="true">
        <svg
          className="figma-snapshot-screen-frame-icon"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        >
          <path d="M7 2v20M17 2v20M2 7h20M2 17h20" />
        </svg>
        <span className="figma-snapshot-screen-index">{String(index + 1)}</span>
      </div>
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
  codegenImpl = generateFigmaCode,
  revokeImpl = revokeFigmaToken,
}: FigmaSnapshotWindowProps): ReactNode {
  const inputId = useId();
  const statusId = useId();
  const validationId = useId();

  const [boardLink, setBoardLink] = useState("");
  const [buildState, setBuildState] = useState<BuildState>("idle");
  const [summary, setSummary] = useState<FigmaSnapshotSummary | null>(null);
  const [errorNotice, setErrorNotice] = useState<SnapshotErrorNotice | null>(null);
  // Explicit read-only-scope acknowledgement (#760) — recorded server-side before the first build.
  const [consentChecked, setConsentChecked] = useState(false);
  // uiux-fix F038 C210: when consent blocks a snapshot (inline pre-check OR the server's 428
  // FIGMA_CONSENT_REQUIRED), the error must point AT the checkbox — mark it invalid and move
  // focus to it instead of leaving the user to connect message and control themselves.
  const [consentInvalid, setConsentInvalid] = useState(false);
  const consentRef = useRef<HTMLInputElement | null>(null);

  // Fix #7: AbortController for the active build/load fetch.
  const abortRef = useRef<AbortController | null>(null);

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

  const linkValid = isValidFigmaLink(boardLink);
  const linkError = figmaLinkValidationMessage(boardLink);
  const isBuilding = buildState === "building";
  const isLoading = buildState === "loading";
  const busy = isBuilding || isLoading;

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

  // Fix #7: abort in-flight fetch on unmount.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const runBuild = useCallback(
    async (link: string, isResnapshot: boolean): Promise<void> => {
      // Abort any previous in-flight request before starting a new one.
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setBuildState("building");
      setErrorNotice(null);
      setCodeState("idle");
      setCode(null);
      try {
        const result = await triggerImpl(link, {
          acknowledgeReadOnly: consentChecked,
          isResnapshot,
          signal: controller.signal,
        });
        setSummary(result);
        updateCfg({ snapshotRunId: result.runId });
        setBuildState("done");
      } catch (err) {
        // Ignore abort — user clicked Cancel or component unmounted.
        if (err instanceof DOMException && err.name === "AbortError") return;
        // uiux-fix F038 C210: the server's 428 message names the policy but not the control —
        // extend it with an instruction that points at the checkbox, and highlight + focus it.
        if (err instanceof ApiError && err.code === "FIGMA_CONSENT_REQUIRED") {
          const notice = formatSnapshotError(err);
          setErrorNotice({
            ...notice,
            detail: `${notice.detail} Tick the acknowledgement checkbox below, then snapshot again.`,
          });
          flagConsentRequired();
        } else {
          setErrorNotice(formatSnapshotError(err));
        }
        setBuildState("error");
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
    // uiux-fix F045 C249: "Re-snapshot this board" means THIS board — always rebuild the
    // link from the stored summary instead of trusting whatever currently sits in the
    // input (which may be invalid or point at a different board, bypassing the
    // isValidFigmaLink gate). New boards go through Submit, which is gated.
    const link = `https://www.figma.com/design/${summary.fileKey}/board?node-id=${summary.nodeId}`;
    void runBuild(link, true);
  }, [busy, runBuild, summary]);

  // Fix #7: Cancel the in-flight build and return to idle with a status note.
  const handleCancel = useCallback((): void => {
    abortRef.current?.abort();
    abortRef.current = null;
    setBuildState("idle");
    setErrorNotice(null);
  }, []);

  const handleGenerateCode = useCallback((): void => {
    const runId = summary?.runId ?? snapshotRunId;
    if (runId === undefined || runId.length === 0 || codeState === "generating") return;
    setCodeState("generating");
    setCodeError(null);
    codegenImpl(runId)
      .then((result) => {
        setCode(result);
        setCodeState("done");
      })
      .catch((err: unknown) => {
        setCodeError(formatError(err));
        setCodeState("error");
      });
  }, [codegenImpl, codeState, snapshotRunId, summary]);

  // Load a previously stored snapshot (e.g. after window re-open) when runId is in cfg but no
  // in-memory summary is present.
  const handleLoadStored = useCallback((): void => {
    if (snapshotRunId === undefined || snapshotRunId.length === 0 || busy) return;
    // Abort any previous in-flight request.
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    // Distinct "loading" state — this path reads the locally stored evidence record
    // only and never contacts Figma, so it must not show the "building" copy.
    setBuildState("loading");
    setErrorNotice(null);
    loadImpl(snapshotRunId, controller.signal)
      .then((result) => {
        setSummary(result);
        setBuildState("done");
      })
      .catch((err: unknown) => {
        // Ignore abort.
        if (err instanceof DOMException && (err as DOMException).name === "AbortError") return;
        // Fix #6: FIGMA_SNAPSHOT_NOT_FOUND on load — the stored runId is stale; clear it so
        // the connected QI hub stops feeding a dead run id.
        if (err instanceof ApiError && err.code === "FIGMA_SNAPSHOT_NOT_FOUND") {
          updateCfg({ snapshotRunId: undefined });
          setErrorNotice({
            ...formatSnapshotError(err),
            detail: `${err.message} The stored run ID has been cleared.`,
          });
        } else {
          setErrorNotice(formatSnapshotError(err));
        }
        setBuildState("error");
      });
  }, [busy, loadImpl, snapshotRunId, updateCfg]);

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
          <p id={validationId} className="figma-snapshot-link-error">
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
            <code>files:read</code>).{" "}
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
            Building snapshot — fetching screens from Figma…
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

      {/* ── First-run guidance (nothing captured or stored yet) ───────────── */}
      {buildState === "idle" && summary === null && !showLoadStored && (
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
            <button
              type="button"
              className="figma-snapshot-codegen-btn"
              onClick={handleGenerateCode}
              aria-disabled={codeState === "generating" ? "true" : undefined}
              aria-busy={codeState === "generating"}
            >
              {codeState === "generating" ? "Generating code…" : "Generate code"}
            </button>
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
                <code>file_read</code> — read design file structure and node metadata
              </li>
              <li>
                <code>files:read</code> — read file content (REST API scope)
              </li>
            </ul>
            <p className="figma-snapshot-scopes-note">
              The token is read server-side from the <code>FIGMA_ACCESS_TOKEN</code> environment
              variable or vault. This window never holds or transmits the token.
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
            <section
              className="figma-snapshot-gallery"
              aria-label={`${String(summary.screenCount)} captured screen${summary.screenCount !== 1 ? "s" : ""}`}
            >
              {summary.screens.map((screen, i) => (
                <ScreenCard
                  key={screen.screenId}
                  index={i}
                  screenId={screen.screenId}
                  name={screen.name}
                  irSummary={screen.irSummary}
                  imageByteLength={screen.imageByteLength}
                />
              ))}
            </section>
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
