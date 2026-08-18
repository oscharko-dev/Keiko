// ADR-0013 — chat_messages CRUD. shortResult is redacted+truncated to ≤ MAX_SHORT_RESULT before persist.
// Issue #66 adds:
//   - `cancelled` to the accepted workflow status set (parity with src/ui/runs.ts RunStatus).
//   - `task_type` column read/write so non-workflow runs (verify/explain-plan) can be labelled.
//   - updateMessage(): partial PATCH on the row, re-using the existing redact+truncate path.

import type { DatabaseSync } from "node:sqlite";
import { validateKnowledgePodRetrievalActivity } from "@oscharko-dev/keiko-contracts";
import type {
  ChatAssistantResponseVersion,
  ChatMessage,
  ChatRole,
  ChatTurnState,
  GroundedAnswer,
  NewChatMessage,
  StoredPdfCitationPreviewCitation,
  UpdateChatMessagePatch,
  WorkflowStatus,
} from "./types.js";
import { invalidRequest, notFound, UiStoreError } from "./errors.js";

const MAX_SHORT_RESULT = 200;
const MAX_TASK_TYPE = 64;
// Constrained to a-z, digits, and a single inner `-` so the label remains URL-safe and survives
// a SQL round-trip. Identical to the rule the BFF descriptors use for taskType identifiers.
const TASK_TYPE_RE = /^[a-z][a-z0-9-]*$/;

const ROLES: ReadonlySet<ChatRole> = new Set(["user", "assistant", "system"]);
const STATUSES: ReadonlySet<WorkflowStatus> = new Set([
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
]);

interface MessageRow {
  readonly id: string;
  readonly chat_id: string;
  readonly role: string;
  readonly content: string;
  readonly timestamp: number;
  readonly run_id: string | null;
  readonly workflow_id: string | null;
  readonly workflow_status: string | null;
  readonly short_result: string | null;
  readonly task_type: string | null;
  readonly grounded_answer_json: string | null;
  readonly grounded_preview_citations_json: string | null;
  readonly client_turn_id: string | null;
  readonly client_turn_state: string | null;
  readonly client_turn_content_digest: string | null;
  readonly assistant_response_versions_json: string | null;
}

const MAX_ASSISTANT_RESPONSE_VERSIONS = 50;

function isResponseVersion(
  value: unknown,
  expectedVersion: number,
): value is ChatAssistantResponseVersion {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const expectedSupersedes = expectedVersion === 1 ? undefined : expectedVersion - 1;
  return (
    candidate.version === expectedVersion &&
    typeof candidate.content === "string" &&
    candidate.content.length > 0 &&
    typeof candidate.timestamp === "number" &&
    Number.isFinite(candidate.timestamp) &&
    candidate.supersedesVersion === expectedSupersedes
  );
}

function isAssistantResponseVersionChain(
  row: MessageRow,
  value: unknown,
): value is ChatAssistantResponseVersion[] {
  return (
    row.role === "assistant" &&
    Array.isArray(value) &&
    value.length >= 2 &&
    value.length <= MAX_ASSISTANT_RESPONSE_VERSIONS &&
    value.every((candidate, index) => isResponseVersion(candidate, index + 1))
  );
}

function parseAssistantResponseVersions(
  row: MessageRow,
): readonly ChatAssistantResponseVersion[] | undefined {
  const raw = row.assistant_response_versions_json;
  if (raw === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new UiStoreError("INTERNAL", "Stored assistant response versions are invalid.", 500);
  }
  if (!isAssistantResponseVersionChain(row, parsed)) {
    throw new UiStoreError("INTERNAL", "Stored assistant response versions are invalid.", 500);
  }
  const current = parsed.at(-1);
  if (current?.content !== row.content || current.timestamp !== row.timestamp) {
    throw new UiStoreError("INTERNAL", "Stored assistant response versions are inconsistent.", 500);
  }
  return parsed;
}

