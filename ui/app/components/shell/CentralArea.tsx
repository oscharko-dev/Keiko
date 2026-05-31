"use client";

import { useSearchParams } from "next/navigation";
import type { ReactNode } from "react";
import type { ProjectWithAvailability } from "@/lib/types";
import { useSelectedProject } from "./useSelectedProject";
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
      className="flex h-full min-w-0 flex-col items-center justify-center text-center"
    >
      <h1
        id="project-header-name"
        className="max-w-full break-words text-heading text-ink"
      >
        {project.name}
      </h1>
      <p className="mt-2 max-w-full break-all font-mono text-sm text-ink-muted" title={project.path}>
        {project.path}
      </p>

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

/**
 * Central content area router. Reads ?project= and ?chat= from the URL and
 * dispatches to: Welcome | ProjectHeader | ChatView.
 * Must be wrapped in <Suspense> at the call site (uses useSearchParams).
 */
export function CentralArea(): ReactNode {
  const searchParams = useSearchParams();
  const projectPath = searchParams.get("project");
  const chatId = searchParams.get("chat");

  const projectState = useSelectedProject();

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
