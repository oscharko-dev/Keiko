// ADR-0013 D3/D8/D9 — DB lifecycle, factories, and the public UiStore wiring. The synchronous
// `node:sqlite` DatabaseSync drives both factories; the node adapter adds directory creation,
// 0o700/0o600 permission hardening (Unix), and reopen-safe migrations.

import { DatabaseSync } from "node:sqlite";
import { existsSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  MAX_DESKTOP_CHAT_CLIENT_TURN_ID_CHARS,
  canonicalDesktopChatTurnReferenceSeed,
} from "@oscharko-dev/keiko-contracts/bff-wire";
// Shared fs-hardening owner [GEN-MAINT-COUPLING-005]: the single 0o700/0o600 hardening pair.
import {
  chmodIfPresent,
  ensureDirHardened,
  FILE_MODE,
} from "@oscharko-dev/keiko-security/fs-hardening";
// Shared SQLite corruption classifier [GEN-DUP-SEMANTIC-019]: the pure classification vocabulary.
import {
  SqliteQuickCheckError,
  errorRecord,
  isSqliteCorruptionError,
} from "@oscharko-dev/keiko-security/sqlite-corruption";
import type {
  Chat,
  ChatMessage,
  ChatTurnAdmission,
  ChatTurnCompletion,
  ChatTurnInspection,
  CreateChatOptions,
  NewChatMessage,
  Project,
  StoredPdfCitationPreviewCitation,
  UiStore,
  UiStoreFactoryOptions,
  UpdateChatOptions,
  UpdateChatMessagePatch,
  UpdateChatPatch,
  UpdateProjectPatch,
  WorkspaceManifestMutationInput,
  WorkspaceManifestRecordRow,
  WorkspaceTrustRecordRow,
  WorkspaceTrustRecordRowInput,
} from "./types.js";
import { runMigrations } from "./schema.js";
import {
  deleteProject as sqlDeleteProject,
  getProject as sqlGetProject,
  listProjects as sqlListProjects,
  updateProject as sqlUpdateProject,
  upsertProject as sqlUpsertProject,
} from "./projects.js";
import {
  deleteChat as sqlDeleteChat,
  findChatById as sqlFindChatById,
  insertChat as sqlInsertChat,
  listChats as sqlListChats,
  listChatsLimited as sqlListChatsLimited,
  touchChat as sqlTouchChat,
  updateChat as sqlUpdateChat,
} from "./chats.js";
import {
  type ClientTurnRecord,
  countMessages as sqlCountMessages,
  findClientTurn as sqlFindClientTurn,
  findClientTurnOwner as sqlFindClientTurnOwner,
  findMessageById as sqlFindMessageById,
  attachGroundedAnswer as sqlAttachGroundedAnswer,
  findGroundedPreviewCitations as sqlFindGroundedPreviewCitations,
  discardLegacyTurnUserMessage as sqlDiscardLegacyTurnUserMessage,
  insertMessage as sqlInsertMessage,
  isLatestChatMessage as sqlIsLatestChatMessage,
  listMessages as sqlListMessages,
  listGatewayMessagesLimited as sqlListGatewayMessagesLimited,
  listMessagesLimited as sqlListMessagesLimited,
  listMessagesPrefixLimited as sqlListMessagesPrefixLimited,
  linkAssistantToClientTurn as sqlLinkAssistantToClientTurn,
  markClientTurnState as sqlMarkClientTurnState,
  recoverInterruptedClientTurns as sqlRecoverInterruptedClientTurns,
  createAssistantResponseVersion as sqlCreateAssistantResponseVersion,
  updateMessage as sqlUpdateMessage,
  validateMessage as sqlValidateMessage,
} from "./messages.js";
import {
  pruneWorkspaceTrustRecords as sqlPruneWorkspaceTrustRecords,
  readWorkspaceTrustRecord as sqlReadWorkspaceTrustRecord,
  writeWorkspaceTrustRecord as sqlWriteWorkspaceTrustRecord,
} from "./workspaceTrust.js";
import {
  deleteSingletonWorkspaceManifestForProject,
  ensureProjectWorkspaceManifest,
  findWorkspaceManifestRecordByProject as sqlFindWorkspaceManifestRecordByProject,
  findWorkspaceManifestRecordByRoot as sqlFindWorkspaceManifestRecordByRoot,
  listWorkspaceManifestRecords as sqlListWorkspaceManifestRecords,
  readWorkspaceManifestRecord as sqlReadWorkspaceManifestRecord,
  replaceWorkspaceManifest as sqlReplaceWorkspaceManifest,
  workspaceManifestRootCountForProject,
} from "./workspaceManifests.js";
import { validateProjectPath } from "./validation.js";
import {
  readMemoryAutonomyPolicy as sqlReadMemoryAutonomyPolicy,
  updateMemoryAutonomyPolicy as sqlUpdateMemoryAutonomyPolicy,
} from "./memory-autonomy-policy.js";
import { invalidRequest } from "./errors.js";

