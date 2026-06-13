"use client";

import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import type { Chat, ProjectWithAvailability } from "@/lib/types";
import { Icons } from "../../Icons";
import { useChatSessionContext } from "../../context/ChatSessionContext";

interface ProjectRowProps {
  readonly project: ProjectWithAvailability;
  readonly activeProjectPath: string | undefined;
  readonly chats: readonly Chat[];
  readonly activeChatId: string | undefined;
  readonly onProject: (project: ProjectWithAvailability) => void;
  readonly onChat: (chat: Chat) => void;
  readonly treeRef: React.RefObject<HTMLDivElement | null>;
}

function projectAvailabilityLabel(project: ProjectWithAvailability): string {
  return project.available ? "Available" : "Unavailable";
}

// Roving-tabindex key set — mirrors FilesWidget TREE_NAV_KEYS (audit PA-03).
const TREE_NAV_KEYS = new Set(["ArrowDown", "ArrowUp", "ArrowRight", "ArrowLeft", "Home", "End"]);

function getTreeItems(container: HTMLDivElement): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll<HTMLButtonElement>("button[role='treeitem']"));
}

function handleTreeKey(event: ReactKeyboardEvent<HTMLDivElement>, container: HTMLDivElement): void {
  const items = getTreeItems(container);
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const btn = target.closest<HTMLButtonElement>("button[role='treeitem']");
  if (btn === null) return;
  const index = items.indexOf(btn);
  if (index < 0) return;
  event.preventDefault();
  const key = event.key;
  if (key === "ArrowDown") {
    items[index + 1]?.focus();
  } else if (key === "ArrowUp") {
    items[index - 1]?.focus();
  } else if (key === "Home") {
    items[0]?.focus();
  } else if (key === "End") {
    items[items.length - 1]?.focus();
  } else if (key === "ArrowRight") {
    // Expand if collapsed, else move to first child.
    if (btn.getAttribute("aria-expanded") === "false") {
      btn.click();
    } else if (btn.getAttribute("aria-expanded") === "true") {
      items[index + 1]?.focus();
    }
  } else if (key === "ArrowLeft") {
    // Collapse if expanded; otherwise move to parent (lower aria-level).
    if (btn.getAttribute("aria-expanded") === "true") {
      btn.click();
    } else {
      const level = Number(btn.getAttribute("aria-level") ?? "1");
      for (let i = index - 1; i >= 0; i -= 1) {
        if (Number(items[i]?.getAttribute("aria-level") ?? "1") < level) {
          items[i]?.focus();
          break;
        }
      }
    }
  }
}

function ProjectRow({
  project,
  activeProjectPath,
  chats,
  activeChatId,
  onProject,
  onChat,
  treeRef,
}: ProjectRowProps): ReactNode {
  const isActiveProject = activeProjectPath === project.path;
  const [expanded, setExpanded] = useState(isActiveProject);
  const availabilityLabel = projectAvailabilityLabel(project);

  useEffect(() => {
    if (isActiveProject) setExpanded(true);
  }, [isActiveProject]);

  return (
    <div className="proj">
      <button
        className="proj-head"
        type="button"
        role="treeitem"
        aria-level={1}
        aria-expanded={expanded}
        aria-selected={isActiveProject}
        data-active={isActiveProject ? "true" : "false"}
        aria-current={isActiveProject ? "true" : undefined}
        aria-label={`${project.name} (${availabilityLabel})`}
        // Roving tabindex: the first item (or active item) is reachable via Tab;
        // all others are skipped and reached via arrow keys only.
        tabIndex={isActiveProject ? 0 : -1}
        onClick={() => {
          setExpanded((current) => !current);
          onProject(project);
          // After activation re-focus so arrow nav keeps the right item at tabIndex 0.
          if (treeRef.current !== null) {
            const items = getTreeItems(treeRef.current);
            items.forEach((item) => {
              item.tabIndex = -1;
            });
          }
        }}
      >
        <span className="proj-caret" data-open={expanded} aria-hidden="true">
          <Icons.chevronR size={13} />
        </span>
        <Icons.folder size={15} aria-hidden="true" />
        <span className="proj-name">{project.name}</span>
        <span className="chat-time">{availabilityLabel}</span>
      </button>
      {expanded && (
        // role="group" groups child treeitems under their parent (APG tree pattern).
        <div className="proj-chats" role="group" aria-label={project.name}>
          {isActiveProject ? (
            chats.length === 0 ? (
              <div className="proj-empty">No chats</div>
            ) : (
              chats.map((chat) => (
                <button
                  key={chat.id}
                  type="button"
                  role="treeitem"
                  aria-level={2}
                  aria-selected={activeChatId === chat.id}
                  className="chat-row"
                  data-active={activeChatId === chat.id}
                  tabIndex={-1}
                  onClick={() => {
                    void onChat(chat);
                  }}
                >
                  <span className="chat-title">{chat.title}</span>
                  {chat.branchLabel !== undefined ? (
                    <span className="chat-meta mono">{chat.branchLabel}</span>
                  ) : null}
                </button>
              ))
            )
          ) : (
            <div className="proj-empty">Select project to load chats</div>
          )}
        </div>
      )}
    </div>
  );
}

export function ProjectPanel(): ReactNode {
  const session = useChatSessionContext();
  const treeRef = useRef<HTMLDivElement | null>(null);

  return (
    <div className="tw-scroll">
      <div className="sb-section">
        <span className="sb-section-label">Projects</span>
      </div>
      {session.projects.length === 0 ? (
        <div className="proj-empty">No registered projects</div>
      ) : (
        // role="tree" + onKeyDown implements the WAI-ARIA tree keyboard pattern (PA-03).
        // tabIndex={-1}: programmatic focus target only (mirrors FilesWidget pattern).
        <div
          className="proj-tree"
          role="tree"
          aria-label="Projects"
          tabIndex={-1}
          ref={treeRef}
          onKeyDown={(event) => {
            if (!TREE_NAV_KEYS.has(event.key)) return;
            if (treeRef.current !== null) handleTreeKey(event, treeRef.current);
          }}
        >
          {session.projects.map((project) => (
            <ProjectRow
              key={project.path}
              project={project}
              activeProjectPath={session.activeProject?.path}
              chats={session.activeProject?.path === project.path ? session.chats : []}
              activeChatId={session.activeChat?.id}
              treeRef={treeRef}
              onProject={(nextProject) => {
                void session.openProject(nextProject);
              }}
              onChat={(chat) => {
                void session.openChat(chat);
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
