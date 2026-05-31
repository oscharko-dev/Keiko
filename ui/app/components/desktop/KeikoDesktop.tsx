"use client";

import type { FormEvent, KeyboardEvent, ReactNode } from "react";
import { useEffect, useState } from "react";
import Image from "next/image";
import {
  ApiError,
  createDesktopChat,
  createProject,
  fetchChatMessages,
  fetchChats,
  fetchModels,
  fetchProjects,
  sendDesktopChat,
} from "@/lib/api";
import type { Chat, ChatMessage, ModelCapability, ProjectWithAvailability } from "@/lib/types";

const DEFAULT_MODEL_ID = "gpt-oss-120b";
const DEFAULT_CHAT_TITLE = "GPT OSS 120B";

type LeftPanel = "project" | "search" | "plugins" | "activity";
type RightPanel = "files" | "browser" | "review" | "terminal";

const LEFT_TOOLS: Array<{ id: LeftPanel; label: string; icon: IconName }> = [
  { id: "project", label: "Project", icon: "folder" },
  { id: "search", label: "Search", icon: "search" },
  { id: "plugins", label: "Plugins", icon: "plugins" },
  { id: "activity", label: "Activity", icon: "activity" },
];

const RIGHT_TOOLS: Array<{ id: RightPanel; label: string; icon: IconName }> = [
  { id: "files", label: "Files", icon: "files" },
  { id: "browser", label: "Browser", icon: "browser" },
  { id: "review", label: "Review", icon: "review" },
  { id: "terminal", label: "Terminal", icon: "terminal" },
];

type IconName =
  | "activity"
  | "agents"
  | "bolt"
  | "branch"
  | "browser"
  | "chat"
  | "chevron"
  | "close"
  | "cube"
  | "files"
  | "folder"
  | "layout"
  | "mobile"
  | "plugins"
  | "plus"
  | "review"
  | "search"
  | "send"
  | "settings"
  | "terminal";

interface IconProps {
  name: IconName;
  size?: number;
}

