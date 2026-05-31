"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ApiError, fetchProjects } from "@/lib/api";
import type { ProjectWithAvailability } from "@/lib/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProjectLookupState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "found"; project: ProjectWithAvailability }
  | { kind: "notfound" }
  | { kind: "error"; message: string; retry: () => void };

let selectedProjectsRequest: Promise<readonly ProjectWithAvailability[]> | null = null;
let selectedProjectsGeneration = 0;

export function clearSelectedProjectCacheForTests(): void {
  selectedProjectsRequest = null;
  selectedProjectsGeneration = 0;
}

function loadSelectedProjects(forceRefresh: boolean): Promise<readonly ProjectWithAvailability[]> {
  if (!forceRefresh && selectedProjectsRequest !== null) {
    return selectedProjectsRequest;
  }

  if (forceRefresh) {
    selectedProjectsRequest = null;
    selectedProjectsGeneration += 1;
  }

  const generation = selectedProjectsGeneration;
  const request = fetchProjects()
    .then((response) => {
      if (generation === selectedProjectsGeneration) {
        selectedProjectsRequest = null;
      }
      return response.projects;
    })
    .catch((error: unknown) => {
      if (generation === selectedProjectsGeneration) {
        selectedProjectsRequest = null;
      }
      throw error;
    });

  selectedProjectsRequest = request;
  return request;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Reads ?project= from the URL and resolves it against /api/projects.
 * Returns a discriminated union so callers branch by kind, not by nullability.
 * Must be used inside a <Suspense> boundary (calls useSearchParams).
 */
export function useSelectedProject(): ProjectLookupState {
  const searchParams = useSearchParams();
  const projectPath = searchParams.get("project");
  const [retryKey, setRetryKey] = useState(0);
  const retry = useCallback(() => {
    setRetryKey((k) => k + 1);
  }, []);

  const [state, setState] = useState<ProjectLookupState>({ kind: "idle" });

  const lookup = useCallback((path: string, forceRefresh: boolean) => {
    setState({ kind: "loading" });
    let active = true;
    void loadSelectedProjects(forceRefresh)
      .then((r) => {
        if (!active) return;
        const found = r.find((p) => p.path === path);
        if (found) {
          setState({ kind: "found", project: found });
        } else {
          setState({ kind: "notfound" });
        }
      })
      .catch((error: unknown) => {
        if (!active) return;
        const message = error instanceof ApiError
          ? error.message
          : "Could not load the selected project. Please try again.";
        setState({ kind: "error", message, retry });
      });
    return () => {
      active = false;
    };
  }, [retry]);

  useEffect(() => {
    if (!projectPath) {
      setState({ kind: "idle" });
      return;
    }
    return lookup(projectPath, retryKey > 0);
  }, [projectPath, lookup, retryKey]);

  return state;
}
