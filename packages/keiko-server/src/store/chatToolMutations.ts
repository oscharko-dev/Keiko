import type { DatabaseSync } from "node:sqlite";
import type { JiraMutationOutcome } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { ServerLogSink } from "../observability/index.js";
import { processServerLogSink } from "../process-log-sink.js";
import { UiStoreError } from "./errors.js";
import { withImmediateTransaction } from "./transaction.js";
import {
  acknowledgedStatus,
  journalConflict,
  sameMutationIdentity,
  validateMutationIntent,
  validateMutationSettlement,
} from "./chatToolMutationState.js";
import { recordChatToolMutation } from "./chatToolMutationActivity.js";
import type {
  ChatToolMutationIntent,
  ChatToolMutationRecord,
  ChatToolMutationPreparation,
  ChatToolMutationStore,
} from "./chatToolMutationTypes.js";
const COLUMNS = `invocation_id AS invocationId, chat_id AS chatId, user_message_id AS userMessageId,
  turn_ref AS turnRef, actor_id AS actorId, pod_id AS podId, binding_generation AS bindingGeneration,
  authentication_generation AS credentialGeneration, authority_digest AS authorityDigest, action_digest AS actionDigest,
  operation, correlation_id AS correlationId, phase, outcome, http_status AS httpStatus, created_at AS createdAt, updated_at AS updatedAt,
  source_kind AS sourceKind, configuration_digest AS configurationDigest, server_name AS serverName,
  tool_name AS toolName, protocol_outcome AS protocolOutcome`;
const MAX_MUTATIONS_PER_TURN = 32;
class GuardDenied extends Error {}
interface MutationChange {
  readonly record: ChatToolMutationRecord;
  readonly event: "response" | "settled" | "replayed";
}
function durableWrite<T>(db: DatabaseSync, operation: () => T): T {
  if (db.isTransaction) throw journalConflict();
  const setting = db.prepare("PRAGMA synchronous").get();
  if (typeof setting?.synchronous !== "number" || setting.synchronous < 2) throw journalConflict();
  try {
    return withImmediateTransaction(db, operation);
  } catch (error) {
    if (error instanceof UiStoreError || error instanceof GuardDenied) throw error;
    throw new UiStoreError("INTERNAL", "The mutation journal could not be persisted.", 500);
  }
}
function timestamp(now: () => number, previous = 0): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) throw journalConflict();
  return Math.max(value, previous);
}
function rowRecord(value: unknown): ChatToolMutationRecord | undefined {
  if (value === undefined) return undefined;
  const row = value as ChatToolMutationRecord;
  if (row.sourceKind === "configured-mcp") return Object.freeze(row);
  const {
    sourceKind: _source,
    configurationDigest: _configuration,
    serverName: _server,
    toolName: _tool,
    protocolOutcome: _protocol,
    ...legacy
  } = value as Record<string, unknown>;
  return Object.freeze(legacy as unknown as ChatToolMutationRecord);
}
/** Read the already admitted canonical turn; this never prepares or dispatches an action. */
export function readChatToolMutationTurn(
  db: DatabaseSync,
  chatId: string,
  turnRef: string,
): readonly ChatToolMutationRecord[] {
  return db
    .prepare(
      `SELECT ${COLUMNS} FROM chat_tool_mutations WHERE chat_id = ? AND turn_ref = ? LIMIT 33`,
    )
    .all(chatId, turnRef)
    .map((row) => rowRecord(row))
    .filter((row): row is ChatToolMutationRecord => row !== undefined);
}

