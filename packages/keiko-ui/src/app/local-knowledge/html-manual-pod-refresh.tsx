"use client";

// Live HTML Manual Knowledge Pod refresh control (Issue #2063). Renders a refresh button for an
// HTML-manual pod; on confirm it starts the governed BFF refresh job and polls its body-free
// `HtmlManualPodJob` projection, surfacing live crawl/index progress until the job settles. Strings
// go through the shared `manualPodRefresh.*` / `manualPod.*` i18n catalog (en+de); only existing
// global classes are reused (no globals.css edit, #1300). Every API call is an injectable seam so
// the flow is tested without a real network. Progress rendering + polling live in the shared
// `manual-pod-job-progress` module (also used by the create control).

import { useCallback, useRef, useState, type ReactNode } from "react";
import type { HtmlManualPodJob, KnowledgeCapsuleId } from "@oscharko-dev/keiko-contracts";
import { getHtmlManualPodJob, startHtmlManualPodRefresh } from "@/lib/local-knowledge-api";
import { useTranslate } from "@/lib/i18n";
import { formatError } from "./format-error";
import {
  ManualPodProgressView,
  useManualPodJobPolling,
  type ManualPodStateLabelKeys,
} from "./manual-pod-job-progress";

const POLL_INTERVAL_MS = 1500;

const REFRESH_LABEL_KEYS: ManualPodStateLabelKeys = {
  running: "manualPodRefresh.progress.running",
  succeeded: "manualPodRefresh.state.succeeded",
  failed: "manualPodRefresh.state.failed",
};

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

export function HtmlManualPodRefresh(props: HtmlManualPodRefreshProps): ReactNode {
  const t = useTranslate();
  const [state, setState] = useState<RefreshState>({ kind: "idle" });
  const busyRef = useRef(false);
  const start = props.startRefreshImpl ?? startHtmlManualPodRefresh;
  const getJob = props.getJobImpl ?? getHtmlManualPodJob;

  const onJob = useCallback((job: HtmlManualPodJob): void => setState({ kind: "active", job }), []);
  const onError = useCallback((message: string): void => setState({ kind: "error", message }), []);
  const pollJobId =
    state.kind === "active" && state.job.state === "running" ? state.job.jobId : undefined;
  useManualPodJobPolling({
    pollJobId,
    getJob,
    onJob,
    onError,
    onComplete: props.onRefreshComplete,
    intervalMs: props.pollIntervalMs ?? POLL_INTERVAL_MS,
  });

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
    return <ManualPodProgressView job={state.job} t={t} labelKeys={REFRESH_LABEL_KEYS} />;
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
    <div className="lkd-manual-refresh-confirm">
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
