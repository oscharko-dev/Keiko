"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  WorkspaceManifest,
  WorkspaceRootDescriptor,
  WorkspaceRootRef,
} from "@oscharko-dev/keiko-contracts";
import {
  addWorkspaceRoot,
  fetchWorkspaceManifestAccess,
  focusWorkspaceRoot,
  removeWorkspaceRoot,
  reorderWorkspaceRoots,
  workspaceManifestEventValue,
  WORKSPACE_MANIFEST_CHANGED_EVENT,
} from "@/lib/workspace-manifest-api";

export interface WorkspaceManifestView {
  readonly manifest: WorkspaceManifest | null;
  readonly pathReadAuthority: "checking" | "available" | "unpaired" | "unavailable";
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

function hasTrackedRoot(rootPath: string | undefined): rootPath is string {
  return Boolean(rootPath);
}

export function useWorkspaceManifest(rootPath: string | undefined): WorkspaceManifestView {
  const tracksRoot = hasTrackedRoot(rootPath);
  const [manifest, setManifest] = useState<WorkspaceManifest | null>(null);
  const [loading, setLoading] = useState(tracksRoot);
  const [pathReadAuthority, setPathReadAuthority] = useState<
    WorkspaceManifestView["pathReadAuthority"]
  >(tracksRoot ? "checking" : "available");
  const [authorityRoot, setAuthorityRoot] = useState(tracksRoot ? rootPath : undefined);
  const [mutating, setMutating] = useState(false);
  const [issue, setIssue] = useState<"load" | "mutation" | null>(null);
  const requestRef = useRef(0);
  const manifestRef = useRef(manifest);
  manifestRef.current = manifest;

  const refresh = useCallback(async (): Promise<void> => {
    requestRef.current += 1;
    const request = requestRef.current;
    if (!hasTrackedRoot(rootPath)) {
      setManifest(null);
      setLoading(false);
      setAuthorityRoot(undefined);
      setPathReadAuthority("available");
      return;
    }
    setLoading(true);
    setAuthorityRoot(rootPath);
    setPathReadAuthority("checking");
    try {
      const access = await fetchWorkspaceManifestAccess();
      if (request === requestRef.current) {
        setManifest(manifestContainingRoot(access.manifests, rootPath));
        setPathReadAuthority(access.session === "unpaired" ? "unpaired" : "available");
        setIssue(null);
      }
    } catch {
      if (request === requestRef.current) {
        setManifest(null);
        setPathReadAuthority("unavailable");
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
        hasTrackedRoot(rootPath) && next.roots.some((root) => root.canonicalRoot === rootPath);
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
        setAuthorityRoot(rootPath);
        setPathReadAuthority("available");
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
  const resolvedPathReadAuthority: WorkspaceManifestView["pathReadAuthority"] =
    authorityRoot === rootPath
      ? pathReadAuthority
      : hasTrackedRoot(rootPath)
        ? "checking"
        : "available";

  return useMemo<WorkspaceManifestView>(
    () => ({
      manifest,
      pathReadAuthority: resolvedPathReadAuthority,
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
    [issue, loading, manifest, mutate, mutating, refresh, resolvedPathReadAuthority],
  );
}
