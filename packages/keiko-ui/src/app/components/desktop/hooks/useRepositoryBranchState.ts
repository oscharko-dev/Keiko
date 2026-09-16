"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { GitBranchListEntry, GitBranchListResponse } from "@/lib/api";
import { DEFAULT_GIT_CLIENT } from "../widgets/cards/git-client/git-client-seam";
import {
  GIT_REPOSITORY_STATE_INVALIDATED_EVENT,
  gitRepositoryStateInvalidationRoots,
} from "../widgets/cards/git-repository-state-events";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { clientErrorSummary, correlationIdOf } from "@/lib/client-error-summary";

interface BranchReadState {
  readonly root: string | null;
  readonly response: GitBranchListResponse | null;
  readonly loading: boolean;
  readonly error: string | null;
}

export interface RepositoryBranchState extends BranchReadState {
  readonly branches: readonly GitBranchListEntry[];
  readonly currentBranch: string | null;
  readonly refresh: () => Promise<void>;
}

const EMPTY_BRANCHES: readonly GitBranchListEntry[] = [];

function currentBranchOf(response: GitBranchListResponse | null): string | null {
  if (response?.available !== true) return null;
  return response.branches.find((branch) => branch.current)?.name ?? null;
}

function useRepositoryInvalidation(root: string | null, refresh: () => Promise<void>): void {
  useEffect(() => {
    if (root === null) return undefined;
    const onInvalidated = (event: Event): void => {
      if (gitRepositoryStateInvalidationRoots(event).includes(root)) void refresh();
    };
    window.addEventListener(GIT_REPOSITORY_STATE_INVALIDATED_EVENT, onInvalidated);
    return (): void =>
      window.removeEventListener(GIT_REPOSITORY_STATE_INVALIDATED_EVENT, onInvalidated);
  }, [refresh, root]);
}

export function useRepositoryBranchState(root: string | null): RepositoryBranchState {
  const [state, setState] = useState<BranchReadState>({
    root: null,
    response: null,
    loading: root !== null,
    error: null,
  });
  const sequenceRef = useRef(0);
  const refresh = useCallback(async (): Promise<void> => {
    const sequence = (sequenceRef.current += 1);
    if (root === null) {
      setState({ root: null, response: null, loading: false, error: null });
      return;
    }
    // #3506 review — do NOT stamp the NEW `root` into state here. The stale-response guard at
    // the bottom of this hook returns `{ ...state, response: null }` when `state.root !== root`;
    // if we stamped `root` synchronously the guard's else branch would be unreachable while a
    // fetch for the new root is in flight, so the previous repository's branch list would keep
    // showing (BranchSelector reads `currentBranch` before `loading`).
    setState((current) => ({ ...current, loading: true, error: null }));
    try {
      const response = await DEFAULT_GIT_CLIENT.listBranches(root);
      if (sequenceRef.current === sequence) {
        setState({ root, response, loading: false, error: null });
      }
    } catch (error) {
      if (sequenceRef.current === sequence) {
        setState({
          root,
          response: null,
          loading: false,
          error: "Git status could not be loaded.",
        });
        reportClientDiagnostic(
          `[keiko] repository branch status failed: ${clientErrorSummary(error)}`,
          { correlationId: correlationIdOf(error) },
        );
      }
    }
  }, [root]);

  useEffect(() => {
    void refresh();
    return (): void => {
      sequenceRef.current += 1;
    };
  }, [refresh]);

  useRepositoryInvalidation(root, refresh);

  const current = state.root === root ? state : { ...state, response: null };
  return {
    ...current,
    branches: current.response?.branches ?? EMPTY_BRANCHES,
    currentBranch: currentBranchOf(current.response),
    refresh,
  };
}
