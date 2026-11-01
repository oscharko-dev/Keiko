import { createHash } from "node:crypto";
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
  ChatToolMutationLinkCounts,
  ChatToolMutationRecord,
  ChatToolMutationPreparation,
  ChatToolMutationSettleEvidence,
  ChatToolMutationStore,
} from "./chatToolMutationTypes.js";
const COLUMNS = `invocation_id AS invocationId, chat_id AS chatId, user_message_id AS userMessageId,
  turn_ref AS turnRef, actor_id AS actorId, pod_id AS podId, binding_generation AS bindingGeneration,
  authentication_generation AS credentialGeneration, authority_digest AS authorityDigest, action_digest AS actionDigest,
  operation, correlation_id AS correlationId, phase, outcome, http_status AS httpStatus, created_at AS createdAt, updated_at AS updatedAt,
  source_kind AS sourceKind, configuration_digest AS configurationDigest, server_name AS serverName,
  tool_name AS toolName, protocol_outcome AS protocolOutcome,
  consumer_kind AS consumerKind, coding_run_id AS codingRunId, native_session_id AS nativeSessionId,
  native_message_id AS nativeMessageId, native_call_id AS nativeCallId, native_arguments_digest AS nativeArgumentsDigest,
  native_mcp_action_digest AS nativeMcpActionDigest`;
const MAX_MUTATIONS_PER_TURN = 32;
function consumerColumns(intent: ChatToolMutationIntent): readonly (string | null)[] {
  const consumer = intent.consumer;
  return consumer === undefined
    ? ["chat", null, null, null, null, null, null]
    : [
        consumer.kind,
        consumer.runId,
        consumer.sessionId,
        consumer.messageId,
        consumer.callId,
        consumer.argumentsDigest,
        consumer.mcpActionDigest ?? null,
      ];
}
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
  const {
    consumerKind,
    codingRunId,
    nativeSessionId,
    nativeMessageId,
    nativeCallId,
    nativeArgumentsDigest,
    nativeMcpActionDigest,
    ...fields
  } = value as Record<string, unknown>;
  const row = {
    ...fields,
    ...(consumerKind === "coding"
      ? {
          consumer: {
            kind: "coding",
            runId: codingRunId,
            sessionId: nativeSessionId,
            messageId: nativeMessageId,
            callId: nativeCallId,
            argumentsDigest: nativeArgumentsDigest,
            ...(nativeMcpActionDigest === null ? {} : { mcpActionDigest: nativeMcpActionDigest }),
          },
        }
      : {}),
  } as unknown as ChatToolMutationRecord;
  if (row.sourceKind === "configured-mcp") return Object.freeze(row);
  const {
    sourceKind: _source,
    configurationDigest: _configuration,
    serverName: _server,
    toolName: _tool,
    protocolOutcome: _protocol,
    ...legacy
  } = row as unknown as Record<string, unknown>;
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
      `SELECT ${COLUMNS} FROM chat_tool_mutations WHERE chat_id = ? AND turn_ref = ? AND consumer_kind = 'chat' LIMIT 33`,
    )
    .all(chatId, turnRef)
    .map((row) => rowRecord(row))
    .filter((row): row is ChatToolMutationRecord => row !== undefined);
}

