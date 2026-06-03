"use client";

import { useCallback, useEffect, useState } from "react";
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
import type {
  Chat,
  ChatMessage,
  ModelCapability,
  ProjectWithAvailability,
} from "@/lib/types";

export const DEFAULT_MODEL_ID = "example-chat-model";
export const DEFAULT_CHAT_TITLE = "New chat";

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return `${error.code}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return "Unknown error";
}

function sortChats(chats: readonly Chat[]): Chat[] {
  return [...chats].sort((a, b) => b.updatedAt - a.updatedAt);
}

function pickChatModelId(models: readonly ModelCapability[]): string {
  if (models.some((model) => model.id === DEFAULT_MODEL_ID)) return DEFAULT_MODEL_ID;
  return models[0]?.id ?? DEFAULT_MODEL_ID;
}

export type ChatSessionApi = UseChatSessionResult;

export interface UseChatSessionResult {
  projects: ProjectWithAvailability[];
  chats: Chat[];
  messages: ChatMessage[];
  models: ModelCapability[];
  activeProject: ProjectWithAvailability | undefined;
  activeChat: Chat | undefined;
  selectedModel: string;
  draft: string;
  loading: boolean;
  sending: boolean;
  error: string | undefined;
  setDraft: (value: string) => void;
  setSelectedModel: (id: string) => void;
  openNewChat: (project?: ProjectWithAvailability) => Promise<void>;
  openProject: (project: ProjectWithAvailability) => Promise<void>;
  openChat: (chat: Chat) => Promise<void>;
  addProject: (path: string) => Promise<void>;
  sendMessage: () => Promise<void>;
}

interface SessionState {
  projects: ProjectWithAvailability[];
  chats: Chat[];
  messages: ChatMessage[];
  models: ModelCapability[];
  activeProject: ProjectWithAvailability | undefined;
  activeChat: Chat | undefined;
  selectedModel: string;
}

const INITIAL_STATE: SessionState = {
  projects: [],
  chats: [],
  messages: [],
  models: [],
  activeProject: undefined,
  activeChat: undefined,
  selectedModel: DEFAULT_MODEL_ID,
};

async function bootstrapSession(): Promise<Partial<SessionState>> {
  const modelPayload = await fetchModels().catch(() => ({ models: [] }));
  const chatModels = modelPayload.models.filter((model) => model.kind === "chat");
  const defaultModel = pickChatModelId(chatModels);

  const projectPayload = await fetchProjects().catch(() => ({ projects: [] }));
  const project =
    projectPayload.projects.find((item) => item.available) ?? projectPayload.projects[0];

  if (project !== undefined) {
    const chatPayload = await fetchChats(project.path).catch(() => ({ chats: [] }));
    const sortedChats = sortChats(chatPayload.chats);
    const latestChat = sortedChats[0];
    if (latestChat !== undefined) {
      const messagePayload = await fetchChatMessages(latestChat.id, project.path);
      return {
        models: chatModels,
        selectedModel: latestChat.selectedModel,
        projects: Array.from(projectPayload.projects),
        activeProject: project,
        chats: sortedChats,
        activeChat: latestChat,
        messages: Array.from(messagePayload.messages),
      };
    }
  }

  const input: { modelId: string; title: string; projectPath?: string } = {
    modelId: defaultModel,
    title: DEFAULT_CHAT_TITLE,
  };
  if (project?.available === true) input.projectPath = project.path;
  const created = await createDesktopChat(input);
  return {
    models: chatModels,
    selectedModel: created.chat.selectedModel,
    projects: Array.from(created.projects),
    activeProject: created.project,
    chats: sortChats(created.chats),
    activeChat: created.chat,
    messages: Array.from(created.messages),
  };
}

export function useChatSession(): UseChatSessionResult {
  const [state, setState] = useState<SessionState>(INITIAL_STATE);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    async function run(): Promise<void> {
      setLoading(true);
      setError(undefined);
      try {
        const patch = await bootstrapSession();
        if (!cancelled) setState((previous) => ({ ...previous, ...patch }));
      } catch (caught) {
        if (!cancelled) setError(errorMessage(caught));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, []);

  const setSelectedModel = useCallback((id: string) => {
    setState((previous) => ({ ...previous, selectedModel: id }));
  }, []);

  const openNewChat = useCallback(
    async (projectOverride?: ProjectWithAvailability): Promise<void> => {
      setError(undefined);
      try {
        const input: { modelId: string; title: string; projectPath?: string } = {
          modelId: state.selectedModel,
          title: DEFAULT_CHAT_TITLE,
        };
        const targetPath = projectOverride?.path ?? state.activeProject?.path;
        if (targetPath !== undefined) input.projectPath = targetPath;
        const created = await createDesktopChat(input);
        setState({
          projects: Array.from(created.projects),
          chats: sortChats(created.chats),
          messages: Array.from(created.messages),
          models: state.models,
          activeProject: created.project,
          activeChat: created.chat,
          selectedModel: created.chat.selectedModel,
        });
      } catch (caught) {
        setError(errorMessage(caught));
      }
    },
    [state.selectedModel, state.activeProject, state.models],
  );

  const openProject = useCallback(
    async (project: ProjectWithAvailability): Promise<void> => {
      setError(undefined);
      setState((previous) => ({ ...previous, activeProject: project }));
      try {
        const chatPayload = await fetchChats(project.path);
        const sorted = sortChats(chatPayload.chats);
        const latest = sorted[0];
        if (latest === undefined) {
          await openNewChat(project);
          return;
        }
        const messagePayload = await fetchChatMessages(latest.id, project.path);
        setState((previous) => ({
          ...previous,
          chats: sorted,
          activeChat: latest,
          selectedModel: latest.selectedModel,
          messages: Array.from(messagePayload.messages),
        }));
      } catch (caught) {
        setError(errorMessage(caught));
      }
    },
    [openNewChat],
  );

  const openChat = useCallback(async (chat: Chat): Promise<void> => {
    setError(undefined);
    try {
      const messagePayload = await fetchChatMessages(chat.id, chat.projectPath);
      setState((previous) => {
        const project = previous.projects.find((item) => item.path === chat.projectPath);
        return {
          ...previous,
          activeProject: project,
          activeChat: chat,
          selectedModel: chat.selectedModel,
          messages: Array.from(messagePayload.messages),
        };
      });
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }, []);

  const addProject = useCallback(
    async (path: string): Promise<void> => {
      const trimmed = path.trim();
      if (trimmed.length === 0) return;
      setError(undefined);
      try {
        const created = await createProject({ path: trimmed });
        const projectPayload = await fetchProjects();
        setState((previous) => ({ ...previous, projects: Array.from(projectPayload.projects) }));
        await openNewChat(created.project);
      } catch (caught) {
        setError(errorMessage(caught));
      }
    },
    [openNewChat],
  );

  const sendMessage = useCallback(async (): Promise<void> => {
    const content = draft.trim();
    const chat = state.activeChat;
    const project = state.activeProject;
    if (content.length === 0 || chat === undefined || project === undefined) return;
    const optimistic: ChatMessage = {
      id: `local-${String(Date.now())}`,
      chatId: chat.id,
      role: "user",
      content,
      timestamp: Date.now(),
    };
    setDraft("");
    setSending(true);
    setError(undefined);
    setState((previous) => ({ ...previous, messages: [...previous.messages, optimistic] }));
    try {
      const result = await sendDesktopChat({
        chatId: chat.id,
        projectPath: project.path,
        content,
        modelId: state.selectedModel,
      });
      setState((previous) => ({
        ...previous,
        activeChat: result.chat,
        chats: sortChats([
          result.chat,
          ...previous.chats.filter((existing) => existing.id !== result.chat.id),
        ]),
        messages: [
          ...previous.messages.filter((message) => message.id !== optimistic.id),
          ...Array.from(result.messages),
        ],
      }));
    } catch (caught) {
      setError(errorMessage(caught));
      try {
        const messagePayload = await fetchChatMessages(chat.id, project.path);
        setState((previous) => ({ ...previous, messages: Array.from(messagePayload.messages) }));
      } catch {
        setState((previous) => ({
          ...previous,
          messages: previous.messages.filter((message) => message.id !== optimistic.id),
        }));
      }
    } finally {
      setSending(false);
    }
  }, [draft, state.activeChat, state.activeProject, state.selectedModel]);

  return {
    projects: state.projects,
    chats: state.chats,
    messages: state.messages,
    models: state.models,
    activeProject: state.activeProject,
    activeChat: state.activeChat,
    selectedModel: state.selectedModel,
    draft,
    loading,
    sending,
    error,
    setDraft,
    setSelectedModel,
    openNewChat,
    openProject,
    openChat,
    addProject,
    sendMessage,
  };
}
