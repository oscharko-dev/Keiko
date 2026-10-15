import type { DatabaseSync } from "node:sqlite";
import type {
  MarkdownSkillDocument,
  MarkdownSkillReference,
  MarkdownSkillSelection,
} from "@oscharko-dev/keiko-contracts/bff-wire";
import { invalidRequest, notFound, UiStoreError } from "./errors.js";
import { withImmediateTransaction } from "./transaction.js";

type ResolveSkill = (reference: MarkdownSkillReference) => MarkdownSkillDocument;
interface SelectionRow {
  readonly revision: number;
  readonly skill_id: string | null;
  readonly skill_revision: number | null;
  readonly digest: string | null;
}
function reference(row: SelectionRow): MarkdownSkillReference | null {
  if (row.skill_id === null && row.skill_revision === null && row.digest === null) return null;
  if (row.skill_id === null || row.skill_revision === null || row.digest === null) {
    throw new UiStoreError("INTERNAL", "Stored skill selection is invalid.", 500);
  }
  return { id: row.skill_id, revision: row.skill_revision, digest: row.digest };
}

export function readMarkdownSkillSelection(
  db: DatabaseSync,
  chatId: string,
): MarkdownSkillSelection {
  if (db.prepare("SELECT 1 FROM chats WHERE id = ?").get(chatId) === undefined)
    throw notFound("Chat");
  const row = db
    .prepare("SELECT * FROM markdown_skill_selections WHERE chat_id = ?")
    .get(chatId) as SelectionRow | undefined;
  return row === undefined
    ? { revision: 0, skill: null }
    : { revision: row.revision, skill: reference(row) };
}

export function selectMarkdownSkill(
  db: DatabaseSync,
  resolve: ResolveSkill,
  chatId: string,
  skill: MarkdownSkillReference | null,
  expectedRevision: number,
): MarkdownSkillSelection {
  if (
    !Number.isSafeInteger(expectedRevision) ||
    expectedRevision < 0 ||
    expectedRevision >= Number.MAX_SAFE_INTEGER
  )
    throw invalidRequest("Invalid selection revision.");
  return withImmediateTransaction(db, () => {
    const current = readMarkdownSkillSelection(db, chatId);
    if (current.revision !== expectedRevision)
      throw new UiStoreError(
        "INVALID_REQUEST",
        "Skill selection is stale. Reload before changing it.",
        409,
      );
    const canonical = skill === null ? null : resolve(skill);
    const revision = current.revision + 1;
    db.prepare(
      `INSERT INTO markdown_skill_selections (chat_id, revision, skill_id, skill_revision, digest)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(chat_id) DO UPDATE SET
      revision = excluded.revision, skill_id = excluded.skill_id,
      skill_revision = excluded.skill_revision, digest = excluded.digest`,
    ).run(
      chatId,
      revision,
      canonical?.id ?? null,
      canonical?.revision ?? null,
      canonical?.digest ?? null,
    );
    return readMarkdownSkillSelection(db, chatId);
  });
}

export function bindMarkdownSkillTurn(
  db: DatabaseSync,
  messageId: string,
  skill: MarkdownSkillReference | null,
): void {
  if (skill === null) return;
  db.prepare(
    `INSERT INTO markdown_skill_turn_bindings (message_id, skill_id, skill_revision, digest)
    VALUES (?, ?, ?, ?)`,
  ).run(messageId, skill.id, skill.revision, skill.digest);
}

export function readMarkdownSkillForTurn(
  db: DatabaseSync,
  resolve: ResolveSkill,
  messageId: string,
): MarkdownSkillDocument | undefined {
  const message = db.prepare("SELECT role FROM chat_messages WHERE id = ?").get(messageId);
  if (message?.role !== "user") throw notFound("User message");
  const row = db
    .prepare("SELECT * FROM markdown_skill_turn_bindings WHERE message_id = ?")
    .get(messageId) as SelectionRow | undefined;
  if (row === undefined) return undefined; // Legacy and explicitly unselected turns stay unselected.
  const skill = reference(row);
  if (skill === null) throw new UiStoreError("INTERNAL", "Stored turn skill is invalid.", 500);
  return resolve(skill);
}
