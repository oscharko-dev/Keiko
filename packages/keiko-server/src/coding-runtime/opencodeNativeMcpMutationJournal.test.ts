import { createOpenCodeV2HistoryProjection } from "./opencodeV2History.js";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { createBufferedServerLogSink } from "../../../../tests/support/buffered-server-log.js";
import { buildUiStoreOverDatabase } from "../store/db.js";
import { runMigrations } from "../store/schema.js";
import { createCodingRuntimeSnapshotStore } from "./codingRuntimeSnapshotStore.js";
import {
  createNativeMcpMutationJournal,
  bindNativeMcpHumanTurn,
  nativeMcpInvocationId,
  type NativeMcpMutationJournal,
} from "./opencodeNativeMcpMutationJournal.js";

const dispose: (() => void)[] = [];
afterEach(() => {
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

interface Fixture {
  readonly owner: NativeMcpMutationJournal;
  readonly store: ReturnType<typeof buildUiStoreOverDatabase>;
  readonly reopen: () => NativeMcpMutationJournal;
}
function fixture(): Fixture {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  runMigrations(db);
  const store = buildUiStoreOverDatabase(db);
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
  return { owner, store, reopen };
}
function begin(f: Fixture): NonNullable<ReturnType<NativeMcpMutationJournal["begin"]>> {
  const permit = f.owner.begin({ ...request, beforeEffect: () => true });
  if (permit === undefined) throw new Error("Expected durable dispatch permit");
  return permit;
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
  expect(reopened.begin({ ...request, beforeEffect: () => true })).toBeUndefined();
});

it("permits a genuinely new Call ID after confirmation, never a replay of the same call", () => {
  const f = fixture();
  f.owner.prepare(request);
  begin(f).acknowledge();
  f.owner.observeCompletion(identity, true);
  expect(f.owner.prepare(request).kind).toBe("replayed");
  expect(f.owner.begin({ ...request, beforeEffect: () => true })).toBeUndefined();
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
    f.owner.begin({
      ...request,
      beforeEffect: (value) => {
        admitted.push(value);
        return false;
      },
    }),
  ).toBeUndefined();
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
  expect(
    f.owner.begin({
      ...retry,
      beforeEffect: (value) => {
        observed = value;
        return true;
      },
    }),
  ).toBeDefined();
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