function assertCurrentTurn(
  db: DatabaseSync,
  intent: Pick<ChatToolMutationRecord, "userMessageId" | "chatId" | "turnRef">,
): void {
  const row = db
    .prepare(
      "SELECT 1 FROM chat_messages WHERE id = ? AND chat_id = ? AND role = 'user' AND client_turn_id = ? AND client_turn_state = 'pending'",
    )
    .get(intent.userMessageId, intent.chatId, intent.turnRef);
  if (row === undefined) throw journalConflict();
}
function blockedTurn(
  db: DatabaseSync,
  intent: ChatToolMutationIntent,
): ChatToolMutationPreparation | undefined {
  const rows = db
    .prepare("SELECT phase, outcome FROM chat_tool_mutations WHERE chat_id = ? AND turn_ref = ?")
    .all(intent.chatId, intent.turnRef);
  if (rows.some((row) => row.outcome === "unknown" || row.outcome === "succeeded-unconfirmed"))
    return { kind: "blocked", reason: "unknown-effect" };
  if (rows.some((row) => row.phase === "dispatched" || row.phase === "acknowledged"))
    return { kind: "blocked", reason: "in-flight" };
  if (rows.length >= MAX_MUTATIONS_PER_TURN) return { kind: "blocked", reason: "capacity" };
  return undefined;
}
/** One SQLite commit precedes every possible external effect; nested savepoints are insufficient. */
class MutationStore implements ChatToolMutationStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number,
    private readonly log: ServerLogSink,
  ) {}
  find(invocationId: string): ChatToolMutationRecord | undefined {
    return rowRecord(
      this.db
        .prepare(`SELECT ${COLUMNS} FROM chat_tool_mutations WHERE invocation_id = ?`)
        .get(invocationId),
    );
  }
  private requireRecord(invocationId: string): ChatToolMutationRecord {
    const record = this.find(invocationId);
    if (record === undefined) throw journalConflict();
    return record;
  }
  prepare(intent: ChatToolMutationIntent): ChatToolMutationPreparation {
    validateMutationIntent(intent);
    const result = durableWrite(this.db, (): ChatToolMutationPreparation => {
      assertCurrentTurn(this.db, intent);
      const prior = rowRecord(
        this.db
          .prepare(
            `SELECT ${COLUMNS} FROM chat_tool_mutations WHERE chat_id = ? AND turn_ref = ? AND action_digest = ?`,
          )
          .get(intent.chatId, intent.turnRef, intent.actionDigest),
      );
      if (prior !== undefined) {
        if (!sameMutationIdentity(prior, intent)) throw journalConflict();
        return { kind: "replayed", record: prior };
      }
      const blocked = blockedTurn(this.db, intent);
      if (blocked !== undefined) return blocked;
      if (this.find(intent.invocationId) !== undefined) throw journalConflict();
      const createdAt = timestamp(this.now);
      this.insertPrepared(intent, createdAt);
      return { kind: "prepared", record: this.requireRecord(intent.invocationId) };
    });
    if (result.kind !== "blocked") recordChatToolMutation(this.log, result.record, result.kind);
    return result;
  }
  private insertPrepared(intent: ChatToolMutationIntent, createdAt: number): void {
    this.db
      .prepare(
        `INSERT INTO chat_tool_mutations (invocation_id, chat_id, user_message_id, turn_ref, actor_id, pod_id, binding_generation, authentication_generation, authority_digest, action_digest, operation, correlation_id, phase, created_at, updated_at, source_kind, configuration_digest, server_name, tool_name) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'prepared',?,?,?,?,?,?)`,
      )
      .run(
        intent.invocationId,
        intent.chatId,
        intent.userMessageId,
        intent.turnRef,
        intent.actorId,
        intent.podId,
        intent.bindingGeneration,
        intent.credentialGeneration,
        intent.authorityDigest,
        intent.actionDigest,
        intent.operation,
        intent.correlationId,
        createdAt,
        createdAt,
        intent.sourceKind ?? "jira",
        intent.sourceKind === "configured-mcp" ? intent.configurationDigest : null,
        intent.sourceKind === "configured-mcp" ? intent.serverName : null,
        intent.sourceKind === "configured-mcp" ? intent.toolName : null,
      );
  }
  beginDispatch(invocationId: string, guard: () => boolean): boolean {
    try {
      const record = durableWrite(this.db, (): ChatToolMutationRecord | undefined => {
        const current = this.requireRecord(invocationId);
        if (current.phase !== "prepared") return undefined;
        assertCurrentTurn(this.db, current);
        const barrier = this.db
          .prepare(
            "SELECT 1 FROM chat_tool_mutations WHERE chat_id = ? AND turn_ref = ? AND (phase IN ('dispatched','acknowledged') OR outcome IN ('unknown','succeeded-unconfirmed')) LIMIT 1",
          )
          .get(current.chatId, current.turnRef);
        if (barrier !== undefined) return undefined;
        // A synchronous guard may atomically redeem an approval in this same transaction.
        if (!guardApproved(guard())) throw new GuardDenied();
        this.db
          .prepare(
            "UPDATE chat_tool_mutations SET phase = 'dispatched', updated_at = ? WHERE invocation_id = ?",
          )
          .run(timestamp(this.now, current.updatedAt), invocationId);
        return this.requireRecord(invocationId);
      });
      if (record === undefined) return false;
      recordChatToolMutation(this.log, record, "dispatched");
      return true;
    } catch (error) {
      if (error instanceof GuardDenied) return false;
      throw error;
    }
  }
  acknowledge(invocationId: string, httpStatus: number): ChatToolMutationRecord {
    if (!Number.isInteger(httpStatus) || httpStatus < 100 || httpStatus > 599)
      throw journalConflict();
    const change = durableWrite(this.db, (): MutationChange => {
      const current = this.requireRecord(invocationId);
      if (current.sourceKind === "configured-mcp") throw journalConflict();
      if (current.httpStatus !== null) {
        if (current.httpStatus !== httpStatus) throw journalConflict();
        return { record: current, event: "replayed" };
      }
      if (current.phase !== "dispatched") throw journalConflict();
      this.db
        .prepare(
          "UPDATE chat_tool_mutations SET phase = ?, http_status = ?, updated_at = ? WHERE invocation_id = ?",
        )
        .run(
          acknowledgedStatus(httpStatus) ? "acknowledged" : "dispatched",
          httpStatus,
          timestamp(this.now, current.updatedAt),
          invocationId,
        );
      return { record: this.requireRecord(invocationId), event: "response" };
    });
    recordChatToolMutation(this.log, change.record, change.event);
    return change.record;
  }
  acknowledgeMcp(invocationId: string, success: boolean): ChatToolMutationRecord {
    const protocolOutcome = success ? "success" : "error";
    const change = durableWrite(this.db, (): MutationChange => {
      const current = this.requireRecord(invocationId);
      if (current.sourceKind !== "configured-mcp") throw journalConflict();
      if (current.protocolOutcome !== null) {
        if (current.protocolOutcome !== protocolOutcome) throw journalConflict();
        return { record: current, event: "replayed" };
      }
      if (current.phase !== "dispatched") throw journalConflict();
      this.db
        .prepare(
          "UPDATE chat_tool_mutations SET phase = ?, protocol_outcome = ?, updated_at = ? WHERE invocation_id = ?",
        )
        .run(
          success ? "acknowledged" : "dispatched",
          protocolOutcome,
          timestamp(this.now, current.updatedAt),
          invocationId,
        );
      return { record: this.requireRecord(invocationId), event: "response" };
    });
    recordChatToolMutation(this.log, change.record, change.event);
    return change.record;
  }
  settle(invocationId: string, outcome: JiraMutationOutcome): ChatToolMutationRecord {
    const change = durableWrite(this.db, (): MutationChange => {
      const current = this.requireRecord(invocationId);
      validateMutationSettlement(current, outcome);
      if (current.phase === "settled") return { record: current, event: "replayed" };
      this.db
        .prepare(
          "UPDATE chat_tool_mutations SET phase = 'settled', outcome = ?, updated_at = ? WHERE invocation_id = ?",
        )
        .run(outcome, timestamp(this.now, current.updatedAt), invocationId);
      return { record: this.requireRecord(invocationId), event: "settled" };
    });
    recordChatToolMutation(this.log, change.record, change.event);
    return change.record;
  }
}

function guardApproved(result: unknown): boolean {
  return result === true;
}
export function createChatToolMutationStore(
  db: DatabaseSync,
  now: () => number,
  log: ServerLogSink = processServerLogSink(),
): ChatToolMutationStore {
  return new MutationStore(db, now, log);
}
