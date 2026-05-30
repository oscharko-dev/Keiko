"use client";

import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { fetchProjects, ApiError } from "@/lib/api";
import type { ProjectWithAvailability } from "@/lib/types";

// ---------------------------------------------------------------------------
// Sidebar states
// ---------------------------------------------------------------------------

type SidebarState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "loaded"; projects: readonly ProjectWithAvailability[] };

// ---------------------------------------------------------------------------
// Sidebar props
// ---------------------------------------------------------------------------

interface SidebarProps {
  collapsed: boolean;
}

/**
 * Project navigation region. Fetches `GET /api/projects` on mount (read-only — ADR-0014 D9).
 * Renders loading / error / empty / list states inline (ADR-0014 D6).
 */
export function Sidebar({ collapsed }: SidebarProps): ReactNode {
  const [state, setState] = useState<SidebarState>({ kind: "loading" });

  const load = useCallback(() => {
    setState({ kind: "loading" });
    let active = true;
    void fetchProjects()
      .then((r) => {
        if (active) setState({ kind: "loaded", projects: r.projects });
      })
      .catch((err: unknown) => {
        if (!active) return;
        const msg = err instanceof ApiError ? err.message : "Failed to load projects";
        setState({ kind: "error", message: msg });
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    return load();
  }, [load]);

  const width = collapsed ? "w-12" : "w-60";

  return (
    <nav
      id="shell-sidebar"
      aria-label="Project navigation"
      className={`flex flex-col overflow-hidden bg-chrome transition-[width] duration-200 ${width}`}
    >
      {!collapsed && (
        <div className="border-b border-border px-3 py-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-dim">Projects</p>
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-2 py-2">
        {state.kind === "loading" && (
          <div role="status" aria-live="polite" aria-label="Loading projects">
            {collapsed ? (
              <div className="flex justify-center">
                <div className="h-5 w-5 animate-pulse rounded-full bg-elevated" />
              </div>
            ) : (
              <div className="space-y-2">
                {[1, 2, 3].map((n) => (
                  <div key={n} className="h-7 animate-pulse rounded bg-elevated" />
                ))}
              </div>
            )}
          </div>
        )}

        {state.kind === "error" && (
          <div role="alert" className="space-y-2">
            {!collapsed && (
              <p className="text-xs text-red-300">{state.message}</p>
            )}
            <button
              type="button"
              onClick={load}
              className="w-full rounded px-2 py-1 text-left text-xs text-ink-muted
                hover:bg-elevated hover:text-ink
                focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              {collapsed ? "↻" : "Retry"}
            </button>
          </div>
        )}

        {state.kind === "loaded" && state.projects.length === 0 && (
          <div className="flex flex-col gap-2 py-2">
            {!collapsed && (
              <>
                <p className="text-xs text-ink-muted">No projects yet</p>
                <p className="text-xs text-ink-dim">Add a project to get started</p>
              </>
            )}
            <button
              type="button"
              disabled
              aria-describedby="add-project-tip"
              className="rounded px-2 py-1 text-left text-xs text-ink-dim
                disabled:cursor-not-allowed disabled:opacity-50"
            >
              {collapsed ? "+" : "Add project"}
            </button>
            <span id="add-project-tip" className="sr-only">
              Available in a later release
            </span>
          </div>
        )}

        {state.kind === "loaded" && state.projects.length > 0 && (
          <ul className="space-y-0.5">
            {state.projects.map((project) => (
              <li key={project.path}>
                <div
                  title={project.path}
                  className={`rounded px-2 py-1.5 text-sm truncate
                    ${project.available === false ? "text-ink-dim" : "text-ink-muted hover:bg-elevated hover:text-ink"}`}
                >
                  {collapsed ? (
                    <span
                      aria-label={
                        project.available === false
                          ? "Project path unavailable"
                          : (project.name ?? project.path)
                      }
                    >
                      {(project.name ?? project.path).charAt(0).toUpperCase()}
                    </span>
                  ) : (
                    <span className="flex items-center gap-2">
                      <span className="truncate">{project.name ?? project.path}</span>
                      {project.available === false && (
                        <span
                          className="shrink-0 text-xs text-ink-dim"
                          aria-label="Project path unavailable"
                        >
                          ✕
                        </span>
                      )}
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </nav>
  );
}

export default Sidebar;
