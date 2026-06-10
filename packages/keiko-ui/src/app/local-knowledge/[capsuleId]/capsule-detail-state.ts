// Issue #198 — state management hook for the capsule detail view.
// Split from capsule-detail.tsx to keep both files under the 400-LOC budget.

import { useState, useEffect, useCallback } from "react";
import type { KnowledgeCapsuleId } from "@oscharko-dev/keiko-contracts";
import { fetchCapsuleDetail } from "@/lib/local-knowledge-api";
import type { CapsuleDetail } from "@/lib/local-knowledge-api";
import { ApiError } from "@/lib/api";

export type DetailLoadStatus = "loading" | "ready" | "error";

export interface CapsuleDetailState {
  readonly data: CapsuleDetail | null;
  readonly loadStatus: DetailLoadStatus;
  readonly loadError: string | null;
  readonly reload: () => void;
}

function formatError(error: unknown): string {
  if (error instanceof ApiError) return `${error.code}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return "An unexpected error occurred.";
}

export function useCapsuleDetail(
  capsuleId: KnowledgeCapsuleId,
  fetchImpl: typeof fetchCapsuleDetail = fetchCapsuleDetail,
): CapsuleDetailState {
  const [data, setData] = useState<CapsuleDetail | null>(null);
  const [loadStatus, setLoadStatus] = useState<DetailLoadStatus>("loading");
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    if (capsuleId === "") {
      setData(null);
      setLoadError("No capsule selected.");
      setLoadStatus("error");
      return;
    }
    setLoadStatus("loading");
    setLoadError(null);
    try {
      const result = await fetchImpl(capsuleId);
      setData(result);
      setLoadStatus("ready");
    } catch (error) {
      setLoadError(formatError(error));
      setLoadStatus("error");
    }
  }, [capsuleId, fetchImpl]);

  useEffect(() => {
    void load();
  }, [load]);

  function reload(): void {
    void load();
  }

  return { data, loadStatus, loadError, reload };
}
