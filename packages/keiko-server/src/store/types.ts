// ADR-0013 D4 — UiStore port and entity types. The port is the seam for testing; the concrete
// `createNodeUiStore` adapter and the `createInMemoryUiStore` test adapter both implement it.
//
// Re-export shim: wire-safe entity types live in @oscharko-dev/keiko-contracts (issue #158).
// WorkflowStatus and ChatMessage are imported from the bff-wire subpath because those names
// collide with unit-test-events.ts and gateway.ts in the main contracts index.
// verbatimModuleSyntax is on: type-only names use `export type`.

// import+export split so UiStore interface can reference these types in its own field signatures.
// Drop .js extension: the package.json exports key is ./bff-wire (no extension), NodeNext matches
// the literal specifier so the extension must match exactly.
import type {
  Project,
  Chat,
  ChatConnectedScope,
  ChatLocalKnowledgeScope,
  ChatRole,
  WorkflowStatus,
  ChatMessage,
  CreateChatOptions,
  UpdateProjectPatch,
  UpdateChatPatch,
  NewChatMessage,
  UpdateChatMessagePatch,
} from "@oscharko-dev/keiko-contracts/bff-wire";
export type {
  Project,
  Chat,
  ChatConnectedScope,
  ChatLocalKnowledgeScope,
  ChatRole,
  WorkflowStatus,
  ChatMessage,
  CreateChatOptions,
  UpdateProjectPatch,
  UpdateChatPatch,
  NewChatMessage,
  UpdateChatMessagePatch,
};

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
  readonly createMessages: (messages: readonly NewChatMessage[]) => readonly ChatMessage[];
  readonly updateMessage: (id: string, patch: UpdateChatMessagePatch) => ChatMessage;

  readonly close: () => void;
}

// Factory options shared by the in-memory test factory and the node adapter so timestamps and
// redaction are deterministic in tests.
export interface UiStoreFactoryOptions {
  readonly now?: () => number;
  readonly newId?: () => string;
  readonly redactString?: (input: string) => string;
}