function parseGroundedAnswer(raw: string | null): GroundedAnswer | undefined {
  if (raw === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new UiStoreError("INTERNAL", "Stored grounded answer metadata is invalid.", 500);
  }
  assertGroundedAnswerRetrievalActivity(
    parsed,
    () =>
      new UiStoreError("INTERNAL", "Stored grounded answer retrieval activity is invalid.", 500),
  );
  return parsed as GroundedAnswer;
}

function parseGroundedPreviewCitations(
  raw: string | null,
): readonly StoredPdfCitationPreviewCitation[] | undefined {
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw) as readonly StoredPdfCitationPreviewCitation[];
  } catch {
    return undefined;
  }
}

function rowToMessage(row: MessageRow): ChatMessage {
  const groundedAnswer = parseGroundedAnswer(row.grounded_answer_json);
  const turnState = parseClientTurnState(row.client_turn_state);
  const responseVersions = parseAssistantResponseVersions(row);
  const currentResponse = responseVersions?.at(-1);
  return {
    id: row.id,
    chatId: row.chat_id,
    role: row.role as ChatRole,
    content: row.content,
    timestamp: row.timestamp,
    canonicalTurnRef: row.client_turn_id ?? undefined,
    turnState,
    responseVersion: currentResponse?.version,
    supersedesResponseVersion: currentResponse?.supersedesVersion,
    responseVersions,
    runId: row.run_id ?? undefined,
    workflowId: row.workflow_id ?? undefined,
    workflowStatus: (row.workflow_status ?? undefined) as WorkflowStatus | undefined,
    shortResult: row.short_result ?? undefined,
    taskType: row.task_type ?? undefined,
    groundedAnswer,
  };
}

const COLUMNS =
  "id, chat_id, role, content, timestamp, run_id, workflow_id, workflow_status, short_result, task_type, grounded_answer_json, grounded_preview_citations_json, client_turn_id, client_turn_state, client_turn_content_digest, assistant_response_versions_json";

const SQL_LIST = `SELECT ${COLUMNS} FROM chat_messages WHERE chat_id = ? ORDER BY timestamp ASC, rowid ASC`;
const SQL_LIST_LIMITED = `
SELECT ${COLUMNS}
FROM (
  SELECT rowid AS __rowid, ${COLUMNS}
  FROM chat_messages
  WHERE chat_id = ?
  ORDER BY timestamp DESC, rowid DESC
  LIMIT ?
)
ORDER BY timestamp ASC, __rowid ASC`;
const GATEWAY_SCAN_PAGE_SIZE = 128;
const SQL_LIST_GATEWAY_PAGE = `
SELECT rowid AS __rowid, ${COLUMNS}
FROM chat_messages
WHERE chat_id = ?
ORDER BY timestamp DESC, rowid DESC
LIMIT ?`;
const SQL_LIST_GATEWAY_PAGE_BEFORE = `
SELECT rowid AS __rowid, ${COLUMNS}
FROM chat_messages
WHERE chat_id = ?
  AND (timestamp < ? OR (timestamp = ? AND rowid < ?))
ORDER BY timestamp DESC, rowid DESC
LIMIT ?`;
const SQL_LIST_PREFIX_LIMITED = `${SQL_LIST} LIMIT ?`;
const SQL_COUNT = "SELECT COUNT(*) AS count FROM chat_messages WHERE chat_id = ?";
const SQL_LATEST_MESSAGE_ID = `
  SELECT id
  FROM chat_messages
  WHERE chat_id = ?
  ORDER BY timestamp DESC, rowid DESC
  LIMIT 1
`;
const SQL_FIND_BY_ID = `SELECT ${COLUMNS} FROM chat_messages WHERE id = ? LIMIT 1`;
const SQL_FIND_BY_CLIENT_TURN = `
  SELECT ${COLUMNS}
  FROM chat_messages
  WHERE chat_id = ? AND client_turn_id = ? AND role IN ('user', 'assistant')
  ORDER BY timestamp ASC, rowid ASC
`;
const SQL_CHAT_EXISTS = "SELECT 1 FROM chats WHERE id = ?";
const SQL_VERSION_ASSISTANT_CONTENT = `
  UPDATE chat_messages
  SET content = ?, timestamp = ?, assistant_response_versions_json = ?
  WHERE id = ? AND role = 'assistant'
  RETURNING ${COLUMNS}
`;
const SQL_INSERT = `
INSERT INTO chat_messages
  (id, chat_id, role, content, timestamp, run_id, workflow_id, workflow_status, short_result, task_type, grounded_answer_json, grounded_preview_citations_json, client_turn_id, client_turn_state, client_turn_content_digest)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
RETURNING ${COLUMNS}
`;

