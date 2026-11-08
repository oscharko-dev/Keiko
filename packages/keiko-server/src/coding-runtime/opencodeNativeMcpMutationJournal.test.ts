import { createOpenCodeV2HistoryProjection } from "./opencodeV2History.js";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import * as jiraProvider from "../atlassian/jiraManagedProvider.js";
import { createBufferedServerLogSink } from "../../../../tests/support/buffered-server-log.js";
import { buildUiStoreOverDatabase } from "../store/db.js";
import { runMigrations } from "../store/schema.js";
import { createCodingRuntimeSnapshotStore } from "./codingRuntimeSnapshotStore.js";
import { jiraOperationBindingForTool } from "../atlassian/jiraManagedProvider.js";
import { jiraMutationToolResult } from "../atlassian/jiraMutationResult.js";
import type { ManagedMcpToolResult } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { CHAT_TOOL_TRANSCRIPT_MAX_BYTES } from "../store/chatToolTranscript.js";
import { CHAT_TOOL_TURN_BUDGET } from "../chat-tool-turn-budget.js";
import {
  createNativeMcpMutationJournal,
  bindNativeMcpHumanTurn,
  nativeMcpInvocationId,
  type NativeMcpMutationJournal,
} from "./opencodeNativeMcpMutationJournal.js";

const dispose: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const close of dispose.splice(0)) close();
});
const source = {
  serverName: "synthetic",
  toolName: "create_note",
  configurationDigest: "c".repeat(64),
};
const identity = {
  runId: "run-one",
  sessionId: "ses_one",
  messageId: "msg_assistant_one",
  callId: "call_one",
};
const args = { text: "synthetic private note" };
const request = { ...source, ...identity, argumentsValue: args, mcpActionDigest: "f".repeat(64) };

const jiraRequest = {
  ...request, serverName: "jira", toolName: "jira.comment",
  argumentsValue: { issueKey: "SYN-1", body: "Synthetic comment" },
};
function jiraResult(outcome: "succeeded" | "succeeded-unconfirmed" | "rejected"): ManagedMcpToolResult {
  const result = jiraMutationToolResult(outcome,
    outcome === "succeeded" ? undefined : "field-validation",
    outcome === "rejected" ? {} : { issueKey: "SYN-1", commentId: "10002" }, false,
    outcome === "rejected" ? { fieldErrors: [{ fieldId: "body", fieldName: "Comment",
      message: "Synthetic required comment" }] } : undefined);
  const operationBinding = jiraOperationBindingForTool("jira.comment");
  if (operationBinding === undefined) throw new Error("Expected Jira binding");
  return { ...result, data: { ...result.data, operationBinding } };
}
function jiraPermit(f: Fixture) {
  f.owner.prepare(jiraRequest);
  const permit = f.owner.begin({ ...jiraRequest, localProvider: "jira", beforeEffect: () => true });
  if (permit?.retainProviderResult === undefined) throw new Error("Expected private result capture");
  return { permit, retain: permit.retainProviderResult };
}
function jiraRead(f: Fixture, signal = new AbortController().signal) {
  const capture = f.owner.beginReadCapture({
    runId: identity.runId, toolName: "jira.projects", argumentsValue: {}, signal,
    localProvider: "jira",
  });
  if (capture?.retainProviderResult === undefined) throw new Error("Expected private read capture");
  return { capture, retain: capture.retainProviderResult };
}
function jiraReadResult(failed = false): ManagedMcpToolResult {
  const operationBinding = jiraOperationBindingForTool("jira.projects");
  if (operationBinding === undefined) throw new Error("Expected Jira read binding");
  return failed
    ? { isError: true, data: { outcome: "failed", reason: "permission-denied", operationBinding } }
    : { data: { outcome: "succeeded", operationBinding,
      items: [{ id: "10000", key: "SYN", name: "Synthetic project" }], startAt: 0, nextStartAt: 1 } };
}
function jiraExchange(f: Fixture) {
  const turn = f.store.codingHistory?.nativeTurn(identity.runId);
  return turn === undefined ? undefined :
    f.history.detail(turn.chatId, "a".repeat(64))?.messages
      .find((message) => message.id === turn.userMessageId)?.toolTranscript?.exchanges[0];
}

function forcedOccupancy(f: Fixture, occupancy: { readonly bytes: number; readonly exchangeCount: number }): void {
  const original = f.history.nativeToolTranscript;
  vi.spyOn(f.history, "nativeToolTranscript").mockImplementation((...args) => ({
    ...original(...args), occupancy: () => occupancy,
  }));
}

