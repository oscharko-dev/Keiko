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
  StoredPdfCitationPreviewCitation,
  WorkspaceManifest,
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

  // Canonical workspace-trust persistence (issue #2521, ADR-0145 D3/D8). The store persists opaque,
  // content-free rows; all trust semantics (derivation, validation, projection) live above the port.
  readonly readWorkspaceTrustRecord: (rootRef: string) => WorkspaceTrustRecordRow | undefined;
  readonly writeWorkspaceTrustRecord: (row: WorkspaceTrustRecordRowInput) => void;
  readonly pruneWorkspaceTrustRecords: (max: number) => void;

  // M11 multi-root workspace manifests (issue #2524, ADR-0145 D1/D8). The projects table remains
  // the root registry; these methods persist ordered membership and atomically invalidate trust.
  readonly listWorkspaceManifestRecords: () => readonly WorkspaceManifestRecordRow[];
  readonly readWorkspaceManifestRecord: (
    workspaceId: string,
  ) => WorkspaceManifestRecordRow | undefined;
  readonly findWorkspaceManifestRecordByRoot: (
    rootRef: string,
  ) => WorkspaceManifestRecordRow | undefined;
  readonly findWorkspaceManifestRecordByProject: (
    projectPath: string,
  ) => WorkspaceManifestRecordRow | undefined;
  readonly replaceWorkspaceManifest: (input: WorkspaceManifestMutationInput) => boolean;

  readonly close: () => void;
}

// A persisted workspace-trust row. `recordJson` is the authoritative, contract-validated
// WorkspaceTrustRecord payload; `trust`/`revision` are denormalized for monotonic revision reads and
// deterministic bounded pruning. All fields are content-free (opaque reference, closed enum,
// revision, digest-bearing JSON — never paths or manifest bytes).
export interface WorkspaceTrustRecordRow {
  readonly rootRef: string;
  readonly revision: number;
  readonly trust: string;
  readonly recordJson: string;
  readonly updatedAt: number;
}

export interface WorkspaceTrustRecordRowInput {
  readonly rootRef: string;
  readonly revision: number;
  readonly trust: "trusted" | "restricted";
  readonly recordJson: string;
}

export interface WorkspaceManifestRecordRow {
  readonly workspaceId: string;
  readonly schemaVersion: number;
  readonly manifestRef: string;
  readonly revision: number;
  readonly manifestDigest: string;
  readonly recordJson: string;
  readonly updatedAt: number;
  readonly rootProjects: readonly WorkspaceManifestRootProject[];
}

export interface WorkspaceManifestMutationInput {
  readonly manifest: WorkspaceManifest;
  readonly expectedRevision: number;
  readonly absorbedWorkspaceIds: readonly string[];
  readonly rootProjects: readonly WorkspaceManifestRootProject[];
}

export interface WorkspaceManifestRootProject {
  readonly rootRef: string;
  readonly projectPath: string;
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
