"use client";

// Living Tests drift panel (Epic #735, Issue #744). Lets the user re-check a run against its current
// connected source and, when tests have drifted, regenerate ONLY the stale ones (a new immutable run
// is written; fresh tests + human edits are preserved). Rendered only when the run card knows the
// source it was launched from. The drift indicator is never colour-only — it pairs an icon with text.

import { useCallback, useState } from "react";
import type { ReactNode } from "react";
import type {
  QualityIntelligenceInlineSource,
  QualityIntelligenceUiStalenessReport,
  QualityIntelligenceUiRegenerateResult,
} from "@oscharko-dev/keiko-contracts";
import { reCheckQiRun, regenerateStaleQiRun } from "@/lib/quality-intelligence-api";
import { formatError } from "./qiShared";

export interface DriftPanelProps {
  readonly runId: string;
  readonly connectedSource: QualityIntelligenceInlineSource;
  /** Called after a successful regeneration so the parent can surface the new run. */
  readonly onRegenerated?: ((result: QualityIntelligenceUiRegenerateResult) => void) | undefined;
  /** Seams for tests. */
  readonly reCheckImpl?: typeof reCheckQiRun | undefined;
  readonly regenerateImpl?: typeof regenerateStaleQiRun | undefined;
}

function DriftIndicator({ staleCount }: { readonly staleCount: number }): ReactNode {
  if (staleCount === 0) {
    return (
      <p className="qi-drift-fresh" role="status" data-testid="qi-drift-fresh">
        <span aria-hidden="true" className="qi-drift-icon-ok">
          ✓
        </span>
        No drift — every test is current.
      </p>
    );
  }
  return (
    <p className="qi-drift-stale" role="status" data-testid="qi-drift-stale">
      <span aria-hidden="true" className="qi-drift-icon-warn">
        ⚠
      </span>
      {`${staleCount.toString()} ${staleCount === 1 ? "test is" : "tests are"} stale — source changed since this run.`}
    </p>
  );
}

export function DriftPanel({
  runId,
  connectedSource,
  onRegenerated,
  reCheckImpl = reCheckQiRun,
  regenerateImpl = regenerateStaleQiRun,
}: DriftPanelProps): ReactNode {
  const [report, setReport] = useState<QualityIntelligenceUiStalenessReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [regenerated, setRegenerated] = useState<QualityIntelligenceUiRegenerateResult | null>(
    null,
  );

  const handleReCheck = useCallback((): void => {
    void (async (): Promise<void> => {
      setBusy(true);
      setError(null);
      setRegenerated(null);
      try {
        setReport(await reCheckImpl(runId, [connectedSource]));
      } catch (err) {
        setError(formatError(err));
      } finally {
        setBusy(false);
      }
    })();
  }, [reCheckImpl, runId, connectedSource]);

  const handleRegenerate = useCallback((): void => {
    void (async (): Promise<void> => {
      setBusy(true);
      setError(null);
      try {
        const result = await regenerateImpl(runId, [connectedSource]);
        setRegenerated(result);
        onRegenerated?.(result);
      } catch (err) {
        setError(formatError(err));
      } finally {
        setBusy(false);
      }
    })();
  }, [regenerateImpl, runId, connectedSource, onRegenerated]);

  return (
    <section className="qi-drift-panel" aria-label="Drift detection">
      <div className="qi-drift-head">
        <h3 className="qi-col-subtitle">Living tests</h3>
        <button
          type="button"
          className="qi-btn qi-btn-secondary"
          onClick={handleReCheck}
          disabled={busy}
          data-testid="qi-drift-recheck"
        >
          {busy ? "Checking…" : "Re-check drift"}
        </button>
      </div>
      {error !== null ? (
        <p className="lk-alert" role="alert">
          {error}
        </p>
      ) : null}
      {report !== null ? <DriftIndicator staleCount={report.staleCount} /> : null}
      {report !== null && report.staleCount > 0 && regenerated === null ? (
        <button
          type="button"
          className="qi-btn qi-btn-approve"
          onClick={handleRegenerate}
          disabled={busy}
          data-testid="qi-drift-regenerate"
        >
          {`Regenerate ${report.staleCount.toString()} stale ${report.staleCount === 1 ? "test" : "tests"}`}
        </button>
      ) : null}
      {regenerated !== null ? (
        <p className="qi-drift-regenerated" role="status" data-testid="qi-drift-regenerated">
          {`Regenerated ${regenerated.regeneratedCount.toString()} test(s) as a new run (${regenerated.preservedCount.toString()} preserved).`}
        </p>
      ) : null}
    </section>
  );
}