interface Fixture {
  readonly db: DatabaseSync;
  readonly history: NonNullable<ReturnType<typeof buildUiStoreOverDatabase>["codingHistory"]>;
  readonly owner: NativeMcpMutationJournal;
  readonly store: ReturnType<typeof buildUiStoreOverDatabase>;
  readonly reopen: () => NativeMcpMutationJournal;
}
function fixture(redactString?: (value: string) => string): Fixture {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  runMigrations(db);
  const store = buildUiStoreOverDatabase(db, redactString === undefined ? {} : { redactString });
  dispose.push(() => {
    store.close();
  });
  const snapshots = createCodingRuntimeSnapshotStore(db);
  const digest = "a".repeat(64);
  const now = new Date(1000).toISOString();
  snapshots.create({
    schemaVersion: "1",
    runId: "run-one",
    state: "running",
    revision: 1,
    requestedMode: "governed-assist",
    runtimeSource: "keiko-sidecar",
    modelSource: "keiko-model-gateway",
    createdAt: now,
    updatedAt: now,
    taskDigest: digest,
    workspaceDigest: digest,
    operatorDigest: digest,
    authorityDigest: digest,
    bindingDigest: digest,
    provenanceDigest: digest,
    toolCallCount: 0,
    patchByteCount: 0,
    modelRequestCount: 0,
  });
  const history = store.codingHistory;
  if (history === undefined) throw new Error("Expected Coding History");
  history.begin({
    projectPath: process.cwd(),
    title: "Synthetic",
    modelId: "synthetic",
    workspaceId: "workspace-one",
    taskId: "task-one",
    branch: "main",
    operatorDigest: digest,
    runId: "run-one",
    intent: "Create note",
  });
  const reopen = (): NativeMcpMutationJournal =>
    createNativeMcpMutationJournal({ store, snapshots, log: createBufferedServerLogSink() });
  const owner = reopen();
  owner.bindTurn("run-one", "msg_user_one", "Create note");
  return { db, history, owner, store, reopen };
}
// The permit is issued at admission; the durable record becomes dispatched only at the transport
// gate (`dispatch`), so a failure before the frame leaves the process stays provably effect-free.
function begin(f: Fixture): NonNullable<ReturnType<NativeMcpMutationJournal["begin"]>> {
  const permit = f.owner.begin({ ...request, beforeEffect: () => true });
  if (permit === undefined) throw new Error("Expected durable dispatch permit");
  if (permit.dispatch?.() !== true) throw new Error("Expected the dispatch gate to admit");
  return permit;
}
function dispatchRefused(
  owner: NativeMcpMutationJournal,
  input: Parameters<NativeMcpMutationJournal["begin"]>[0],
): boolean {
  const permit = owner.begin(input);
  return permit === undefined || permit.dispatch?.() !== true;
}

it("does not confirm success until the committed native producer tool completes", () => {
  const f = fixture();
  expect(f.owner.prepare(request).kind).toBe("prepared");
  const permit = begin(f);
  expect(permit.invocationId).toBe(nativeMcpInvocationId(request));
  permit.acknowledge();
  expect(f.owner.unsettled(identity.runId)).toBe(true);
  expect(f.owner.observeCompletion({ ...identity, callId: "foreign_call" }, true)).toBe("ignored");
  expect(f.owner.observeCompletion(identity, true)).toBe("confirmed");
  expect(f.owner.unsettled(identity.runId)).toBe(false);
  expect(f.owner.observeCompletion(identity, true)).toBe("ignored");
});

it.each([false, true])("retains a validated read across reload without a write journal row, failed=%s", (failed) => {
  const f = fixture();
  const { capture, retain } = jiraRead(f);
  expect(jiraExchange(f)).toBeUndefined();
  const result = jiraReadResult(failed);
  retain(result);
  capture.release();
  f.reopen();
  expect(jiraExchange(f)).toMatchObject({
    call: { id: capture.invocationId, name: "jira_projects" },
    result: { status: failed ? "failed" : "completed", effectStarted: false, data: result.data },
  });
  expect(jiraExchange(f)).not.toHaveProperty("mutationOutcome");
  expect(jiraExchange(f)).not.toHaveProperty("resultBinding");
  expect(jiraExchange(f)).not.toHaveProperty("operationBinding");
  expect(jiraExchange(f)?.result?.page).toEqual(failed ? null : {
    truncated: true, reason: "result-cap", cursor: null,
  });
  expect(f.db.prepare("SELECT COUNT(*) AS count FROM chat_tool_mutations").get()?.count).toBe(0);
  expect(f.owner.observeCompletion(identity, true)).toBe("ignored");
  expect(f.owner.unsettled(identity.runId)).toBe(false);
});

it("retains read scope denial without provider data, write state or a journal row", () => {
  const f = fixture();
  const { capture } = jiraRead(f);
  if (capture.retainLocalFailure === undefined) throw new Error("Expected local refusal capture");
  capture.retainLocalFailure("connector-scope-missing");
  capture.release();
  expect(jiraExchange(f)?.result).toMatchObject({
    status: "denied", reason: "effect-denied", effectStarted: false, data: null,
  });
  expect(jiraExchange(f)).not.toHaveProperty("mutationOutcome");
  expect(f.db.prepare("SELECT COUNT(*) AS count FROM chat_tool_mutations").get()?.count).toBe(0);
});

