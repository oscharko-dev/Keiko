"use client";

import { useEffect, useState } from "react";
import type { ReactNode } from "react";
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
}

function projectAvailabilityLabel(project: ProjectWithAvailability): string {
  return project.available ? "Available" : "Unavailable";
}

function ProjectRow({
  project,
  activeProjectPath,
  chats,
  activeChatId,
  onProject,
  onChat,
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
        data-active={isActiveProject ? "true" : "false"}
        aria-expanded={expanded}
        aria-current={isActiveProject ? "true" : undefined}
        aria-label={`${project.name} (${availabilityLabel})`}
        onClick={() => {
          setExpanded((current) => !current);
          onProject(project);
        }}
      >
        <span className="proj-caret" data-open={expanded}>
          <Icons.chevronR size={13} />
        </span>
        <Icons.folder size={15} />
        <span className="proj-name">{project.name}</span>
        <span className="chat-time">{availabilityLabel}</span>
      </button>
      {expanded && (
        <div className="proj-chats">
          {isActiveProject ? (
            chats.length === 0 ? (
              <div className="proj-empty">No chats</div>
            ) : (
              chats.map((chat) => (
                <button
                  key={chat.id}
                  type="button"
                  className="chat-row"
                  data-active={activeChatId === chat.id}
                  aria-pressed={activeChatId === chat.id}
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

  return (
    <div className="tw-scroll">
      <div className="sb-section">
        <span className="sb-section-label">Projects</span>
      </div>
      {session.projects.length === 0 ? (
        <div className="proj-empty">No registered projects</div>
      ) : (
        session.projects.map((project) => (
          <ProjectRow
            key={project.path}
            project={project}
            activeProjectPath={session.activeProject?.path}
            chats={session.activeProject?.path === project.path ? session.chats : []}
            activeChatId={session.activeChat?.id}
            onProject={(nextProject) => {
              void session.openProject(nextProject);
            }}
            onChat={(chat) => {
              void session.openChat(chat);
            }}
          />
        ))
      )}
    </div>
  );
}
