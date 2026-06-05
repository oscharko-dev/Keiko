// ADR-0013 D3/D8/D9 — DB lifecycle, factories, and the public UiStore wiring. The synchronous
// `node:sqlite` DatabaseSync drives both factories; the node adapter adds directory creation,
// 0o700/0o600 permission hardening (Unix), and reopen-safe migrations.

import { DatabaseSync } from "node:sqlite";
import { chmodSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  Chat,
  ChatMessage,
  CreateChatOptions,
  NewChatMessage,
  Project,
  UiStore,
  UiStoreFactoryOptions,
  UpdateChatMessagePatch,
  UpdateChatPatch,
  UpdateProjectPatch,
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
  touchChat as sqlTouchChat,
  updateChat as sqlUpdateChat,
} from "./chats.js";
import {
  insertMessage as sqlInsertMessage,
  listMessages as sqlListMessages,
  updateMessage as sqlUpdateMessage,
} from "./messages.js";
import { validateProjectPath } from "./validation.js";
import { basename } from "node:path";
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
): ChatMessage {
  return sqlInsertMessage(db, options.newId(), msg, options.redactString);
}

function createProjectRecord(
  db: DatabaseSync,
  options: ResolvedFactoryOptions,
  path: string,
  name?: string,
): Project {
  const normalized = validateProjectPath(path, { mustExist: true });
  const resolvedName = deriveProjectName(name, normalized);
  return sqlUpsertProject(db, normalized, resolvedName, name !== undefined, options.now());
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
  sqlDeleteProject(db, normalized);
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

function buildStore(db: DatabaseSync, options: ResolvedFactoryOptions): UiStore {
  return {
    listProjects: () => sqlListProjects(db),
    createProject: (path: string, name?: string): Project =>
      createProjectRecord(db, options, path, name),
    updateProject: (path: string, patch: UpdateProjectPatch): Project =>
      updateProjectRecord(db, options, path, patch),
    deleteProject: (path: string): void => {
      deleteProjectRecord(db, path);
    },
    listChats: (projectPath: string) => sqlListChats(db, projectPath),
    findChatById: (id: string): Chat | undefined => sqlFindChatById(db, id),
    createChat: (
      projectPath: string,
      title: string,
      selectedModel: string,
      opts?: CreateChatOptions,
    ): Chat => createChatRecord(db, options, projectPath, title, selectedModel, opts),
    updateChat: (id: string, patch: UpdateChatPatch): Chat =>
      sqlUpdateChat(db, id, patch, options.now()),
    deleteChat: (id: string): void => {
      sqlDeleteChat(db, id);
    },
    listMessages: (chatId: string): readonly ChatMessage[] => sqlListMessages(db, chatId),
    createMessage: (msg: NewChatMessage): ChatMessage => {
      const message = createMessageRecord(db, options, msg);
      sqlTouchChat(db, msg.chatId, options.now());
      return message;
    },
    createMessages: (messages: readonly NewChatMessage[]): readonly ChatMessage[] =>
      createMessageBatch(db, options, messages),
    updateMessage: (id: string, patch: UpdateChatMessagePatch): ChatMessage =>
      sqlUpdateMessage(db, id, patch, options.redactString),
    close: (): void => {
      db.close();
    },
  };
}

function quarantineCorruptDb(target: string): void {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  renameSync(target, `${target}.corrupt.${ts}`);
  for (const sidecar of [`${target}-wal`, `${target}-shm`]) {
    if (existsSync(sidecar)) {
      renameSync(sidecar, `${sidecar}.corrupt.${ts}`);
    }
  }
}

function preparedDatabase(target: string): DatabaseSync {
  const db = new DatabaseSync(target);
  db.exec("PRAGMA foreign_keys = ON");
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

function ensureDirHardened(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  if (process.platform !== "win32") {
    try {
      chmodSync(dir, 0o700);
    } catch {
      // best-effort; leave existing perms if owner change is unavailable
    }
  }
}

function chmodIfPresent(path: string, mode: number): void {
  if (process.platform === "win32") return;
  try {
    chmodSync(path, mode);
  } catch {
    // file may not exist yet (WAL/-shm sidecars); best-effort
  }
}

export function createNodeUiStore(dbPath: string, opts?: UiStoreFactoryOptions): UiStore {
  ensureDirHardened(dirname(dbPath));
  let db = preparedDatabase(dbPath);
  try {
    db.exec("PRAGMA journal_mode = WAL");
    runMigrations(db);
  } catch {
    // Corrupt DB: quarantine (rename to .corrupt.<iso>) and open a fresh one.
    db.close();
    quarantineCorruptDb(dbPath);
    db = preparedDatabase(dbPath);
    db.exec("PRAGMA journal_mode = WAL");
    runMigrations(db);
  }
  chmodIfPresent(dbPath, 0o600);
  chmodIfPresent(`${dbPath}-wal`, 0o600);
  chmodIfPresent(`${dbPath}-shm`, 0o600);
  return buildStore(db, resolveOptions(opts));
}