it.each([
  ["connector-scope-missing", "denied", "effect-denied"],
  ["protocol-error", "failed", "handler-failed"],
  ["tool-error", "failed", "handler-failed"],
  ["deadline-exceeded", "timeout", "deadline-exceeded"],
  ["aborted", "cancelled", "parent-cancelled"],
] as const)("retains local read %s as %s rather than inventing a permission refusal", (failure, status, reason) => {
  const f = fixture();
  const { capture } = jiraRead(f);
  capture.retainRelayFailure(failure);
  capture.release();
  f.reopen();
  expect(jiraExchange(f)?.result).toMatchObject({ status, reason, effectStarted: false, data: null, page: null });
  expect(jiraExchange(f)).not.toHaveProperty("mutationOutcome");
  expect(f.db.prepare("SELECT COUNT(*) AS count FROM chat_tool_mutations").get()?.count).toBe(0);
  expect(f.owner.observeCompletion(identity, true)).toBe("ignored");
  expect(f.owner.unsettled(identity.runId)).toBe(false);
});

it("enforces the scope-only local failure API at runtime before retaining any outcome", () => {
  const f = fixture();
  const { capture } = jiraRead(f);
  for (const reason of ["protocol-error", "deadline-exceeded", "aborted", "arbitrary-provider-text", null]) {
    expect(() => Reflect.apply(capture.retainLocalFailure, undefined, [reason])).toThrow();
    expect(jiraExchange(f)).toBeUndefined();
  }
  for (const reason of ["arbitrary-provider-text", "constructor", null]) {
    expect(() => Reflect.apply(capture.retainRelayFailure, undefined, [reason])).toThrow();
    expect(jiraExchange(f)).toBeUndefined();
  }
  capture.retainLocalFailure("connector-scope-missing");
  capture.release();
  expect(jiraExchange(f)?.result).toMatchObject({ status: "denied", reason: "effect-denied" });
});

it("retains a native POST search timeout as a read with no journal effect or recovery state", () => {
  const f = fixture();
  const capture = f.owner.beginReadCapture({
    runId: identity.runId, toolName: "jira.search-post", argumentsValue: { jql: "project = SYN" },
    signal: new AbortController().signal, localProvider: "jira",
  });
  if (capture === undefined) throw new Error("Expected POST read capture");
  vi.spyOn(jiraProvider, "jiraOperationForTool").mockImplementation(() => {
    throw new Error("Do not replace the admitted descriptor while retaining a read failure");
  });
  capture.retainRelayFailure("deadline-exceeded");
  capture.release();
  f.reopen();
  expect(jiraExchange(f)).toMatchObject({
    call: { name: "jira_search_post" },
    result: { status: "timeout", reason: "deadline-exceeded", effectStarted: false, data: null },
  });
  expect(jiraExchange(f)).not.toHaveProperty("mutationOutcome");
  expect(f.db.prepare("SELECT COUNT(*) AS count FROM chat_tool_mutations").get()?.count).toBe(0);
  expect(f.owner.observeCompletion(identity, true)).toBe("ignored");
  expect(f.owner.unsettled(identity.runId)).toBe(false);
});

it.each([false, true])("preserves validated provider read data when a later technical failure arrives, failed=%s", (failed) => {
  const f = fixture();
  const { capture, retain } = jiraRead(f);
  const result = jiraReadResult(failed);
  retain(result);
  capture.retainRelayFailure("protocol-error");
  capture.release();
  expect(jiraExchange(f)?.result).toMatchObject({ status: failed ? "failed" : "completed", data: result.data });
  expect(f.db.prepare("SELECT COUNT(*) AS count FROM chat_tool_mutations").get()?.count).toBe(0);
});

it("does not overwrite a retained explicit scope denial with a later transport failure", () => {
  const f = fixture();
  const { capture } = jiraRead(f);
  capture.retainLocalFailure("connector-scope-missing");
  capture.retainRelayFailure("protocol-error");
  capture.release();
  expect(jiraExchange(f)?.result).toMatchObject({ status: "denied", reason: "effect-denied", data: null });
});

it("refuses late technical error retention after release, cancellation or accepted-turn change", () => {
  const f = fixture();
  const released = jiraRead(f);
  released.capture.release();
  expect(() => released.capture.retainRelayFailure("protocol-error")).toThrow();
  const controller = new AbortController();
  const cancelled = jiraRead(f, controller.signal);
  controller.abort();
  expect(() => cancelled.capture.retainRelayFailure("aborted")).toThrow();
  cancelled.capture.release();
  const stale = jiraRead(f);
  f.owner.bindTurn(identity.runId, "msg_next_human", "New human instruction");
  expect(() => stale.capture.retainRelayFailure("deadline-exceeded")).toThrow("owner changed");
  stale.capture.release();
  expect(jiraExchange(f)).toBeUndefined();
  expect(f.db.prepare("SELECT COUNT(*) AS count FROM chat_tool_mutations").get()?.count).toBe(0);
});