function assertCurrentTurn(
  db: DatabaseSync,
  intent: ChatToolMutationRecord | ChatToolMutationIntent,
): void {
  if (intent.consumer !== undefined) {
    const row = db
      .prepare(
        `SELECT 1 FROM coding_history_runs r
      JOIN coding_history_tasks t ON t.chat_id=r.chat_id
      JOIN coding_runtime_snapshots s ON s.run_id=r.run_id
      JOIN chat_messages m ON m.id=r.active_user_message_id AND m.chat_id=r.chat_id
      JOIN coding_history_message_bindings b ON b.run_id=r.run_id AND b.message_id=m.id AND b.source_id=r.active_native_turn_ref
      WHERE r.run_id=? AND r.chat_id=? AND r.active_user_message_id=? AND r.active_native_turn_ref=?
        AND m.role='user' AND t.operator_digest=? AND s.operator_digest=? AND s.authority_digest=?
        AND s.state IN ('running','awaiting-approval') AND s.terminal_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM coding_history_runs next WHERE next.chat_id=r.chat_id AND next.sequence>r.sequence)`,
      )
      .get(
        intent.consumer.runId,
        intent.chatId,
        intent.userMessageId,
        intent.turnRef,
        intent.actorId,
        intent.actorId,
        intent.authorityDigest,
      );
    if (row === undefined) throw journalConflict();
    return;
  }
  const row = db
    .prepare(
      "SELECT 1 FROM chat_messages WHERE id = ? AND chat_id = ? AND role = 'user' AND client_turn_id = ? AND client_turn_state = 'pending'",
    )
    .get(intent.userMessageId, intent.chatId, intent.turnRef);
  if (row === undefined) throw journalConflict();
}
function observedWithinNativeCall(
  row: ChatToolMutationRecord,
  intent: Pick<ChatToolMutationIntent, "consumer" | "invocationId">,
): boolean {
  const current = intent.consumer;
  const prior = row.consumer;
  if (current === undefined || prior === undefined || row.invocationId === intent.invocationId)
    return false;
  return (
    row.phase === "acknowledged" &&
    prior.runId === current.runId &&
    prior.sessionId === current.sessionId &&
    prior.messageId === current.messageId &&
    prior.callId === current.callId
  );
}
function turnRecords(
  db: DatabaseSync,
  intent: { readonly chatId: string; readonly turnRef: string },
): readonly ChatToolMutationRecord[] {
  return db
    .prepare(`SELECT ${COLUMNS} FROM chat_tool_mutations WHERE chat_id = ? AND turn_ref = ?`)
    .all(intent.chatId, intent.turnRef)
    .map(rowRecord)
    .filter((row): row is ChatToolMutationRecord => row !== undefined);
}
function hasInflightBarrier(
  rows: readonly ChatToolMutationRecord[],
  intent: Pick<ChatToolMutationIntent, "consumer" | "invocationId">,
): boolean {
  return rows.some(
    (row) =>
      row.phase === "dispatched" ||
      (row.phase === "acknowledged" && !observedWithinNativeCall(row, intent)),
  );
}
/**
 * Whether a record may have reached the provider. The turn bound limits writes, so a record that
 * settled as a local refusal before dispatch (an existing draft item, a value refused before
 * sending) does not use it up (#4175, #4178). The settlement rules admit those two outcomes only
 * without a provider response; every other record counts.
 */
