import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes, randomUUID } from "node:crypto";
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
  AtlassianHttpBodyPort,
  JiraAttachmentSource,
  JiraManagedMutationExecutor,
} from "@oscharko-dev/keiko-connectors";
import {
  fixtureRead,
  fixtureWrite,
  response,
} from "../../../../tests/support/jira-managed-remote.js";
import {
  ARGUMENTS,
  ATTACHED,
  REMOTE_STATE,
  SUCCESS_RECEIPTS,
  mutationRemoteState,
  nativeRead,
  nativeParticipationWrite,
  nativeWrite,
  type MutationRemoteState,
  type SingleMutation,
} from "../../../../tests/support/jira-managed-mutation-scenarios.js";
import { jiraMutationToolId } from "./jiraMutationToolId.js";
import { jiraChatCatalogRoutes } from "./jiraChatCatalogConsumer.js";
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
import { executeJiraChatDraft, jiraDraftChildIntent } from "./jiraChatDraft.js";
import type { AtlassianHttpLifecycleOptions } from "./httpRequestLifecycle.js";
import { buildAtlassianConnectorCredentialDeps } from "./wiring.js";
import { verifyStoredCredential } from "./credentialVerification.js";
import type { AtlassianConnectorCredentialDeps } from "./credentialRoutes.js";
import type { JiraChatToolMutationIntent as ChatToolMutationIntent } from "../store/chatToolMutationTypes.js";
import { jiraChatMutationOutcome } from "./jiraChatMutationOutcome.js";

const cleanup: (() => void | Promise<void>)[] = [];
const BASE_URL = "https://203.0.113.10/context";
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const SINGLE_MUTATIONS = JIRA_MUTATION_OPERATIONS.filter(
  (operation): operation is SingleMutation => operation !== "jira.draft",
);
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
type RemoteMode =
  | "confirmed"
  | "readback-denied"
  | "lost-response"
  | "jira-error-document"
  | "html-error-page"
  | "server-error";
