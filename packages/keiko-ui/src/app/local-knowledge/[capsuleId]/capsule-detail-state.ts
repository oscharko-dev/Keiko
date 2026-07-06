// Issue #198 — state management hook for the capsule detail view.
// Split from capsule-detail.tsx to keep both files under the 400-LOC budget.

import { useState, useEffect, useCallback } from "react";
import type { KnowledgeCapsuleId } from "@oscharko-dev/keiko-contracts";
import { fetchCapsuleDetail } from "@/lib/local-knowledge-api";
import type { CapsuleDetail } from "@/lib/local-knowledge-api";
import { formatError } from "../format-error";

export type DetailLoadStatus = "loading" | "ready" | "error";

export interface CapsuleDetailState {
  readonly data: CapsuleDetail | null;
  readonly loadStatus: DetailLoadStatus;
  readonly loadError: string | null;
  readonly reload: () => void;
  readonly replaceData: (nextData: CapsuleDetail) => void;
}

export function useCapsuleDetail(
  capsuleId: KnowledgeCapsuleId,
  fetchImpl: typeof fetchCapsuleDetail = fetchCapsuleDetail,
): CapsuleDetailState {
  const [data, setData] = useState<CapsuleDetail | null>(null);
  const [loadStatus, setLoadStatus] = useState<DetailLoadStatus>("loading");
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(
    async (opts: { readonly quiet?: boolean } = {}): Promise<void> => {
      if (capsuleId === "") {
        setData(null);
        setLoadError("No Knowledge Pod selected.");
        setLoadStatus("error");
        return;
      }
      if (opts.quiet !== true) {
        setLoadStatus("loading");
        setLoadError(null);
      }
      try {
        const result = await fetchImpl(capsuleId);
        setData(result);
        setLoadStatus("ready");
      } catch (error) {
        if (opts.quiet === true) return;
        setLoadError(formatError(error));
        setLoadStatus("error");
      }
    },
    [capsuleId, fetchImpl],
  );

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const latestJob = data?.indexingJobs[0];
    const isActive =
      data?.capsule.lifecycleState === "indexing" ||
      latestJob?.status === "queued" ||
      latestJob?.status === "running";
    if (!isActive) return;
    // GEN-PERF-RENDER-005 — pause the 2s poll while the tab is hidden (it kept
    // fetching every 2s in a background tab for the whole job, which can run for
    // minutes on large ingestion). Resume with an immediate catch-up on return to
    // visible so a job that finished while hidden reflects promptly.
    let timer: number | null = null;
    const isHidden = (): boolean =>
      typeof document !== "undefined" && document.visibilityState === "hidden";
    const startPolling = (): void => {
      if (timer !== null) return;
      timer = window.setInterval(() => {
        void load({ quiet: true });
      }, 2_000);
    };
    const stopPolling = (): void => {
      if (timer === null) return;
      window.clearInterval(timer);
      timer = null;
    };
    const sync = (): void => {
      if (isHidden()) {
        stopPolling();
      } else {
        void load({ quiet: true });
        startPolling();
      }
    };
    if (!isHidden()) startPolling();
    document.addEventListener("visibilitychange", sync);
    return () => {
      stopPolling();
      document.removeEventListener("visibilitychange", sync);
    };
  }, [data?.capsule.lifecycleState, data?.indexingJobs, load]);

  function reload(): void {
    void load();
  }

  function replaceData(nextData: CapsuleDetail): void {
    setData(nextData);
    setLoadError(null);
    setLoadStatus("ready");
  }

  return { data, loadStatus, loadError, reload, replaceData };
}
