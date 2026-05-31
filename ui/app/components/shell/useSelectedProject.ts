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

  const lookup = useCallback((path: string) => {
    setState({ kind: "loading" });
    let active = true;
    void fetchProjects()
      .then((r) => {
        if (!active) return;
        const found = r.projects.find((p) => p.path === path);
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
    return lookup(projectPath);
  }, [projectPath, lookup, retryKey]);

  return state;
}