it("validates read delivery and history against the admitted snapshot after registry drift", () => {
  const f = fixture();
  const { capture, retain } = jiraRead(f);
  const data = jiraReadResult();
  vi.spyOn(jiraProvider, "jiraOperationForTool").mockImplementation(() => {
    throw new Error("Do not resolve the current registry for an admitted read");
  });
  retain(data);
  capture.release();
  f.reopen();
  expect(jiraExchange(f)?.result?.data).toEqual(data.data);
});

it("refuses read capture after release, cancellation or a changed accepted turn", () => {
  const f = fixture();
  const released = jiraRead(f);
  released.capture.release();
  expect(() => released.retain(jiraReadResult())).toThrow();
  const controller = new AbortController();
  const cancelled = jiraRead(f, controller.signal);
  controller.abort();
  expect(() => cancelled.retain(jiraReadResult())).toThrow();
  cancelled.capture.release();
  const stale = jiraRead(f);
  f.owner.bindTurn(identity.runId, "msg_next_human", "New human instruction");
  expect(() => stale.retain(jiraReadResult())).toThrow("owner changed");
  stale.capture.release();
  expect(jiraExchange(f)).toBeUndefined();
});

it("refuses unknown or mutation tools on the read-only retention path", () => {
  const f = fixture();
  for (const toolName of ["jira.guessed", "jira.comment"]) {
    expect(() => f.owner.beginReadCapture({ runId: identity.runId, toolName,
      argumentsValue: {}, signal: new AbortController().signal, localProvider: "jira" })).toThrow();
  }
  expect(f.owner.beginReadCapture({ runId: "foreign-run", toolName: "jira.projects",
    argumentsValue: {}, signal: new AbortController().signal, localProvider: "jira" })).toBeUndefined();
  expect(jiraExchange(f)).toBeUndefined();
});

it("shares reservation capacity between reads and writes without reserving an effect for reads", () => {
  const f = fixture();
  forcedOccupancy(f, { bytes: 0, exchangeCount: CHAT_TOOL_TURN_BUDGET.maxToolCalls - 1 });
  const first = jiraRead(f);
  expect(() => jiraRead(f)).toThrow();
  f.owner.prepare(jiraRequest);
  expect(() => f.owner.begin({ ...jiraRequest, localProvider: "jira", beforeEffect: () => true })).toThrow();
  first.capture.release();
  const second = jiraRead(f);
  expect(second.capture.invocationId).not.toBe(first.capture.invocationId);
  second.capture.release();
  expect(f.store.chatToolMutations?.find(nativeMcpInvocationId(jiraRequest))?.outcome).toBe("not-dispatched");
});

it("refuses read admission when known transcript capacity or durable data is unavailable", () => {
  const f = fixture();
  const turn = f.history.nativeTurn(identity.runId);
  if (turn === undefined) throw new Error("Expected native turn");
  f.db.prepare("UPDATE chat_messages SET tool_transcript_json='' WHERE id=?").run(turn.userMessageId);
  expect(() => jiraRead(f)).toThrow();
  expect(f.db.prepare("SELECT COUNT(*) AS count FROM chat_tool_mutations").get()?.count).toBe(0);
});

it("persists a validated Jira success before delivery and derives its state from the same native journal", () => {
  const f = fixture();
  const { permit, retain } = jiraPermit(f);
  expect(jiraExchange(f)).toBeUndefined(); // No artificial start while the provider is running.
  expect(permit.dispatch?.()).toBe(true);
  retain(jiraResult("succeeded"));
  expect(jiraExchange(f)).toMatchObject({
    call: { id: permit.invocationId, name: "jira_comment" },
    mutationOutcome: "unknown",
    result: { status: "completed", data: { outcome: "succeeded", issueKey: "SYN-1", commentId: "10002" } },
  });
  permit.acknowledge();
  expect(jiraExchange(f)?.mutationOutcome).toBe("succeeded-unconfirmed");
  expect(f.reopen().observeCompletion(identity, true)).toBe("confirmed");
  expect(jiraExchange(f)?.mutationOutcome).toBe("succeeded");
  expect(jiraExchange(f)).not.toHaveProperty("resultBinding");
  expect(f.reopen().prepare(jiraRequest).kind).toBe("replayed");
  expect(dispatchRefused(f.reopen(), { ...jiraRequest, beforeEffect: () => true })).toBe(true);
});

it("retains known Jira identities before recovery without treating an error result as an ACK", () => {
  const f = fixture();
  const { permit, retain } = jiraPermit(f);
  expect(permit.dispatch?.()).toBe(true);
  retain(jiraResult("succeeded-unconfirmed"));
  permit.fail();
  expect(f.store.chatToolMutations?.find(permit.invocationId)).toMatchObject({
    phase: "settled", outcome: "unknown", protocolOutcome: null,
  });
  expect(jiraExchange(f)).toMatchObject({
    mutationOutcome: "unknown",
    result: { status: "failed", reason: "provider-reported-error",
      data: { issueKey: "SYN-1", commentId: "10002" } },
  });
  expect(f.reopen().prepare({ ...jiraRequest, callId: "retry" })).toEqual({
    kind: "blocked", reason: "unknown-effect",
  });
});

