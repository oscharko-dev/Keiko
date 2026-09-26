"use client";

// Co-located tests: `useWorkspaceTrust.test.ts` in this directory covers the refresh path,
// the grant/revoke mutation paths, `requestRef` deconfliction, event-driven refresh, and the
// empty-project-id sentinel projection consumed by every downstream trust widget.
import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkspaceTrustStatus } from "@oscharko-dev/keiko-contracts";
import {
  fetchWorkspaceTrustStatus,
  mutateWorkspaceTrust,
  workspaceTrustFailure,
  WORKSPACE_TRUST_CHANGED_EVENT,
  workspaceTrustEventProjectId,
  type WorkspaceTrustFailure,
} from "@/lib/workspace-trust-api";
import {
  WORKSPACE_MANIFEST_CHANGED_EVENT,
  workspaceManifestEventValue,
} from "@/lib/workspace-manifest-api";

export interface WorkspaceTrustView {
  readonly status: WorkspaceTrustStatus | undefined;
  readonly loading: boolean;
  readonly mutating: boolean;
  readonly issue: "load" | "update" | undefined;
  readonly failure: WorkspaceTrustFailure | undefined;
  readonly refresh: () => Promise<void>;
  readonly grant: () => Promise<boolean>;
  readonly revoke: () => Promise<boolean>;
}

export function useWorkspaceTrust(projectId: string | undefined): WorkspaceTrustView {
  const [status, setStatus] = useState<WorkspaceTrustStatus>();
  const [loading, setLoading] = useState(projectId !== undefined);
  const [mutating, setMutating] = useState(false);
  const [issue, setIssue] = useState<"load" | "update">();
  const [failure, setFailure] = useState<WorkspaceTrustFailure>();
  const requestRef = useRef(0);

  const refresh = useCallback(async (): Promise<void> => {
    requestRef.current += 1;
    const request = requestRef.current;
    if (projectId === undefined || projectId.length === 0) {
      setStatus(undefined);
      setLoading(false);
      setIssue(undefined);
      setFailure(undefined);
      return;
    }
    setLoading(true);
    setIssue(undefined);
    setFailure(undefined);
    try {
      const next = await fetchWorkspaceTrustStatus(projectId);
      if (request === requestRef.current) {
        setStatus(next);
        setIssue(undefined);
        setFailure(undefined);
      }
    } catch (error) {
      if (request === requestRef.current) {
        setStatus(undefined);
        setIssue("load");
        setFailure(workspaceTrustFailure(error));
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
    // KEIKO-0352: server-side trust invalidation can also fire as part of a sibling-root manifest
    // mutation (applyRootBindingChanges → recomputeForRoots), so mirror useWorkspaceManifest's
    // filter — only refresh when the delivered manifest carries the current projectId as a root.
    const onManifestChanged = (event: Event): void => {
      const manifest = workspaceManifestEventValue(event);
      if (manifest === null || projectId === undefined || projectId.length === 0) return;
      if (manifest.roots.some((root) => root.canonicalRoot === projectId)) void refresh();
    };
    window.addEventListener(WORKSPACE_TRUST_CHANGED_EVENT, onChanged);
    window.addEventListener(WORKSPACE_MANIFEST_CHANGED_EVENT, onManifestChanged);
    return () => {
      requestRef.current += 1;
      window.removeEventListener(WORKSPACE_TRUST_CHANGED_EVENT, onChanged);
      window.removeEventListener(WORKSPACE_MANIFEST_CHANGED_EVENT, onManifestChanged);
    };
  }, [projectId, refresh]);

  const mutate = useCallback(
    async (action: "grant" | "revoke"): Promise<boolean> => {
      if (projectId === undefined || projectId.length === 0 || mutating) return false;
      setMutating(true);
      setIssue(undefined);
      setFailure(undefined);
      try {
        const next = await mutateWorkspaceTrust(projectId, action);
        setStatus(next);
        setFailure(undefined);
        return true;
      } catch (error) {
        setIssue("update");
        setFailure(workspaceTrustFailure(error));
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
    failure,
    refresh,
    grant: () => mutate("grant"),
    revoke: () => mutate("revoke"),
  };
}