function validateTaskType(value: string): void {
  if (value.length === 0 || value.length > MAX_TASK_TYPE || !TASK_TYPE_RE.test(value)) {
    throw invalidRequest("Invalid taskType.");
  }
}

function hasRunSummaryFields(msg: NewChatMessage): boolean {
  return (
    msg.runId !== undefined ||
    msg.workflowId !== undefined ||
    msg.workflowStatus !== undefined ||
    msg.shortResult !== undefined ||
    msg.taskType !== undefined
  );
}

function validateRunIdentifiers(msg: NewChatMessage): void {
  if (msg.runId?.length === 0) {
    throw invalidRequest("runId is required for run summaries.");
  }
  if (msg.workflowId?.length === 0) {
    throw invalidRequest("workflowId must be non-empty.");
  }
}

function validateRunSummaryScope(msg: NewChatMessage): void {
  if (hasRunSummaryFields(msg) && (msg.role !== "system" || msg.runId === undefined)) {
    throw invalidRequest("Run summary fields require a system message with runId.");
  }
  if (msg.groundedAnswer !== undefined && msg.role !== "assistant") {
    throw invalidRequest("Grounded answer metadata requires an assistant message.");
  }
}

export function validateMessage(msg: NewChatMessage): void {
  if (!ROLES.has(msg.role)) throw invalidRequest("Invalid role.");
  if (msg.content.length === 0) throw invalidRequest("Content is required.");
  validateRunIdentifiers(msg);
  validateRunSummaryScope(msg);
  if (msg.workflowStatus !== undefined && !STATUSES.has(msg.workflowStatus)) {
    throw invalidRequest("Invalid workflowStatus.");
  }
  if (msg.taskType !== undefined) validateTaskType(msg.taskType);
}

export function isLatestChatMessage(db: DatabaseSync, chatId: string, messageId: string): boolean {
  const row = db.prepare(SQL_LATEST_MESSAGE_ID).get(chatId) as unknown as
    { readonly id: string } | undefined;
  return row?.id === messageId;
}

export interface ClientTurnOwner {
  readonly clientTurnId: string;
  readonly state: ClientTurnRecord["state"];
  readonly userMessage: ChatMessage;
}

export function findClientTurnOwner(
  db: DatabaseSync,
  userMessageId: string,
): ClientTurnOwner | undefined {
  const row = db
    .prepare(
      `
        SELECT ${COLUMNS}
        FROM chat_messages
        WHERE id = ? AND role = 'user' AND client_turn_id IS NOT NULL
        LIMIT 1
      `,
    )
    .get(userMessageId) as unknown as MessageRow | undefined;
  if (typeof row?.client_turn_id !== "string") return undefined;
  return {
    clientTurnId: row.client_turn_id,
    state: parseClientTurnState(row.client_turn_state),
    userMessage: rowToMessage(row),
  };
}

function processShortResult(
  raw: string | undefined,
  redactString: (s: string) => string,
): string | null {
  if (raw === undefined) return null;
  const redacted = redactString(raw);
  return redacted.length > MAX_SHORT_RESULT ? redacted.slice(0, MAX_SHORT_RESULT) : redacted;
}

