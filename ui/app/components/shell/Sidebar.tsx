"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { ReactNode } from "react";
import { fetchProjects, ApiError } from "@/lib/api";
import type { ProjectWithAvailability } from "@/lib/types";
import { sortProjects } from "@/lib/sidebar-sort";
import { ChatList } from "./ChatList";
import { AddProjectDialog } from "./AddProjectDialog";
import { ProjectRow } from "./ProjectRow";
import { NewChatButton } from "./NewChatButton";

// ---------------------------------------------------------------------------
// Sidebar states
// ---------------------------------------------------------------------------

type SidebarState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "loaded"; projects: readonly ProjectWithAvailability[] };

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface SidebarProps {
  collapsed: boolean;
}

/**
 * Interactive project navigation region.
 * Selection state lives in URL search params: ?project=<encoded-path>&chat=<id>.
 * Wrap in <Suspense> at call site — useSearchParams() requires it in App Router static export.
 */
export function Sidebar({ collapsed }: SidebarProps): ReactNode {
  const router = useRouter();
  const searchParams = useSearchParams();

  const rawProject = searchParams.get("project");
  const selectedProject = rawProject ? decodeURIComponent(rawProject) : null;
  const selectedChat = searchParams.get("chat");

  const [state, setState] = useState<SidebarState>({ kind: "loading" });
  const [refreshKey, setRefreshKey] = useState(0);
  // chatRefreshKey bumps on refreshKey (project op) or when selectedChat changes (new chat created)
  const [chatRefreshKey, setChatRefreshKey] = useState(0);
  const [dialogOpen, setDialogOpen] = useState(false);
  const addButtonRef = useRef<HTMLButtonElement>(null);

  const load = useCallback(() => {
    setState({ kind: "loading" });
    let active = true;
    void fetchProjects()
      .then((r) => {
        if (active) setState({ kind: "loaded", projects: sortProjects(r.projects) });
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
  }, [load, refreshKey]);

  // Re-fetch chat list when selectedChat changes (new chat created by NewChatButton)
  useEffect(() => {
    setChatRefreshKey((k) => k + 1);
  }, [selectedChat, refreshKey]);

  function selectProject(path: string): void {
    const params = new URLSearchParams(searchParams.toString());
    params.set("project", encodeURIComponent(path));
    params.delete("chat");
    router.replace(`/?${params.toString()}`);
  }

  function selectChat(chatId: string): void {
    const params = new URLSearchParams(searchParams.toString());
    params.set("chat", chatId);
    router.replace(`/?${params.toString()}`);
  }

  function handleProjectAdded(): void {
    setRefreshKey((k) => k + 1);
    setDialogOpen(false);
    // Return focus to the add button after dialog closes
    setTimeout(() => { addButtonRef.current?.focus(); }, 0);
  }

  function handleFavoriteToggled(): void {
    setRefreshKey((k) => k + 1);
  }

  function handleProjectRemoved(removedPath: string): void {
    setRefreshKey((k) => k + 1);
    // If we were viewing this project, clear URL selection
    if (selectedProject === removedPath) {
      const params = new URLSearchParams(searchParams.toString());
      params.delete("project");
      params.delete("chat");
      router.replace(`/?${params.toString()}`);
    }
  }

  const width = collapsed ? "w-12" : "w-60";

  return (
    <>
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

        {/* New chat button — top of sidebar */}
        <div className={`px-2 pt-2 ${collapsed ? "" : "pb-1"}`}>
          <NewChatButton collapsed={collapsed} />
        </div>

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

          {state.kind === "loaded" && state.projects.length === 0 && !collapsed && (
            <div className="py-2">
              <p className="text-xs text-ink-muted">No projects yet</p>
              <p className="mt-1 text-xs text-ink-dim">Add a project to get started</p>
            </div>
          )}

          {state.kind === "loaded" && state.projects.length > 0 && (
            <ul className="space-y-0.5">
              {state.projects.map((project) => (
                <li key={project.path}>
                  <ProjectRow
                    project={project}
                    collapsed={collapsed}
                    selected={selectedProject === project.path}
                    onSelect={selectProject}
                    onFavoriteToggled={handleFavoriteToggled}
                    onRemoved={handleProjectRemoved}
                  />
                  {/* Nested chat list — only shown for selected project when sidebar is expanded */}
                  {!collapsed && selectedProject === project.path && (
                    <div className="ml-3 mt-0.5 border-l border-border pl-2">
                      <ChatList
                        projectPath={project.path}
                        selectedChatId={selectedChat}
                        onSelectChat={selectChat}
                        refreshKey={chatRefreshKey}
                      />
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Bottom add-project button — always visible */}
        <div className="border-t border-border px-2 py-2">
          <button
            ref={addButtonRef}
            type="button"
            onClick={() => { setDialogOpen(true); }}
            aria-label={collapsed ? "Add project" : undefined}
            className="w-full rounded px-2 py-1.5 text-left text-xs text-ink-muted
              hover:bg-elevated hover:text-ink
              focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            {collapsed ? "+" : "+ Add project"}
          </button>
        </div>
      </nav>

      {dialogOpen && (
        <AddProjectDialog
          onSuccess={handleProjectAdded}
          onClose={() => {
            setDialogOpen(false);
            setTimeout(() => { addButtonRef.current?.focus(); }, 0);
          }}
        />
      )}
    </>
  );
}

export default Sidebar;
