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

import { useCallback, useId, useState, type FormEvent, type ReactNode } from "react";
import {
  triggerFigmaSnapshot,
  loadFigmaSnapshotSummary,
  generateFigmaCode,
} from "@/lib/figma-snapshot-api";
import type { FigmaSnapshotSummary, FigmaCodegenResponse } from "@/lib/figma-snapshot-api";
import { ApiError } from "@/lib/api";

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

function formatError(err: unknown): string {
  if (err instanceof ApiError) return `${err.code}: ${err.message}`;
  if (err instanceof Error) return err.message;
  return "An unexpected error occurred.";
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
  const kib = (imageByteLength / 1024).toFixed(1);
  return (
    <article
      className="figma-snapshot-screen-card"
      aria-label={`Screen ${String(index + 1)}: ${name}`}
    >
      <div className="figma-snapshot-screen-placeholder" aria-hidden="true">
        <span className="figma-snapshot-screen-index">{String(index + 1)}</span>
      </div>
      <div className="figma-snapshot-screen-meta">
        <h3 className="figma-snapshot-screen-name">{name}</h3>
        <p className="figma-snapshot-screen-summary">{irSummary}</p>
        <p className="figma-snapshot-screen-size">{kib} KiB</p>
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
}

// ─── Component ────────────────────────────────────────────────────────────────

type BuildState = "idle" | "building" | "done" | "error";

export function FigmaSnapshotWindow({
  snapshotRunId,
  updateCfg,
  triggerImpl = triggerFigmaSnapshot,
  loadImpl = loadFigmaSnapshotSummary,
  codegenImpl = generateFigmaCode,
}: FigmaSnapshotWindowProps): ReactNode {
  const inputId = useId();
  const statusId = useId();

  const [boardLink, setBoardLink] = useState("");
  const [buildState, setBuildState] = useState<BuildState>("idle");
  const [summary, setSummary] = useState<FigmaSnapshotSummary | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  // Explicit read-only-scope acknowledgement (#760) — recorded server-side before the first build.
  const [consentChecked, setConsentChecked] = useState(false);
  // Design-to-code (#755) state — a reviewable artifact generated from the stored snapshot.
  const [codeState, setCodeState] = useState<"idle" | "generating" | "done" | "error">("idle");
  const [code, setCode] = useState<FigmaCodegenResponse | null>(null);
  const [codeError, setCodeError] = useState<string | null>(null);

  const linkValid = isValidFigmaLink(boardLink);
  const isBuilding = buildState === "building";

  const runBuild = useCallback(
    async (link: string, isResnapshot: boolean): Promise<void> => {
      setBuildState("building");
      setErrorMsg(null);
      setCodeState("idle");
      setCode(null);
      try {
        const result = await triggerImpl(link, {
          acknowledgeReadOnly: consentChecked,
          isResnapshot,
        });
        setSummary(result);
        updateCfg({ snapshotRunId: result.runId });
        setBuildState("done");
      } catch (err) {
        setErrorMsg(formatError(err));
        setBuildState("error");
      }
    },
    [triggerImpl, updateCfg, consentChecked],
  );

  const handleSubmit = useCallback(
    (e: FormEvent<HTMLFormElement>): void => {
      e.preventDefault();
      if (!linkValid || isBuilding) return;
      void runBuild(boardLink, false);
    },
    [boardLink, isBuilding, linkValid, runBuild],
  );

  const handleResnapshot = useCallback((): void => {
    if (isBuilding) return;
    const link =
      boardLink.trim().length > 0
        ? boardLink
        : summary !== null
          ? `https://www.figma.com/design/${summary.fileKey}/board?node-id=${summary.nodeId}`
          : "";
    if (link.length === 0) return;
    void runBuild(link, true);
  }, [boardLink, isBuilding, runBuild, summary]);

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
    if (snapshotRunId === undefined || snapshotRunId.length === 0) return;
    setBuildState("building");
    setErrorMsg(null);
    loadImpl(snapshotRunId)
      .then((result) => {
        setSummary(result);
        setBuildState("done");
      })
      .catch((err: unknown) => {
        setErrorMsg(formatError(err));
        setBuildState("error");
      });
  }, [loadImpl, snapshotRunId]);

  const showLoadStored =
    snapshotRunId !== undefined &&
    snapshotRunId.length > 0 &&
    summary === null &&
    buildState === "idle";

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
            }}
            aria-describedby={statusId}
            aria-invalid={boardLink.length > 0 && !linkValid ? "true" : undefined}
            disabled={isBuilding}
            autoComplete="off"
            spellCheck={false}
          />
          <button
            type="submit"
            className="figma-snapshot-trigger-btn"
            disabled={!linkValid || isBuilding}
            aria-busy={isBuilding}
          >
            {isBuilding ? "Building…" : "Snapshot"}
          </button>
        </div>
        {/* Explicit read-only-scope acknowledgement (#760): recorded server-side before the first
            fetch for a board. The connector reads files + renders images — it never writes. */}
        <label className="figma-snapshot-consent">
          <input
            type="checkbox"
            className="figma-snapshot-consent-checkbox"
            checked={consentChecked}
            onChange={(e) => {
              setConsentChecked(e.target.checked);
            }}
            disabled={isBuilding}
          />
          <span>
            I acknowledge the configured Figma PAT is read-only and least-privilege (
            <code>files:read</code>).
          </span>
        </label>
        <p className="figma-snapshot-hint">
          Paste a Figma board link with a node-id param (section or frame anchor). The access token
          is resolved server-side — it never reaches this page.
        </p>
      </form>

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
        {buildState === "error" && errorMsg !== null && (
          <p className="figma-snapshot-error" role="alert">
            {errorMsg}
          </p>
        )}
      </div>

      {/* ── Load stored snapshot ──────────────────────────────────────────── */}
      {showLoadStored && (
        <div className="figma-snapshot-stored-notice">
          <p className="figma-snapshot-stored-text">A stored snapshot is available.</p>
          <button type="button" className="figma-snapshot-load-btn" onClick={handleLoadStored}>
            Load snapshot
          </button>
        </div>
      )}

      {/* ── Snapshot summary ──────────────────────────────────────────────── */}
      {summary !== null && buildState === "done" && (
        <div className="figma-snapshot-result">
          {/* Reduction info */}
          <div className="figma-snapshot-reduction">
            <p className="figma-snapshot-reduction-hint">{summary.reductionHint}</p>
            {summary.skippedCount > 0 && (
              <p className="figma-snapshot-skipped-notice">
                {String(summary.skippedCount)} screen{summary.skippedCount !== 1 ? "s" : ""} could
                not be rendered and were skipped.
              </p>
            )}
          </div>

          {/* Re-snapshot action */}
          <button
            type="button"
            className="figma-snapshot-resnapshot-btn"
            onClick={handleResnapshot}
            disabled={isBuilding}
            aria-label="Re-snapshot this board"
          >
            Re-snapshot
          </button>

          {/* Design-to-code (#755): generate reviewable HTML/CSS + design tokens from the stored
              snapshot. Deterministic + model-free server-side; the result is a proposal for review. */}
          <div className="figma-snapshot-codegen">
            <button
              type="button"
              className="figma-snapshot-codegen-btn"
              onClick={handleGenerateCode}
              disabled={codeState === "generating"}
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

          {/* PAT scopes info — informational only, operator-facing */}
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