function processGroundedAnswer(
  raw: GroundedAnswer | undefined,
  redactString: (s: string) => string,
): string | null {
  if (raw === undefined) return null;
  assertGroundedAnswerRetrievalActivity(raw, () =>
    invalidRequest("Grounded answer retrieval activity is invalid."),
  );
  const redacted = redactString(JSON.stringify(raw));
  let parsed: unknown;
  try {
    parsed = JSON.parse(redacted) as unknown;
  } catch {
    throw invalidRequest("Grounded answer metadata is invalid.");
  }
  assertGroundedAnswerRetrievalActivity(parsed, () =>
    invalidRequest("Grounded answer retrieval activity is invalid."),
  );
  return redacted;
}

function assertGroundedAnswerRetrievalActivity(
  value: unknown,
  errorFactory: () => UiStoreError,
): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw errorFactory();
  }
  const activity = (value as { readonly retrievalActivity?: unknown }).retrievalActivity;
  if (activity === undefined) return;
  const validation = validateKnowledgePodRetrievalActivity(activity);
  if (!validation.ok) throw errorFactory();
}

function processGroundedPreviewCitations(
  raw: readonly StoredPdfCitationPreviewCitation[] | undefined,
): string | null {
  if (raw === undefined) return null;
  const json = JSON.stringify(raw);
  try {
    JSON.parse(json);
  } catch {
    throw invalidRequest("Grounded preview citation metadata is invalid.");
  }
  return json;
}

export function listMessages(db: DatabaseSync, chatId: string): readonly ChatMessage[] {
  return (db.prepare(SQL_LIST).all(chatId) as unknown as MessageRow[]).map(rowToMessage);
}

export function listMessagesLimited(
  db: DatabaseSync,
  chatId: string,
  limit: number,
): readonly ChatMessage[] {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw invalidRequest("limit must be a positive integer.");
  }
  return (db.prepare(SQL_LIST_LIMITED).all(chatId, limit) as unknown as MessageRow[]).map(
    rowToMessage,
  );
}

export function listMessagesPrefixLimited(
  db: DatabaseSync,
  chatId: string,
  limit: number,
): readonly ChatMessage[] {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw invalidRequest("limit must be a positive integer.");
  }
  return (db.prepare(SQL_LIST_PREFIX_LIMITED).all(chatId, limit) as unknown as MessageRow[]).map(
    rowToMessage,
  );
}

export function countMessages(db: DatabaseSync, chatId: string): number {
  const row = db.prepare(SQL_COUNT).get(chatId) as { count?: unknown } | undefined;
  return typeof row?.count === "number" ? row.count : 0;
}

export function findMessageById(db: DatabaseSync, id: string): ChatMessage | undefined {
  const row = db.prepare(SQL_FIND_BY_ID).get(id) as unknown as MessageRow | undefined;
  return row === undefined ? undefined : rowToMessage(row);
}

export interface ClientTurnRecord {
  readonly userMessage?: ChatMessage | undefined;
  readonly assistantMessage?: ChatMessage | undefined;
  readonly state?: ChatTurnState | undefined;
  readonly contentDigest?: string | undefined;
}

function parseClientTurnState(value: string | null): ClientTurnRecord["state"] {
  if (value === null) return undefined;
  if (value === "pending" || value === "completed" || value === "failed" || value === "cancelled") {
    return value;
  }
  throw new UiStoreError("INTERNAL", "Stored client turn state is invalid.", 500);
}

