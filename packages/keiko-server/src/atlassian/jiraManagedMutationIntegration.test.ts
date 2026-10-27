import { DatabaseSync } from "node:sqlite";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security/hashing";
import { createGatewayToolCatalogBridge } from "@oscharko-dev/keiko-model-gateway";
import {
  JIRA_MUTATION_OPERATIONS,
  type JiraMutationOperation,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type {
  AtlassianCredentialMetadata,
  JiraManagedMutationExecutor,
} from "@oscharko-dev/keiko-connectors";
import {
  fixtureRead,
  fixtureWrite,
  response,
  type SyntheticJira,
} from "../../../../tests/support/jira-managed-remote.js";
import { createBufferedServerLogSink } from "../../../../tests/support/buffered-server-log.js";
import {
  expectRegisteredActivityLogLine,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";
import { buildUiStoreOverDatabase } from "../store/index.js";
import { runMigrations } from "../store/schema.js";
import { createChatToolMutationStore } from "../store/chatToolMutations.js";
import { createManagedProviderCatalog } from "../tool-catalog/managedProviderCatalog.js";
import type {
  CatalogHandlerContext,
  CatalogHandlerResult,
  CatalogToolDispatchOutcome,
} from "../tool-catalog/catalogToolPorts.js";
import {
  createConversationConsumerFixture,
  type ConversationConsumer,
  type ConversationAction,
} from "../tool-catalog/__fixtures__/conversationConsumer.js";
import { createJiraProviderForCatalog } from "./jiraManagedProvider.js";
import { executeJiraChatMutation } from "./jiraChatMutation.js";
import { buildAtlassianConnectorCredentialDeps } from "./wiring.js";
import type { AtlassianConnectorCredentialDeps } from "./credentialRoutes.js";
import type { ChatToolMutationIntent } from "../store/chatToolMutationTypes.js";
import { jiraChatMutationOutcome } from "./jiraChatMutationOutcome.js";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const ARGUMENTS: Readonly<Record<JiraMutationOperation, CatalogJsonObject>> = {
  "jira.create": {
    projectId: "10000",
    issueTypeId: "10001",
    fields: { summary: "Changed", customfield_10000: "Required" },
  },
  "jira.edit": { issueKey: "SYN-1", fields: { summary: "Changed" } },
  "jira.assign": { issueKey: "SYN-1", assigneeName: "synthetic-user" },
  "jira.comment": { issueKey: "SYN-1", body: "Synthetic comment" },
  "jira.transition": {
    issueKey: "SYN-1",
    transitionId: "31",
    fields: { customfield_10000: "Screen value" },
  },
};
const REMOTE_STATE: Readonly<Record<JiraMutationOperation, object>> = {
  "jira.create": {
    fields: {
      summary: "Changed",
      customfield_10000: "Required",
      project: { id: "10000" },
      issuetype: { id: "10001" },
    },
  },
  "jira.edit": { fields: { summary: "Changed", labels: ["initial"] } },
  "jira.assign": { fields: { assignee: { name: "synthetic-user" } } },
  "jira.comment": { comment: "Synthetic comment" },
  "jira.transition": { fields: { status: { id: "3" }, customfield_10000: "Screen value" } },
};
function database(): {
  journal: ReturnType<typeof createChatToolMutationStore>;
  chatId: string;
  userMessageId: string;
  turnRef: string;
  logs: ReturnType<typeof createBufferedServerLogSink>;
} {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  runMigrations(db);
  const store = buildUiStoreOverDatabase(db);
  cleanup.push(() => {
    store.close();
  });
  const chat = store.createChat(store.createProject(process.cwd()).path, "Synthetic", "model");
  const turn = store.admitChatTurn("synthetic-sdk-turn", {
    chatId: chat.id,
    role: "user",
    content: "synthetic",
    timestamp: 1000,
    runId: undefined,
    workflowId: undefined,
    workflowStatus: undefined,
    shortResult: undefined,
    taskType: undefined,
  });
  if (turn.kind !== "admitted" || turn.userMessage.canonicalTurnRef === undefined)
    throw new Error("Expected admitted synthetic turn");
  const logs = createBufferedServerLogSink();
  return {
    journal: createChatToolMutationStore(db, () => 1000, logs),
    chatId: chat.id,
    userMessageId: turn.userMessage.id,
    turnRef: turn.userMessage.canonicalTurnRef,
    logs,
  };
}
type RemoteMode = "confirmed" | "readback-denied" | "lost-response";
function remote(
  mode: RemoteMode,
  beforeWrite: () => void,
): {
  fetch: typeof fetch;
  state: SyntheticJira;
  writes: () => number;
} {
  const state: SyntheticJira = {
    fields: {
      summary: "Original",
      assignee: { name: "previous-user" },
      status: { id: "1" },
      labels: ["initial"],
    },
    comment: "",
  };
  let writes = 0;
  return {
    state,
    writes: () => writes,
    fetch: async (input, init): Promise<Response> => {
      const request = new Request(input, init);
      expect(request.headers.get("authorization")).toBe(["Bearer", "synthetic-test-pat"].join(" "));
      const path = new URL(request.url).pathname;
      if (request.method !== "GET") {
        beforeWrite();
        writes += 1;
      }
      const result =
        request.method === "GET"
          ? mode === "readback-denied" && writes > 0
            ? response({}, 403)
            : fixtureRead(path, state)
          : fixtureWrite(path, await request.text(), state);
      if (request.method !== "GET" && mode === "lost-response")
        throw new TypeError("Synthetic connection loss after commit");
      if (result.kind !== "response") throw new Error("Expected synthetic HTTP response");
      return new Response(result.status === 204 ? null : result.bodyText, {
        status: result.status,
        headers: { "content-type": "application/json" },
      });
    },
  };
}
function mutationCredentials(fetchImpl: typeof fetch): {
  credentials: AtlassianConnectorCredentialDeps;
  metadata: AtlassianCredentialMetadata;
} {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), "keiko-jira-mutation-custody-"));
  cleanup.push(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  const credentials = buildAtlassianConnectorCredentialDeps({
    configPath: join(directory, "gateway.json"),
    env: { KEIKO_ATLASSIAN_CONNECTOR_CREDENTIALS_KEY: randomBytes(32).toString("base64") },
    egress: () => undefined,
    fetchImpl,
  });
  const metadata = credentials.custody.create(
    {
      provider: "jira",
      deployment: "data-center",
      authScheme: "bearer-pat",
      displayName: "Synthetic mutation Jira",
      baseUrl: "https://jira.example.invalid/context",
      apiToken: ["synthetic", "test", "pat"].join("-"),
      livePodCreationRequestId: randomUUID(),
    },
    "a".repeat(64),
  );
  return { credentials, metadata };
}
async function fixture(
  mode: RemoteMode = "confirmed",
  afterAcknowledgement?: "binding-revoked" | "cancelled",
): Promise<{
  invoke: (
    operation: JiraMutationOperation,
    args?: CatalogJsonObject,
  ) => Promise<CatalogToolDispatchOutcome>;
  intent: () => ChatToolMutationIntent;
  journal: ReturnType<typeof createChatToolMutationStore>;
  writes: () => number;
  state: SyntheticJira;
  logs: ReturnType<typeof createBufferedServerLogSink>;
  offered: unknown;
}> {
  const db = database();
  let activeInvocation = "";
  let activeIntent: ChatToolMutationIntent | undefined;
  let invalidate = (): void => undefined;
  const jira = remote(mode, () => {
    expect(db.journal.find(activeInvocation)?.phase).toBe("dispatched");
  });
  const { credentials, metadata } = mutationCredentials(jira.fetch);
  const executeMutation: JiraManagedMutationExecutor<
    CatalogHandlerContext<ConversationConsumer>
  > = (operation, args, context, execute) => {
    activeInvocation = context.invocationId;
    activeIntent = Object.freeze({
      invocationId: context.invocationId,
      chatId: context.chatId,
      userMessageId: db.userMessageId,
      turnRef: db.turnRef,
      actorId: context.actorId,
      podId: "synthetic-pod",
      bindingGeneration: context.binding.generation,
      credentialGeneration: 1,
      authorityDigest: sha256Hex(context.authority),
      actionDigest: sha256Hex(canonicalise({ operation, args })),
      operation,
      correlationId: context.correlationId,
    });
    return executeJiraChatMutation({
      journal: db.journal,
      intent: activeIntent,
      httpPortFactory: (lifecycle) =>
        credentials.httpBodyPortFactory(metadata, context.correlationId, {
          ...lifecycle,
          onResponse: (request, status): boolean => {
            const observed = lifecycle.onResponse?.(request, status) === true;
            if (request.method !== "GET" && observed) invalidate();
            return observed;
          },
        }),
      beforeEffect: context.beforeEffect,
      beforeMutation: context.beforeEffect,
      execute,
    });
  };
  const provider = createJiraProviderForCatalog<CatalogHandlerContext<ConversationConsumer>>(
    () => ({
      deployment: "data-center",
      baseUrl: "https://jira.example.invalid/context",
      http: vi.fn(() => {
        throw new Error("Mutation must use the journal-owned HTTP port");
      }),
    }),
    JIRA_MUTATION_OPERATIONS,
    executeMutation,
  );
  const managed = await createManagedProviderCatalog<ConversationConsumer>({
    providers: [provider],
    profile: { id: "jira-mutation-fixture", version: 1 },
    log: { primary: db.logs, diagnostics: { record: () => undefined } },
    correlationId: "mutation-admission",
    now: () => 1000,
    routes: JIRA_MUTATION_OPERATIONS.map((name) => ({
      name,
      alias: name.replace(".", "_"),
      catalogAction: name,
      previewAction: (identity): ConversationAction => ({
        ...identity,
        action: "mutation",
        query: name,
      }),
      actionFor: (args, identity): ConversationAction => ({
        ...identity,
        action: "mutation",
        query: canonicalise({ name, args }),
      }),
      resultFor: (data): CatalogHandlerResult => ({
        data,
        page: { truncated: false, reason: "none", cursor: null },
        resultCount: 1,
      }),
    })),
  });
  cleanup.push(() => managed.close());
  const consumer = createConversationConsumerFixture(undefined, managed);
  consumer.context.chatId = db.chatId;
  invalidate = (): void => {
    if (afterAcknowledgement === "cancelled") consumer.abort();
    if (afterAcknowledgement === "binding-revoked") consumer.context.binding.generation++;
  };
  cleanup.push(consumer.dispose);
  let serial = 0;
  const gateway = createGatewayToolCatalogBridge(
    {
      modelId: "synthetic-model",
      messages: [],
      toolCatalog: {
        kind: "bound",
        catalog: managed.catalog,
        projection: managed.projection,
        offered: consumer.binder.offer(),
      },
    },
    () => 1000,
    db.logs,
  );
  return {
    intent: (): ChatToolMutationIntent => {
      if (activeIntent === undefined) throw new Error("Expected mutation intent");
      return activeIntent;
    },
    journal: db.journal,
    writes: jira.writes,
    state: jira.state,
    logs: db.logs,
    offered: gateway.tools,
    invoke: async (operation, args = ARGUMENTS[operation]): Promise<CatalogToolDispatchOutcome> => {
      const id = `model-call-${String(++serial)}`;
      const call = gateway.bind({ id, name: operation.replace(".", "_"), arguments: args });
      return consumer.binder.dispatch(call.invocation, { actionId: id, idempotencyKey: id });
    },
  };
}

