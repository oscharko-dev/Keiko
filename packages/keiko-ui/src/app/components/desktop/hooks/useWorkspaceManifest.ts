"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  WorkspaceManifest,
  WorkspaceRootDescriptor,
  WorkspaceRootRef,
} from "@oscharko-dev/keiko-contracts";
import {
  addWorkspaceRoot,
  fetchWorkspaceManifests,
  focusWorkspaceRoot,
  removeWorkspaceRoot,
  reorderWorkspaceRoots,
  workspaceManifestEventValue,
  WORKSPACE_MANIFEST_CHANGED_EVENT,
} from "@/lib/workspace-manifest-api";

export interface WorkspaceManifestView {
  readonly manifest: WorkspaceManifest | null;
  readonly loading: boolean;
  readonly mutating: boolean;
  readonly issue: "load" | "mutation" | null;
  readonly refresh: () => Promise<void>;
  readonly addRoot: (actorRootRef: WorkspaceRootRef, projectPath: string) => Promise<boolean>;
  readonly removeRoot: (
    actorRootRef: WorkspaceRootRef,
    targetRootRef: WorkspaceRootRef,
  ) => Promise<boolean>;
  readonly reorderRoots: (
    actorRootRef: WorkspaceRootRef,
    orderedRootRefs: readonly WorkspaceRootRef[],
  ) => Promise<boolean>;
  readonly focusRoot: (targetRootRef: WorkspaceRootRef) => Promise<boolean>;
}

function manifestContainingRoot(
  manifests: readonly WorkspaceManifest[],
  rootPath: string,
): WorkspaceManifest | null {
  return (
    manifests.find((manifest) => manifest.roots.some((root) => root.canonicalRoot === rootPath)) ??
    null
  );
}

function currentRoot(
  manifest: WorkspaceManifest,
  rootRef: WorkspaceRootRef,
): WorkspaceRootDescriptor | null {
  return manifest.roots.find((root) => root.rootRef === rootRef) ?? null;
}

export function useWorkspaceManifest(rootPath: string | undefined): WorkspaceManifestView {
  const [manifest, setManifest] = useState<WorkspaceManifest | null>(null);
  const [loading, setLoading] = useState(rootPath !== undefined);
  const [mutating, setMutating] = useState(false);
  const [issue, setIssue] = useState<"load" | "mutation" | null>(null);
  const requestRef = useRef(0);
  const manifestRef = useRef(manifest);
  manifestRef.current = manifest;

  const refresh = useCallback(async (): Promise<void> => {
    requestRef.current += 1;
    const request = requestRef.current;
    if (rootPath === undefined || rootPath.length === 0) {
      setManifest(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const manifests = await fetchWorkspaceManifests();
      if (request === requestRef.current) {
        setManifest(manifestContainingRoot(manifests, rootPath));
        setIssue(null);
      }
    } catch {
      if (request === requestRef.current) {
        setManifest(null);
        setIssue("load");
      }
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }, [rootPath]);

  useEffect(() => {
    void refresh();
    const onChanged = (event: Event): void => {
      const next = workspaceManifestEventValue(event);
      const current = manifestRef.current;
      if (next === null) return;
      const sameWorkspace = current?.workspaceId === next.workspaceId;
      const containsTrackedRoot =
        rootPath !== undefined && next.roots.some((root) => root.canonicalRoot === rootPath);
      if (sameWorkspace || containsTrackedRoot) {
        // Issue #2747 — a delivered manifest is newer than anything `refresh()` still has in flight,
        // so it takes the request token with it. Without this a fetch that predates the change
        // resolves afterwards and passes its own staleness guard, reinstating a snapshot in which a
        // root added moments ago is missing — which the editor host reads as a removal and answers
        // by force-disposing that live root's models. Clearing `loading` here keeps the state
        // coherent, since the discarded response can no longer run its own `finally`.
        requestRef.current += 1;
        setManifest(next);
        setLoading(false);
        setIssue(null);
      }
    };
    window.addEventListener(WORKSPACE_MANIFEST_CHANGED_EVENT, onChanged);
    return () => {
      requestRef.current += 1;
      window.removeEventListener(WORKSPACE_MANIFEST_CHANGED_EVENT, onChanged);
    };
  }, [refresh, rootPath]);

  const mutate = useCallback(
    async (
      actorRootRef: WorkspaceRootRef,
      action: (
        current: WorkspaceManifest,
        actor: WorkspaceRootDescriptor,
      ) => Promise<WorkspaceManifest>,
    ): Promise<boolean> => {
      const current = manifestRef.current;
      if (current === null || mutating) return false;
      const actor = currentRoot(current, actorRootRef);
      if (actor === null) return false;
      setMutating(true);
      setIssue(null);
      try {
        const next = await action(current, actor);
        setManifest(next);
        return true;
      } catch {
        setIssue("mutation");
        return false;
      } finally {
        setMutating(false);
      }
    },
    [mutating],
  );

  return useMemo<WorkspaceManifestView>(
    () => ({
      manifest,
      loading,
      mutating,
      issue,
      refresh,
      addRoot: (actorRootRef, projectPath) =>
        mutate(actorRootRef, (current, actor) => addWorkspaceRoot(current, actor, projectPath)),
      removeRoot: (actorRootRef, targetRootRef) =>
        mutate(actorRootRef, (current, actor) =>
          removeWorkspaceRoot(current, actor, targetRootRef),
        ),
      reorderRoots: (actorRootRef, orderedRootRefs) =>
        mutate(actorRootRef, (current, actor) =>
          reorderWorkspaceRoots(current, actor, orderedRootRefs),
        ),
      focusRoot: (targetRootRef) =>
        mutate(targetRootRef, (current, actor) =>
          focusWorkspaceRoot(current, actor, targetRootRef),
        ),
    }),
    [issue, loading, manifest, mutate, mutating, refresh],
  );
}