function Icon({ name, size = 16 }: IconProps): ReactNode {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  switch (name) {
    case "activity":
      return (
        <svg {...common}>
          <path d="M4 14h4l2-7 4 11 2-6h4" />
        </svg>
      );
    case "agents":
      return (
        <svg {...common}>
          <path d="M8 10a4 4 0 1 0 8 0 4 4 0 0 0-8 0Z" />
          <path d="M4 21a8 8 0 0 1 16 0" />
        </svg>
      );
    case "bolt":
      return (
        <svg {...common}>
          <path d="m13 2-8 12h6l-1 8 9-13h-6l0-7Z" />
        </svg>
      );
    case "branch":
      return (
        <svg {...common}>
          <path d="M6 3v12" />
          <path d="M18 7a4 4 0 0 1-4 4H6" />
          <path d="M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" />
          <path d="M18 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" />
        </svg>
      );
    case "browser":
      return (
        <svg {...common}>
          <rect x="3" y="4" width="18" height="16" rx="3" />
          <path d="M3 9h18" />
          <path d="M8 14h8" />
        </svg>
      );
    case "chat":
      return (
        <svg {...common}>
          <path d="M5 6.5A3.5 3.5 0 0 1 8.5 3h7A3.5 3.5 0 0 1 19 6.5v5A3.5 3.5 0 0 1 15.5 15H11l-5 4v-4.4A3.5 3.5 0 0 1 5 12V6.5Z" />
        </svg>
      );
    case "chevron":
      return (
        <svg {...common}>
          <path d="m9 6 6 6-6 6" />
        </svg>
      );
    case "close":
      return (
        <svg {...common}>
          <path d="M6 6l12 12" />
          <path d="M18 6 6 18" />
        </svg>
      );
    case "cube":
      return (
        <svg {...common}>
          <path d="m12 2 8 4.5v9L12 20l-8-4.5v-9L12 2Z" />
          <path d="M12 11 4.5 6.8" />
          <path d="M12 11v8.5" />
          <path d="m12 11 7.5-4.2" />
        </svg>
      );
    case "files":
      return (
        <svg {...common}>
          <path d="M5 4h7l2 2h5v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z" />
          <path d="M7 10h10" />
          <path d="M7 14h7" />
        </svg>
      );
    case "folder":
      return (
        <svg {...common}>
          <path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
        </svg>
      );
    case "layout":
      return (
        <svg {...common}>
          <rect x="4" y="4" width="16" height="16" rx="2" />
          <path d="M4 10h16" />
          <path d="M10 10v10" />
        </svg>
      );
    case "mobile":
      return (
        <svg {...common}>
          <rect x="7" y="3" width="10" height="18" rx="2" />
          <path d="M11 18h2" />
        </svg>
      );
    case "plugins":
      return (
        <svg {...common}>
          <path d="M9 7V4" />
          <path d="M15 7V4" />
          <path d="M7 7h10v5a5 5 0 0 1-10 0V7Z" />
          <path d="M12 17v4" />
        </svg>
      );
    case "plus":
      return (
        <svg {...common}>
          <path d="M12 5v14" />
          <path d="M5 12h14" />
        </svg>
      );
    case "review":
      return (
        <svg {...common}>
          <path d="M7 4h10a2 2 0 0 1 2 2v13H7a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z" />
          <path d="M9 9h6" />
          <path d="M9 13h4" />
        </svg>
      );
    case "search":
      return (
        <svg {...common}>
          <circle cx="11" cy="11" r="6" />
          <path d="m16 16 4 4" />
        </svg>
      );
    case "send":
      return (
        <svg {...common}>
          <path d="m5 12 14-7-5 14-3-6-6-1Z" />
        </svg>
      );
    case "settings":
      return (
        <svg {...common}>
          <path d="M12 15.5A3.5 3.5 0 1 0 12 8a3.5 3.5 0 0 0 0 7.5Z" />
          <path d="M19 12a7.7 7.7 0 0 0-.1-1.2l2-1.5-2-3.4-2.4 1a7 7 0 0 0-2-1.2L14.2 3h-4.4l-.4 2.7a7 7 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.5A7.7 7.7 0 0 0 5 12c0 .4 0 .8.1 1.2l-2 1.5 2 3.4 2.4-1a7 7 0 0 0 2 1.2l.4 2.7h4.4l.4-2.7a7 7 0 0 0 2-1.2l2.4 1 2-3.4-2-1.5c.1-.4.1-.8.1-1.2Z" />
        </svg>
      );
    case "terminal":
      return (
        <svg {...common}>
          <rect x="3" y="5" width="18" height="14" rx="2" />
          <path d="m7 10 3 2-3 2" />
          <path d="M13 15h4" />
        </svg>
      );
  }
  return null;
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return `${error.code}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return "Unknown error";
}

function sortChats(chats: readonly Chat[]): Chat[] {
  return [...chats].sort((a, b) => b.updatedAt - a.updatedAt);
}

function timeLabel(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function displayName(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

export function KeikoDesktop(): ReactNode {
  const [leftPanel, setLeftPanel] = useState<LeftPanel>("project");
  const [rightPanel, setRightPanel] = useState<RightPanel | undefined>(undefined);
  const [chatOpen, setChatOpen] = useState(true);
  const [projects, setProjects] = useState<ProjectWithAvailability[]>([]);
  const [chats, setChats] = useState<Chat[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [models, setModels] = useState<ModelCapability[]>([]);
  const [activeProject, setActiveProject] = useState<ProjectWithAvailability | undefined>();
  const [activeChat, setActiveChat] = useState<Chat | undefined>();
  const [selectedModel, setSelectedModel] = useState(DEFAULT_MODEL_ID);
  const [draft, setDraft] = useState("");
  const [projectPath, setProjectPath] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    async function bootstrap(): Promise<void> {
      setLoading(true);
      setError(undefined);
      try {
        const modelPayload = await fetchModels().catch(() => ({ models: [] }));
        const chatModels = modelPayload.models.filter((model) => model.kind === "chat");
        const defaultModel = chatModels.some((model) => model.id === DEFAULT_MODEL_ID)
          ? DEFAULT_MODEL_ID
          : chatModels[0]?.id ?? DEFAULT_MODEL_ID;

        const projectPayload = await fetchProjects().catch(() => ({ projects: [] }));
        const project = projectPayload.projects.find((item) => item.available) ?? projectPayload.projects[0];
        if (project !== undefined) {
          const chatPayload = await fetchChats(project.path).catch(() => ({ chats: [] }));
          const latestChat = sortChats(chatPayload.chats)[0];
          if (latestChat !== undefined) {
            const messagePayload = await fetchChatMessages(latestChat.id, project.path);
            if (!cancelled) {
              setModels(chatModels);
              setSelectedModel(latestChat.selectedModel);
              setProjects(Array.from(projectPayload.projects));
              setActiveProject(project);
              setChats(sortChats(chatPayload.chats));
              setActiveChat(latestChat);
              setMessages(Array.from(messagePayload.messages));
            }
            return;
          }
        }

        const input: { modelId: string; title: string; projectPath?: string } = {
          modelId: defaultModel,
          title: DEFAULT_CHAT_TITLE,
        };
        if (project?.available === true) {
          input.projectPath = project.path;
        }
        const created = await createDesktopChat(input);
        if (!cancelled) {
          setModels(chatModels);
          setSelectedModel(created.chat.selectedModel);
          setProjects(Array.from(created.projects));
          setActiveProject(created.project);
          setChats(sortChats(created.chats));
          setActiveChat(created.chat);
          setMessages(Array.from(created.messages));
        }
      } catch (caught) {
        if (!cancelled) {
          setError(errorMessage(caught));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }
    void bootstrap();
    return () => {
      cancelled = true;
    };
  }, []);

  async function openNewChat(projectOverride?: ProjectWithAvailability): Promise<void> {
    setError(undefined);
    try {
      const input: { modelId: string; title: string; projectPath?: string } = {
        modelId: selectedModel,
        title: DEFAULT_CHAT_TITLE,
      };
      const targetPath = projectOverride?.path ?? activeProject?.path;
      if (targetPath !== undefined) {
        input.projectPath = targetPath;
      }
      const created = await createDesktopChat(input);
      setProjects(Array.from(created.projects));
      setActiveProject(created.project);
      setChats(sortChats(created.chats));
      setActiveChat(created.chat);
      setMessages(Array.from(created.messages));
      setSelectedModel(created.chat.selectedModel);
      setChatOpen(true);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  async function openProject(project: ProjectWithAvailability): Promise<void> {
    setError(undefined);
    setActiveProject(project);
    try {
      const chatPayload = await fetchChats(project.path);
      const sorted = sortChats(chatPayload.chats);
      const latest = sorted[0];
      setChats(sorted);
      if (latest === undefined) {
        await openNewChat(project);
        return;
      }
      const messagePayload = await fetchChatMessages(latest.id, project.path);
      setActiveChat(latest);
      setSelectedModel(latest.selectedModel);
      setMessages(Array.from(messagePayload.messages));
      setChatOpen(true);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  async function openChat(chat: Chat): Promise<void> {
    setError(undefined);
    try {
      const messagePayload = await fetchChatMessages(chat.id, chat.projectPath);
      const project = projects.find((item) => item.path === chat.projectPath);
      setActiveProject(project);
      setActiveChat(chat);
      setSelectedModel(chat.selectedModel);
      setMessages(Array.from(messagePayload.messages));
      setChatOpen(true);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  async function addProject(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const path = projectPath.trim();
    if (path.length === 0) return;
    setError(undefined);
    try {
      const created = await createProject({ path });
      const projectPayload = await fetchProjects();
      setProjectPath("");
      setProjects(Array.from(projectPayload.projects));
      await openNewChat(created.project);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  async function sendMessage(): Promise<void> {
    const content = draft.trim();
    if (content.length === 0 || activeChat === undefined || activeProject === undefined) {
      return;
    }
    const optimistic: ChatMessage = {
      id: `local-${String(Date.now())}`,
      chatId: activeChat.id,
      role: "user",
      content,
      timestamp: Date.now(),
    };
    setDraft("");
    setSending(true);
    setError(undefined);
    setMessages((current) => [...current, optimistic]);
    try {
      const result = await sendDesktopChat({
        chatId: activeChat.id,
        projectPath: activeProject.path,
        content,
        modelId: selectedModel,
      });
      setActiveChat(result.chat);
      setChats((current) => sortChats([result.chat, ...current.filter((chat) => chat.id !== result.chat.id)]));
      setMessages((current) => [
        ...current.filter((message) => message.id !== optimistic.id),
        ...Array.from(result.messages),
      ]);
    } catch (caught) {
      setError(errorMessage(caught));
      try {
        const messagePayload = await fetchChatMessages(activeChat.id, activeProject.path);
        setMessages(Array.from(messagePayload.messages));
      } catch {
        setMessages((current) => current.filter((message) => message.id !== optimistic.id));
      }
    } finally {
      setSending(false);
    }
  }

  function onComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendMessage();
    }
  }

  const modelOptions = models.length > 0 ? models : [{ id: DEFAULT_MODEL_ID } as ModelCapability];
  const workspaceName = activeProject?.name ?? activeProject?.path ?? "Local workspace";
  const visibleMessages = messages.filter((message) => message.role === "user" || message.role === "assistant");

  return (
    <div className="keiko-app">
      <header className="keiko-header" aria-label="Keiko workspace header">
        <div className="brand">
          <Image src="/keiko-logo.svg" alt="Keiko" width={23} height={23} priority />
          <span>Keiko</span>
        </div>
        <button className="top-tab" type="button" onClick={() => setLeftPanel("project")}>
          <Icon name="folder" size={14} />
          <span className="truncate">{workspaceName}</span>
          <Icon name="chevron" size={13} />
        </button>
        <button className="top-action" type="button" onClick={() => void openNewChat()}>
          <Icon name="plus" size={15} />
          <span>New</span>
        </button>
        <span className="spacer" />
        <div className="hide-mobile row" aria-label="Window layout controls">
          <button className="layout-btn" type="button" title="Tile windows">
            <Icon name="layout" size={15} />
          </button>
          <button className="layout-btn" type="button" title="Open agents">
            <Icon name="agents" size={15} />
          </button>
        </div>
        <span className="top-pill mono">
          <span className="dot" style={{ background: "var(--ok)" }} />
          connected
        </span>
      </header>

      <main className="keiko-main">
        <nav className="rail rail-left" aria-label="Workspace tools">
          <button
            className="rail-new"
            type="button"
            title="New chat"
            aria-label="New chat"
            onClick={() => void openNewChat()}
          >
            <Icon name="plus" size={18} />
          </button>
          <div className="rail-divider" />
          {LEFT_TOOLS.map((tool) => (
            <button
              key={tool.id}
              className="rail-btn"
              type="button"
              data-active={leftPanel === tool.id}
              aria-label={tool.label}
              onClick={() => setLeftPanel(tool.id)}
            >
              <Icon name={tool.icon} size={17} />
            </button>
          ))}
          <span className="spacer" />
          <button className="rail-btn" type="button" aria-label="Mobile">
            <Icon name="mobile" size={17} />
          </button>
          <button className="rail-btn" type="button" aria-label="Settings">
            <Icon name="settings" size={17} />
          </button>
          <div className="avatar" aria-label="Current user">
            M
          </div>
        </nav>

        <section className="stage" aria-label="Keiko desktop workspace">
          <div className="workspace">
            <ToolPanel
              panel={leftPanel}
              projects={projects}
              chats={chats}
              activeChat={activeChat}
              activeProject={activeProject}
              projectPath={projectPath}
              onProjectPath={setProjectPath}
              onAddProject={addProject}
              onOpenProject={openProject}
              onOpenChat={openChat}
              onClose={() => setLeftPanel("project")}
            />

            {chatOpen && activeChat !== undefined ? (
              <section className="workspace-window" aria-label="GPT OSS chat window">
                <div className="window-head">
                  <Icon name="chat" size={16} />
                  <span className="window-title">Chat</span>
                  <span className="window-sub">{activeChat.title}</span>
                  <span className="spacer" />
                  <span className="window-sub mono">{selectedModel}</span>
                  <button className="win-btn" type="button" aria-label="Close chat" onClick={() => setChatOpen(false)}>
                    <Icon name="close" size={15} />
                  </button>
                </div>
                <div className="chat-body">
                  <div className="messages" aria-live="polite">
                    {visibleMessages.length === 0 ? (
                      <div className="empty-chat">
                        <div>
                          <h2>Chat with GPT OSS 120B</h2>
                          <p className="state-text">
                            The model call stays behind the existing Keiko Model Gateway. No provider
                            details or Azure secrets are exposed to the browser.
                          </p>
                        </div>
                      </div>
                    ) : (
                      visibleMessages.map((message) => (
                        <article key={message.id} className="message" data-role={message.role}>
                          <div className="message-bubble">
                            <div className="message-role">{message.role === "user" ? "You" : "Keiko"}</div>
                            {message.content}
                            <div className="message-role mono" style={{ marginTop: 8, marginBottom: 0 }}>
                              {timeLabel(message.timestamp)}
                            </div>
                          </div>
                        </article>
                      ))
                    )}
                  </div>
                  <form
                    className="composer"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void sendMessage();
                    }}
                  >
                    <div className="composer-box">
                      <textarea
                        value={draft}
                        aria-label="Chat message"
                        placeholder={loading ? "Loading local workspace..." : "Ask GPT OSS 120B about your code..."}
                        onChange={(event) => setDraft(event.target.value)}
                        onKeyDown={onComposerKeyDown}
                        disabled={loading || sending}
                      />
                      <div className="composer-bar">
                        <span className="chip">
                          <Icon name="bolt" size={14} />
                          Direct chat
                        </span>
                        <span className="chip">
                          <Icon name="cube" size={14} />
                          Work locally
                        </span>
                        <select
                          className="model-select mono"
                          value={selectedModel}
                          aria-label="Model"
                          onChange={(event) => setSelectedModel(event.target.value)}
                        >
                          {modelOptions.map((model) => (
                            <option key={model.id} value={model.id}>
                              {model.id}
                            </option>
                          ))}
                        </select>
                        <span className="spacer" />
                        <button
                          className="send-btn"
                          type="submit"
                          data-ready={draft.trim().length > 0 && !sending}
                          disabled={draft.trim().length === 0 || sending || loading}
                          aria-label="Send message"
                        >
                          <Icon name="send" size={16} />
                        </button>
                      </div>
                      {error !== undefined ? <div className="error-banner">{error}</div> : null}
                    </div>
                  </form>
                </div>
              </section>
            ) : (
              <div className="hero">
                <div className="hero-mark">
                  <Icon name="chat" size={26} />
                </div>
                <h1>Keiko workspace</h1>
                <p>
                  Start a local, gateway-backed chat against your configured Azure-hosted
                  GPTOSS model. Files, Browser, Review, and Terminal are visible entry points for
                  follow-up integration work.
                </p>
                <button className="top-action" type="button" onClick={() => void openNewChat()}>
                  <Icon name="plus" size={15} />
                  Open chat
                </button>
              </div>
            )}
          </div>
        </section>

        <aside className="rail rail-right" aria-label="Context entry points">
          {RIGHT_TOOLS.map((tool) => (
            <button
              key={tool.id}
              className="rail-btn"
              type="button"
              data-active={rightPanel === tool.id}
              aria-label={tool.label}
              title={`${tool.label}: planned entry point`}
              onClick={() => setRightPanel(rightPanel === tool.id ? undefined : tool.id)}
            >
              <Icon name={tool.icon} size={17} />
            </button>
          ))}
          {rightPanel !== undefined ? (
            <div
              role="status"
              className="top-pill mono"
              style={{
                position: "absolute",
                right: 66,
                top: 64,
                zIndex: 25,
                background: "var(--card)",
              }}
            >
              {rightPanel} follows
            </div>
          ) : null}
        </aside>
      </main>

      <footer className="keiko-footer mono">
        <span className="footer-seg footer-accent">
          <Image src="/keiko-logo.svg" alt="" width={14} height={14} />
          Keiko governing
        </span>
        <span className="footer-seg">
          <Icon name="folder" size={13} />
          <span className="truncate">{activeProject?.name ?? "local"}</span>
        </span>
        <span className="footer-seg hide-mobile">
          <Icon name="branch" size={13} />
          {activeChat?.branchLabel ?? "local"}
        </span>
        <span className="footer-seg hide-mobile">
          <Icon name="cube" size={13} />
          Work locally
        </span>
        <span className="spacer" />
        <span className="footer-seg footer-accent">
          <Icon name="layout" size={13} />1 window
        </span>
        <span className="footer-seg">
          <Icon name="bolt" size={13} />
          {selectedModel}
        </span>
        <span className="footer-seg footer-accent">
          <span className="dot" style={{ background: "var(--accent)" }} />
          autosaved
        </span>
      </footer>
    </div>
  );
}

interface ToolPanelProps {
  panel: LeftPanel;
  projects: readonly ProjectWithAvailability[];
  chats: readonly Chat[];
  activeChat: Chat | undefined;
  activeProject: ProjectWithAvailability | undefined;
  projectPath: string;
  onProjectPath: (path: string) => void;
  onAddProject: (event: FormEvent<HTMLFormElement>) => void;
  onOpenProject: (project: ProjectWithAvailability) => void | Promise<void>;
  onOpenChat: (chat: Chat) => void | Promise<void>;
  onClose: () => void;
}

function ToolPanel({
  panel,
  projects,
  chats,
  activeChat,
  activeProject,
  projectPath,
  onProjectPath,
  onAddProject,
  onOpenProject,
  onOpenChat,
  onClose,
}: ToolPanelProps): ReactNode {
  const title = panel === "project" ? "Project" : panel === "search" ? "Search" : panel === "plugins" ? "Plugins" : "Activity";
  const icon = panel === "project" ? "folder" : panel === "search" ? "search" : panel === "plugins" ? "plugins" : "activity";
  return (
    <aside className="tool-panel" aria-label={`${title} panel`}>
      <div className="tool-head">
        <Icon name={icon} size={16} />
        <span className="tool-title">{title}</span>
        <span className="spacer" />
        <button className="panel-close" type="button" aria-label="Collapse panel" onClick={onClose}>
          <Icon name="chevron" size={15} />
        </button>
      </div>
      <div className="tool-body">
        {panel === "project" ? (
          <ProjectPanel
            projects={projects}
            chats={chats}
            activeChat={activeChat}
            activeProject={activeProject}
            projectPath={projectPath}
            onProjectPath={onProjectPath}
            onAddProject={onAddProject}
            onOpenProject={onOpenProject}
            onOpenChat={onOpenChat}
          />
        ) : null}
        {panel === "search" ? <SearchPanel activeProject={activeProject} /> : null}
        {panel === "plugins" ? <PluginsPanel /> : null}
        {panel === "activity" ? <ActivityPanel /> : null}
      </div>
    </aside>
  );
}

interface ProjectPanelProps {
  projects: readonly ProjectWithAvailability[];
  chats: readonly Chat[];
  activeChat: Chat | undefined;
  activeProject: ProjectWithAvailability | undefined;
  projectPath: string;
  onProjectPath: (path: string) => void;
  onAddProject: (event: FormEvent<HTMLFormElement>) => void;
  onOpenProject: (project: ProjectWithAvailability) => void | Promise<void>;
  onOpenChat: (chat: Chat) => void | Promise<void>;
}

function ProjectPanel({
  projects,
  chats,
  activeChat,
  activeProject,
  projectPath,
  onProjectPath,
  onAddProject,
  onOpenProject,
  onOpenChat,
}: ProjectPanelProps): ReactNode {
  return (
    <>
      <form className="path-form" onSubmit={onAddProject}>
        <Icon name="plus" size={14} />
        <input
          value={projectPath}
          onChange={(event) => onProjectPath(event.target.value)}
          placeholder="/absolute/local/project"
          aria-label="Add local project by absolute path"
        />
        <button className="mini-btn" type="submit">
          Add
        </button>
      </form>
      <div className="tool-label">Projects</div>
      {projects.length === 0 ? (
        <p className="state-text">No local project has been persisted yet.</p>
      ) : (
        projects.map((project) => (
          <button
            key={project.path}
            className="project-row"
            type="button"
            onClick={() => void onOpenProject(project)}
            aria-current={activeProject?.path === project.path ? "true" : undefined}
          >
            <Icon name="folder" size={15} />
            <span className="truncate">{project.name || displayName(project.path)}</span>
            <span
              className="dot"
              title={project.available ? "available" : "unavailable"}
              style={{ background: project.available ? "var(--accent)" : "var(--danger)" }}
            />
          </button>
        ))
      )}
      <div className="tool-label">Chats</div>
      {chats.length === 0 ? (
        <p className="state-text">No chats for the selected project.</p>
      ) : (
        chats.map((chat) => (
          <button
            key={chat.id}
            className="chat-row"
            type="button"
            data-active={activeChat?.id === chat.id}
            onClick={() => void onOpenChat(chat)}
          >
            <Icon name="chat" size={13} />
            <span className="truncate">{chat.title}</span>
            <span className="mono" style={{ color: "var(--fg-faint)", fontSize: 10 }}>
              {timeLabel(chat.updatedAt)}
            </span>
          </button>
        ))
      )}
    </>
  );
}

function SearchPanel({ activeProject }: { activeProject: ProjectWithAvailability | undefined }): ReactNode {
  return (
    <>
      <div className="search-box">
        <Icon name="search" size={14} />
        <input placeholder="Search project files" aria-label="Search project files" />
      </div>
      <div className="tool-label">Project preview</div>
      {["src", "ui", "tests", "README.md"].map((item) => (
        <button key={item} className="file-row" type="button" disabled>
          <Icon name={item.includes(".") ? "review" : "folder"} size={13} />
          <span>{item}</span>
        </button>
      ))}
      <p className="state-text" style={{ marginTop: 14 }}>
        Search is scoped to {activeProject?.name ?? "the selected local project"}; full file indexing
        remains a follow-up integration.
      </p>
    </>
  );
}

function PluginsPanel(): ReactNode {
  const rows = [
    ["GitHub", "Connected through existing workflows", true],
    ["Evidence", "Open run artifacts and manifests", true],
    ["Browser", "Planned controlled browsing entry point", false],
    ["Terminal", "Planned execution boundary", false],
  ] as const;
  return (
    <>
      <div className="tool-label">Connectors</div>
      {rows.map(([name, desc, on]) => (
        <div key={name} className="plugin-row">
          <Icon name="plugins" size={15} />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="truncate" style={{ color: "var(--fg)", fontSize: 13 }}>
              {name}
            </div>
            <div className="truncate state-text">{desc}</div>
          </div>
          <span className="dot" style={{ background: on ? "var(--accent)" : "var(--line-strong)" }} />
        </div>
      ))}
    </>
  );
}

function ActivityPanel(): ReactNode {
  return (
    <>
      <div className="tool-label">Session</div>
      <div className="plugin-row">
        <Icon name="bolt" size={15} />
        <div>
          <div style={{ color: "var(--fg)", fontSize: 13 }}>Direct GPTOSS chat enabled</div>
          <div className="state-text">Workflow orchestration remains on the existing run paths.</div>
        </div>
      </div>
      <div className="plugin-row">
        <Icon name="review" size={15} />
        <div>
          <div style={{ color: "var(--fg)", fontSize: 13 }}>Reviewable follow-ups</div>
          <div className="state-text">Files, Browser, Review, and Terminal are entry points only.</div>
        </div>
      </div>
    </>
  );
}