it.each(["binding-revoked", "cancelled"] as const)(
  "preserves the durable effect after %s interrupts the actual SDK/binder call",
  async (interruption) => {
    const f = await fixture("confirmed", interruption);
    const outcome = await f.invoke("jira.create");
    if (outcome.kind !== "settled") throw new Error("Expected settled invocation");
    expect(outcome.result).toMatchObject({
      status: interruption === "cancelled" ? "cancelled" : "invalid",
      data: null,
    });
    const expected = f.intent();
    expect(
      jiraChatMutationOutcome({
        result: outcome.result,
        record: f.journal.find(expected.invocationId),
        expected,
      }),
    ).toBe("succeeded-unconfirmed");
    expect(outcome.receipt).toMatchObject({ effectStarted: true, budgetDisposition: "committed" });
    expect(f.writes()).toBe(1);
    expect(f.state).toMatchObject(REMOTE_STATE["jira.create"]);
  },
);

it.each(JIRA_MUTATION_OPERATIONS)(
  "executes %s through the real gateway/binder/SDK and durable journal",
  async (operation) => {
    const f = await fixture();
    expect(await f.invoke(operation)).toMatchObject({
      kind: "settled",
      result: {
        status: "completed",
        data: {
          outcome: "succeeded",
          issueKey: "SYN-1",
          browseUrl: "https://jira.example.invalid/context/browse/SYN-1",
        },
      },
    });
    expect(f.writes()).toBe(1);
    expect(f.state).toMatchObject(REMOTE_STATE[operation]);
    expect(await f.invoke(operation)).toMatchObject({
      kind: "settled",
      result: { data: { outcome: "succeeded", replayed: true } },
    });
    expect(f.writes()).toBe(1);
    expect(JSON.stringify(f.offered)).not.toMatch(
      /synthetic-test-pat|jira\.example|synthetic-ref/u,
    );
    expect(f.logs.lines().join()).not.toMatch(
      /synthetic-test-pat|jira\.example|Synthetic comment|SYN-1/u,
    );
  },
);
it.each(JIRA_MUTATION_OPERATIONS)(
  "keeps %s unconfirmed when readback is denied and blocks further writes",
  async (operation) => {
    const f = await fixture("readback-denied");
    expect(await f.invoke(operation)).toMatchObject({
      kind: "settled",
      result: { status: "failed", data: { outcome: "succeeded-unconfirmed" } },
    });
    expect(await f.invoke(operation)).toMatchObject({
      kind: "settled",
      result: { data: { outcome: "succeeded-unconfirmed", replayed: true } },
    });
    expect(
      await f.invoke("jira.comment", { issueKey: "SYN-1", body: "Different action" }),
    ).toMatchObject({
      kind: "settled",
      result: { data: { outcome: "not-dispatched", reason: "conflict" } },
    });
    expect(f.writes()).toBe(1);
  },
);
it.each(JIRA_MUTATION_OPERATIONS)(
  "never repeats %s after losing the response to an applied mutation",
  async (operation) => {
    const f = await fixture("lost-response");
    expect(await f.invoke(operation)).toMatchObject({
      kind: "settled",
      result: { data: { outcome: "unknown" } },
    });
    expect(await f.invoke(operation)).toMatchObject({
      kind: "settled",
      result: { data: { outcome: "unknown", replayed: true } },
    });
    expect(f.writes()).toBe(1);
    expect(f.state).toMatchObject(REMOTE_STATE[operation]);
  },
);
it("requires explicit clearing and rejects ambiguous assignment through the SDK path", async () => {
  const f = await fixture();
  expect(
    await f.invoke("jira.assign", {
      issueKey: "SYN-1",
      assigneeName: "synthetic-user",
      clearAssignee: true,
    }),
  ).toMatchObject({
    kind: "settled",
    result: { data: { outcome: "rejected", reason: "field-validation" } },
  });
  expect(f.writes()).toBe(0);
  expect(await f.invoke("jira.assign", { issueKey: "SYN-1", clearAssignee: true })).toMatchObject({
    kind: "settled",
    result: { data: { outcome: "succeeded" } },
  });
  expect(f.state.fields.assignee).toBeNull();
  expect(f.writes()).toBe(1);
});

it.each([51, 100])(
  "rejects %s updates at the catalog boundary before journal preparation",
  async (count) => {
    const f = await fixture();
    const prepare = vi.spyOn(f.journal, "prepare");
    await expect(
      f.invoke("jira.edit", {
        issueKey: "SYN-1",
        fields: {},
        updates: Array.from({ length: count }, (_, index) => ({
          fieldId: "labels",
          operation: "add",
          value: `label-${String(index)}`,
        })),
      }),
    ).rejects.toMatchObject({ reason: "invalid-arguments" });
    expect(prepare).not.toHaveBeenCalled();
    expect(f.writes()).toBe(0);
    const rejections = f.logs.events.filter(
      (event) => event.op === "gateway.tool-catalog.rejected",
    );
    expect(rejections).toHaveLength(1);
    for (const event of rejections)
      expect(
        expectRegisteredActivityLogLine(
          "gateway.tool-catalog.rejected",
          formatActivityLogProofLine(event),
        ),
      ).toMatchObject({ reason: "invalid-arguments" });
  },
);
