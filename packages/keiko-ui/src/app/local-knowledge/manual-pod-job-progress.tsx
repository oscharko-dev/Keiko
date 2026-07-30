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
// `partial` is a real terminal state, not a flavour of success: a usable pod exists but pages of the
// approved manual were skipped or failed, and neither the success nor the failure label tells the
// truth about it (0.3.0 audit).
export interface ManualPodStateLabelKeys {
  readonly running: ManualPodMessageKey;
  readonly succeeded: ManualPodMessageKey;
  readonly partial: ManualPodMessageKey;
  readonly failed: ManualPodMessageKey;
}

function manualPodStateLabel(
  job: HtmlManualPodJob,
  t: I18nTranslate,
  keys: ManualPodStateLabelKeys,
): string {
  if (job.state === "running") return t(keys.running);
  if (job.state === "succeeded") return t(keys.succeeded);
  if (job.state === "partial") return t(keys.partial);
  return t(keys.failed);
}

// The skipped/failed document counts. Rendered only when there is a gap to report, so a clean import
// stays a two-line progress read.
function ManualPodGapCounts({
  indexing,
  t,
}: {
  readonly indexing: HtmlManualPodJob["indexing"];
  readonly t: I18nTranslate;
}): ReactNode {
  if (indexing === null || (indexing.failedDocuments === 0 && indexing.skippedDocuments === 0)) {
    return null;
  }
  return (
    <p>
      {t("manualPod.progress.gaps", {
        failed: String(indexing.failedDocuments),
        skipped: String(indexing.skippedDocuments),
      })}
    </p>
  );
}

// What was left out, from the server's body-free remediation pairs (a closed reason code plus fixed
// generic guidance — never a URL, page path, or page body). This is the "see what was skipped"
// affordance: without it the counts say a gap exists but not which class of gap.
function ManualPodGapReasons({
  remediations,
  t,
}: {
  readonly remediations: HtmlManualPodJob["remediations"];
  readonly t: I18nTranslate;
}): ReactNode {
  if (remediations.length === 0) return null;
  return (
    <>
      <p className="lkd-action-progress-note">{t("manualPod.progress.gapsTitle")}</p>
      {/* Existing global reason-list class (#1300: no globals.css edit for new styling). */}
      <ul className="lkd-stale-reasons">
        {remediations.map((remediation) => (
          <li key={remediation.reason}>{remediation.guidance}</li>
        ))}
      </ul>
    </>
  );
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
        {/* `accepted` is what the CRAWLER accepted, which is not what landed in the index — the
            index line below owns that count. */}
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
      <ManualPodGapCounts indexing={job.indexing} t={t} />
      {job.state === "running" ? null : (
        <ManualPodGapReasons remediations={job.remediations} t={t} />
      )}
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