export function findClientTurn(
  db: DatabaseSync,
  chatId: string,
  clientTurnId: string,
): ClientTurnRecord {
  const rows = db
    .prepare(SQL_FIND_BY_CLIENT_TURN)
    .all(chatId, clientTurnId) as unknown as MessageRow[];
  const userRow = rows.find((row) => row.role === "user");
  const assistantRow = rows.find((row) => row.role === "assistant");
  return {
    ...(userRow === undefined ? {} : { userMessage: rowToMessage(userRow) }),
    ...(assistantRow === undefined ? {} : { assistantMessage: rowToMessage(assistantRow) }),
    ...(userRow === undefined ? {} : { state: parseClientTurnState(userRow.client_turn_state) }),
    ...(userRow?.client_turn_content_digest === null || userRow === undefined
      ? {}
      : { contentDigest: userRow.client_turn_content_digest }),
  };
}

export function linkAssistantToClientTurn(
  db: DatabaseSync,
  chatId: string,
  assistantMessageId: string,
  clientTurnId: string,
): void {
  const linked = db
    .prepare(
      `
        UPDATE chat_messages
        SET client_turn_id = ?
        WHERE id = ? AND chat_id = ? AND role = 'assistant' AND client_turn_id IS NULL
      `,
    )
    .run(clientTurnId, assistantMessageId, chatId);
  if (linked.changes !== 1) throw notFound("Message");
  const completed = db
    .prepare(
      `
        UPDATE chat_messages
        SET client_turn_state = 'completed'
        WHERE chat_id = ? AND client_turn_id = ? AND role = 'user'
          AND client_turn_state = 'pending'
      `,
    )
    .run(chatId, clientTurnId);
  if (completed.changes !== 1) throw notFound("Message");
}

export function markClientTurnState(
  db: DatabaseSync,
  chatId: string,
  clientTurnId: string,
  from: ChatTurnState,
  to: ChatTurnState,
): boolean {
  const result = db
    .prepare(
      `
        UPDATE chat_messages
        SET client_turn_state = ?
        WHERE chat_id = ? AND client_turn_id = ? AND role = 'user'
          AND client_turn_state = ?
      `,
    )
    .run(to, chatId, clientTurnId, from);
  return result.changes === 1;
}

interface GatewayMessageRow extends MessageRow {
  readonly __rowid: number;
}

interface GatewayScanCursor {
  readonly timestamp: number;
  readonly rowid: number;
}

interface GatewayScanState {
  readonly eligibleUnits: GatewayMessageRow[][];
  eligibleCount: number;
  currentFound: boolean;
  readonly canonicalUsers: Map<string, GatewayMessageRow>;
  readonly canonicalAssistants: Map<string, GatewayMessageRow>;
  legacyAssistant: GatewayMessageRow | undefined;
}

function listGatewayScanPage(
  db: DatabaseSync,
  chatId: string,
  cursor: GatewayScanCursor | undefined,
): readonly GatewayMessageRow[] {
  if (cursor === undefined) {
    return db
      .prepare(SQL_LIST_GATEWAY_PAGE)
      .all(chatId, GATEWAY_SCAN_PAGE_SIZE) as unknown as GatewayMessageRow[];
  }
  return db
    .prepare(SQL_LIST_GATEWAY_PAGE_BEFORE)
    .all(
      chatId,
      cursor.timestamp,
      cursor.timestamp,
      cursor.rowid,
      GATEWAY_SCAN_PAGE_SIZE,
    ) as unknown as GatewayMessageRow[];
}

function appendGatewayUnit(
  state: GatewayScanState,
  rows: readonly GatewayMessageRow[],
  currentUserMessageId: string,
): void {
  state.eligibleUnits.push([...rows]);
  state.eligibleCount += rows.length;
  if (rows.some((row): boolean => row.id === currentUserMessageId)) state.currentFound = true;
}

