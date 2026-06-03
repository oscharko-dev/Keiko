// Wire-safe entity types for the BFF (Back-For-Frontend) layer (ADR-0013 D4). These types
// travel over the HTTP wire between the BFF and the React UI. The DI port interfaces
// (UiStore, UiStoreFactoryOptions) remain in src/ui/store/types.ts to avoid a contracts→ui
// circular dependency.

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
export type WorkflowStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

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
  readonly taskType: string | undefined;
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
  readonly taskType: string | undefined;
}

// Issue #66 — partial PATCH for a run-summary system message. Every field is independently
// optional; an empty patch is an error (the route returns INVALID_REQUEST). The store re-runs
// the same redact-then-truncate pipeline as createMessage when shortResult is present.
export interface UpdateChatMessagePatch {
  readonly workflowStatus?: WorkflowStatus;
  readonly shortResult?: string;
  readonly taskType?: string;
}