it("retains preflight refusal and permits a corrected new call only after the unopened gate is released", () => {
  const f = fixture();
  const { permit, retain } = jiraPermit(f);
  retain(jiraResult("rejected"));
  permit.release?.();
  expect(jiraExchange(f)).toMatchObject({ mutationOutcome: "not-dispatched",
    result: { effectStarted: false, data: { outcome: "rejected", reason: "field-validation",
      fieldErrors: [{ fieldId: "body", fieldName: "Comment", message: "Synthetic required comment" }] } } });
  expect(f.reopen().prepare({ ...jiraRequest, callId: "corrected",
    argumentsValue: { issueKey: "SYN-1", body: "Corrected comment" } }).kind).toBe("prepared");
});

it("refuses mismatched result contracts without leaving a synthetic History start", () => {
  const f = fixture();
  const { retain } = jiraPermit(f);
  const result = jiraResult("rejected");
  expect(() => retain({ ...result, data: { ...result.data, operationBinding: {
    identity: "foreign", contractDigest: "0".repeat(64),
  } } })).toThrow();
  expect(jiraExchange(f)).toBeUndefined();
});

it("does not give a configured external server a local Jira capture hook based on its name", () => {
  const f = fixture();
  f.owner.prepare(jiraRequest);
  expect(f.owner.begin({ ...jiraRequest, beforeEffect: () => true })?.retainProviderResult).toBeUndefined();
});

it("uses the admitted immutable result snapshot after the installed contract changes", () => {
  const f = fixture();
  const { permit, retain } = jiraPermit(f);
  const data = jiraResult("succeeded-unconfirmed");
  permit.dispatch?.();
  vi.spyOn(jiraProvider, "jiraOperationForTool").mockImplementation(() => {
    throw new Error("Current registry must not be consulted for the captured result");
  });
  retain(data);
  permit.fail();
  f.reopen();
  expect(jiraExchange(f)?.result?.data).toMatchObject({ issueKey: "SYN-1", commentId: "10002" });
  expect(jiraExchange(f)?.mutationOutcome).toBe("unknown");
});

it("cannot promote an acknowledged provider result when its durable capture fails", () => {
  const f = fixture();
  const original = f.history.nativeToolTranscript;
  vi.spyOn(f.history, "nativeToolTranscript").mockImplementation((...args) => ({
    ...original(...args),
    capture: () => { throw new Error("Synthetic durable store unavailable"); },
  }));
  const { permit, retain } = jiraPermit(f);
  permit.dispatch?.();
  expect(() => retain(jiraResult("succeeded"))).toThrow("durable store unavailable");
  permit.fail();
  expect(f.store.chatToolMutations?.find(permit.invocationId)).toMatchObject({
    phase: "settled", outcome: "unknown", protocolOutcome: null,
  });
  expect(jiraExchange(f)).toBeUndefined();
  expect(f.reopen().prepare({ ...jiraRequest, callId: "retry" }).kind).toBe("blocked");
});

it("projects the same native journal receipt when the Coding user row also has a canonical turn ref", () => {
  const f = fixture();
  const { permit, retain } = jiraPermit(f);
  const turn = f.store.codingHistory?.nativeTurn(identity.runId);
  if (turn === undefined) throw new Error("Expected native turn");
  f.db.prepare("UPDATE chat_messages SET client_turn_id=? WHERE id=?")
    .run("synthetic-canonical-turn", turn.userMessageId);
  permit.dispatch?.();
  retain(jiraResult("succeeded"));
  permit.acknowledge();
  expect(jiraExchange(f)?.mutationOutcome).toBe("succeeded-unconfirmed");
  expect(f.owner.observeCompletion(identity, true)).toBe("confirmed");
  expect(jiraExchange(f)?.mutationOutcome).toBe("succeeded");
});

it.each([false, true])("persists local scope denial with dispatched=%s and no fabricated provider data", (dispatched) => {
  const f = fixture();
  const { permit } = jiraPermit(f);
  if (dispatched) permit.dispatch?.();
  if (permit.retainLocalFailure === undefined) throw new Error("Expected local refusal capture");
  permit.retainLocalFailure("connector-scope-missing");
  if (dispatched) permit.fail();
  else permit.release?.();
  f.reopen();
  expect(jiraExchange(f)).toMatchObject({
    mutationOutcome: dispatched ? "unknown" : "not-dispatched",
    result: { status: "denied", reason: "effect-denied", effectStarted: dispatched, data: null },
  });
});

it("keeps journal identity private when displayed arguments are redacted", () => {
  const f = fixture((value) => value.replaceAll("Synthetic comment", "[REDACTED]"));
  const { permit, retain } = jiraPermit(f);
  permit.dispatch?.();
  retain(jiraResult("succeeded"));
  permit.acknowledge();
  f.owner.observeCompletion(identity, true);
  expect(jiraExchange(f)).toMatchObject({
    call: { arguments: { body: "[REDACTED]" } }, mutationOutcome: "succeeded",
  });
  expect(jiraExchange(f)).not.toHaveProperty("nativeArgumentsDigest");
});

