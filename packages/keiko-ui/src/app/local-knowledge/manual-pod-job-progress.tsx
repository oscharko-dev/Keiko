"use client";

// Shared live-progress rendering + polling for HTML Manual Knowledge Pod jobs (Issue #2063). The
// create and refresh controls both project the same body-free `HtmlManualPodJob` and stream the same
// crawl/index progress; only the per-operation state labels differ. Extracted so both controls share
// one proven self-scheduling poll loop (a new poll never fires until the previous one resolves, so
// requests never stack and the completion callback runs exactly once when the job settles).

import { useEffect, type ReactNode } from "react";
import type { HtmlManualPodJob } from "@oscharko-dev/keiko-contracts";
import type { I18nTranslate } from "@/lib/i18n";
import { formatError } from "./format-error";

type ManualPodMessageKey = Parameters<I18nTranslate>[0];

// A getter for the body-free job projection (mirrors `getHtmlManualPodJob`); named locally so the
// shared module does not depend on the API module's identifier. Internal to this module.
type ManualPodJobGetter = (jobId: string) => Promise<HtmlManualPodJob>;

// The per-operation state labels (create vs refresh); crawl/index progress lines are shared.
export interface ManualPodStateLabelKeys {
  readonly running: ManualPodMessageKey;
  readonly succeeded: ManualPodMessageKey;
  readonly failed: ManualPodMessageKey;
}

function manualPodStateLabel(
  job: HtmlManualPodJob,
  t: I18nTranslate,
  keys: ManualPodStateLabelKeys,
): string {
  if (job.state === "running") return t(keys.running);
  if (job.state === "succeeded") return t(keys.succeeded);
  return t(keys.failed);
}

export function ManualPodProgressView({
  job,
  t,
  labelKeys,
}: {
  readonly job: HtmlManualPodJob;
  readonly t: I18nTranslate;
  readonly labelKeys: ManualPodStateLabelKeys;
}): ReactNode {
  return (
    <div className="lkd-action-progress" role="status" aria-live="polite">
      <p>{manualPodStateLabel(job, t, labelKeys)}</p>
      <p>
        {t("manualPod.progress.crawl", {
          accepted: String(job.crawl.accepted),
          denied: String(job.crawl.deniedCount),
        })}
      </p>
      {job.indexing !== null ? (
        <p>
          {t("manualPod.progress.index", {
            processed: String(job.indexing.processedDocuments),
            total: String(job.indexing.totalDocuments),
          })}
        </p>
      ) : null}
    </div>
  );
}

export interface ManualPodJobPollingParams {
  // The running job's id, or undefined when there is nothing to poll. Keep this stable across
  // progress ticks (derive it from the running job id) so the effect starts once per job.
  readonly pollJobId: string | undefined;
  readonly getJob: ManualPodJobGetter;
  readonly onJob: (job: HtmlManualPodJob) => void;
  readonly onError: (message: string) => void;
  readonly onComplete: (() => void) | undefined;
  readonly intervalMs: number;
}

// Poll the job until it leaves the running state. A self-scheduling timeout (not an interval) means a
// new poll never fires until the previous one resolves. Callers must pass stable `onJob`/`onError`
// callbacks (e.g. `useCallback`) so the effect does not restart on every render.
export function useManualPodJobPolling(params: ManualPodJobPollingParams): void {
  const { pollJobId, getJob, onJob, onError, onComplete, intervalMs } = params;
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
          onJob(job);
          if (job.state === "running") {
            timer = window.setTimeout(poll, intervalMs);
          } else {
            onComplete?.();
          }
        })
        .catch((error: unknown) => {
          if (!cancelled) onError(formatError(error));
        });
    };
    timer = window.setTimeout(poll, intervalMs);
    return () => {
      cancelled = true;
      // clearTimeout tolerates undefined, so no guard is needed for the pre-first-tick case.
      window.clearTimeout(timer);
    };
  }, [pollJobId, getJob, onJob, onError, onComplete, intervalMs]);
}
