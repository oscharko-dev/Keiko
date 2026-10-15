import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  MARKDOWN_SKILL_LIMITS,
  type MarkdownSkillDocument,
  type MarkdownSkillMetadata,
  type MarkdownSkillUpload,
  type MarkdownSkillReference,
  type MarkdownSkillSelection,
} from "@oscharko-dev/keiko-contracts/bff-wire";
import { UiStoreError, notFound } from "./errors.js";
import { withImmediateTransaction } from "./transaction.js";
import {
  readMarkdownSkillSelection,
  selectMarkdownSkill,
  readMarkdownSkillForTurn,
} from "./markdownSkillSelections.js";
import {
  assertMarkdownSkillIdentity,
  markdownSkillDigest,
  validateMarkdownSkillUpload,
  type ValidatedMarkdownSkill,
} from "./markdownSkillValidation.js";

export interface MarkdownSkillStore {
  readonly selection: (chatId: string) => MarkdownSkillSelection;
  readonly select: (
    chatId: string,
    skill: MarkdownSkillReference | null,
    expectedRevision: number,
  ) => MarkdownSkillSelection;
  readonly resolve: (skill: MarkdownSkillReference) => MarkdownSkillDocument;
  readonly forTurn: (messageId: string) => MarkdownSkillDocument | undefined;
  readonly list: () => readonly MarkdownSkillMetadata[];
  readonly get: (id: string, revision?: number) => MarkdownSkillDocument | undefined;
  readonly import: (input: MarkdownSkillUpload) => MarkdownSkillDocument;
  readonly replace: (
    id: string,
    expectedRevision: number,
    input: MarkdownSkillUpload,
  ) => MarkdownSkillDocument;
  readonly delete: (id: string, expectedRevision: number) => void;
}

const METADATA_COLUMNS =
  "r.skill_id AS id, r.revision, r.digest, r.name, r.byte_count AS byteCount, r.created_at AS createdAt";
const LIVE_REVISIONS = "markdown_skill_revisions r JOIN markdown_skills s ON s.id = r.skill_id";

function readSkill(
  db: DatabaseSync,
  id: string,
  revision?: number,
): MarkdownSkillDocument | undefined {
  assertMarkdownSkillIdentity(id, revision);
  const condition = revision === undefined ? "r.revision = s.revision" : "r.revision = ?";
  const row = db
    .prepare(
      `SELECT ${METADATA_COLUMNS}, r.body FROM ${LIVE_REVISIONS} WHERE s.id = ? AND ${condition}`,
    )
    .get(...(revision === undefined ? [id] : [id, revision])) as MarkdownSkillDocument | undefined;
  if (row === undefined) return undefined;
  if (
    markdownSkillDigest(row.body) !== row.digest ||
    Buffer.byteLength(row.body) !== row.byteCount
  ) {
    throw new UiStoreError("INTERNAL", "Stored skill integrity check failed.", 500);
  }
  return { ...row };
}

function assertCapacity(db: DatabaseSync, byteCount: number, creating: boolean): void {
  const counts = db
    .prepare(
      `SELECT
    (SELECT COUNT(*) FROM markdown_skills) AS skills,
    COUNT(*) AS revisions, COALESCE(SUM(byte_count), 0) AS bytes
    FROM markdown_skill_revisions`,
    )
    .get() as { skills: number; revisions: number; bytes: number };
  if (
    (creating && counts.skills >= MARKDOWN_SKILL_LIMITS.skills) ||
    counts.bytes + byteCount > MARKDOWN_SKILL_LIMITS.libraryBytes ||
    counts.revisions >= MARKDOWN_SKILL_LIMITS.revisions
  ) {
    throw new UiStoreError(
      "INVALID_REQUEST",
      "Skill library is full. Delete unused skills first.",
      409,
    );
  }
}

