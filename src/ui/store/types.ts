// ADR-0013 D4 — UiStore port and entity types. The port is the seam for testing; the concrete
// `createNodeUiStore` adapter and the `createInMemoryUiStore` test adapter both implement it.

export interface Project {
  readonly path: string;
  readonly name: string;
  readonly favorite: boolean;
  readonly createdAt: number;
  readonly lastOpenedAt: number;
}

export interface Chat {
  readonly id: string;
  readonly projectPath: string;
  readonly title: string;
  readonly selectedModel: string;
  readonly branchLabel: string | undefined;
  readonly status: "open" | "closed" | undefined;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type ChatRole = "user" | "assistant" | "system";
export type WorkflowStatus = "pending" | "running" | "completed" | "failed";

export interface ChatMessage {
  readonly id: string;
  readonly chatId: string;
  readonly role: ChatRole;
  readonly content: string;
  readonly timestamp: number;
  readonly runId: string | undefined;
  readonly workflowId: string | undefined;
  readonly workflowStatus: WorkflowStatus | undefined;
  readonly shortResult: string | undefined;
}

export interface CreateChatOptions {
  readonly branchLabel?: string;
}

export interface UpdateProjectPatch {
  readonly name?: string;
  readonly favorite?: boolean;
}

export interface UpdateChatPatch {
  readonly title?: string;
  readonly selectedModel?: string;
  readonly branchLabel?: string;
  readonly status?: "open" | "closed";
}

export interface NewChatMessage {
  readonly chatId: string;
  readonly role: ChatRole;
  readonly content: string;
  readonly timestamp: number;
  readonly runId: string | undefined;
  readonly workflowId: string | undefined;
  readonly workflowStatus: WorkflowStatus | undefined;
  readonly shortResult: string | undefined;
}

export interface UiStore {
  readonly listProjects: () => readonly Project[];
  readonly createProject: (path: string, name?: string) => Project;
  readonly updateProject: (path: string, patch: UpdateProjectPatch) => Project;
  readonly deleteProject: (path: string) => void;

  readonly listChats: (projectPath: string) => readonly Chat[];
  readonly createChat: (
    projectPath: string,
    title: string,
    selectedModel: string,
    opts?: CreateChatOptions,
  ) => Chat;
  readonly updateChat: (id: string, patch: UpdateChatPatch) => Chat;
  readonly deleteChat: (id: string) => void;

  readonly listMessages: (chatId: string) => readonly ChatMessage[];
  readonly createMessage: (msg: NewChatMessage) => ChatMessage;

  readonly close: () => void;
}

// Factory options shared by the in-memory test factory and the node adapter so timestamps and
// redaction are deterministic in tests.
export interface UiStoreFactoryOptions {
  readonly now?: () => number;
  readonly newId?: () => string;
  readonly redactString?: (input: string) => string;
}
