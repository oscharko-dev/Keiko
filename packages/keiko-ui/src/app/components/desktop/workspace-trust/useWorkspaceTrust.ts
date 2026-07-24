"use client";

// Co-located tests: `useWorkspaceTrust.test.ts` in this directory covers the refresh path,
// the grant/revoke mutation paths, `requestRef` deconfliction, event-driven refresh, and the
// empty-project-id sentinel projection consumed by every downstream trust widget.
import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkspaceTrustStatus } from "@oscharko-dev/keiko-contracts";
import {
  fetchWorkspaceTrustStatus,
  mutateWorkspaceTrust,
  WORKSPACE_TRUST_CHANGED_EVENT,
  workspaceTrustEventProjectId,
} from "@/lib/workspace-trust-api";

export interface WorkspaceTrustView {
  readonly status: WorkspaceTrustStatus | undefined;
  readonly loading: boolean;
  readonly mutating: boolean;
  readonly issue: "load" | "update" | undefined;
  readonly refresh: () => Promise<void>;
  readonly grant: () => Promise<boolean>;
  readonly revoke: () => Promise<boolean>;
}

export function useWorkspaceTrust(projectId: string | undefined): WorkspaceTrustView {
  const [status, setStatus] = useState<WorkspaceTrustStatus>();
  const [loading, setLoading] = useState(projectId !== undefined);
  const [mutating, setMutating] = useState(false);
  const [issue, setIssue] = useState<"load" | "update">();
  const requestRef = useRef(0);

  const refresh = useCallback(async (): Promise<void> => {
    requestRef.current += 1;
    const request = requestRef.current;
    if (projectId === undefined || projectId.length === 0) {
      setStatus(undefined);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const next = await fetchWorkspaceTrustStatus(projectId);
      if (request === requestRef.current) {
        setStatus(next);
        setIssue(undefined);
      }
    } catch {
      if (request === requestRef.current) {
        setStatus(undefined);
        setIssue("load");
      }
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void refresh();
    const onChanged = (event: Event): void => {
      if (workspaceTrustEventProjectId(event) === projectId) void refresh();
    };
    window.addEventListener(WORKSPACE_TRUST_CHANGED_EVENT, onChanged);
    return () => {
      requestRef.current += 1;
      window.removeEventListener(WORKSPACE_TRUST_CHANGED_EVENT, onChanged);
    };
  }, [projectId, refresh]);

  const mutate = useCallback(
    async (action: "grant" | "revoke"): Promise<boolean> => {
      if (projectId === undefined || projectId.length === 0 || mutating) return false;
      setMutating(true);
      setIssue(undefined);
      try {
        const next = await mutateWorkspaceTrust(projectId, action);
        setStatus(next);
        return true;
      } catch {
        setIssue("update");
        return false;
      } finally {
        setMutating(false);
      }
    },
    [mutating, projectId],
  );

  return {
    status,
    loading,
    mutating,
    issue,
    refresh,
    grant: () => mutate("grant"),
    revoke: () => mutate("revoke"),
  };
}