function heldWrite(row: ChatToolMutationRecord): boolean {
  return !(
    row.phase === "settled" &&
    (row.outcome === "not-dispatched" || row.outcome === "rejected")
  );
}
function blockedTurn(
  db: DatabaseSync,
  intent: ChatToolMutationIntent,
): ChatToolMutationPreparation | undefined {
  const rows = turnRecords(db, intent);
  if (rows.some((row) => row.outcome === "unknown" || row.outcome === "succeeded-unconfirmed"))
    return { kind: "blocked", reason: "unknown-effect" };
  if (hasInflightBarrier(rows, intent)) return { kind: "blocked", reason: "in-flight" };
  if (rows.filter((row) => heldWrite(row)).length >= MAX_MUTATIONS_PER_TURN)
    return { kind: "blocked", reason: "capacity" };
  return undefined;
}
function retryableAttachment(
  prior: ChatToolMutationRecord,
  intent: ChatToolMutationIntent,
): boolean {
  return (
    prior.operation === "jira.attach" &&
    prior.phase === "settled" &&
    (prior.outcome === "rejected" || prior.outcome === "not-dispatched") &&
    prior.invocationId !== intent.invocationId &&
    sameMutationIdentity(prior, intent)
  );
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
  preparedNative(
    input: Parameters<NonNullable<ChatToolMutationStore["preparedNative"]>>[0],
  ): ChatToolMutationRecord | undefined {
    const rows = this.db
      .prepare(
        `SELECT ${COLUMNS} FROM chat_tool_mutations WHERE consumer_kind='coding'
      AND coding_run_id=? AND native_session_id=? AND server_name=? AND tool_name=? AND native_arguments_digest=? AND turn_ref=? AND phase='prepared' LIMIT 2`,
      )
      .all(
        input.runId,
        input.sessionId,
        input.serverName,
        input.toolName,
        input.argumentsDigest,
        input.turnRef,
      );
    return rows.length === 1 ? rowRecord(rows[0]) : undefined;
  }
  unsettledNative(runId: string): readonly ChatToolMutationRecord[] {
    return this.db
      .prepare(
        `SELECT ${COLUMNS} FROM chat_tool_mutations WHERE consumer_kind='coding' AND coding_run_id=?
      AND (phase IN ('dispatched','acknowledged') OR outcome IN ('unknown','succeeded-unconfirmed')) LIMIT 257`,
      )
      .all(runId)
      .map((row) => rowRecord(row))
      .filter((row): row is ChatToolMutationRecord => row !== undefined);
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
      if (prior !== undefined && retryableAttachment(prior, intent)) this.retire(prior);
      else if (prior !== undefined) {
        if (!sameMutationIdentity(prior, intent)) throw journalConflict();
        return { kind: "replayed", record: prior };
      }
      const blocked = blockedTurn(this.db, intent);
      if (blocked !== undefined) return blocked;
      const existingInvocation = this.find(intent.invocationId);
      if (existingInvocation !== undefined) throw journalConflict();
      const createdAt = timestamp(this.now);
      this.insertPrepared(intent, createdAt);
      return { kind: "prepared", record: this.requireRecord(intent.invocationId) };
    });
    if (result.kind !== "blocked") recordChatToolMutation(this.log, result.record, result.kind);
    return result;
  }
  /**
   * A refused or never-sent attachment left no remote effect, and the model is told to request it
   * again after correcting the file; the retry is a new call and must not replay that refusal. The
   * old record keeps its identity and outcome under a retired action digest (#4176).
   */
  private retire(record: ChatToolMutationRecord): void {
    this.db
      .prepare("UPDATE chat_tool_mutations SET action_digest = ? WHERE invocation_id = ?")
      .run(
        createHash("sha256")
          .update(`${record.actionDigest}:retired:${record.invocationId}`)
          .digest("hex"),
        record.invocationId,
      );
  }
  private insertPrepared(intent: ChatToolMutationIntent, createdAt: number): void {
    this.db
      .prepare(
        `INSERT INTO chat_tool_mutations (invocation_id, chat_id, user_message_id, turn_ref, actor_id, pod_id, binding_generation, authentication_generation, authority_digest, action_digest, operation, correlation_id, phase, created_at, updated_at, source_kind, configuration_digest, server_name, tool_name, consumer_kind, coding_run_id, native_session_id, native_message_id, native_call_id, native_arguments_digest, native_mcp_action_digest) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'prepared',?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
        ...consumerColumns(intent),
      );
  }
  beginDispatch(invocationId: string, guard: () => boolean): boolean {
    try {
      const record = durableWrite(this.db, (): ChatToolMutationRecord | undefined => {
        const current = this.requireRecord(invocationId);
        if (current.phase !== "prepared") return undefined;
        assertCurrentTurn(this.db, current);
        const rows = turnRecords(this.db, current);
        if (
          rows.some(
            (row) => row.outcome === "unknown" || row.outcome === "succeeded-unconfirmed",
          ) ||
          hasInflightBarrier(rows, current)
        )
          return undefined;
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
  settle(
    invocationId: string,
    outcome: JiraMutationOutcome,
    links?: ChatToolMutationLinkCounts,
    evidence?: ChatToolMutationSettleEvidence,
  ): ChatToolMutationRecord {
    const change = durableWrite(this.db, (): MutationChange => {
      const current = this.requireRecord(invocationId);
      validateMutationSettlement(current, outcome, evidence?.jiraErrorDocument === true);
      if (current.phase === "settled") return { record: current, event: "replayed" };
      this.db
        .prepare(
          "UPDATE chat_tool_mutations SET phase = 'settled', outcome = ?, updated_at = ? WHERE invocation_id = ?",
        )
        .run(outcome, timestamp(this.now, current.updatedAt), invocationId);
      return { record: this.requireRecord(invocationId), event: "settled" };
    });
    recordChatToolMutation(
      this.log,
      change.record,
      change.event,
      change.event === "settled" ? links : undefined,
    );
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