function scanCanonicalGatewayRow(
  state: GatewayScanState,
  row: GatewayMessageRow,
  currentUserMessageId: string,
): void {
  const turnId = row.client_turn_id;
  if (turnId === null) return;
  if (row.role === "assistant") {
    const user = state.canonicalUsers.get(turnId);
    if (user !== undefined) {
      state.canonicalUsers.delete(turnId);
      appendGatewayUnit(state, [user, row], currentUserMessageId);
      return;
    }
    state.canonicalAssistants.set(turnId, row);
    return;
  }
  if (row.role !== "user") return;
  const assistant = state.canonicalAssistants.get(turnId);
  state.canonicalAssistants.delete(turnId);
  if (row.client_turn_state === "completed" && assistant !== undefined) {
    appendGatewayUnit(state, [row, assistant], currentUserMessageId);
    return;
  }
  if (row.client_turn_state === "completed") {
    state.canonicalUsers.set(turnId, row);
  } else if (row.id === currentUserMessageId) {
    appendGatewayUnit(state, [row], currentUserMessageId);
  }
}

function scanLegacyGatewayRow(
  state: GatewayScanState,
  row: GatewayMessageRow,
  currentUserMessageId: string,
): void {
  if (row.role === "system") return;
  if (row.role === "assistant") {
    state.legacyAssistant = row;
    return;
  }
  if (row.role !== "user") return;
  const assistant = state.legacyAssistant;
  state.legacyAssistant = undefined;
  if (assistant !== undefined) {
    appendGatewayUnit(state, [row, assistant], currentUserMessageId);
  } else if (row.id === currentUserMessageId) {
    appendGatewayUnit(state, [row], currentUserMessageId);
  }
}

function gatewayScanCanStop(
  state: GatewayScanState,
  currentUserMessageId: string,
  limit: number,
): boolean {
  const currentSatisfied = currentUserMessageId.length === 0 || state.currentFound;
  return state.eligibleCount >= limit && state.canonicalUsers.size === 0 && currentSatisfied;
}

function scanGatewayPage(
  state: GatewayScanState,
  page: readonly GatewayMessageRow[],
  currentUserMessageId: string,
  limit: number,
): boolean {
  for (const row of page) {
    if (row.client_turn_id === null) {
      scanLegacyGatewayRow(state, row, currentUserMessageId);
    } else {
      scanCanonicalGatewayRow(state, row, currentUserMessageId);
    }
    if (gatewayScanCanStop(state, currentUserMessageId, limit)) return false;
  }
  return true;
}

function compareGatewayRows(left: GatewayMessageRow, right: GatewayMessageRow): number {
  return left.timestamp - right.timestamp || left.__rowid - right.__rowid;
}

function compareGatewayUnits(
  left: readonly GatewayMessageRow[],
  right: readonly GatewayMessageRow[],
): number {
  const leftAnchor = left.at(0);
  const rightAnchor = right.at(0);
  if (leftAnchor === undefined || rightAnchor === undefined) return left.length - right.length;
  return compareGatewayRows(leftAnchor, rightAnchor);
}

function selectGatewayUnits(
  units: readonly (readonly GatewayMessageRow[])[],
  limit: number,
  currentUserMessageId: string,
): readonly GatewayMessageRow[] {
  const newestFirst = [...units];
  newestFirst.sort((left, right): number => -compareGatewayUnits(left, right));
  const selected: GatewayMessageRow[][] = [];
  const mandatory = newestFirst.find((unit): boolean =>
    unit.some((row): boolean => row.id === currentUserMessageId),
  );
  let selectedCount = 0;
  if (mandatory !== undefined && mandatory.length <= limit) {
    selected.push([...mandatory]);
    selectedCount = mandatory.length;
  }
  for (const unit of newestFirst) {
    if (unit === mandatory) continue;
    if (unit.length > limit - selectedCount) break;
    selected.push([...unit]);
    selectedCount += unit.length;
    if (selectedCount === limit) break;
  }
  selected.sort(compareGatewayUnits);
  return selected.flat();
}