const DEFAULT_REDACT = (s: string): string => s;

// Returns whether a project's directory currently exists and is a directory. Derived availability
// (ADR-0013 D5): the store never deletes a row because the path went missing; the UI surfaces this.
export function isProjectAvailable(project: { readonly path: string }): boolean {
  try {
    return statSync(project.path).isDirectory();
  } catch {
    return false;
  }
}

interface ResolvedFactoryOptions {
  readonly now: () => number;
  readonly newId: () => string;
  readonly redactString: (s: string) => string;
}

function resolveOptions(opts: UiStoreFactoryOptions | undefined): ResolvedFactoryOptions {
  return {
    now: opts?.now ?? ((): number => Date.now()),
    newId: opts?.newId ?? randomUUID,
    redactString: opts?.redactString ?? DEFAULT_REDACT,
  };
}

function deriveProjectName(explicit: string | undefined, path: string): string {
  if (explicit === undefined) return basename(path);
  if (explicit.length === 0) throw invalidRequest("Name must not be empty.");
  return explicit;
}

function createChatRecord(
  db: DatabaseSync,
  options: ResolvedFactoryOptions,
  projectPath: string,
  title: string,
  selectedModel: string,
  opts: CreateChatOptions | undefined,
): Chat {
  const project = sqlGetProject(db, projectPath);
  if (project !== undefined && !isProjectAvailable(project)) {
    throw invalidRequest("Project path is unavailable.");
  }
  return sqlInsertChat(db, {
    id: options.newId(),
    projectPath,
    title,
    selectedModel,
    opts,
    now: options.now(),
  });
}

function createMessageRecord(
  db: DatabaseSync,
  options: ResolvedFactoryOptions,
  msg: NewChatMessage,
  clientTurnId?: string,
  clientTurnState?: "pending",
  messageId = options.newId(),
  clientTurnContentDigest?: string,
): ChatMessage {
  return sqlInsertMessage(
    db,
    messageId,
    msg,
    options.redactString,
    clientTurnId,
    clientTurnState,
    clientTurnContentDigest,
  );
}

interface StagedTurnAssistant {
  readonly clientTurnId: string;
  readonly userMessageId: string;
  readonly message: ChatMessage;
  readonly draft: NewChatMessage;
  readonly previewCitations?: readonly StoredPdfCitationPreviewCitation[] | undefined;
}

type StagedTurnAssistants = Map<string, StagedTurnAssistant>;

function stagedMessage(id: string, draft: NewChatMessage): ChatMessage {
  return {
    id,
    chatId: draft.chatId,
    role: draft.role,
    content: draft.content,
    timestamp: draft.timestamp,
    runId: draft.runId,
    workflowId: draft.workflowId,
    workflowStatus: draft.workflowStatus,
    shortResult: draft.shortResult,
    taskType: draft.taskType,
    ...(draft.groundedAnswer === undefined ? {} : { groundedAnswer: draft.groundedAnswer }),
  };
}

