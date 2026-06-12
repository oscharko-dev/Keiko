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
}

export function useCapsuleDetail(
  capsuleId: KnowledgeCapsuleId,
  fetchImpl: typeof fetchCapsuleDetail = fetchCapsuleDetail,
): CapsuleDetailState {
  const [data, setData] = useState<CapsuleDetail | null>(null);
  const [loadStatus, setLoadStatus] = useState<DetailLoadStatus>("loading");
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async (opts: { readonly quiet?: boolean } = {}): Promise<void> => {
    if (capsuleId === "") {
      setData(null);
      setLoadError("No capsule selected.");
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
  }, [capsuleId, fetchImpl]);

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
    const timer = window.setInterval(() => {
      void load({ quiet: true });
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [data?.capsule.lifecycleState, data?.indexingJobs, load]);

  function reload(): void {
    void load();
  }

  return { data, loadStatus, loadError, reload };
}