/** The value this synthetic Jira refuses, as Data Center does for a bad option. */
const REJECTED_VALUE = "Rot";
const JIRA_FIELD_ERROR = "Option 'Rot' is not valid.";
const JIRA_ERROR_DOCUMENT = JSON.stringify({
  errorMessages: [],
  errors: { customfield_10000: JIRA_FIELD_ERROR },
});
const REFUSALS: Readonly<Record<string, { readonly status: number; readonly body: string }>> = {
  // Jira validated the whole request and said why (#4176): nothing was applied.
  "jira-error-document": { status: 400, body: JIRA_ERROR_DOCUMENT },
  // A proxy's page is no Jira error document: whether the write was applied is unknown.
  "html-error-page": { status: 400, body: "<html><body>Bad Request</body></html>" },
  "server-error": { status: 503, body: JIRA_ERROR_DOCUMENT },
};
async function scriptedRefusal(mode: RemoteMode, request: Request): Promise<Response | undefined> {
  const refusal = REFUSALS[mode];
  if (refusal === undefined || !(await request.clone().text()).includes(REJECTED_VALUE))
    return undefined;
  return new Response(refusal.body, {
    status: refusal.status,
    headers: { "content-type": "application/json" },
  });
}
/** The same bounded Data Center probes production verification consumes, with no DNS or socket. */
function verificationProbe(path: string): ReturnType<typeof response> | undefined {
  if (path.endsWith("/serverInfo")) {
    return response({
      version: "10.3.26",
      versionNumbers: [10, 3, 26],
      deploymentType: "Data Center",
    });
  }
  if (path.endsWith("/myself")) {
    return response({ name: "synthetic-user", key: "synthetic-key", active: true });
  }
  return undefined;
}
function fixtureReadResult(
  mode: RemoteMode,
  path: string,
  state: MutationRemoteState,
  writes: number,
): ReturnType<typeof fixtureRead> {
  if (mode === "readback-denied" && writes > 0) return response({}, 403);
  return verificationProbe(path) ?? nativeRead(path, state) ?? fixtureRead(path, state);
}
function remote(
  mode: RemoteMode,
  beforeWrite: () => void,
): {
  fetch: typeof fetch;
  state: MutationRemoteState;
  writes: () => number;
} {
  const state = mutationRemoteState();
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
      const refusal = await scriptedRefusal(mode, request);
      if (refusal !== undefined) return refusal;
      const result =
        request.method === "GET"
          ? fixtureReadResult(mode, path, state, writes)
          : await fixtureWriteResult(request, path, state);
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
/** A governed upload reaches Jira as one multipart POST that carries the XSRF opt-out header. */
async function fixtureWriteResult(
  request: Request,
  path: string,
  state: MutationRemoteState,
): Promise<ReturnType<typeof fixtureWrite>> {
  const participation = nativeParticipationWrite(request, state);
  if (participation !== undefined) return participation;
  if (
    path.includes("/worklog") &&
    new URL(request.url).searchParams.get("adjustEstimate") !== "leave"
  )
    throw new TypeError("Worklogs must retain the existing remaining estimate");
  if (!request.headers.get("content-type")?.startsWith("multipart/form-data; boundary=keiko-")) {
    const text = await request.text();
    return nativeWrite(path, text, state) ?? fixtureWrite(path, text, state);
  }
  expect(request.headers.get("x-atlassian-token")).toBe("no-check");
  expect(request.method).toBe("POST");
  return fixtureWrite(path, undefined, state, {
    bytes: new Uint8Array(await request.arrayBuffer()),
  });
}
async function mutationCredentials(
  fetchImpl: typeof fetch,
  activityLog: ReturnType<typeof createBufferedServerLogSink>,
  verifyConnection = true,
): Promise<{
  credentials: AtlassianConnectorCredentialDeps;
  metadata: AtlassianCredentialMetadata;
}> {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), "keiko-jira-mutation-custody-"));
  cleanup.push(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  const credentials = buildAtlassianConnectorCredentialDeps({
    configPath: join(directory, "gateway.json"),
    env: { KEIKO_ATLASSIAN_CONNECTOR_CREDENTIALS_KEY: randomBytes(32).toString("base64") },
    egress: () => undefined,
    fetchImpl,
    activityLog,
  });
  const metadata = credentials.custody.create(
    {
      provider: "jira",
      deployment: "data-center",
      authScheme: "bearer-pat",
      displayName: "Synthetic mutation Jira",
      baseUrl: BASE_URL,
      apiToken: ["synthetic", "test", "pat"].join("-"),
      livePodCreationRequestId: randomUUID(),
    },
    "a".repeat(64),
  );
  if (!verifyConnection) return { credentials, metadata };
  expect(await verifyStoredCredential(credentials, metadata, "mutation-fixture-verification")).toBe(
    "ok",
  );
  const verified = credentials.custody.getMetadata(metadata.authRef);
  if (verified === undefined) throw new Error("Expected verified synthetic Jira metadata");
  expect(verified).toMatchObject({ livePod: { verificationStatus: "ok" } });
  return { credentials, metadata: verified };
}
async function fixture(
  mode: RemoteMode = "confirmed",
  afterAcknowledgement?: "binding-revoked" | "cancelled",
  initialOperation?: JiraMutationOperation,
): Promise<{
  invoke: (
    operation: JiraMutationOperation,
    args?: CatalogJsonObject,
  ) => Promise<CatalogToolDispatchOutcome>;
  intent: () => ChatToolMutationIntent;
  journal: ReturnType<typeof createChatToolMutationStore>;
  writes: () => number;
  state: MutationRemoteState;
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
  jira.state.isWatching = initialOperation === "jira.unwatch";
  jira.state.hasVoted = initialOperation === "jira.unvote";
  const { credentials, metadata } = await mutationCredentials(jira.fetch, db.logs);
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
    const shared = {
      journal: db.journal,
      intent: activeIntent,
      httpPortFactory: (lifecycle: AtlassianHttpLifecycleOptions): AtlassianHttpBodyPort =>
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
    };
    if (operation !== "jira.draft") return executeJiraChatMutation({ ...shared, execute });
    // The draft itself is never journaled; its one synthetic item is what reaches Jira.
    activeInvocation = jiraDraftChildIntent(activeIntent, "one").invocationId;
    return executeJiraChatDraft({
      ...shared,
      arguments: args,
      deselected: [],
      context,
      connection: { deployment: "data-center", baseUrl: BASE_URL },
    });
  };
  const provider = createJiraProviderForCatalog<CatalogHandlerContext<ConversationConsumer>>(
    () => ({
      deployment: "data-center",
      baseUrl: BASE_URL,
      http: vi.fn(() => {
        throw new Error("Mutation must use the journal-owned HTTP port");
      }),
      attachmentSource: (): ReturnType<JiraAttachmentSource> => {
        const sha256 = createHash("sha256").update(ATTACHED).digest("hex");
        return Promise.resolve({
          ok: true,
          content: { name: "report.txt", bytes: ATTACHED, sha256 },
        });
      },
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
    routes: jiraChatCatalogRoutes(JIRA_MUTATION_OPERATIONS).map(({ name, alias }) => ({
      name,
      alias,
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
      const projected = managed.projection.tools.find(
        (tool) => tool.toolRef.canonicalId === jiraMutationToolId(operation),
      );
      if (projected === undefined) throw new TypeError("Expected offered mutation identity");
      const call = gateway.bind({ id, name: projected.alias, arguments: args });
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

it.each(SINGLE_MUTATIONS)(
  "executes %s through the real gateway/binder/SDK and durable journal",
  async (operation) => {
    const f = await fixture("confirmed", undefined, operation);
    expect(await f.invoke(operation)).toMatchObject({
      kind: "settled",
      result: {
        status: "completed",
        data: {
          outcome: "succeeded",
          ...SUCCESS_RECEIPTS[operation],
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
      /synthetic-test-pat|203\.0\.113\.10|synthetic-ref/u,
    );
    expect(f.logs.lines().join()).not.toMatch(
      /synthetic-test-pat|203\.0\.113\.10|Synthetic comment|SYN-1/u,
    );
  },
);
it.each(SINGLE_MUTATIONS)(
  "keeps %s unconfirmed when readback is denied and blocks further writes",
  async (operation) => {
    const f = await fixture("readback-denied", undefined, operation);
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
it.each(SINGLE_MUTATIONS)(
  "never repeats %s after losing the response to an applied mutation",
  async (operation) => {
    const f = await fixture("lost-response", undefined, operation);
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
function create(value: string): CatalogJsonObject {
  return {
    projectId: "10000",
    issueTypeId: "10001",
    fields: { summary: "Changed", customfield_10000: value },
  };
}
it("returns Jira's field error and lets the corrected retry succeed in the same turn (#4176)", async () => {
  const f = await fixture("jira-error-document");

  const refused = await f.invoke("jira.create", create(REJECTED_VALUE));

  // Data Center validates a whole request before applying anything: its error document is a
  // definitive rejection, so the outcome is `rejected` and Jira's field id and message reach the model.
  expect(refused).toMatchObject({
    kind: "settled",
    result: {
      status: "failed",
      data: {
        outcome: "rejected",
        reason: "field-validation",
        fieldErrors: [{ fieldId: "customfield_10000", message: JIRA_FIELD_ERROR }],
      },
    },
  });
  expect(f.writes()).toBe(1);
  expect(f.state.fields).not.toMatchObject({ customfield_10000: REJECTED_VALUE });
  expect(f.journal.find(f.intent().invocationId)).toMatchObject({
    phase: "settled",
    outcome: "rejected",
    httpStatus: 400,
  });

  const corrected = await f.invoke("jira.create", create("Required"));

  expect(corrected).toMatchObject({
    kind: "settled",
    result: { status: "completed", data: { outcome: "succeeded", issueKey: "SYN-1" } },
  });
  expect(f.writes()).toBe(2);
  expect(f.state).toMatchObject(REMOTE_STATE["jira.create"]);
  expect(f.logs.lines().join()).not.toContain(JIRA_FIELD_ERROR);
});
it.each(["html-error-page", "server-error"] as const)(
  "keeps the turn blocked after %s: the write may have been applied (#2953)",
  async (mode) => {
    const f = await fixture(mode);

    const refused = await f.invoke("jira.create", create(REJECTED_VALUE));

    expect(refused).toMatchObject({
      kind: "settled",
      result: { status: "failed", data: { outcome: "unknown" } },
    });
    expect(await f.invoke("jira.create", create("Required"))).toMatchObject({
      kind: "settled",
      result: { data: { outcome: "not-dispatched", reason: "conflict" } },
    });
    expect(f.writes()).toBe(1);
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

/** The registered settled line of the one mutation a fixture ran. */
function settledMutationLine(
  logs: ReturnType<typeof createBufferedServerLogSink>,
): Record<string, unknown> {
  const settled = logs.events.filter(
    (event) => event.op === "chat.tool-mutation" && event.extra?.event === "settled",
  );
  expect(settled).toHaveLength(1);
  return expectRegisteredActivityLogLine(
    "chat.tool-mutation",
    formatActivityLogProofLine(settled[0] ?? {}),
  );
}
// #4173: a write Keiko refuses before dispatch settles `rejected` with no HTTP status. Its settled
// line must name Keiko's closed reason, or the log cannot say why the model's write failed.
it("names Keiko's closed reason on the settled line of a write refused before dispatch", async () => {
  const f = await fixture();

  await f.invoke("jira.assign", {
    issueKey: "SYN-1",
    assigneeName: "synthetic-user",
    clearAssignee: true,
  });

  expect(f.writes()).toBe(0);
  const line = settledMutationLine(f.logs);
  // The refusal now names its argument (#4173); the line keeps only the closed class, never the
  // argument's name or the sentence the model reads.
  expect(line).toMatchObject({
    outcome: "rejected",
    refusalReason: "field-validation",
    fieldValidation: "required-field",
  });
  expect(line).not.toHaveProperty("rejection");
  expect(f.logs.lines().join()).not.toMatch(
    /synthetic-user|SYN-1|assigneeName|Nothing was changed/u,
  );
});
it("names the closed field-validation class of a field Keiko refused before dispatch", async () => {
  const f = await fixture();

  await f.invoke("jira.create", {
    projectId: "10000",
    issueTypeId: "10001",
    fields: { summary: "Changed", customfield_99999: "synthetic-value" },
  });

  expect(f.writes()).toBe(0);
  expect(settledMutationLine(f.logs)).toMatchObject({
    outcome: "rejected",
    refusalReason: "field-validation",
    fieldValidation: "invalid-field",
  });
  expect(f.logs.lines().join()).not.toMatch(/customfield_99999|synthetic-value/u);
});
it("records no local refusal reason once Jira itself answered the write", async () => {
  const f = await fixture("jira-error-document");

  await f.invoke("jira.create", create(REJECTED_VALUE));

  const line = settledMutationLine(f.logs);
  expect(line).toMatchObject({ outcome: "rejected", rejection: "jira-error-document" });
  expect(line).not.toHaveProperty("refusalReason");
  expect(line).not.toHaveProperty("fieldValidation");
});
it("runs a backlog draft through the real gateway/binder/SDK as journaled item creates (#4178)", async () => {
  const f = await fixture();
  expect(await f.invoke("jira.draft")).toMatchObject({
    kind: "settled",
    result: {
      status: "completed",
      data: {
        outcome: "succeeded",
        createdCount: 1,
        items: [
          {
            ref: "one",
            state: "created",
            issueKey: "SYN-1",
            browseUrl: `${BASE_URL}/browse/SYN-1`,
          },
        ],
      },
    },
  });
  expect(f.writes()).toBe(1);
  expect(f.state).toMatchObject(REMOTE_STATE["jira.create"]);
  const child = jiraDraftChildIntent(f.intent(), "one");
  expect(f.journal.find(child.invocationId)).toMatchObject({
    operation: "jira.create",
    outcome: "succeeded",
  });
  expect(f.journal.find(f.intent().invocationId)).toBeUndefined();
  expect(await f.invoke("jira.draft")).toMatchObject({
    kind: "settled",
    result: { data: { outcome: "succeeded", items: [{ ref: "one", state: "created" }] } },
  });
  expect(f.writes()).toBe(1);
  expect(f.logs.lines().join()).not.toMatch(/synthetic-test-pat|203\.0\.113\.10|SYN-1/u);
});

it("requires saved target admission before the SDK fixture can dispatch any HTTP", async () => {
  const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(Response.json({})));
  const logs = createBufferedServerLogSink();
  const { credentials, metadata } = await mutationCredentials(fetchImpl, logs, false);
  expect(
    await credentials.httpBodyPortFactory(
      metadata,
      "mutation-missing-admission",
    )({
      method: "GET",
      url: `${BASE_URL}/rest/api/2/myself`,
      timeoutMs: 1000,
      maxBodyBytes: 4096,
    }),
  ).toEqual({ kind: "network-error" });
  expect(fetchImpl).not.toHaveBeenCalled();
  const admission = logs.events.filter((event) => event.op === "atlassian.target.admission");
  expect(admission).toHaveLength(1);
  for (const event of admission) {
    const line = formatActivityLogProofLine(event);
    expect(expectRegisteredActivityLogLine("atlassian.target.admission", line)).toMatchObject({
      source: "saved-data-center",
      outcome: "blocked",
    });
    expect(line).not.toMatch(/203\.0\.113\.10|synthetic-test-pat|Authorization|Bearer/u);
    expect(line).not.toContain(metadata.authRef);
  }
});

it("treats a draft whose items all exist already as a completed no-op, not a tool error (#4178)", async () => {
  const f = await fixture();
  expect(await f.invoke("jira.draft")).toMatchObject({
    kind: "settled",
    result: { status: "completed", data: { outcome: "succeeded", createdCount: 1 } },
  });
  expect(f.writes()).toBe(1);
  // The same backlog under another local reference is a new draft action with a fresh journal:
  // its one item is reconciled to the issue that exists, so Jira receives nothing.
  const [first] = ARGUMENTS["jira.draft"].items as readonly Record<string, unknown>[];
  const rerun = { items: [{ ...first, ref: "uno" }] } as unknown as CatalogJsonObject;
  expect(await f.invoke("jira.draft", rerun)).toMatchObject({
    kind: "settled",
    result: {
      status: "completed",
      data: {
        outcome: "not-dispatched",
        existingCount: 1,
        createdCount: 0,
        failedCount: 0,
        items: [{ ref: "uno", state: "existing", issueKey: "SYN-1" }],
      },
    },
  });
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