function createTurnAssistantRecord(
  db: DatabaseSync,
  options: ResolvedFactoryOptions,
  staged: StagedTurnAssistants,
  userMessageId: string,
  draft: NewChatMessage,
): ChatMessage {
  sqlValidateMessage(draft);
  if (draft.role !== "assistant") {
    throw invalidRequest("Canonical chat turn completion requires assistant role.");
  }
  const owner = sqlFindClientTurnOwner(db, userMessageId);
  if (owner === undefined) return createMessageRecord(db, options, draft);
  if (owner.state !== "pending" || owner.userMessage.chatId !== draft.chatId) {
    throw invalidRequest("Canonical assistant does not match the admitted chat turn.");
  }
  const id = options.newId();
  const message = stagedMessage(id, draft);
  staged.set(id, {
    clientTurnId: owner.clientTurnId,
    userMessageId,
    message,
    draft,
  });
  return message;
}

function createProjectRecord(
  db: DatabaseSync,
  options: ResolvedFactoryOptions,
  path: string,
  name?: string,
): Project {
  const normalized = validateProjectPath(path, { mustExist: true });
  const resolvedName = deriveProjectName(name, normalized);
  const now = options.now();
  db.exec("BEGIN IMMEDIATE");
  try {
    const project = sqlUpsertProject(db, normalized, resolvedName, name !== undefined, now);
    ensureProjectWorkspaceManifest(db, project.path, project.name, now);
    db.exec("COMMIT");
    return project;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function reconnectProjectRecord(
  db: DatabaseSync,
  options: ResolvedFactoryOptions,
  path: string,
): Project {
  const normalized = validateProjectPath(path, { mustExist: false });
  const now = options.now();
  db.exec("BEGIN IMMEDIATE");
  try {
    const project = sqlUpdateProject(db, normalized, {}, now);
    validateProjectPath(project.path, { mustExist: true });
    ensureProjectWorkspaceManifest(db, project.path, project.name, now);
    db.exec("COMMIT");
    return project;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function updateProjectRecord(
  db: DatabaseSync,
  options: ResolvedFactoryOptions,
  path: string,
  patch: UpdateProjectPatch,
): Project {
  const normalized = validateProjectPath(path, { mustExist: false });
  return sqlUpdateProject(db, normalized, patch, options.now());
}

function deleteProjectRecord(db: DatabaseSync, path: string): void {
  const normalized = validateProjectPath(path, { mustExist: false });
  const rootCount = workspaceManifestRootCountForProject(db, normalized);
  if (rootCount !== undefined && rootCount > 1) {
    throw invalidRequest("Project is bound to a multi-root workspace.");
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    deleteSingletonWorkspaceManifestForProject(db, normalized);
    sqlDeleteProject(db, normalized);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function validateClientTurnId(clientTurnId: string): void {
  // Keep the opaque retry identity byte-exact; trimming is validation-only and never changes the
  // persisted hash input or aliases two caller-provided identifiers.
  if (
    clientTurnId.length > MAX_DESKTOP_CHAT_CLIENT_TURN_ID_CHARS ||
    clientTurnId.trim().length === 0
  ) {
    throw invalidRequest("Invalid clientTurnId.");
  }
}

function storedClientTurnId(chatId: string, clientTurnId: string): string {
  return createHash("sha256")
    .update(canonicalDesktopChatTurnReferenceSeed(chatId, clientTurnId), "utf8")
    .digest("hex");
}

function storedClientTurnContentDigest(
  chatId: string,
  clientTurnId: string,
  content: string,
): string {
  return createHash("sha256")
    .update(JSON.stringify([chatId, clientTurnId, content]), "utf8")
    .digest("hex");
}

function clientTurnContentMatches(
  turn: ClientTurnRecord,
  expectedDigest: string,
  legacyContent: string,
): boolean {
  return turn.contentDigest === undefined
    ? turn.userMessage?.content === legacyContent
    : turn.contentDigest === expectedDigest;
}

function withImmediateTransaction<T>(db: DatabaseSync, operation: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function existingTurnAdmission(
  db: DatabaseSync,
  chatId: string,
  clientTurnId: string,
  userContent: string,
  contentDigest: string,
): ChatTurnAdmission | undefined {
  const turn = sqlFindClientTurn(db, chatId, clientTurnId);
  const user = turn.userMessage;
  if (user === undefined) return undefined;
  if (!clientTurnContentMatches(turn, contentDigest, userContent) || turn.state === undefined) {
    return { kind: "conflict" };
  }
  if (turn.state === "completed" && turn.assistantMessage !== undefined) {
    return { kind: "replay", userMessage: user, assistantMessage: turn.assistantMessage };
  }
  if (turn.state === "failed" || turn.state === "cancelled") {
    if (!sqlIsLatestChatMessage(db, chatId, user.id)) return { kind: "conflict" };
    if (!sqlMarkClientTurnState(db, chatId, clientTurnId, turn.state, "pending")) {
      return { kind: "in-progress", userMessage: user };
    }
    return { kind: "admitted", userMessage: user };
  }
  return { kind: "in-progress", userMessage: user };
}

function inspectChatTurnRecord(
  db: DatabaseSync,
  chatId: string,
  clientTurnId: string,
  userContent: string,
): ChatTurnInspection {
  validateClientTurnId(clientTurnId);
  const storedTurnId = storedClientTurnId(chatId, clientTurnId);
  const turn = sqlFindClientTurn(db, chatId, storedTurnId);
  const user = turn.userMessage;
  if (user === undefined) return { kind: "missing" };
  const contentDigest = storedClientTurnContentDigest(chatId, clientTurnId, userContent);
  if (!clientTurnContentMatches(turn, contentDigest, userContent) || turn.state === undefined) {
    return { kind: "conflict" };
  }
  if (turn.state === "completed") {
    return turn.assistantMessage === undefined
      ? { kind: "conflict" }
      : { kind: "replay", userMessage: user, assistantMessage: turn.assistantMessage };
  }
  if (turn.state === "failed" || turn.state === "cancelled") {
    return sqlIsLatestChatMessage(db, chatId, user.id)
      ? { kind: "retryable", userMessage: user }
      : { kind: "conflict" };
  }
  return { kind: "in-progress", userMessage: user };
}

function admitChatTurnRecord(
  db: DatabaseSync,
  options: ResolvedFactoryOptions,
  clientTurnId: string,
  userMessage: NewChatMessage,
  admissionOptions?: { readonly identityContent: string },
): ChatTurnAdmission {
  validateClientTurnId(clientTurnId);
  if (userMessage.role !== "user") throw invalidRequest("Chat turn admission requires user role.");
  const storedTurnId = storedClientTurnId(userMessage.chatId, clientTurnId);
  const identityContent = admissionOptions?.identityContent ?? userMessage.content;
  const contentDigest = storedClientTurnContentDigest(
    userMessage.chatId,
    clientTurnId,
    identityContent,
  );
  return withImmediateTransaction(db, () => {
    const existing = existingTurnAdmission(
      db,
      userMessage.chatId,
      storedTurnId,
      identityContent,
      contentDigest,
    );
    if (existing !== undefined) return existing;
    const admitted = createMessageRecord(
      db,
      options,
      userMessage,
      storedTurnId,
      "pending",
      undefined,
      contentDigest,
    );
    sqlTouchChat(db, userMessage.chatId, options.now());
    return { kind: "admitted", userMessage: admitted };
  });
}

interface ChatTurnCommitPlan {
  readonly kind: "commit";
  readonly userMessage: ChatMessage;
  readonly pendingAssistant: StagedTurnAssistant;
}

function stagedAssistantMatchesTurn(
  pending: StagedTurnAssistant | undefined,
  storedTurnId: string,
  userMessageId: string,
  chatId: string,
): pending is StagedTurnAssistant {
  return (
    pending?.clientTurnId === storedTurnId &&
    pending.userMessageId === userMessageId &&
    pending.draft.chatId === chatId
  );
}

function planChatTurnCompletion(
  turn: ClientTurnRecord,
  staged: StagedTurnAssistants,
  storedTurnId: string,
  chatId: string,
  userContent: string,
  contentDigest: string,
  assistantMessageId: string,
): ChatTurnCompletion | ChatTurnCommitPlan {
  const user = turn.userMessage;
  if (user === undefined) return { kind: "conflict" };
  if (!clientTurnContentMatches(turn, contentDigest, userContent)) return { kind: "conflict" };
  if (turn.assistantMessage !== undefined) {
    return turn.state === "completed" && turn.assistantMessage.id === assistantMessageId
      ? { kind: "completed", userMessage: user, assistantMessage: turn.assistantMessage }
      : { kind: "conflict" };
  }
  const pending = staged.get(assistantMessageId);
  return turn.state === "pending" &&
    stagedAssistantMatchesTurn(pending, storedTurnId, user.id, chatId)
    ? { kind: "commit", userMessage: user, pendingAssistant: pending }
    : { kind: "conflict" };
}

function persistStagedAssistant(
  db: DatabaseSync,
  options: ResolvedFactoryOptions,
  assistantMessageId: string,
  pending: StagedTurnAssistant,
): ChatMessage {
  const assistant = createMessageRecord(
    db,
    options,
    pending.draft,
    undefined,
    undefined,
    assistantMessageId,
  );
  return pending.previewCitations !== undefined && pending.draft.groundedAnswer !== undefined
    ? sqlAttachGroundedAnswer(
        db,
        assistantMessageId,
        pending.draft.groundedAnswer,
        pending.previewCitations,
        options.redactString,
      )
    : assistant;
}

function completeChatTurnRecord(
  db: DatabaseSync,
  options: ResolvedFactoryOptions,
  staged: StagedTurnAssistants,
  chatId: string,
  clientTurnId: string,
  userContent: string,
  assistantMessageId: string,
): ChatTurnCompletion {
  validateClientTurnId(clientTurnId);
  const storedTurnId = storedClientTurnId(chatId, clientTurnId);
  const contentDigest = storedClientTurnContentDigest(chatId, clientTurnId, userContent);
  const result = withImmediateTransaction<ChatTurnCompletion>(db, () => {
    const turn = sqlFindClientTurn(db, chatId, storedTurnId);
    const plan = planChatTurnCompletion(
      turn,
      staged,
      storedTurnId,
      chatId,
      userContent,
      contentDigest,
      assistantMessageId,
    );
    if (plan.kind !== "commit") return plan;
    const assistant = persistStagedAssistant(
      db,
      options,
      assistantMessageId,
      plan.pendingAssistant,
    );
    sqlLinkAssistantToClientTurn(db, chatId, assistantMessageId, storedTurnId);
    return { kind: "completed", userMessage: plan.userMessage, assistantMessage: assistant };
  });
  if (result.kind === "completed") staged.delete(assistantMessageId);
  return result;
}

function failChatTurnRecord(
  db: DatabaseSync,
  chatId: string,
  clientTurnId: string,
  terminalState: "failed" | "cancelled",
): string {
  validateClientTurnId(clientTurnId);
  const storedTurnId = storedClientTurnId(chatId, clientTurnId);
  sqlMarkClientTurnState(db, chatId, storedTurnId, "pending", terminalState);
  return storedTurnId;
}

function attachGroundedAnswerRecord(
  db: DatabaseSync,
  staged: StagedTurnAssistants,
  id: string,
  answer: Parameters<UiStore["attachGroundedAnswer"]>[1],
  previewCitations: readonly StoredPdfCitationPreviewCitation[] | undefined,
  redactString: (input: string) => string,
): ChatMessage {
  const pending = staged.get(id);
  if (pending === undefined) {
    return sqlAttachGroundedAnswer(db, id, answer, previewCitations, redactString);
  }
  const draft: NewChatMessage = { ...pending.draft, groundedAnswer: answer };
  const message = stagedMessage(id, draft);
  staged.set(id, {
    ...pending,
    message,
    draft,
    ...(previewCitations === undefined ? {} : { previewCitations }),
  });
  return message;
}

function createMessageBatch(
  db: DatabaseSync,
  options: ResolvedFactoryOptions,
  messages: readonly NewChatMessage[],
): readonly ChatMessage[] {
  if (messages.length === 0) {
    throw invalidRequest("At least one message is required.");
  }
  db.exec("BEGIN");
  try {
    const created = messages.map((msg) => createMessageRecord(db, options, msg));
    for (const chatId of new Set(messages.map((msg) => msg.chatId))) {
      sqlTouchChat(db, chatId, options.now());
    }
    db.exec("COMMIT");
    return created;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

// Flat UiStore factory: one thin arrow per store method delegating to a sql* helper. No
// branching/logic to extract; splitting the literal would only obscure the 1:1 method→helper mapping.
// eslint-disable-next-line max-lines-per-function
function buildStore(db: DatabaseSync, options: ResolvedFactoryOptions): UiStore {
  const stagedTurnAssistants: StagedTurnAssistants = new Map();
  return {
    listProjects: () => sqlListProjects(db),
    createProject: (path: string, name?: string): Project =>
      createProjectRecord(db, options, path, name),
    reconnectProject: (path: string): Project => reconnectProjectRecord(db, options, path),
    updateProject: (path: string, patch: UpdateProjectPatch): Project =>
      updateProjectRecord(db, options, path, patch),
    deleteProject: (path: string): void => {
      deleteProjectRecord(db, path);
    },
    listChats: (projectPath: string, limit?: number) =>
      limit === undefined
        ? sqlListChats(db, projectPath)
        : sqlListChatsLimited(db, projectPath, limit),
    findChatById: (id: string): Chat | undefined => sqlFindChatById(db, id),
    createChat: (
      projectPath: string,
      title: string,
      selectedModel: string,
      opts?: CreateChatOptions,
    ): Chat => createChatRecord(db, options, projectPath, title, selectedModel, opts),
    updateChat: (id: string, patch: UpdateChatPatch, updateOptions?: UpdateChatOptions): Chat =>
      sqlUpdateChat(db, id, patch, options.now(), updateOptions),
    deleteChat: (id: string): void => {
      sqlDeleteChat(db, id);
    },
    listMessages: (chatId: string, limit?: number): readonly ChatMessage[] =>
      limit === undefined ? sqlListMessages(db, chatId) : sqlListMessagesLimited(db, chatId, limit),
    listMessagesPrefix: (chatId: string, limit: number): readonly ChatMessage[] =>
      sqlListMessagesPrefixLimited(db, chatId, limit),
    listGatewayMessages: (
      chatId: string,
      currentUserMessageId: string,
      limit: number,
    ): readonly ChatMessage[] =>
      sqlListGatewayMessagesLimited(db, chatId, currentUserMessageId, limit),
    countMessages: (chatId: string): number => sqlCountMessages(db, chatId),
    findMessageById: (id: string): ChatMessage | undefined => sqlFindMessageById(db, id),
    createMessage: (msg: NewChatMessage): ChatMessage => {
      const message = createMessageRecord(db, options, msg);
      sqlTouchChat(db, msg.chatId, options.now());
      return message;
    },
    createMessages: (messages: readonly NewChatMessage[]): readonly ChatMessage[] =>
      createMessageBatch(db, options, messages),
    createTurnAssistant: (userMessageId: string, assistantMessage: NewChatMessage): ChatMessage =>
      createTurnAssistantRecord(db, options, stagedTurnAssistants, userMessageId, assistantMessage),
    inspectChatTurn: (
      chatId: string,
      clientTurnId: string,
      userContent: string,
    ): ChatTurnInspection => inspectChatTurnRecord(db, chatId, clientTurnId, userContent),
    admitChatTurn: (
      clientTurnId: string,
      userMessage: NewChatMessage,
      admissionOptions?: { readonly identityContent: string },
    ): ChatTurnAdmission =>
      admitChatTurnRecord(db, options, clientTurnId, userMessage, admissionOptions),
    completeChatTurn: (
      chatId: string,
      clientTurnId: string,
      userContent: string,
      assistantMessageId: string,
    ): ChatTurnCompletion =>
      completeChatTurnRecord(
        db,
        options,
        stagedTurnAssistants,
        chatId,
        clientTurnId,
        userContent,
        assistantMessageId,
      ),
    failChatTurn: (chatId: string, clientTurnId: string, terminalState = "failed"): void => {
      const storedTurnId = failChatTurnRecord(db, chatId, clientTurnId, terminalState);
      for (const [id, pending] of stagedTurnAssistants) {
        if (pending.clientTurnId === storedTurnId) stagedTurnAssistants.delete(id);
      }
    },
    discardLegacyTurnUserMessage: (chatId: string, id: string): void => {
      sqlDiscardLegacyTurnUserMessage(db, chatId, id);
    },
    updateMessage: (id: string, patch: UpdateChatMessagePatch): ChatMessage =>
      sqlUpdateMessage(db, id, patch, options.redactString),
    attachGroundedAnswer: (id: string, answer, previewCitations): ChatMessage =>
      attachGroundedAnswerRecord(
        db,
        stagedTurnAssistants,
        id,
        answer,
        previewCitations,
        options.redactString,
      ),
    findGroundedPreviewCitations: (id: string) => sqlFindGroundedPreviewCitations(db, id),
    createAssistantResponseVersion: (id: string, content: string, timestamp: number): ChatMessage =>
      sqlCreateAssistantResponseVersion(db, id, content, timestamp),
    readMemoryAutonomyPolicy: () => sqlReadMemoryAutonomyPolicy(db),
    updateMemoryAutonomyPolicy: (mode, expectedRevision) =>
      sqlUpdateMemoryAutonomyPolicy(db, mode, expectedRevision),
    readWorkspaceTrustRecord: (rootRef: string): WorkspaceTrustRecordRow | undefined =>
      sqlReadWorkspaceTrustRecord(db, rootRef),
    writeWorkspaceTrustRecord: (row: WorkspaceTrustRecordRowInput): void => {
      sqlWriteWorkspaceTrustRecord(db, row, options.now());
    },
    pruneWorkspaceTrustRecords: (max: number): void => {
      sqlPruneWorkspaceTrustRecords(db, max);
    },
    listWorkspaceManifestRecords: (): readonly WorkspaceManifestRecordRow[] =>
      sqlListWorkspaceManifestRecords(db),
    readWorkspaceManifestRecord: (workspaceId: string): WorkspaceManifestRecordRow | undefined =>
      sqlReadWorkspaceManifestRecord(db, workspaceId),
    findWorkspaceManifestRecordByRoot: (rootRef: string): WorkspaceManifestRecordRow | undefined =>
      sqlFindWorkspaceManifestRecordByRoot(db, rootRef),
    findWorkspaceManifestRecordByProject: (
      projectPath: string,
    ): WorkspaceManifestRecordRow | undefined =>
      sqlFindWorkspaceManifestRecordByProject(db, projectPath),
    replaceWorkspaceManifest: (input: WorkspaceManifestMutationInput): boolean =>
      sqlReplaceWorkspaceManifest(db, input, options.now()),
    close: (): void => {
      db.close();
    },
  };
}

function assertQuickCheckOk(db: DatabaseSync): void {
  const rows = db.prepare("PRAGMA quick_check").all() as readonly Record<string, unknown>[];
  const values = rows
    .map((row) => Object.values(row)[0])
    .filter((value): value is string => typeof value === "string");
  if (values.length === 1 && values[0] === "ok") return;
  throw new SqliteQuickCheckError(values.length > 0 ? values : ["no quick_check rows returned"]);
}

function quarantineCorruptDb(target: string, cause?: unknown): void {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const quarantinedPath = `${target}.corrupt.${ts}`;
  renameSync(target, quarantinedPath);
  const sidecarQuarantinePaths: string[] = [];
  for (const sidecar of [`${target}-wal`, `${target}-shm`]) {
    if (existsSync(sidecar)) {
      const sidecarQuarantinePath = `${sidecar}.corrupt.${ts}`;
      renameSync(sidecar, sidecarQuarantinePath);
      sidecarQuarantinePaths.push(sidecarQuarantinePath);
    }
  }
  writeFileSync(
    `${quarantinedPath}.diagnostic.json`,
    `${JSON.stringify(
      {
        incidentId: randomUUID(),
        store: "ui-db",
        timestamp: new Date().toISOString(),
        dbPath: target,
        quarantinedPath,
        sidecarQuarantinePaths,
        cause: errorRecord(cause ?? new Error("manual quarantine")),
      },
      null,
      2,
    )}\n`,
    { mode: FILE_MODE },
  );
}

// Issue #639 — bound the SQLITE_BUSY window so concurrent UI/BFF writers (chat writes,
// relationship writes, evidence-adjacent updates) wait for the writer lock for a short, bounded
// interval instead of failing immediately. 5_000ms matches the conservative default we want for
// the local single-writer desktop pattern; exported so the regression test can assert the value
// without re-deriving it.
export const UI_DB_BUSY_TIMEOUT_MS = 5_000;

function preparedDatabase(target: string): DatabaseSync {
  const db = new DatabaseSync(target);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`PRAGMA busy_timeout = ${String(UI_DB_BUSY_TIMEOUT_MS)}`);
  return db;
}

// ────────────────────────────────────────────────────────────────────────────
// In-memory factory (tests)
// ────────────────────────────────────────────────────────────────────────────

export function createInMemoryUiStore(opts?: UiStoreFactoryOptions): UiStore {
  const db = preparedDatabase(":memory:");
  runMigrations(db);
  return buildStore(db, resolveOptions(opts));
}

// ────────────────────────────────────────────────────────────────────────────
// Node on-disk factory
// ────────────────────────────────────────────────────────────────────────────

// Issue #539: deps.ts needs the raw DatabaseSync to compose the relationship-engine store on
// the same UI database file. The relationship V5 schema lives in this DB (schema.ts §V5);
// keeping a single connection avoids WAL-coordination overhead. `createNodeUiStore` stays a
// one-shot convenience for callers that do not need the underlying handle.
export function openNodeUiDatabase(dbPath: string): DatabaseSync {
  ensureDirHardened(dirname(dbPath));
  let db = preparedDatabase(dbPath);
  try {
    db.exec("PRAGMA journal_mode = WAL");
    assertQuickCheckOk(db);
    runMigrations(db);
    sqlRecoverInterruptedClientTurns(db);
  } catch (error) {
    db.close();
    if (!isSqliteCorruptionError(error)) {
      throw error;
    }
    quarantineCorruptDb(dbPath, error);
    db = preparedDatabase(dbPath);
    db.exec("PRAGMA journal_mode = WAL");
    assertQuickCheckOk(db);
    runMigrations(db);
    sqlRecoverInterruptedClientTurns(db);
  }
  chmodIfPresent(dbPath, FILE_MODE);
  chmodIfPresent(`${dbPath}-wal`, FILE_MODE);
  chmodIfPresent(`${dbPath}-shm`, FILE_MODE);
  return db;
}

export function buildUiStoreOverDatabase(db: DatabaseSync, opts?: UiStoreFactoryOptions): UiStore {
  return buildStore(db, resolveOptions(opts));
}

export function createNodeUiStore(dbPath: string, opts?: UiStoreFactoryOptions): UiStore {
  return buildUiStoreOverDatabase(openNodeUiDatabase(dbPath), opts);
}
