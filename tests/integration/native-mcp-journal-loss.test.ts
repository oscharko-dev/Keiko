import { createOpenCodeV2HistoryProjection } from "../../packages/keiko-server/src/coding-runtime/opencodeV2History.js";
import { connectExternalMcp, createMcpRelayEndpoint } from "@oscharko-dev/keiko-mcp";
import type {
  ExternalMcpConnection,
  ManagedMcpInvocationContext,
} from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { createBufferedServerLogSink } from "../support/buffered-server-log.js";
import { buildUiStoreOverDatabase } from "../../packages/keiko-server/src/store/db.js";
import { runMigrations } from "../../packages/keiko-server/src/store/schema.js";
import { createCodingRuntimeSnapshotStore } from "../../packages/keiko-server/src/coding-runtime/codingRuntimeSnapshotStore.js";
import {
  createNativeMcpMutationJournal,
  type NativeMcpMutationJournal,
} from "../../packages/keiko-server/src/coding-runtime/opencodeNativeMcpMutationJournal.js";

const dispose: (() => void)[] = [];
const clients: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const client of clients.splice(0).reverse()) await client.close();
});
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

async function mcpFixture(loseFirstReply = false): Promise<{
  readonly f: Fixture;
  readonly client: ExternalMcpConnection;
  readonly context: ManagedMcpInvocationContext;
  readonly effects: () => number;
}> {
  const f = fixture();
  let effects = 0;
  let loseReply = loseFirstReply;
  const connection: ExternalMcpConnection = {
    signal: new AbortController().signal,
    tools: [
      {
        name: source.toolName,
        inputSchema: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
          additionalProperties: false,
        },
      },
    ],
    call: () => {
      effects += 1;
      return Promise.resolve({ content: [{ type: "text", text: "synthetic committed effect" }] });
    },
    close: () => Promise.resolve(),
  };
  const endpoint = createMcpRelayEndpoint(connection, { [source.toolName]: "write" });
  clients.push(endpoint);
  const context: ManagedMcpInvocationContext = {
    signal: new AbortController().signal,
    correlationId: identity.runId,
    invocationId: "temporary-relay-request-id",
    beforeEffect: () => true,
    onUncertainMutation: () => undefined,
    beginMutation: (input) =>
      f.owner.begin({ ...source, ...input, runId: identity.runId, beforeEffect: () => true }),
  };
  const client = await connectExternalMcp({
    signal: context.signal,
    correlationId: identity.runId,
    log: { write: () => undefined },
    transport: {
      kind: "remote",
      transport: "streamable-http",
      url: "https://synthetic.example.test/mcp",
      fetch: async (input, init) => {
        const original = new Request(input, init);
        const body = await original.text();
        if (body.length === 0) return endpoint.fetch(original, context);
        const message = JSON.parse(body) as { method: string; params?: Record<string, unknown> };
        const call = message.method === "tools/call";
        if (call)
          message.params = {
            ...message.params,
            _meta: {
              ...(message.params?._meta as Record<string, unknown> | undefined),
              "ai.opencode/sessionID": identity.sessionId,
            },
          };
        const response = await endpoint.fetch(
          new Request(original.url, {
            method: original.method,
            headers: original.headers,
            body: JSON.stringify(message),
            signal: original.signal,
          }),
          context,
        );
        if (call && loseReply) {
          loseReply = false;
          await response.body?.cancel();
          throw new TypeError("Synthetic reply lost after remote commit");
        }
        return response;
      },
    },
  });
  clients.push(client);
  return { f, client, context, effects: () => effects };
}

it("prevents a second effect after the real SDK reply is lost, including a reopened journal owner", async () => {
  const { f, client, context, effects } = await mcpFixture(true);
  expect(f.owner.prepare(request).kind).toBe("prepared");
  await expect(client.call(source.toolName, args, context)).rejects.toThrow();
  const reopened = f.reopen();
  const retry = reopened.prepare({ ...request, callId: "model_retry_call" });
  // Exercise the actual second dispatch if a regression removes the durable barrier.
  if (retry.kind === "prepared") await client.call(source.toolName, args, context);
  expect(effects()).toBe(1);
  expect(retry).toMatchObject({ kind: "blocked", reason: "in-flight" });
  expect(reopened.unsettled(identity.runId)).toBe(true);
});

function producerComplete(f: Fixture, programError: boolean, callId = identity.callId): void {
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
          id: callId,
          name: "execute",
          executed: true,
          native: {},
          time: { created: 2, ran: 3, completed: 4 },
          state: {
            status: "completed",
            input: { code: "synthetic program" },
            content: [{ type: "text", text: "synthetic outcome" }],
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
    )
      f.owner.observeCompletion(
        { runId: identity.runId, messageId: signal.messageId, callId: signal.callId },
        signal.state === "succeeded",
      );
  }
}
it.each([false, true])(
  "counts real SDK effects for distinct inner actions with parent error=%s",
  async (parentError) => {
    const { f, client, context, effects } = await mcpFixture();
    f.owner.prepare(request);
    await client.call(source.toolName, args, context);
    const secondArgs = { text: "second distinct synthetic action" };
    expect(f.owner.prepare({ ...request, argumentsValue: secondArgs }).kind).toBe("prepared");
    await client.call(source.toolName, secondArgs, context);
    expect(effects()).toBe(2);
    producerComplete(f, parentError);
    const nextCall = { ...request, callId: "next_model_call" };
    const retry = f.owner.prepare(nextCall);
    if (parentError) {
      expect(retry).toMatchObject({ kind: "blocked", reason: "unknown-effect" });
      await client.call(source.toolName, args, context);
      expect(effects()).toBe(2);
    } else {
      expect(retry.kind).toBe("prepared");
      await client.call(source.toolName, args, context);
      producerComplete(f, false, nextCall.callId);
      expect(effects()).toBe(3);
      expect(f.owner.unsettled(identity.runId)).toBe(false);
    }
  },
);
it("does not execute the same inner action twice within one producer call", async () => {
  const { f, client, context, effects } = await mcpFixture();
  f.owner.prepare(request);
  await client.call(source.toolName, args, context);
  expect(f.owner.prepare(request)).toMatchObject({
    kind: "replayed",
    record: { phase: "acknowledged" },
  });
  await client.call(source.toolName, args, context);
  expect(effects()).toBe(1);
});
