"use client";

import { useState } from "react";
import type { ReactNode } from "react";
import { Icons } from "../../Icons";

interface Chat {
  id: string;
  title: string;
  time?: string;
  running?: boolean;
  pinned?: boolean;
}

interface Project {
  name: string;
  open: boolean;
  chats: Chat[];
}

const PROJECTS: Project[] = [
  {
    name: "Keiko",
    open: true,
    chats: [
      { id: "c1", title: "Workspace bootstrap", time: "2h" },
      { id: "c2", title: "Resizable card system", time: "5h" },
    ],
  },
  { name: "c2c-PreBeta", open: false, chats: [] },
  {
    name: "example-workspace",
    open: true,
    chats: [
      { id: "c3", title: "Start work mode", running: true },
      { id: "c4", title: "Create agent team for #29", time: "8h" },
      { id: "c5", title: "Begin work", pinned: true },
    ],
  },
];

interface ProjectRowProps {
  project: Project;
  activeChat: string;
  onChat: (id: string) => void;
}

function ProjectRow({ project, activeChat, onChat }: ProjectRowProps): ReactNode {
  const [exp, setExp] = useState(project.open);
  return (
    <div className="proj">
      <button className="proj-head" onClick={() => { setExp((e) => !e); }}>
        <span className="proj-caret" data-open={exp}>
          <Icons.chevronR size={13} />
        </span>
        <Icons.folder size={15} />
        <span className="proj-name">{project.name}</span>
      </button>
      {exp && (
        <div className="proj-chats">
          {project.chats.length === 0 ? (
            <div className="proj-empty">No chats</div>
          ) : (
            project.chats.map((c) => (
              <button
                key={c.id}
                className="chat-row"
                data-active={activeChat === c.id}
                onClick={() => { onChat(c.id); }}
              >
                {c.running === true && (
                  <span className="chat-spin">
                    <Icons.reset size={12} />
                  </span>
                )}
                <span className="chat-title">{c.title}</span>
                {c.pinned === true && (
                  <span className="chat-meta">
                    <Icons.pin size={12} />
                  </span>
                )}
                {c.time !== undefined && <span className="chat-time">{c.time}</span>}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

export function ProjectPanel(): ReactNode {
  const stored =
    typeof window !== "undefined" ? (localStorage.getItem("keiko.project.activeChat") ?? "c3") : "c3";
  const [activeChat, setActiveChat] = useState(stored);

  const handleChat = (id: string): void => {
    setActiveChat(id);
    if (typeof window !== "undefined") {
      localStorage.setItem("keiko.project.activeChat", id);
    }
  };

  return (
    <div className="tw-scroll">
      <div className="sb-section">
        <span className="sb-section-label">Projects</span>
        <button className="sb-section-add" aria-label="Add project">
          <Icons.plus size={14} />
        </button>
      </div>
      {PROJECTS.map((p) => (
        <ProjectRow key={p.name} project={p} activeChat={activeChat} onChat={handleChat} />
      ))}
      <div className="sb-section" style={{ marginTop: 14 }}>
        <span className="sb-section-label">Chats</span>
      </div>
      <div className="proj-empty" style={{ paddingLeft: 12 }}>
        No chats
      </div>
    </div>
  );
}
