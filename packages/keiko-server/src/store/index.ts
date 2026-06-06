// ADR-0013 — UI-local SQLite persistence layer. Barrel re-exporting the public seams.

export type {
  Chat,
  ChatConnectedScope,
  ChatLocalKnowledgeScope,
  ChatMessage,
  ChatRole,
  CreateChatOptions,
  NewChatMessage,
  Project,
  UiStore,
  UiStoreFactoryOptions,
  UpdateChatMessagePatch,
  UpdateChatPatch,
  UpdateProjectPatch,
  WorkflowStatus,
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
export { runMigrations, SCHEMA_VERSION } from "./schema.js";
export {
  buildUiStoreOverDatabase,
  createInMemoryUiStore,
  createNodeUiStore,
  isProjectAvailable,
  openNodeUiDatabase,
} from "./db.js";