it("looks up the exact captured invocation after earlier undispatched refusals", () => {
  const f = fixture();
  for (let index = 0; index < 34; index++) {
    const refused = { ...jiraRequest, callId: `refused-${index}`,
      argumentsValue: { ...jiraRequest.argumentsValue, body: `Refused ${index}` } };
    f.owner.prepare(refused);
    f.owner.begin({ ...refused, beforeEffect: () => true })?.release?.();
  }
  const { permit, retain } = jiraPermit(f);
  permit.dispatch?.();
  retain(jiraResult("succeeded"));
  permit.acknowledge();
  f.owner.observeCompletion(identity, true);
  expect(jiraExchange(f)?.mutationOutcome).toBe("succeeded");
});

it.each([
  { bytes: CHAT_TOOL_TRANSCRIPT_MAX_BYTES, exchangeCount: 0 },
  { bytes: 0, exchangeCount: CHAT_TOOL_TURN_BUDGET.maxToolCalls },
])("refuses an exhausted transcript before issuing a native dispatch permit: %j", (occupancy) => {
  const f = fixture();
  forcedOccupancy(f, occupancy);
  f.owner.prepare(jiraRequest);
  expect(() => f.owner.begin({ ...jiraRequest, localProvider: "jira", beforeEffect: () => true })).toThrow();
  expect(f.store.chatToolMutations?.find(nativeMcpInvocationId(jiraRequest))).toMatchObject({
    phase: "settled", outcome: "not-dispatched", protocolOutcome: null,
  });
  expect(jiraExchange(f)).toBeUndefined();
});

it("reserves the remaining transcript slot across concurrent preflights and releases it on refusal", () => {
  const f = fixture();
  forcedOccupancy(f, {
    bytes: 0, exchangeCount: CHAT_TOOL_TURN_BUDGET.maxToolCalls - 1,
  });
  const { permit } = jiraPermit(f);
  const second = { ...jiraRequest, callId: "second", argumentsValue: { issueKey: "SYN-1", body: "Second" } };
  f.owner.prepare(second);
  expect(() => f.owner.begin({ ...second, localProvider: "jira", beforeEffect: () => true })).toThrow();
  permit.release?.();
  const third = { ...second, callId: "third", argumentsValue: { issueKey: "SYN-1", body: "Third" } };
  f.owner.prepare(third);
  const next = f.owner.begin({ ...third, localProvider: "jira", beforeEffect: () => true });
  expect(next?.retainProviderResult).toBeDefined();
  next?.release?.();
});

it("keeps generic Chat APIs isolated and refuses capture after the accepted Coding turn changes", () => {
  const f = fixture();
  const { permit, retain } = jiraPermit(f);
  const turn = f.history.nativeTurn(identity.runId);
  if (turn === undefined) throw new Error("Expected native turn");
  expect(f.store.findMessageById(turn.userMessageId)).toBeUndefined();
  expect(() => f.store.updateChatToolTranscript(turn.userMessageId, {
    kind: "started", call: { id: "forbidden-generic", name: "jira_comment", arguments: jiraRequest.argumentsValue },
  }, "generic-chat")).toThrow();
  expect(() => f.history.nativeToolTranscript(identity.runId, { ...turn, userMessageId: "foreign-message" })).toThrow();
  const port = f.history.nativeToolTranscript(identity.runId, turn);
  f.owner.bindTurn(identity.runId, "msg_next_human", "New human instruction");
  expect(() => port.occupancy()).toThrow("owner changed");
  expect(() => retain(jiraResult("rejected"))).toThrow("owner changed");
  permit.release?.();
});

it("does not treat unreadable stored transcript JSON as empty available capacity", () => {
  const f = fixture();
  const turn = f.history.nativeTurn(identity.runId);
  if (turn === undefined) throw new Error("Expected native turn");
  f.db.prepare("UPDATE chat_messages SET tool_transcript_json='' WHERE id=?").run(turn.userMessageId);
  f.owner.prepare(jiraRequest);
  expect(() => f.owner.begin({ ...jiraRequest, localProvider: "jira", beforeEffect: () => true })).toThrow();
  expect(f.store.chatToolMutations?.find(nativeMcpInvocationId(jiraRequest))).toMatchObject({
    phase: "settled", outcome: "not-dispatched", protocolOutcome: null,
  });
});

it("keeps an unconsumed successful relay response fenced after reopening the owner", () => {
  const f = fixture();
  f.owner.prepare(request);
  begin(f).acknowledge();
  const reopened = f.reopen();
  expect(reopened.unsettled(identity.runId)).toBe(true);
  expect(reopened.prepare({ ...request, callId: "call_retry" })).toEqual({
    kind: "blocked",
    reason: "in-flight",
  });
  expect(dispatchRefused(reopened, { ...request, beforeEffect: () => true })).toBe(true);
});