function collectGatewayRows(
  db: DatabaseSync,
  chatId: string,
  currentUserMessageId: string,
  limit: number,
): readonly GatewayMessageRow[] {
  const state: GatewayScanState = {
    eligibleUnits: [],
    eligibleCount: 0,
    currentFound: false,
    canonicalUsers: new Map(),
    canonicalAssistants: new Map(),
    legacyAssistant: undefined,
  };
  let cursor: GatewayScanCursor | undefined;
  while (!gatewayScanCanStop(state, currentUserMessageId, limit)) {
    const page = listGatewayScanPage(db, chatId, cursor);
    if (page.length === 0) break;
    if (!scanGatewayPage(state, page, currentUserMessageId, limit)) break;
    if (page.length < GATEWAY_SCAN_PAGE_SIZE) break;
    const oldest = page.at(-1);
    if (oldest === undefined) break;
    cursor = { timestamp: oldest.timestamp, rowid: oldest.__rowid };
  }
  return selectGatewayUnits(state.eligibleUnits, limit, currentUserMessageId);
}

export function listGatewayMessagesLimited(
  db: DatabaseSync,
  chatId: string,
  currentUserMessageId: string,
  limit: number,
): readonly ChatMessage[] {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw invalidRequest("limit must be a positive integer.");
  }
  return collectGatewayRows(db, chatId, currentUserMessageId, limit).map(rowToMessage);
}

export function recoverInterruptedClientTurns(db: DatabaseSync): void {
  db.prepare(
    `
      UPDATE chat_messages
      SET client_turn_state = 'failed'
      WHERE role = 'user' AND client_turn_id IS NOT NULL AND client_turn_state = 'pending'
    `,
  ).run();
}

export function insertMessage(
  db: DatabaseSync,
  id: string,
  msg: NewChatMessage,
  redactString: (s: string) => string,
  clientTurnId?: string,
  clientTurnState?: "pending",
  clientTurnContentDigest?: string,
): ChatMessage {
  validateMessage(msg);
  const chatExists = db.prepare(SQL_CHAT_EXISTS).get(msg.chatId) !== undefined;
  if (!chatExists) throw notFound("Chat");
  const shortResult = processShortResult(msg.shortResult, redactString);
  const groundedAnswer = processGroundedAnswer(msg.groundedAnswer, redactString);
  const groundedPreviewCitations = null;
  const row = db
    .prepare(SQL_INSERT)
    .get(
      id,
      msg.chatId,
      msg.role,
      msg.content,
      msg.timestamp,
      msg.runId ?? null,
      msg.workflowId ?? null,
      msg.workflowStatus ?? null,
      shortResult,
      msg.taskType ?? null,
      groundedAnswer,
      groundedPreviewCitations,
      clientTurnId ?? null,
      clientTurnState ?? null,
      clientTurnContentDigest ?? null,
    ) as unknown as MessageRow;
  return rowToMessage(row);
}

export function attachGroundedAnswer(
  db: DatabaseSync,
  id: string,
  answer: GroundedAnswer,
  previewCitations: readonly StoredPdfCitationPreviewCitation[] | undefined,
  redactString: (s: string) => string,
): ChatMessage {
  const groundedAnswer = processGroundedAnswer(answer, redactString);
  const groundedPreviewCitations = processGroundedPreviewCitations(previewCitations);
  const row = db
    .prepare(
      `
        UPDATE chat_messages
        SET grounded_answer_json = ?, grounded_preview_citations_json = ?
        WHERE id = ? AND role = 'assistant'
        RETURNING ${COLUMNS}
      `,
    )
    .get(groundedAnswer, groundedPreviewCitations, id) as unknown as MessageRow | undefined;
  if (row === undefined) throw notFound("Message");
  return rowToMessage(row);
}

export function findGroundedPreviewCitations(
  db: DatabaseSync,
  id: string,
): readonly StoredPdfCitationPreviewCitation[] | undefined {
  const row = db.prepare(SQL_FIND_BY_ID).get(id) as unknown as MessageRow | undefined;
  return row === undefined
    ? undefined
    : parseGroundedPreviewCitations(row.grounded_preview_citations_json);
}

