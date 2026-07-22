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
  GroundedAnswer,
  UpdateProjectPatch,
  UpdateChatPatch,
  NewChatMessage,
  UpdateChatMessagePatch,
} from "@oscharko-dev/keiko-contracts/bff-wire";
import type {
  CodingWorkbenchMode,
  StoredPdfCitationPreviewCitation,
} from "@oscharko-dev/keiko-contracts";
export type {
  Project,
  Chat,
  ChatConnectedScope,
  ChatLocalKnowledgeScope,
  ChatRole,
  WorkflowStatus,
  ChatMessage,
  CreateChatOptions,
  GroundedAnswer,
  UpdateProjectPatch,
  UpdateChatPatch,
  NewChatMessage,
  UpdateChatMessagePatch,
  StoredPdfCitationPreviewCitation,
};

export type ChatTurnAdmission =
  | { readonly kind: "admitted"; readonly userMessage: ChatMessage }
  | {
      readonly kind: "replay";
      readonly userMessage: ChatMessage;
      readonly assistantMessage: ChatMessage;
    }
  | { readonly kind: "in-progress"; readonly userMessage: ChatMessage }
  | { readonly kind: "conflict" };

export type ChatTurnInspection =
  | { readonly kind: "missing" }
  | { readonly kind: "retryable"; readonly userMessage: ChatMessage }
  | {
      readonly kind: "replay";
      readonly userMessage: ChatMessage;
      readonly assistantMessage: ChatMessage;
    }
  | { readonly kind: "in-progress"; readonly userMessage: ChatMessage }
  | { readonly kind: "conflict" };

export type ChatTurnCompletion =
  | {
      readonly kind: "completed";
      readonly userMessage: ChatMessage;
      readonly assistantMessage: ChatMessage;
    }
  | { readonly kind: "conflict" };

export interface UiStore {
  readonly listProjects: () => readonly Project[];
  readonly createProject: (path: string, name?: string) => Project;
  readonly updateProject: (path: string, patch: UpdateProjectPatch) => Project;
  readonly deleteProject: (path: string) => void;

  readonly listChats: (projectPath: string, limit?: number) => readonly Chat[];
  readonly findChatById: (id: string) => Chat | undefined;
  readonly createChat: (
    projectPath: string,
    title: string,
    selectedModel: string,
    opts?: CreateChatOptions,
  ) => Chat;
  readonly updateChat: (id: string, patch: UpdateChatPatch, options?: UpdateChatOptions) => Chat;
  readonly deleteChat: (id: string) => void;

  readonly listMessages: (chatId: string, limit?: number) => readonly ChatMessage[];
  readonly listMessagesPrefix: (chatId: string, limit: number) => readonly ChatMessage[];
  readonly countMessages: (chatId: string) => number;
  readonly findMessageById: (id: string) => ChatMessage | undefined;
  readonly createMessage: (msg: NewChatMessage) => ChatMessage;
  readonly createMessages: (messages: readonly NewChatMessage[]) => readonly ChatMessage[];
  readonly createTurnAssistant: (
    userMessageId: string,
    assistantMessage: NewChatMessage,
  ) => ChatMessage;
  readonly inspectChatTurn: (
    chatId: string,
    clientTurnId: string,
    userContent: string,
  ) => ChatTurnInspection;
  readonly admitChatTurn: (
    clientTurnId: string,
    userMessage: NewChatMessage,
    options?: { readonly identityContent: string },
  ) => ChatTurnAdmission;
  readonly completeChatTurn: (
    chatId: string,
    clientTurnId: string,
    userContent: string,
    assistantMessageId: string,
  ) => ChatTurnCompletion;
  readonly failChatTurn: (chatId: string, clientTurnId: string) => void;
  readonly updateMessage: (id: string, patch: UpdateChatMessagePatch) => ChatMessage;
  readonly attachGroundedAnswer: (
    id: string,
    answer: GroundedAnswer,
    previewCitations?: readonly StoredPdfCitationPreviewCitation[],
  ) => ChatMessage;
  readonly findGroundedPreviewCitations: (
    id: string,
  ) => readonly StoredPdfCitationPreviewCitation[] | undefined;
  readonly replaceAssistantMessageContent: (
    id: string,
    content: string,
    timestamp: number,
  ) => ChatMessage;

  readonly getMemoryAutonomyMode: () => CodingWorkbenchMode | undefined;
  readonly setMemoryAutonomyMode: (mode: CodingWorkbenchMode) => void;

  readonly close: () => void;
}

export interface UpdateChatOptions {
  readonly maxConnectedSources?: number;
  readonly maxLocalKnowledgeSources?: number;
}

// Factory options shared by the in-memory test factory and the node adapter so timestamps and
// redaction are deterministic in tests.
export interface UiStoreFactoryOptions {
  readonly now?: () => number;
  readonly newId?: () => string;
  readonly redactString?: (input: string) => string;
}
