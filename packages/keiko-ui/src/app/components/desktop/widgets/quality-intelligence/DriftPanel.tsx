"use client";

// Living Tests drift panel (Epic #735, Issue #744). Lets the user re-check a run against its current
// connected source and, when tests have drifted, regenerate ONLY the stale ones (a new immutable run
// is written; fresh tests + human edits are preserved). Rendered only when the run card knows the
// source it was launched from. The drift indicator is never colour-only — it pairs an icon with text.

import { useCallback, useRef, useState } from "react";
import type { ReactNode } from "react";
import type {
  QualityIntelligenceInlineSource,
  QualityIntelligenceUiStalenessReport,
  QualityIntelligenceUiRegenerateResult,
} from "@oscharko-dev/keiko-contracts";
import { reCheckQiRun, regenerateStaleQiRun } from "@/lib/quality-intelligence-api";
import { formatError } from "./qiShared";
import { useQiTranslate, type I18nTranslate } from "./qi-i18n";

export interface DriftPanelProps {
  readonly runId: string;
  /**
   * The inline sources this run was launched from (Epic #735). Re-check and regeneration run against
   * ALL of them, in the same order they were generated from, so a multi-source run (folders +
   * capsules + figma snapshots) drifts as a whole. Must be non-empty (the card hides the panel
   * otherwise).
   */
  readonly connectedSources: readonly QualityIntelligenceInlineSource[];
  /** Called after a successful regeneration so the parent can surface the new run. */
  readonly onRegenerated?: ((result: QualityIntelligenceUiRegenerateResult) => void) | undefined;
  /** Seams for tests. */
  readonly reCheckImpl?: typeof reCheckQiRun | undefined;
  readonly regenerateImpl?: typeof regenerateStaleQiRun | undefined;
}

// The drift sentence is shared by the visible indicator AND the persistent sr-only live region
// (uiux-fix F047 C155: a role="status" element inserted together with its content is often not
// announced — the live region must exist BEFORE the text changes).
function driftMessage(staleCount: number, t: I18nTranslate): string {
  return staleCount === 0
    ? t("qi.drift.fresh")
    : t(staleCount === 1 ? "qi.drift.staleSingle" : "qi.drift.staleMany", {
        count: staleCount,
      });
}

function regeneratedMessage(
  result: QualityIntelligenceUiRegenerateResult,
  t: I18nTranslate,
): string {
  // Real singular/plural wording — no "test(s)" shorthand (uiux-fix F047 C276/C391).
  const regenerated = result.regeneratedCount;
  const preserved = result.preservedCount;
  return t(regenerated === 1 ? "qi.drift.regeneratedSingle" : "qi.drift.regeneratedMany", {
    count: regenerated,
    preserved,
  });
}

function DriftIndicator({
  staleCount,
  t,
}: {
  readonly staleCount: number;
  readonly t: I18nTranslate;
}): ReactNode {
  if (staleCount === 0) {
    return (
      <p className="qi-drift-fresh" data-testid="qi-drift-fresh">
        <span aria-hidden="true" className="qi-drift-icon-ok">
          ✓
        </span>
        {driftMessage(0, t)}
      </p>
    );
  }
  return (
    <p className="qi-drift-stale" data-testid="qi-drift-stale">
      <span aria-hidden="true" className="qi-drift-icon-warn">
        ⚠
      </span>
      {driftMessage(staleCount, t)}
    </p>
  );
}

