import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ContextCompactionRecord } from "@oscharko-dev/keiko-contracts";
import { validateContextCompactionRecord } from "@oscharko-dev/keiko-contracts/runtime/context-engineering-compaction-validation";
import { projectContextCompactionRecord } from "@oscharko-dev/keiko-evidence";
import type { ChatContinuityCheckpoint } from "./types.js";
import { chatHistoryRevision } from "./messages.js";
import { withImmediateTransaction } from "./transaction.js";

const MAX_CHECKPOINT_BYTES = 262_144;
const READ = `SELECT generation, history_revision, through_message_id, record_json, record_digest
  FROM chat_continuity_checkpoints WHERE chat_id = ?`;
const WRITE = `INSERT INTO chat_continuity_checkpoints
  (chat_id, generation, history_revision, through_message_id, record_json, record_digest)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(chat_id) DO UPDATE SET generation = excluded.generation,
    history_revision = excluded.history_revision, through_message_id = excluded.through_message_id,
    record_json = excluded.record_json, record_digest = excluded.record_digest`;

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function decodeRecord(
  row: Record<string, unknown>,
  revision: number,
  redactContent: (value: string) => string,
): ContextCompactionRecord | undefined {
  if (!validEnvelope(row, revision)) return undefined;
  const value: unknown = JSON.parse(row.record_json);
  if (!validateContextCompactionRecord(value).ok) return undefined;
  const record = projectContextCompactionRecord(value as ContextCompactionRecord, redactContent);
  if (
    !validateContextCompactionRecord(record).ok ||
    record.conversationCoverage?.historyRevision !== revision ||
    record.conversationCoverage.throughMessageId !== row.through_message_id
  )
    return undefined;
  return record;
}

export function readContinuityCheckpoint(
  db: DatabaseSync,
  chatId: string,
  redactContent: (value: string) => string,
): ChatContinuityCheckpoint | undefined {
  const revision = chatHistoryRevision(db, chatId);
  const row = db.prepare(READ).get(chatId);
  if (row === undefined) return undefined;
  if (typeof row.generation !== "number" || !Number.isSafeInteger(row.generation)) {
    throw new TypeError("Invalid continuity checkpoint generation.");
  }
  return { generation: row.generation, record: decodeRecord(row, revision, redactContent) };
}

/** All binding checks and the generation swap share the same SQLite transaction. */
export function writeContinuityCheckpoint(
  db: DatabaseSync,
  chatId: string,
  input: ContextCompactionRecord,
  expectedGeneration: number | undefined,
  redactContent: (value: string) => string,
): boolean {
  if (!validateContextCompactionRecord(input).ok) return false;
  const record = projectContextCompactionRecord(input, redactContent);
  const coverage = record.conversationCoverage;
  if (coverage === undefined || !validateContextCompactionRecord(record).ok) return false;
  const json = JSON.stringify(record);
  if (Buffer.byteLength(json) > MAX_CHECKPOINT_BYTES) return false;
  return withImmediateTransaction(db, (): boolean => {
    if (chatHistoryRevision(db, chatId) !== coverage.historyRevision) return false;
    if (
      db
        .prepare("SELECT 1 FROM chat_messages WHERE id = ? AND chat_id = ?")
        .get(coverage.throughMessageId, chatId) === undefined
    )
      return false;
    const current = readContinuityCheckpoint(db, chatId, redactContent);
    if (current?.generation !== expectedGeneration) return false;
    if (narrowsExistingPrefix(current?.record, record)) return false;
    const generation = (current?.generation ?? 0) + 1;
    if (!Number.isSafeInteger(generation)) return false;
    db.prepare(WRITE).run(
      chatId,
      generation,
      coverage.historyRevision,
      coverage.throughMessageId,
      json,
      digest(json),
    );
    return true;
  });
}

function validEnvelope(
  row: Record<string, unknown>,
  revision: number,
): row is Record<string, unknown> & { readonly record_json: string } {
  return (
    typeof row.record_json === "string" &&
    Buffer.byteLength(row.record_json) <= MAX_CHECKPOINT_BYTES &&
    digest(row.record_json) === row.record_digest &&
    row.history_revision === revision
  );
}

function narrowsExistingPrefix(
  existing: ContextCompactionRecord | undefined,
  record: ContextCompactionRecord,
): boolean {
  if (existing?.conversationCoverage === undefined) return false;
  const coverage = record.conversationCoverage;
  return (
    coverage !== undefined &&
    existing.itemsBefore > record.itemsBefore &&
    existing.conversationCoverage.contextWindowTokens === coverage.contextWindowTokens &&
    existing.conversationCoverage.effectiveInputBudget === coverage.effectiveInputBudget
  );
}
