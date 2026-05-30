"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { fetchProjects, ApiError } from "@/lib/api";
import type { ProjectWithAvailability } from "@/lib/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProjectLookupState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "found"; project: ProjectWithAvailability }
  | { kind: "notfound" };

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
      .catch((err: unknown) => {
        if (!active) return;
        if (err instanceof ApiError) {
          setState({ kind: "notfound" });
        } else {
          setState({ kind: "notfound" });
        }
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!projectPath) {
      setState({ kind: "idle" });
      return;
    }
    return lookup(projectPath);
  }, [projectPath, lookup]);

  return state;
}