export function DriftPanel({
  runId,
  connectedSources,
  onRegenerated,
  reCheckImpl = reCheckQiRun,
  regenerateImpl = regenerateStaleQiRun,
}: DriftPanelProps): ReactNode {
  const t = useQiTranslate();
  const [report, setReport] = useState<QualityIntelligenceUiStalenessReport | null>(null);
  // Re-check and regenerate carry their OWN busy label ("Checking…" vs "Regenerating…") — a shared
  // boolean put "Checking…" on the idle Re-check button during the long model-backed regeneration
  // (uiux-fix F047 C274). Either operation still inerts BOTH buttons.
  const [busyOp, setBusyOp] = useState<"check" | "regenerate" | null>(null);
  const busy = busyOp !== null;
  const [error, setError] = useState<string | null>(null);
  const [regenerated, setRegenerated] = useState<QualityIntelligenceUiRegenerateResult | null>(
    null,
  );
  const reCheckBtnRef = useRef<HTMLButtonElement | null>(null);
  const regenerateBtnRef = useRef<HTMLButtonElement | null>(null);

  const handleReCheck = useCallback((): void => {
    if (busy) return;
    void (async (): Promise<void> => {
      setBusyOp("check");
      setError(null);
      setRegenerated(null);
      try {
        setReport(await reCheckImpl(runId, connectedSources));
      } catch (err) {
        setError(formatError(err));
      } finally {
        setBusyOp(null);
      }
    })();
  }, [busy, reCheckImpl, runId, connectedSources]);

  const handleRegenerate = useCallback((): void => {
    if (busy) return;
    void (async (): Promise<void> => {
      setBusyOp("regenerate");
      setError(null);
      try {
        const result = await regenerateImpl(runId, connectedSources);
        // The Regenerate button unmounts on success — park keyboard focus on the always-mounted
        // Re-check button first so it does not strand on <body> (uiux-fix F047 C268, WCAG 2.4.3).
        if (document.activeElement === regenerateBtnRef.current) {
          reCheckBtnRef.current?.focus();
        }
        setRegenerated(result);
        // The stale report described the OLD run; once a new run is written it no longer applies, so
        // clear it to avoid showing a stale count next to the "regenerated" confirmation (#744).
        setReport(null);
        onRegenerated?.(result);
      } catch (err) {
        setError(formatError(err));
      } finally {
        setBusyOp(null);
      }
    })();
  }, [busy, regenerateImpl, runId, connectedSources, onRegenerated]);

  return (
    <section className="qi-drift-panel" aria-label={t("qi.drift.title")}>
      {/* Persistent live region (uiux-fix F047 C155): mounted from the first render so screen
          readers reliably announce the re-check result and the regenerate confirmation — regions
          inserted together with their content are often skipped. The visible indicator below stays
          conditional and is no longer a live region itself. */}
      <p className="sr-only" role="status" aria-live="polite">
        {regenerated !== null
          ? regeneratedMessage(regenerated, t)
          : report !== null
            ? driftMessage(report.staleCount, t)
            : ""}
      </p>
      <div className="qi-drift-head">
        <h3 className="qi-col-subtitle">{t("qi.drift.livingTests")}</h3>
        {/* aria-disabled (not native disabled) keeps focus on the button while busy — native
            disable threw keyboard focus onto <body> mid-operation (uiux-fix F047 C268). The click
            guard lives in the handler. */}
        <button
          type="button"
          ref={reCheckBtnRef}
          className="qi-btn qi-btn-secondary"
          onClick={handleReCheck}
          aria-disabled={busy || undefined}
          data-testid="qi-drift-recheck"
        >
          {busyOp === "check" ? t("qi.drift.checking") : t("qi.drift.recheck")}
        </button>
      </div>
      {error !== null ? (
        <p className="lk-alert" role="alert">
          {error}
        </p>
      ) : null}
      {report !== null ? <DriftIndicator staleCount={report.staleCount} t={t} /> : null}
      {report !== null && report.staleCount > 0 && regenerated === null ? (
        <button
          type="button"
          ref={regenerateBtnRef}
          className="qi-btn qi-btn-approve"
          onClick={handleRegenerate}
          aria-disabled={busy || undefined}
          data-testid="qi-drift-regenerate"
        >
          {busyOp === "regenerate"
            ? t("qi.drift.regenerating")
            : t(report.staleCount === 1 ? "qi.drift.regenerateSingle" : "qi.drift.regenerateMany", {
                count: report.staleCount,
              })}
        </button>
      ) : null}
      {regenerated !== null ? (
        <p className="qi-drift-regenerated" data-testid="qi-drift-regenerated">
          {regeneratedMessage(regenerated, t)}
        </p>
      ) : null}
    </section>
  );
}
