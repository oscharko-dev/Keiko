"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { ReactNode } from "react";
import { fetchProjects, ApiError } from "@/lib/api";
import type { ProjectWithAvailability } from "@/lib/types";
import { WorkspaceShellEntry } from "./WorkspaceShellEntry";
import { ChatView } from "./ChatView";

// ---------------------------------------------------------------------------
// Project header (project selected, no chat selected)
// ---------------------------------------------------------------------------

interface ProjectHeaderProps {
  project: ProjectWithAvailability;
}

function ProjectHeader({ project }: ProjectHeaderProps): ReactNode {
  return (
    <section
      aria-labelledby="project-header-name"
      className="flex h-full flex-col items-center justify-center text-center"
    >
      <h1
        id="project-header-name"
        className="text-heading text-ink"
      >
        {project.name}
      </h1>
      <p className="mt-2 text-sm text-ink-muted">{project.path}</p>

      {project.available === false && (
        <div
          role="alert"
          className="mt-4 max-w-sm rounded bg-panel px-4 py-3 text-xs text-ink-muted"
          style={{ border: "1px solid #3a4052" }}
        >
          <span className="block font-medium text-ink">Path no longer available.</span>
          This path is no longer available on disk. Reconnect by re-adding the same path,
          or remove it from the sidebar.
        </div>
      )}

      {project.available !== false && (
        <p className="mt-3 text-xs text-ink-dim">
          Select a chat from the sidebar, or create a new one.
        </p>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// CentralArea — reads search params and dispatches to the right view
// ---------------------------------------------------------------------------

type ProjectLookupState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "found"; project: ProjectWithAvailability }
  | { kind: "notfound" };

/**
 * Central content area router. Reads ?project= and ?chat= from the URL and
 * dispatches to: Welcome | ProjectHeader | ChatView.
 * Must be wrapped in <Suspense> at the call site (uses useSearchParams).
 */
export function CentralArea(): ReactNode {
  const searchParams = useSearchParams();
  const rawProject = searchParams.get("project");
  const projectPath = rawProject ? decodeURIComponent(rawProject) : null;
  const chatId = searchParams.get("chat");

  const [projectState, setProjectState] = useState<ProjectLookupState>({ kind: "idle" });

  const lookupProject = useCallback((path: string) => {
    setProjectState({ kind: "loading" });
    let active = true;
    void fetchProjects()
      .then((r) => {
        if (!active) return;
        const found = r.projects.find((p) => p.path === path);
        if (found) {
          setProjectState({ kind: "found", project: found });
        } else {
          setProjectState({ kind: "notfound" });
        }
      })
      .catch((err: unknown) => {
        if (!active) return;
        // Graceful fallback — just show welcome
        if (err instanceof ApiError) {
          setProjectState({ kind: "notfound" });
        } else {
          setProjectState({ kind: "notfound" });
        }
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!projectPath) {
      setProjectState({ kind: "idle" });
      return;
    }
    return lookupProject(projectPath);
  }, [projectPath, lookupProject]);

  // No project selected → welcome
  if (!projectPath) {
    return <WorkspaceShellEntry />;
  }

  // Loading project data
  if (projectState.kind === "idle" || projectState.kind === "loading") {
    return (
      <div className="flex h-full items-center justify-center">
        <div
          role="status"
          aria-live="polite"
          aria-label="Loading project"
          className="h-8 w-32 animate-pulse rounded bg-elevated"
        />
      </div>
    );
  }

  // Project not found in list (stale URL) — fall back to welcome
  if (projectState.kind === "notfound") {
    return <WorkspaceShellEntry />;
  }

  const project = projectState.project;

  // Project selected, chat selected → ChatView
  if (chatId) {
    return <ChatView chatId={chatId} project={project} />;
  }

  // Project selected, no chat → ProjectHeader
  return <ProjectHeader project={project} />;
}

export default CentralArea;