it("permits a genuinely new Call ID after confirmation, never a replay of the same call", () => {
  const f = fixture();
  f.owner.prepare(request);
  begin(f).acknowledge();
  f.owner.observeCompletion(identity, true);
  expect(f.owner.prepare(request).kind).toBe("replayed");
  expect(dispatchRefused(f.owner, { ...request, beforeEffect: () => true })).toBe(true);
  expect(f.owner.prepare({ ...request, callId: "call_two" }).kind).toBe("prepared");
  expect(begin(f).invocationId).toBe(nativeMcpInvocationId({ ...request, callId: "call_two" }));
});

it("retains distinct unknown and succeeded-unconfirmed outcomes and never upgrades a late acknowledgement", () => {
  const f = fixture();
  f.owner.prepare(request);
  const permit = begin(f);
  permit.acknowledge();
  permit.fail();
  expect(f.store.chatToolMutations?.find(permit.invocationId)?.outcome).toBe(
    "succeeded-unconfirmed",
  );
  expect(f.owner.observeCompletion(identity, true)).toBe("uncertain");
  expect(f.owner.prepare({ ...request, callId: "call_retry" })).toEqual({
    kind: "blocked",
    reason: "unknown-effect",
  });
});

it("matches only the current real Human turn and refuses changed arguments or session identity", () => {
  const f = fixture();
  f.owner.prepare(request);
  f.owner.bindTurn(identity.runId, "msg_user_two", "A second human turn");
  f.owner.prepare({ ...request, messageId: "msg_assistant_two", callId: "call_two" });
  expect(
    f.owner.begin({ ...request, sessionId: "ses_foreign", beforeEffect: () => true }),
  ).toBeUndefined();
  expect(
    f.owner.begin({ ...request, argumentsValue: { text: "changed" }, beforeEffect: () => true }),
  ).toBeUndefined();
  expect(begin(f).invocationId).toBe(
    nativeMcpInvocationId({ ...request, messageId: "msg_assistant_two", callId: "call_two" }),
  );
});

it("refuses an ambiguous pair of identically prepared writes before either remote effect", () => {
  const f = fixture();
  f.owner.prepare(request);
  f.owner.prepare({ ...request, callId: "call_two" });
  expect(f.owner.begin({ ...request, beforeEffect: () => true })).toBeUndefined();
  expect(f.owner.unsettled(identity.runId)).toBe(false);
});

it("does not reopen a slash-command binding through an internal continuation", () => {
  const f = fixture();
  const run = { runId: identity.runId, nativeMutationTurnBound: false };
  bindNativeMcpHumanTurn(f.owner, run, {
    messageId: "msg_verification",
    text: "internal continuation",
    origin: "verification-continuation",
  });
  expect(run.nativeMutationTurnBound).toBe(false);
  expect(f.store.codingHistory?.nativeTurn(identity.runId)?.turnRef).toBe("msg_user_one");
  bindNativeMcpHumanTurn(f.owner, run, {
    messageId: "msg_next_human",
    text: "Actual new human request",
    origin: undefined,
  });
  expect(run.nativeMutationTurnBound).toBe(true);
  expect(f.store.codingHistory?.nativeTurn(identity.runId)?.turnRef).toBe("msg_next_human");
});
it("rechecks the exact prepared call's authority before any effect", () => {
  const f = fixture();
  f.owner.prepare(request);
  const admitted: unknown[] = [];
  expect(
    dispatchRefused(f.owner, {
      ...request,
      beforeEffect: (value) => {
        admitted.push(value);
        return false;
      },
    }),
  ).toBe(true);
  expect(admitted).toEqual([{ ...identity, mcpActionDigest: request.mcpActionDigest }]);
  expect(f.owner.unsettled(identity.runId)).toBe(false);
});
it("settles an unconsumed observed success honestly and never upgrades it on a late observation", () => {
  const f = fixture();
  f.owner.prepare(request);
  begin(f).acknowledge();
  f.owner.settleUnconfirmed(identity.runId);
  expect(f.store.chatToolMutations?.find(nativeMcpInvocationId(request))).toMatchObject({
    phase: "settled",
    outcome: "succeeded-unconfirmed",
  });
  expect(f.owner.observeCompletion(identity, true)).toBe("uncertain");
  expect(f.owner.prepare({ ...request, callId: "new_retry" })).toMatchObject({
    kind: "blocked",
    reason: "unknown-effect",
  });
});