function insertRevision(db: DatabaseSync, document: MarkdownSkillDocument): void {
  db.prepare(
    `INSERT INTO markdown_skill_revisions
    (skill_id, revision, digest, name, byte_count, created_at, body) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    document.id,
    document.revision,
    document.digest,
    document.name,
    document.byteCount,
    document.createdAt,
    document.body,
  );
}

function importSkill(
  db: DatabaseSync,
  input: ValidatedMarkdownSkill,
  now: number,
): MarkdownSkillDocument {
  const duplicate = db
    .prepare(
      `SELECT s.id FROM ${LIVE_REVISIONS}
    WHERE r.revision = s.revision AND r.digest = ? ORDER BY s.id LIMIT 1`,
    )
    .get(input.digest) as { id: string } | undefined;
  if (duplicate !== undefined) {
    const existing = readSkill(db, duplicate.id);
    if (existing !== undefined) return existing;
  }
  assertCapacity(db, input.byteCount, true);
  const document = { ...input, id: `msk_${randomUUID()}`, revision: 1, createdAt: now };
  db.prepare("INSERT INTO markdown_skills (id, revision) VALUES (?, 1)").run(document.id);
  insertRevision(db, document);
  return document;
}

function requireCurrentRevision(db: DatabaseSync, id: string, revision: number): void {
  assertMarkdownSkillIdentity(id, revision);
  const current = db.prepare("SELECT revision FROM markdown_skills WHERE id = ?").get(id);
  if (current === undefined) throw notFound("Skill");
  if (current.revision !== revision) {
    throw new UiStoreError(
      "INVALID_REQUEST",
      "Skill revision is stale. Reload before changing it.",
      409,
    );
  }
}

function replaceSkill(
  db: DatabaseSync,
  id: string,
  revision: number,
  input: ValidatedMarkdownSkill,
  now: number,
): MarkdownSkillDocument {
  requireCurrentRevision(db, id, revision);
  const current = readSkill(db, id);
  if (current === undefined) throw notFound("Skill");
  if (current.digest === input.digest) return current;
  assertCapacity(db, input.byteCount, false);
  const document = { ...input, id, revision: revision + 1, createdAt: now };
  insertRevision(db, document);
  db.prepare("UPDATE markdown_skills SET revision = ? WHERE id = ?").run(document.revision, id);
  return document;
}

export function createMarkdownSkillStore(db: DatabaseSync, now: () => number): MarkdownSkillStore {
  const resolve = (reference: MarkdownSkillReference): MarkdownSkillDocument => {
    const skill = readSkill(db, reference.id, reference.revision);
    if (skill?.digest !== reference.digest) {
      throw new UiStoreError(
        "INVALID_REQUEST",
        "Selected skill is unavailable. Select an available skill or remove it.",
        409,
      );
    }
    return skill;
  };
  return {
    selection: (chatId) => readMarkdownSkillSelection(db, chatId),
    select: (chatId, skill, revision) => selectMarkdownSkill(db, resolve, chatId, skill, revision),
    resolve,
    forTurn: (messageId) => readMarkdownSkillForTurn(db, resolve, messageId),
    list: () =>
      db
        .prepare(
          `SELECT ${METADATA_COLUMNS} FROM ${LIVE_REVISIONS}
      WHERE r.revision = s.revision ORDER BY r.created_at DESC, s.id`,
        )
        .all() as unknown as MarkdownSkillMetadata[],
    get: (id, revision) => readSkill(db, id, revision),
    import: (input): MarkdownSkillDocument => {
      const validated = validateMarkdownSkillUpload(input);
      return withImmediateTransaction(db, () => importSkill(db, validated, now()));
    },
    replace: (id, revision, input): MarkdownSkillDocument => {
      const validated = validateMarkdownSkillUpload(input);
      return withImmediateTransaction(db, () => replaceSkill(db, id, revision, validated, now()));
    },
    delete: (id, revision): void => {
      withImmediateTransaction(db, () => {
        requireCurrentRevision(db, id, revision);
        db.prepare("DELETE FROM markdown_skills WHERE id = ?").run(id);
      });
    },
  };
}