// Issue #66 — Partial PATCH on a system run-summary message. Builds a dynamic SET clause from the
// supplied fields so absent fields are not overwritten. shortResult goes through the existing
// redact+truncate pipeline. workflowStatus and taskType are validated before SQL is built. An
// empty patch is an invalid_request — the route surface guards this earlier, but the store layer
// also fails-closed.
// A legacy turn (no clientTurnId) rejected AFTER admission has no settle surface: the ledger
// no-ops without a turn id, so the just-admitted user row must be discarded or every rejected
// request leaves an orphaned message and a retry duplicates it. The WHERE clause fails closed:
// ledger rows (client_turn_id set) and non-user rows are never deletable through this path.
const SQL_DISCARD_LEGACY_TURN_USER = `
DELETE FROM chat_messages
WHERE id = ? AND chat_id = ? AND role = 'user' AND client_turn_id IS NULL
`;

export function discardLegacyTurnUserMessage(db: DatabaseSync, chatId: string, id: string): void {
  db.prepare(SQL_DISCARD_LEGACY_TURN_USER).run(id, chatId);
}

export function updateMessage(
  db: DatabaseSync,
  id: string,
  patch: UpdateChatMessagePatch,
  redactString: (s: string) => string,
): ChatMessage {
  const sets: string[] = [];
  const args: (string | null)[] = [];
  if (patch.workflowStatus !== undefined) {
    if (!STATUSES.has(patch.workflowStatus)) throw invalidRequest("Invalid workflowStatus.");
    sets.push("workflow_status = ?");
    args.push(patch.workflowStatus);
  }
  if (patch.shortResult !== undefined) {
    sets.push("short_result = ?");
    args.push(processShortResult(patch.shortResult, redactString));
  }
  if (patch.taskType !== undefined) {
    validateTaskType(patch.taskType);
    sets.push("task_type = ?");
    args.push(patch.taskType);
  }
  if (sets.length === 0) {
    throw invalidRequest("PATCH body must include at least one updatable field.");
  }
  const sql = `
    UPDATE chat_messages
    SET ${sets.join(", ")}
    WHERE id = ? AND role = 'system' AND run_id IS NOT NULL AND length(run_id) > 0
    RETURNING ${COLUMNS}
  `;
  const row = db.prepare(sql).get(...args, id) as unknown as MessageRow | undefined;
  if (row === undefined) throw notFound("Message");
  return rowToMessage(row);
}

function initialAssistantResponseVersion(row: MessageRow): ChatAssistantResponseVersion {
  return { version: 1, content: row.content, timestamp: row.timestamp };
}

export function createAssistantResponseVersion(
  db: DatabaseSync,
  id: string,
  content: string,
  timestamp: number,
): ChatMessage {
  if (content.length === 0) throw invalidRequest("Content is required.");
  const current = db.prepare(SQL_FIND_BY_ID).get(id) as unknown as MessageRow | undefined;
  if (current?.role !== "assistant") throw notFound("Message");
  if (current.grounded_answer_json !== null) {
    throw invalidRequest("Grounded assistant responses cannot be regenerated.");
  }
  const existing = parseAssistantResponseVersions(current) ?? [
    initialAssistantResponseVersion(current),
  ];
  if (existing.length >= MAX_ASSISTANT_RESPONSE_VERSIONS) {
    throw invalidRequest("Assistant response version limit reached.");
  }
  const previous = existing.at(-1);
  if (previous === undefined) {
    throw new UiStoreError("INTERNAL", "Stored assistant response versions are invalid.", 500);
  }
  const next: ChatAssistantResponseVersion = {
    version: previous.version + 1,
    content,
    timestamp,
    supersedesVersion: previous.version,
  };
  const versions = [...existing, next];
  const updated = db
    .prepare(SQL_VERSION_ASSISTANT_CONTENT)
    .get(content, timestamp, JSON.stringify(versions), id) as unknown as MessageRow | undefined;
  if (updated === undefined) throw notFound("Message");
  return rowToMessage(updated);
}