function producerCompletion(f: Fixture, status: "completed" | "error", programError = false): void {
  const projection = createOpenCodeV2HistoryProjection({
    runId: identity.runId,
    toolProfile: "native",
    activityLog: createBufferedServerLogSink(),
  });
  const messages = [
    { id: "msg_user_one", type: "user", time: { created: 1 }, text: "Synthetic human task" },
    {
      id: identity.messageId,
      type: "assistant",
      time: { created: 2 },
      content: [
        {
          type: "tool",
          id: identity.callId,
          name: "execute",
          executed: true,
          native: {},
          time: { created: 2, ran: 3, completed: 4 },
          state: {
            status,
            input: { code: "await syntheticWrite(); throw new Error('synthetic');" },
            content: [{ type: "text", text: "synthetic tool outcome" }],
            metadata: { error: programError },
          },
        },
      ],
    },
  ];
  for (const event of projection.project(identity.sessionId, messages, undefined)) {
    const signal = projection.takeSignal(event);
    if (
      signal?.kind === "tool" &&
      signal.messageId !== undefined &&
      (signal.state === "succeeded" || signal.state === "failed")
    ) {
      f.owner.observeCompletion(
        { runId: identity.runId, messageId: signal.messageId, callId: signal.callId },
        signal.state === "succeeded",
      );
    }
  }
}
it.each(["producer-tool", "outer-program"] as const)(
  "blocks a replay when %s fails after the MCP response was consumed",
  (failure) => {
    const f = fixture();
    let effects = 0;
    f.owner.prepare(request);
    const permit = begin(f);
    effects += 1;
    permit.acknowledge();
    producerCompletion(
      f,
      failure === "producer-tool" ? "error" : "completed",
      failure === "outer-program",
    );
    const retry = f.owner.prepare({ ...request, callId: "next_model_call" });
    if (retry.kind === "prepared") {
      begin(f);
      effects += 1;
    }
    expect(effects).toBe(1);
    expect(retry).toMatchObject({ kind: "blocked", reason: "unknown-effect" });
    expect(f.store.chatToolMutations?.find(permit.invocationId)).toMatchObject({
      outcome: "succeeded-unconfirmed",
    });
  },
);
it("keeps distinct inner mutations under one real parent call until its persisted completion", () => {
  const f = fixture();
  f.owner.prepare(request);
  const first = begin(f);
  first.acknowledge();
  const secondRequest = {
    ...request,
    argumentsValue: { text: "Different explicitly admitted mutation" },
  };
  expect(f.owner.prepare(secondRequest).kind).toBe("prepared");
  const second = f.owner.begin({ ...secondRequest, beforeEffect: () => true });
  expect(second?.invocationId).not.toBe(first.invocationId);
  expect(second?.dispatch?.()).toBe(true);
  second?.acknowledge();
  expect(f.owner.prepare({ ...request, callId: "another_model_call" }).kind).toBe("blocked");
  producerCompletion(f, "completed");
  expect(f.owner.unsettled(identity.runId)).toBe(false);
  expect(f.owner.prepare({ ...request, callId: "another_model_call" }).kind).toBe("prepared");
});

it("retains the first budget admission through a permission replay without changing mutation identity", () => {
  const f = fixture();
  const first = { ...request, mcpActionDigest: "d".repeat(64) };
  const retry = { ...request, mcpActionDigest: "e".repeat(64) };
  expect(nativeMcpInvocationId(first)).toBe(nativeMcpInvocationId(retry));
  expect(f.owner.prepare(first).kind).toBe("prepared");
  expect(f.owner.prepare(retry)).toMatchObject({
    kind: "replayed",
    record: { consumer: { mcpActionDigest: first.mcpActionDigest } },
  });
  let observed: unknown;
  const permit = f.owner.begin({
    ...retry,
    beforeEffect: (value) => {
      observed = value;
      return true;
    },
  });
  expect(permit).toBeDefined();
  expect(permit?.dispatch?.()).toBe(true);
  expect(observed).toMatchObject({ ...identity, mcpActionDigest: first.mcpActionDigest });
});

it("retains legacy receipts without admitting a mutation with missing budget identity", () => {
  const f = fixture();
  f.owner.prepare({ ...request, mcpActionDigest: undefined });
  let readmissions = 0;
  expect(
    f.owner.begin({
      ...request,
      beforeEffect: () => {
        readmissions += 1;
        return true;
      },
    }),
  ).toBeUndefined();
  expect(readmissions).toBe(0);
});

it("settles a call that failed before the transport gate as not dispatched, with no effect", () => {
  const f = fixture();
  f.owner.prepare(request);
  const permit = f.owner.begin({ ...request, beforeEffect: () => true });
  expect(permit?.release).toBeDefined();
  expect(f.store.chatToolMutations?.find(nativeMcpInvocationId(request))).toMatchObject({
    phase: "prepared",
  });
  permit?.release?.();
  expect(f.store.chatToolMutations?.find(nativeMcpInvocationId(request))).toMatchObject({
    phase: "settled",
    outcome: "not-dispatched",
  });
  expect(f.owner.unsettled(identity.runId)).toBe(false);
  expect(f.owner.prepare({ ...request, callId: "model_retry" }).kind).toBe("prepared");
});

it("never calls a dispatched record effect-free: release after dispatch stays unconfirmed", () => {
  const f = fixture();
  f.owner.prepare(request);
  const permit = begin(f);
  permit.release?.();
  expect(f.store.chatToolMutations?.find(permit.invocationId)).toMatchObject({
    phase: "settled",
    outcome: "unknown",
  });
  expect(f.owner.prepare({ ...request, callId: "model_retry" })).toMatchObject({
    kind: "blocked",
    reason: "unknown-effect",
  });
});
