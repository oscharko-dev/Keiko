"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import type {
  WorkspaceReplaceApplyConflict,
  WorkspaceReplaceApplyFile,
} from "@oscharko-dev/keiko-contracts";

export type WorkspaceReplaceOpenBufferResult =
  | { readonly status: "not-open" }
  | { readonly status: "applied"; readonly path: string }
  | { readonly status: "conflict"; readonly conflict: WorkspaceReplaceApplyConflict };

export type WorkspaceReplaceOpenBufferApply = (
  file: WorkspaceReplaceApplyFile,
) => Promise<WorkspaceReplaceOpenBufferResult> | WorkspaceReplaceOpenBufferResult;

interface WorkspaceReplaceBufferRegistryApi {
  readonly register: (
    root: string,
    path: string,
    apply: WorkspaceReplaceOpenBufferApply,
  ) => () => void;
  readonly apply: (
    root: string,
    file: WorkspaceReplaceApplyFile,
  ) => Promise<WorkspaceReplaceOpenBufferResult>;
}

const WorkspaceReplaceBufferContext = createContext<WorkspaceReplaceBufferRegistryApi | null>(null);

function bufferKey(root: string, path: string): string {
  return `${root}\u0000${path}`;
}

export function WorkspaceReplaceBufferProvider({
  children,
}: {
  readonly children: ReactNode;
}): ReactNode {
  const buffersRef = useRef(new Map<string, WorkspaceReplaceOpenBufferApply>());

  const register = useCallback(
    (root: string, path: string, apply: WorkspaceReplaceOpenBufferApply): (() => void) => {
      const key = bufferKey(root, path);
      buffersRef.current.set(key, apply);
      return () => {
        if (buffersRef.current.get(key) === apply) buffersRef.current.delete(key);
      };
    },
    [],
  );

  const apply = useCallback(
    async (
      root: string,
      file: WorkspaceReplaceApplyFile,
    ): Promise<WorkspaceReplaceOpenBufferResult> => {
      const handler = buffersRef.current.get(bufferKey(root, file.path));
      if (handler === undefined) return { status: "not-open" };
      return handler(file);
    },
    [],
  );

  const value = useMemo(() => ({ register, apply }), [apply, register]);
  return (
    <WorkspaceReplaceBufferContext.Provider value={value}>
      {children}
    </WorkspaceReplaceBufferContext.Provider>
  );
}

export function useWorkspaceReplaceBuffers(): WorkspaceReplaceBufferRegistryApi | null {
  return useContext(WorkspaceReplaceBufferContext);
}

export function useRegisterWorkspaceReplaceBuffer(
  root: string | undefined,
  path: string | undefined,
  apply: WorkspaceReplaceOpenBufferApply,
): void {
  const registry = useWorkspaceReplaceBuffers();
  useEffect(() => {
    if (registry === null || root === undefined || path === undefined || path.length === 0) {
      return undefined;
    }
    return registry.register(root, path, apply);
  }, [apply, path, registry, root]);
}
