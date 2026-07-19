"use client";

// Live HTML Manual Knowledge Pod refresh control (Issue #2063). Renders a refresh button for an
// HTML-manual pod; on confirm it starts the governed BFF refresh job and polls its body-free
// `HtmlManualPodJob` projection, surfacing live crawl/index progress until the job settles. Strings
// go through the shared `manualPodRefresh.*` i18n catalog (en+de); only existing global classes are
// reused (no globals.css edit, #1300). Every API call is an injectable seam so the flow is tested
// without a real network.

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { HtmlManualPodJob, KnowledgeCapsuleId } from "@oscharko-dev/keiko-contracts";
import { getHtmlManualPodJob, startHtmlManualPodRefresh } from "@/lib/local-knowledge-api";
import { useTranslate } from "@/lib/i18n";
import { formatError } from "./format-error";

const POLL_INTERVAL_MS = 1500;

export interface HtmlManualPodRefreshProps {
  readonly capsuleId: KnowledgeCapsuleId;
  readonly sourceId: string;
  readonly startRefreshImpl?: typeof startHtmlManualPodRefresh;
  readonly getJobImpl?: typeof getHtmlManualPodJob;
  readonly onRefreshComplete?: () => void;
  // Test seam: the live-progress poll interval (defaults to POLL_INTERVAL_MS in the product).
  readonly pollIntervalMs?: number;
}

type RefreshState =
  | { readonly kind: "idle" }
  | { readonly kind: "confirm" }
  | { readonly kind: "active"; readonly job: HtmlManualPodJob }
  | { readonly kind: "error"; readonly message: string };

type Translate = ReturnType<typeof useTranslate>;

function stateLabel(job: HtmlManualPodJob, t: Translate): string {
  if (job.state === "running") return t("manualPodRefresh.progress.running");
  if (job.state === "succeeded") return t("manualPodRefresh.state.succeeded");
  return t("manualPodRefresh.state.failed");
}

function ProgressView({
  job,
  t,
}: {
  readonly job: HtmlManualPodJob;
  readonly t: Translate;
}): ReactNode {
  return (
    <div className="lkd-action-progress" role="status" aria-live="polite">
      <p>{stateLabel(job, t)}</p>
      <p>
        {t("manualPodRefresh.progress.crawl", {
          accepted: String(job.crawl.accepted),
          denied: String(job.crawl.deniedCount),
        })}
      </p>
      {job.indexing !== null ? (
        <p>
          {t("manualPodRefresh.progress.index", {
            processed: String(job.indexing.processedDocuments),
            total: String(job.indexing.totalDocuments),
          })}
        </p>
      ) : null}
    </div>
  );
}

// Poll the job until it leaves the running state, updating `setState` on each tick.
function useJobPolling(
  state: RefreshState,
  getJob: typeof getHtmlManualPodJob,
  setState: (next: RefreshState) => void,
  onComplete: (() => void) | undefined,
  intervalMs: number,
): void {
  // Key the poll on the running job's id (stable across progress ticks) so the effect starts once
  // per job and does not restart on every setState. A self-scheduling timeout (not an interval)
  // means a new poll never fires until the previous one has resolved, so overlapping requests can
  // never stack and `onComplete` fires exactly once when the job settles.
  const pollJobId =
    state.kind === "active" && state.job.state === "running" ? state.job.jobId : undefined;
  useEffect(() => {
    if (pollJobId === undefined) {
      return undefined;
    }
    let cancelled = false;
    let timer: number | undefined;
    const poll = (): void => {
      void getJob(pollJobId)
        .then((job) => {
          if (cancelled) return;
          setState({ kind: "active", job });
          if (job.state === "running") {
            timer = window.setTimeout(poll, intervalMs);
          } else {
            onComplete?.();
          }
        })
        .catch((error: unknown) => {
          if (!cancelled) setState({ kind: "error", message: formatError(error) });
        });
    };
    timer = window.setTimeout(poll, intervalMs);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [pollJobId, getJob, setState, onComplete, intervalMs]);
}

export function HtmlManualPodRefresh(props: HtmlManualPodRefreshProps): ReactNode {
  const t = useTranslate();
  const [state, setState] = useState<RefreshState>({ kind: "idle" });
  const busyRef = useRef(false);
  const start = props.startRefreshImpl ?? startHtmlManualPodRefresh;
  const getJob = props.getJobImpl ?? getHtmlManualPodJob;

  useJobPolling(
    state,
    getJob,
    setState,
    props.onRefreshComplete,
    props.pollIntervalMs ?? POLL_INTERVAL_MS,
  );

  const beginRefresh = useCallback((): void => {
    if (busyRef.current) return;
    busyRef.current = true;
    void start(props.capsuleId, props.sourceId)
      .then((job) => setState({ kind: "active", job }))
      .catch((error: unknown) => setState({ kind: "error", message: formatError(error) }))
      .finally(() => {
        busyRef.current = false;
      });
  }, [start, props.capsuleId, props.sourceId]);

  if (state.kind === "active") {
    return <ProgressView job={state.job} t={t} />;
  }
  return (
    <div className="lkd-manual-refresh-trigger">
      {state.kind === "error" ? (
        <p className="lk-alert" role="alert">
          {state.message}
        </p>
      ) : null}
      {state.kind === "confirm" ? (
        <ConfirmRow t={t} onConfirm={beginRefresh} onCancel={() => setState({ kind: "idle" })} />
      ) : (
        <button
          type="button"
          className="lk-btn lk-btn-ghost"
          onClick={() => setState({ kind: "confirm" })}
        >
          {t("manualPodRefresh.button")}
        </button>
      )}
    </div>
  );
}

function ConfirmRow({
  t,
  onConfirm,
  onCancel,
}: {
  readonly t: Translate;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}): ReactNode {
  return (
    <div className="lkd-manual-refresh-confirm" role="group">
      <span>{t("manualPodRefresh.confirm.body")}</span>
      <button type="button" className="lk-btn lk-btn-ghost" onClick={onCancel}>
        {t("manualPodRefresh.confirm.cancel")}
      </button>
      <button type="button" className="lk-btn" onClick={onConfirm}>
        {t("manualPodRefresh.confirm.confirm")}
      </button>
    </div>
  );
}
