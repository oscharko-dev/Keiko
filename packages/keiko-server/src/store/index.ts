// ADR-0013 — UI-local SQLite persistence layer. Barrel re-exporting the public seams.

export type {
  Chat,
  ChatConnectedScope,
  ChatLocalKnowledgeScope,
  ChatMessage,
  ChatRole,
  ChatTurnAdmission,
  ChatTurnCompletion,
  ChatTurnInspection,
  CreateChatOptions,
  GroundedAnswer,
  MemoryAutonomyPolicyRecord,
  NewChatMessage,
  Project,
  UiStore,
  UiStoreFactoryOptions,
  UpdateChatOptions,
  UpdateChatMessagePatch,
  UpdateChatPatch,
  UpdateProjectPatch,
  WorkflowStatus,
  WorkspaceManifestMutationInput,
  WorkspaceManifestRecordRow,
  WorkspaceManifestRootProject,
  WorkspaceTrustRecordRow,
  WorkspaceTrustRecordRowInput,
} from "./types.js";
export {
  UiStoreError,
  type UiStoreErrorCode,
  invalidPath,
  invalidRequest,
  notFound,
  pathNotDirectory,
  pathNotFound,
  projectExists,
} from "./errors.js";
export {
  classifyPathShape,
  validateProjectPath,
  type PathShape,
  type ValidateProjectPathOptions,
} from "./validation.js";
export {
  assertUiDbOutsideProject,
  resolveUiDbPath,
  UI_DB_FILENAME,
  UI_DB_DIRNAME,
} from "./paths.js";
export { runMigrations, SCHEMA_VERSION, UiStoreSchemaVersionError } from "./schema.js";
export {
  buildUiStoreOverDatabase,
  createInMemoryUiStore,
  createNodeUiStore,
  isProjectAvailable,
  openNodeUiDatabase,
  UI_DB_BUSY_TIMEOUT_MS,
} from "./db.js";
