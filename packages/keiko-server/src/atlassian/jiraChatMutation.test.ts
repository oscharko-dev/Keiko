import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi, type Mock } from "vitest";
import type {
  JiraMutationAttempt,
  JiraMutationOperation,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { JiraAcknowledgedMutationError } from "@oscharko-dev/keiko-connectors";
import { defaultServerDiagnosticSink } from "../diagnostics-log.js";
import { buildUiStoreOverDatabase, createNodeUiStore } from "../store/index.js";
import { runMigrations } from "../store/schema.js";
import { createChatToolMutationStore } from "../store/chatToolMutations.js";
import type { JiraChatToolMutationIntent as ChatToolMutationIntent } from "../store/chatToolMutationTypes.js";
import { createBufferedServerLogSink } from "../../../../tests/support/buffered-server-log.js";
import { executeJiraChatMutation, type JiraChatMutationExecution } from "./jiraChatMutation.js";
import { createGatewayAtlassianHttpBodyPort } from "./httpPort.js";
import { createJiraProviderForCatalog } from "./jiraManagedProvider.js";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
});
function fixture(path = ":memory:"): {
  input: JiraChatMutationExecution;
  close: () => void;
  effects: Mock<typeof fetch>;
  logs: ReturnType<typeof createBufferedServerLogSink>;
} {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  runMigrations(db);
  const store = buildUiStoreOverDatabase(db);
  let closed = false;
  const close = (): void => {
    if (!closed) store.close();
    closed = true;
  };
  cleanup.push(close);
  const chat = store.createChat(store.createProject(process.cwd()).path, "Synthetic", "model");
  const turn = store.admitChatTurn("synthetic-turn", {
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
    throw new Error("Expected turn");
  const logs = createBufferedServerLogSink();
  const journal = createChatToolMutationStore(db, () => 1000, logs);
  const intent: ChatToolMutationIntent = {
    invocationId: "invocation-one",
    chatId: chat.id,
    userMessageId: turn.userMessage.id,
    turnRef: turn.userMessage.canonicalTurnRef,
    actorId: "actor-one",
    podId: "pod-one",
    bindingGeneration: 1,
    credentialGeneration: 1,
    authorityDigest: "a".repeat(64),
    actionDigest: "b".repeat(64),
    operation: "jira.create",
    correlationId: "mutation-one",
  };
  const effects = vi.fn<typeof fetch>(() => {
    expect(journal.find(intent.invocationId)?.phase).toBe("dispatched");
    return Promise.resolve(new Response('{"key":"SYN-1","id":"10001"}', { status: 201 }));
  });
  const input: JiraChatMutationExecution = {
    journal,
    intent,
    httpPortFactory: (lifecycle) =>
      createGatewayAtlassianHttpBodyPort({
        ...lifecycle,
        correlationId: intent.correlationId,
        baseUrl: "https://jira.example.invalid",
        authRef: "synthetic-ref",
        credentials: {
          resolveForExecution: () => ({ scheme: "bearer-pat", apiToken: "synthetic-test-pat" }),
        },
        fetchImpl: effects,
      }),
    beforeEffect: () => true,
    beforeMutation: () => true,
    execute: async (http): Promise<JiraMutationAttempt> => {
      const response = await http({
        method: "POST",
        url: "https://jira.example.invalid/rest/api/2/issue",
        bodyJson: "{}",
        maxBodyBytes: 1000,
        timeoutMs: 1000,
      });
      if (response.kind !== "response" || response.status !== 201 || response.truncated)
        return { ok: false, reason: "unavailable" };
      const parsed = JSON.parse(response.bodyText) as { key: string; id: string };
      return { ok: true, receipt: { issueKey: parsed.key, issueId: parsed.id } };
    },
  };
  return { input, effects, logs, close };
}
it("commits before sending, records acknowledgement, and never repeats a completed invocation", async () => {
  const f = fixture();
  expect(await executeJiraChatMutation(f.input)).toMatchObject({
    data: { outcome: "succeeded", issueKey: "SYN-1" },
  });
  expect(
    await executeJiraChatMutation({
      ...f.input,
      intent: { ...f.input.intent, invocationId: "duplicate-delivery" },
    }),
  ).toMatchObject({ data: { outcome: "succeeded", replayed: true } });
  expect(f.effects).toHaveBeenCalledOnce();
  expect(f.input.journal?.find(f.input.intent.invocationId)).toMatchObject({
    phase: "settled",
    outcome: "succeeded",
    httpStatus: 201,
  });
  expect(f.logs.events.map((event) => event.extra?.event)).toEqual([
    "prepared",
    "dispatched",
    "response",
    "settled",
    "replayed",
  ]);
  expect(f.logs.lines().join()).not.toMatch(/synthetic-test-pat|jira\.example|SYN-1/u);
});
it.each([
  {
    operation: "jira.update-comment",
    path: "api/2/issue/SYN-1/comment/10002",
    method: "PUT",
    status: 200,
    receipt: { issueKey: "SYN-1", commentId: "10002" },
  },
  {
    operation: "jira.create-component",
    path: "api/2/component",
    method: "POST",
    status: 201,
    receipt: { componentId: "37", projectId: "10000", projectKey: "SYN" },
  },
  {
    operation: "jira.update-component",
    path: "api/2/component/37",
    method: "PUT",
    status: 200,
    receipt: { componentId: "37", projectId: "10000", projectKey: "SYN" },
  },
  {
    operation: "jira.create-version",
    path: "api/2/version",
    method: "POST",
    status: 201,
    receipt: { versionId: "37" },
  },
  {
    operation: "jira.update-version",
    path: "api/2/version/37",
    method: "PUT",
    status: 200,
    receipt: { versionId: "37" },
  },
  {
    operation: "jira.create-project",
    path: "api/2/project",
    method: "POST",
    status: 201,
    receipt: { projectId: "10000", projectKey: "SYN" },
  },
  {
    operation: "jira.update-project",
    path: "api/2/project/SYN",
    method: "PUT",
    status: 200,
    receipt: { projectId: "10000", projectKey: "SYN" },
  },
  {
    operation: "jira.board-create",
    path: "agile/1.0/board",
    method: "POST",
    status: 201,
    receipt: { boardId: "37" },
  },
  {
    operation: "jira.sprint-create",
    path: "agile/1.0/sprint",
    method: "POST",
    status: 201,
    receipt: { sprintId: "37" },
  },
  {
    operation: "jira.sprint-update",
    path: "agile/1.0/sprint/37",
    method: "POST",
    status: 200,
    receipt: { sprintId: "37" },
  },
  {
    operation: "jira.sprint-move-issues",
    path: "agile/1.0/sprint/37/issue",
    method: "POST",
    status: 204,
    receipt: { sprintId: "37", issueKeys: ["SYN-1"] },
  },
  {
    operation: "jira.backlog-move-issues",
    path: "agile/1.0/backlog/issue",
    method: "POST",
    status: 204,
    receipt: { issueKeys: ["SYN-1"] },
  },
  {
    operation: "jira.epic-update",
    path: "agile/1.0/epic/SYN-1",
    method: "POST",
    status: 200,
    receipt: { epicKey: "SYN-1" },
  },
  {
    operation: "jira.epic-move-issues",
    path: "agile/1.0/epic/SYN-1/issue",
    method: "POST",
    status: 204,
    receipt: { epicKey: "SYN-1", issueKeys: ["SYN-2"] },
  },
] as const)(
  "journals $operation and replays its result without another HTTP effect",
  async ({ operation, path, method, status, receipt }) => {
    const f = fixture();
    f.effects.mockImplementation(() =>
      Promise.resolve(new Response(status === 204 ? null : "{}", { status })),
    );
    const input: JiraChatMutationExecution = {
      ...f.input,
      intent: { ...f.input.intent, operation },
      execute: async (http) => {
        const response = await http({
          method,
          url: `https://jira.example.invalid/rest/${path}`,
          bodyJson: "{}",
          maxBodyBytes: 1000,
          timeoutMs: 1000,
        });
        expect(response).toMatchObject({ kind: "response", status });
        return { ok: true, receipt };
      },
    };
    expect(await executeJiraChatMutation(input)).toMatchObject({
      data: { outcome: "succeeded", ...receipt },
    });
    expect(await executeJiraChatMutation(input)).toMatchObject({
      data: { outcome: "succeeded", replayed: true },
    });
    expect(f.effects).toHaveBeenCalledOnce();
  },
);
it("uses the injected custody transport factory with journal-owned lifecycle hooks", async () => {
  const f = fixture();
  const httpPortFactory = vi.fn(f.input.httpPortFactory);
  const input = { ...f.input, httpPortFactory };
  expect(await executeJiraChatMutation(input)).toMatchObject({ data: { outcome: "succeeded" } });
  expect(httpPortFactory).toHaveBeenCalledOnce();
  expect(httpPortFactory.mock.calls[0]?.[0].beforeDispatch).toBeTypeOf("function");
  expect(httpPortFactory.mock.calls[0]?.[0].onResponse).toBeTypeOf("function");
  expect(f.effects).toHaveBeenCalledOnce();
});

const PROPERTY_JOURNAL_CASES = [
  {
    operation: "jira.set-issue-property",
    root: "/rest/api/2",
    entity: "issue",
    id: "10001",
    args: { issueIdOrKey: "syn-1" },
    context: { issueId: "10001", issueKey: "SYN-1" },
    before: false,
    after: null,
    remove: false,
  },
  {
    operation: "jira.delete-issue-property",
    root: "/rest/api/2",
    entity: "issue",
    id: "10001",
    args: { issueIdOrKey: "syn-1" },
    context: { issueId: "10001", issueKey: "SYN-1" },
    before: null,
    after: null,
    remove: true,
  },
  {
    operation: "jira.set-board-property",
    root: "/rest/agile/1.0",
    entity: "board",
    id: "7",
    args: { boardId: "7" },
    context: { boardId: "7" },
    before: null,
    after: false,
    remove: false,
  },
  {
    operation: "jira.delete-board-property",
    root: "/rest/agile/1.0",
    entity: "board",
    id: "7",
    args: { boardId: "7" },
    context: { boardId: "7" },
    before: false,
    after: null,
    remove: true,
  },
] as const;
type PropertyJournalCase = (typeof PROPERTY_JOURNAL_CASES)[number];
type PropertyObservation =
  "confirmed" | "lost-ack" | "denied-readback" | "stale" | "unchanged" | "absent-review";
const JOURNAL_PROPERTY_KEY = "display ~key";
function propertyNodes(value: null | false): readonly CatalogJsonObject[] {
  return value === null
    ? [{ path: "", kind: "null" }]
    : [{ path: "", kind: "boolean", booleanValue: false }];
}
function fixtureJson(body: unknown, status = 200): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify(body), { status }));
}
function propertyWriteResponse(
  f: ReturnType<typeof fixture>,
  scenario: PropertyJournalCase,
  observation: PropertyObservation,
  selectedPath: string,
  resource: string,
  init: RequestInit | undefined,
): Promise<Response> {
  expect(f.input.journal?.find(f.input.intent.invocationId)?.phase).toBe("dispatched");
  expect(selectedPath).toBe(`${resource}/${JOURNAL_PROPERTY_KEY}`);
  expect(init?.method).toBe(scenario.remove ? "DELETE" : "PUT");
  expect(init?.body).toBe(scenario.remove ? undefined : JSON.stringify(scenario.after));
  if (observation === "lost-ack")
    return Promise.reject(new Error("Synthetic lost property acknowledgement"));
  return Promise.resolve(new Response(null, { status: 204 }));
}
function observedPropertyValue(
  scenario: PropertyJournalCase,
  observation: PropertyObservation,
  dispatched: boolean,
): null | false {
  if (dispatched || observation === "unchanged") return scenario.after;
  if (observation === "stale") return scenario.before === null ? false : null;
  return scenario.before;
}
function propertyReadResponse(
  scenario: PropertyJournalCase,
  observation: PropertyObservation,
  dispatched: boolean,
  selectedPath: string,
  parent: string,
  resource: string,
): Promise<Response> {
  if (dispatched && observation === "denied-readback")
    return fixtureJson({ errorMessages: ["Readback denied"] }, 403);
  if (selectedPath === parent || selectedPath === `${scenario.root}/issue/syn-1`)
    return fixtureJson(
      scenario.entity === "issue"
        ? { id: scenario.id, key: "SYN-1", fields: { summary: "Synthetic issue" } }
        : { id: Number(scenario.id), name: "Synthetic board" },
    );
  const present = !dispatched || !scenario.remove;
  if (selectedPath === resource)
    return fixtureJson({ keys: present ? [{ key: JOURNAL_PROPERTY_KEY }] : [] });
  expect(selectedPath).toBe(`${resource}/${JOURNAL_PROPERTY_KEY}`);
  if (!present) return fixtureJson({ errorMessages: ["Property missing"] }, 404);
  return fixtureJson({
    key: JOURNAL_PROPERTY_KEY,
    value: observedPropertyValue(scenario, observation, dispatched),
  });
}
function propertyJournalFixture(
  scenario: PropertyJournalCase,
  observation: PropertyObservation,
  path = ":memory:",
): ReturnType<typeof fixture> & { readonly receipt: CatalogJsonObject } {
  const f = fixture(path);
  const parent = `${scenario.root}/${scenario.entity}/${scenario.id}`;
  const resource = `${parent}/properties`;
  let dispatched = false;
  f.effects.mockImplementation((input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const selectedPath = decodeURIComponent(url.pathname);
    if (init?.method !== "GET") {
      dispatched = true;
      return propertyWriteResponse(f, scenario, observation, selectedPath, resource, init);
    }
    return propertyReadResponse(scenario, observation, dispatched, selectedPath, parent, resource);
  });
  const expected = observation === "unchanged" ? scenario.after : scenario.before;
  const args: CatalogJsonObject = {
    ...scenario.args,
    propertyKey: JOURNAL_PROPERTY_KEY,
    ...(observation === "absent-review"
      ? { expectAbsent: true }
      : { expectedValueNodes: propertyNodes(expected) }),
    ...(scenario.remove ? {} : { valueNodes: propertyNodes(scenario.after) }),
  };
  const execute = managedAttempt(f, scenario.operation, args);
  const receipt = {
    ...scenario.context,
    propertyKey: JOURNAL_PROPERTY_KEY,
    propertyPresent: !scenario.remove,
  };
  return {
    ...f,
    receipt,
    input: { ...f.input, intent: { ...f.input.intent, operation: scenario.operation }, execute },
  };
}
/** The private transcript keeps receipts; the durable journal proves only its outcome. */
function expectJournalReplay(
  result: Awaited<ReturnType<typeof executeJiraChatMutation>>,
  outcome: "succeeded" | "succeeded-unconfirmed" | "unknown",
): void {
  expect(result).toMatchObject({ data: { outcome, replayed: true } });
  for (const field of ["issueId", "issueKey", "boardId", "propertyKey", "propertyPresent"])
    expect(result.data).not.toHaveProperty(field);
}
it.each(PROPERTY_JOURNAL_CASES)(
  "journals one $operation using its fixed root and complete same-parent property readback",
  async (scenario) => {
    const f = propertyJournalFixture(scenario, "confirmed");
    expect(await executeJiraChatMutation(f.input)).toMatchObject({
      data: { outcome: "succeeded", ...f.receipt },
    });
    expect(f.effects.mock.calls.map(([, init]) => init?.method)).toEqual([
      "GET",
      "GET",
      "GET",
      scenario.remove ? "DELETE" : "PUT",
      "GET",
      "GET",
      "GET",
    ]);
    expectJournalReplay(await executeJiraChatMutation(f.input), "succeeded");
    expect(f.effects).toHaveBeenCalledTimes(7);
    expect(f.logs.lines().join()).not.toMatch(
      /display|Synthetic issue|Synthetic board|jira\.example|propertyKey|valueNodes/u,
    );
  },
);
it.each(PROPERTY_JOURNAL_CASES)(
  "retains only the requested $operation presence and exact context after denied readback",
  async (scenario) => {
    const f = propertyJournalFixture(scenario, "denied-readback");
    expect(await executeJiraChatMutation(f.input)).toMatchObject({
      data: { outcome: "succeeded-unconfirmed", ...f.receipt },
    });
    const requests = f.effects.mock.calls.length;
    expectJournalReplay(await executeJiraChatMutation(f.input), "succeeded-unconfirmed");
    expect(f.effects).toHaveBeenCalledTimes(requests);
    expect(f.effects.mock.calls.filter(([, init]) => init?.method !== "GET")).toHaveLength(1);
  },
);
it.each(PROPERTY_JOURNAL_CASES)(
  "reloads uncertain $operation without a second provider or native mutation call",
  async (scenario) => {
    const directory = mkdtempSync(join(tmpdir(), "keiko-property-replay-"));
    const path = join(directory, "ui.sqlite");
    try {
      const f = propertyJournalFixture(scenario, "lost-ack", path);
      expect(await executeJiraChatMutation(f.input)).toMatchObject({
        data: { outcome: "unknown", ...f.receipt },
      });
      f.close();
      const reopened = createNodeUiStore(path);
      try {
        const execute = vi.fn(f.input.execute);
        expectJournalReplay(
          await executeJiraChatMutation({
            ...f.input,
            journal: reopened.chatToolMutations,
            execute,
          }),
          "unknown",
        );
        expect(execute).not.toHaveBeenCalled();
        expect(f.effects.mock.calls.map(([, init]) => init?.method)).toEqual([
          "GET",
          "GET",
          "GET",
          scenario.remove ? "DELETE" : "PUT",
        ]);
      } finally {
        reopened.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
it.each(PROPERTY_JOURNAL_CASES)(
  "refuses a changed reviewed $operation value before its first effect",
  async (scenario) => {
    const f = propertyJournalFixture(scenario, "stale");
    expect(await executeJiraChatMutation(f.input)).toMatchObject({
      data: { outcome: "rejected", reason: "conflict" },
    });
    expect(f.effects.mock.calls.map(([, init]) => init?.method)).toEqual(["GET", "GET", "GET"]);
  },
);
it.each(PROPERTY_JOURNAL_CASES.filter((scenario) => !scenario.remove))(
  "preserves observed null/false for $operation and refuses an absent review",
  async (scenario) => {
    const f = propertyJournalFixture(scenario, "absent-review");
    expect(await executeJiraChatMutation(f.input)).toMatchObject({
      data: { outcome: "rejected", reason: "conflict" },
    });
    expect(f.effects.mock.calls.map(([, init]) => init?.method)).toEqual(["GET", "GET", "GET"]);
  },
);
it.each(PROPERTY_JOURNAL_CASES.filter((scenario) => !scenario.remove))(
  "returns an observed unchanged $operation without a native write",
  async (scenario) => {
    const f = propertyJournalFixture(scenario, "unchanged");
    expect(await executeJiraChatMutation(f.input)).toMatchObject({
      data: { outcome: "rejected", reason: "conflict", unchanged: true, ...f.receipt },
    });
    expect(f.effects.mock.calls.map(([, init]) => init?.method)).toEqual(["GET", "GET", "GET"]);
  },
);
it.each(PROPERTY_JOURNAL_CASES)(
  "does not infer an atomic $operation rejection from a generic structured HTTP400",
  async (scenario) => {
    const f = propertyJournalFixture(scenario, "confirmed");
    const original = f.effects.getMockImplementation();
    if (original === undefined) throw new TypeError("Missing native property fixture");
    f.effects.mockImplementation((input, init) =>
      init?.method !== "GET"
        ? Promise.resolve(new Response('{"errorMessages":["Native refusal"]}', { status: 400 }))
        : original(input, init),
    );
    expect(await executeJiraChatMutation(f.input)).toMatchObject({
      data: { outcome: "unknown", ...f.receipt },
    });
    expectJournalReplay(await executeJiraChatMutation(f.input), "unknown");
    expect(f.effects.mock.calls.filter(([, init]) => init?.method !== "GET")).toHaveLength(1);
  },
);

const MONITORING_WRITES = [
  {
    operation: "jira.set-app-monitoring",
    path: "monitoring/app",
    read: "monitoring/app",
    before: false,
    target: true,
    args: { expectedEnabled: false, enabled: true },
    receipt: { monitoringEnabled: true },
  },
  {
    operation: "jira.set-ipd-monitoring",
    path: "monitoring/ipd",
    read: "monitoring/ipd",
    before: true,
    target: false,
    args: { expectedEnabled: true, enabled: false },
    receipt: { monitoringEnabled: false },
  },
  {
    operation: "jira.start-jmx-metrics",
    path: "monitoring/jmx/startExposing",
    read: "monitoring/jmx/areMetricsExposed",
    before: false,
    target: true,
    args: { expectedEnabled: false },
    receipt: { jmxMetricsExposed: true },
  },
  {
    operation: "jira.stop-jmx-metrics",
    path: "monitoring/jmx/stopExposing",
    read: "monitoring/jmx/areMetricsExposed",
    before: true,
    target: false,
    args: { expectedEnabled: true },
    receipt: { jmxMetricsExposed: false },
  },
] as const;
type MonitoringCase = (typeof MONITORING_WRITES)[number];
type MonitoringObservation = "confirmed" | "lost-ack" | "denied-readback" | "unchanged" | "stale";
function monitoringWriteResponse(
  f: ReturnType<typeof fixture>,
  scenario: MonitoringCase,
  observation: MonitoringObservation,
  url: URL,
  scalar: boolean,
): Promise<Response> {
  expect(f.input.journal?.find(f.input.intent.invocationId)?.phase).toBe("dispatched");
  expect(url.pathname).toBe(`/rest/api/2/${scenario.path}`);
  if (observation === "lost-ack")
    return Promise.reject(new Error("Synthetic lost monitoring response"));
  return Promise.resolve(new Response(null, { status: scalar ? 200 : 204 }));
}
function monitoringReadResponse(
  scenario: MonitoringCase,
  observation: MonitoringObservation,
  dispatched: boolean,
  scalar: boolean,
): Promise<Response> {
  if (dispatched && observation === "denied-readback")
    return fixtureJson({ errorMessages: ["Readback denied"] }, 403);
  const enabled =
    dispatched || observation === "unchanged" || observation === "stale"
      ? scenario.target
      : scenario.before;
  return fixtureJson(scalar ? enabled : { enabled });
}
function monitoringFixture(
  scenario: MonitoringCase,
  observation: MonitoringObservation,
  path = ":memory:",
): ReturnType<typeof fixture> {
  const f = fixture(path);
  let dispatched = false;
  const scalar = scenario.read === "monitoring/jmx/areMetricsExposed";
  f.effects.mockImplementation((input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (init?.method === "POST") {
      dispatched = true;
      return monitoringWriteResponse(f, scenario, observation, url, scalar);
    }
    expect(init?.method).toBe("GET");
    expect(url.pathname).toBe(`/rest/api/2/${scenario.read}`);
    return monitoringReadResponse(scenario, observation, dispatched, scalar);
  });
  const args: CatalogJsonObject =
    observation === "unchanged"
      ? { ...scenario.args, expectedEnabled: scenario.target }
      : scenario.args;
  const execute = managedAttempt(f, scenario.operation, args);
  return {
    ...f,
    input: { ...f.input, intent: { ...f.input.intent, operation: scenario.operation }, execute },
  };
}
it.each(MONITORING_WRITES)(
  "confirms $operation only after one effect and independent boolean readback",
  async (scenario) => {
    const f = monitoringFixture(scenario, "confirmed");
    expect(await executeJiraChatMutation(f.input)).toMatchObject({
      data: { outcome: "succeeded", ...scenario.receipt },
    });
    expect(f.effects.mock.calls.map(([, init]) => init?.method)).toEqual(["GET", "POST", "GET"]);
    expect(await executeJiraChatMutation(f.input)).toMatchObject({
      data: { outcome: "succeeded", replayed: true },
    });
    expect(f.effects).toHaveBeenCalledTimes(3);
    expect(f.logs.lines().join()).not.toMatch(
      /jira\.example|monitoring\/|expectedEnabled|synthetic-test-pat/u,
    );
  },
);
it.each(MONITORING_WRITES)(
  "keeps $operation target boolean unconfirmed after denied readback without replay",
  async (scenario) => {
    const f = monitoringFixture(scenario, "denied-readback");
    expect(await executeJiraChatMutation(f.input)).toMatchObject({
      data: { outcome: "succeeded-unconfirmed", ...scenario.receipt },
    });
    expect(await executeJiraChatMutation(f.input)).toMatchObject({
      data: { outcome: "succeeded-unconfirmed", replayed: true },
    });
    expect(f.effects.mock.calls.map(([, init]) => init?.method)).toEqual(["GET", "POST", "GET"]);
  },
);
it.each(MONITORING_WRITES)(
  "keeps a lost $operation response unknown across store reload without another provider call",
  async (scenario) => {
    const directory = mkdtempSync(join(tmpdir(), "keiko-monitoring-replay-"));
    const path = join(directory, "ui.sqlite");
    try {
      const f = monitoringFixture(scenario, "lost-ack", path);
      expect(await executeJiraChatMutation(f.input)).toMatchObject({
        data: { outcome: "unknown", ...scenario.receipt },
      });
      f.close();
      const reopened = createNodeUiStore(path);
      try {
        const execute = vi.fn(f.input.execute);
        expect(
          await executeJiraChatMutation({
            ...f.input,
            journal: reopened.chatToolMutations,
            execute,
          }),
        ).toMatchObject({ data: { outcome: "unknown", replayed: true } });
        expect(execute).not.toHaveBeenCalled();
        expect(f.effects.mock.calls.map(([, init]) => init?.method)).toEqual(["GET", "POST"]);
      } finally {
        reopened.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
it.each(MONITORING_WRITES)(
  "settles an observed unchanged $operation without a POST",
  async (scenario) => {
    const f = monitoringFixture(scenario, "unchanged");
    expect(await executeJiraChatMutation(f.input)).toMatchObject({
      data: {
        outcome: "rejected",
        reason: "conflict",
        unchanged: true,
        ...scenario.receipt,
      },
    });
    expect(f.effects.mock.calls.map(([, init]) => init?.method)).toEqual(["GET"]);
  },
);
it.each(MONITORING_WRITES)(
  "refuses stale reviewed $operation state before dispatch",
  async (scenario) => {
    const f = monitoringFixture(scenario, "stale");
    const result = await executeJiraChatMutation(f.input);
    expect(result).toMatchObject({ data: { outcome: "rejected", reason: "conflict" } });
    expect(result.data).not.toHaveProperty("monitoringEnabled");
    expect(result.data).not.toHaveProperty("jmxMetricsExposed");
    expect(f.effects.mock.calls.map(([, init]) => init?.method)).toEqual(["GET"]);
  },
);
it.each(MONITORING_WRITES)(
  "does not infer an atomic no-effect rejection for $operation from a structured HTTP400",
  async (scenario) => {
    const f = monitoringFixture(scenario, "confirmed");
    const original = f.effects.getMockImplementation();
    if (original === undefined) throw new TypeError("Missing native monitoring fixture");
    f.effects.mockImplementation((input, init) =>
      init?.method === "POST"
        ? Promise.resolve(new Response('{"errorMessages":["Native refusal"]}', { status: 400 }))
        : original(input, init),
    );
    expect(await executeJiraChatMutation(f.input)).toMatchObject({
      data: { outcome: "unknown", ...scenario.receipt },
    });
    expect(await executeJiraChatMutation(f.input)).toMatchObject({
      data: { outcome: "unknown", replayed: true },
    });
    expect(f.effects.mock.calls.map(([, init]) => init?.method)).toEqual(["GET", "POST"]);
  },
);

it("records a body-only Markdown projection only in the settled body-free audit event", async () => {
  const f = fixture();
  const execute = f.input.execute;
  const result = await executeJiraChatMutation({
    ...f.input,
    execute: async (...args) => ({
      ...(await execute(...args)),
      descriptionProjection: "supported-markdown",
    }),
  });
  expect(result.data).not.toHaveProperty("descriptionProjection");
  expect(f.input.journal?.find(f.input.intent.invocationId)).not.toHaveProperty(
    "descriptionProjection",
  );
  const events = f.logs.events.filter((event) => event.extra?.descriptionProjection !== undefined);
  expect(events).toHaveLength(1);
  expect(events[0]?.extra).toMatchObject({
    event: "settled",
    descriptionProjection: "supported-markdown",
  });
  expect(events[0]?.extra).not.toHaveProperty("descriptionConvertedHeadingCount");
  expect(f.logs.lines().join()).not.toMatch(/synthetic-test-pat|jira\.example|SYN-1/u);
});
const LINK_ACCOUNT = { requested: 3, created: 3, missing: [], unconfirmed: false } as const;
/** The same journal and approval, over a Jira that answers each call by its path (#4176). */
function linkFixture(answer: (url: string, index: number) => Response): {
  f: ReturnType<typeof fixture>;
  input: JiraChatMutationExecution;
  fetches: Mock<typeof fetch>;
  post: (
    http: Parameters<JiraChatMutationExecution["execute"]>[0],
    path: string,
  ) => Promise<number>;
} {
  const f = fixture();
  let calls = 0;
  const fetches = vi.fn<typeof fetch>((request) => {
    const url = request instanceof Request ? request.url : String(request);
    return Promise.resolve(answer(url, calls++));
  });
  const input: JiraChatMutationExecution = {
    ...f.input,
    httpPortFactory: (lifecycle) =>
      createGatewayAtlassianHttpBodyPort({
        ...lifecycle,
        correlationId: f.input.intent.correlationId,
        baseUrl: "https://jira.example.invalid",
        authRef: "synthetic-ref",
        credentials: {
          resolveForExecution: () => ({ scheme: "bearer-pat", apiToken: "synthetic-test-pat" }),
        },
        fetchImpl: fetches,
      }),
  };
  const post = async (
    http: Parameters<JiraChatMutationExecution["execute"]>[0],
    path: string,
  ): Promise<number> => {
    try {
      const response = await http({
        method: "POST",
        url: `https://jira.example.invalid/rest/api/2/${path}`,
        bodyJson: "{}",
        maxBodyBytes: 1000,
        timeoutMs: 1000,
      });
      return response.kind === "response" ? response.status : 0;
    } catch {
      // The journal-owned lifecycle refuses a dispatch it did not admit by throwing; 0 = not sent.
      return 0;
    }
  };
  return { f, input, fetches, post };
}
const createdThenLinked = (url: string): Response =>
  url.endsWith("/issueLink")
    ? new Response(null, { status: 201 })
    : new Response('{"key":"SYN-1","id":"10001"}', { status: 201 });

it("sends further issue links under the same journal record and approval (#4176)", async () => {
  const l = linkFixture(createdThenLinked);
  const beforeMutation = vi.fn(() => true);
  const result = await executeJiraChatMutation({
    ...l.input,
    beforeMutation,
    execute: async (http) => {
      await l.post(http, "issue");
      await l.post(http, "issueLink");
      await l.post(http, "issueLink");
      return { ok: true, receipt: { issueKey: "SYN-1", issueId: "10001" }, links: LINK_ACCOUNT };
    },
  });
  expect(result).toMatchObject({
    data: { outcome: "succeeded", issueKey: "SYN-1", linksRequested: 3, linksCreated: 3 },
  });
  expect(l.fetches).toHaveBeenCalledTimes(3);
  // One approval claim for the primary write and one per further link, never a new record.
  expect(beforeMutation).toHaveBeenCalledTimes(3);
  expect(l.f.input.journal?.find(l.f.input.intent.invocationId)).toMatchObject({
    phase: "settled",
    outcome: "succeeded",
    httpStatus: 201,
  });
  const settled = l.f.logs.events.find((event) => event.extra?.event === "settled");
  expect(settled?.extra).toMatchObject({
    linkRequestedCount: 3,
    linkCreatedCount: 3,
    linkFailedCount: 0,
  });
  expect(l.f.logs.lines().join()).not.toMatch(/SYN-|synthetic-test-pat|jira\.example/u);
});
it("settles a created issue whose link failed as unconfirmed and names the missing links (#4176)", async () => {
  const l = linkFixture((url) =>
    url.endsWith("/issueLink")
      ? new Response('{"errorMessages":["Issue Does Not Exist"],"errors":{}}', { status: 404 })
      : new Response('{"key":"SYN-1","id":"10001"}', { status: 201 }),
  );
  const missing = [{ type: "Relates", direction: "outward", issueKey: "SYN-9" }] as const;
  const input: JiraChatMutationExecution = {
    ...l.input,
    execute: async (http) => {
      await l.post(http, "issue");
      await l.post(http, "issueLink");
      return {
        ok: false,
        reason: "not-found",
        receipt: { issueKey: "SYN-1", issueId: "10001" },
        links: { requested: 2, created: 1, missing, unconfirmed: false },
      };
    },
  };
  const result = await executeJiraChatMutation(input);
  expect(result).toMatchObject({
    isError: true,
    data: {
      outcome: "succeeded-unconfirmed",
      reason: "not-found",
      issueKey: "SYN-1",
      issueId: "10001",
      linksRequested: 2,
      linksCreated: 1,
      linksMissing: [{ type: "Relates", direction: "outward", issueKey: "SYN-9" }],
    },
  });
  // The failed answer did not overwrite the primary write's acknowledgement in the journal.
  expect(l.f.input.journal?.find(input.intent.invocationId)).toMatchObject({
    phase: "settled",
    outcome: "succeeded-unconfirmed",
    httpStatus: 201,
  });
  const settled = l.f.logs.events.find((event) => event.extra?.event === "settled");
  expect(settled?.extra).toMatchObject({
    linkRequestedCount: 2,
    linkCreatedCount: 1,
    linkFailedCount: 1,
  });
  // A replay returns the recorded outcome; nothing is created or linked again.
  const calls = l.fetches.mock.calls.length;
  expect(
    await executeJiraChatMutation({
      ...input,
      intent: { ...input.intent, invocationId: "duplicate-delivery" },
    }),
  ).toMatchObject({ data: { outcome: "succeeded-unconfirmed", replayed: true } });
  expect(l.fetches).toHaveBeenCalledTimes(calls);
});
it("admits at most the approved number of further links and only after an acknowledged write (#4176)", async () => {
  const l = linkFixture(createdThenLinked);
  const statuses: number[] = [];
  await executeJiraChatMutation({
    ...l.input,
    execute: async (http) => {
      // A link call before any acknowledged write is the primary write itself, once.
      statuses.push(await l.post(http, "issue"));
      for (let index = 0; index < 21; index++) statuses.push(await l.post(http, "issueLink")); // NOSONAR typescript:S9382 -- sequential by design
      return { ok: false, reason: "unavailable" };
    },
  });
  expect(statuses.filter((status) => status === 201)).toHaveLength(1 + 19);
  expect(statuses.slice(-2)).toEqual([0, 0]);
  expect(l.fetches).toHaveBeenCalledTimes(1 + 19);
});
it("sends no link when the primary write was not acknowledged (#4176)", async () => {
  const l = linkFixture(() => new Response("{}", { status: 500 }));
  const statuses: number[] = [];
  await executeJiraChatMutation({
    ...l.input,
    execute: async (http) => {
      statuses.push(await l.post(http, "issue"), await l.post(http, "issueLink"));
      return { ok: false, reason: "unavailable" };
    },
  });
  expect(statuses).toEqual([500, 0]);
  expect(l.fetches).toHaveBeenCalledOnce();
});
it("stops sending links when the current authority is gone mid-sequence (#4176)", async () => {
  const l = linkFixture(createdThenLinked);
  let live = true;
  const statuses: number[] = [];
  await executeJiraChatMutation({
    ...l.input,
    beforeEffect: () => live,
    execute: async (http) => {
      statuses.push(await l.post(http, "issue"));
      live = false;
      statuses.push(await l.post(http, "issueLink"));
      return { ok: false, reason: "unavailable" };
    },
  });
  expect(statuses).toEqual([201, 0]);
  expect(l.fetches).toHaveBeenCalledOnce();
});
it("refuses a write when concrete approval cannot be claimed at final dispatch", async () => {
  const f = fixture();
  const beforeMutation = vi.fn(() => false);
  const input = { ...f.input, beforeMutation };
  expect(await executeJiraChatMutation(input)).toMatchObject({ data: { outcome: "rejected" } });
  expect(beforeMutation).toHaveBeenCalledOnce();
  expect(f.effects).not.toHaveBeenCalled();
  expect(f.input.journal?.find(f.input.intent.invocationId)).toMatchObject({
    phase: "settled",
    outcome: "rejected",
    httpStatus: null,
  });
});
it.each([400, 401, 403, 429, 500, 503])(
  "keeps committed-then-%s unknown and does not repeat the mutation",
  async (status) => {
    const f = fixture();
    f.effects.mockImplementation(() => Promise.resolve(new Response(null, { status })));
    expect(await executeJiraChatMutation(f.input)).toMatchObject({
      data: { outcome: "unknown" },
      isError: true,
    });
    expect(await executeJiraChatMutation(f.input)).toMatchObject({
      data: { outcome: "unknown", replayed: true },
    });
    expect(f.effects).toHaveBeenCalledOnce();
  },
);
it.each([
  ["jira.board-create", "POST", "agile/1.0/board"],
  ["jira.sprint-create", "POST", "agile/1.0/sprint"],
  ["jira.sprint-update", "POST", "agile/1.0/sprint/37"],
  ["jira.epic-update", "POST", "agile/1.0/epic/SYN-1"],
  ["jira.create-component", "POST", "api/2/component"],
  ["jira.update-component", "PUT", "api/2/component/37"],
  ["jira.create-version", "POST", "api/2/version"],
  ["jira.update-version", "PUT", "api/2/version/37"],
  ["jira.create-worklog", "POST", "api/2/issue/SYN-1/worklog"],
  ["jira.update-worklog", "PUT", "api/2/issue/SYN-1/worklog/37"],
  ["jira.delete-worklog", "DELETE", "api/2/issue/SYN-1/worklog/37?adjustEstimate=leave"],
  ["jira.delete-comment", "DELETE", "api/2/issue/SYN-1/comment/37"],
  ["jira.delete-attachment", "DELETE", "api/2/attachment/37"],
  ["jira.watch", "POST", "api/2/issue/SYN-1/watchers"],
  ["jira.unwatch", "DELETE", "api/2/issue/SYN-1/watchers?username=synthetic-user"],
  ["jira.vote", "POST", "api/2/issue/SYN-1/votes"],
  ["jira.unvote", "DELETE", "api/2/issue/SYN-1/votes"],
] as const)(
  "allows correction after %s returns a structured 400 without effects",
  async (operation, method, path) => {
    const f = fixture();
    if (f.input.journal === undefined) throw new TypeError("Expected mutation journal");
    const settle = vi.spyOn(f.input.journal, "settle");
    f.effects.mockImplementation(() =>
      Promise.resolve(
        new Response('{"errorMessages":["Correct the requested fields"],"errors":{}}', {
          status: 400,
        }),
      ),
    );
    const input: JiraChatMutationExecution = {
      ...f.input,
      intent: { ...f.input.intent, operation },
      execute: async (http) => {
        await http({
          method,
          url: `https://jira.example.invalid/rest/${path}`,
          ...(method === "DELETE" ? {} : { bodyJson: "{}" }),
          maxBodyBytes: 1000,
          timeoutMs: 1000,
        });
        return {
          ok: false,
          reason: "field-validation",
          detail: { messages: ["Correct the requested fields"] },
        };
      },
    };
    expect(await executeJiraChatMutation(input)).toMatchObject({
      data: {
        outcome: "rejected",
        messages: ["Correct the requested fields"],
      },
    });
    expect(f.input.journal.find(input.intent.invocationId)).toMatchObject({
      outcome: "rejected",
      httpStatus: 400,
    });
    expect(settle).toHaveBeenCalledWith(
      input.intent.invocationId,
      "rejected",
      undefined,
      { jiraErrorDocument: true },
      expect.anything(),
      expect.anything(),
    );
    expect(await executeJiraChatMutation(input)).toMatchObject({
      data: { outcome: "rejected", replayed: true },
    });
    expect(f.effects).toHaveBeenCalledOnce();
  },
);
it("preserves a possible Agile bulk effect despite a structured 400 and never replays it", async () => {
  const f = fixture();
  f.effects.mockImplementation(() =>
    Promise.resolve(
      new Response(JSON.stringify({ errorMessages: ["One member failed"], errors: {} }), {
        status: 400,
      }),
    ),
  );
  const input: JiraChatMutationExecution = {
    ...f.input,
    intent: { ...f.input.intent, operation: "jira.sprint-move-issues" },
    execute: async (http) => {
      await http({
        method: "POST",
        url: "https://jira.example.invalid/rest/agile/1.0/sprint/37/issue",
        bodyJson: '{"issues":["SYN-1"]}',
        maxBodyBytes: 1000,
        timeoutMs: 1000,
      });
      return {
        ok: false,
        reason: "field-validation",
        detail: { messages: ["One member failed"] },
        receipt: { sprintId: "37", issueKeys: ["SYN-1"] },
      };
    },
  };
  expect(await executeJiraChatMutation(input)).toMatchObject({
    data: { outcome: "unknown", sprintId: "37", issueKeys: ["SYN-1"] },
  });
  expect(await executeJiraChatMutation(input)).toMatchObject({
    data: { outcome: "unknown", replayed: true },
  });
  expect(f.effects).toHaveBeenCalledOnce();
});
it("retains an acknowledged malformed response as succeeded-unconfirmed", async () => {
  const f = fixture();
  f.effects.mockImplementation(() => Promise.resolve(new Response("not-json", { status: 201 })));
  expect(await executeJiraChatMutation(f.input)).toMatchObject({
    data: { outcome: "succeeded-unconfirmed" },
  });
  expect(await executeJiraChatMutation(f.input)).toMatchObject({
    data: { outcome: "succeeded-unconfirmed", replayed: true },
  });
  expect(f.effects).toHaveBeenCalledOnce();
});
it("diagnoses an unexpected post-acknowledgement failure while retaining membership evidence", async () => {
  const f = fixture();
  const diagnostic = vi.spyOn(defaultServerDiagnosticSink, "record");
  try {
    f.effects.mockImplementation(() => Promise.resolve(new Response(null, { status: 204 })));
    const input: JiraChatMutationExecution = {
      ...f.input,
      intent: { ...f.input.intent, operation: "jira.sprint-move-issues" },
      execute: async (http) => {
        await http({
          method: "POST",
          url: "https://jira.example.invalid/rest/agile/1.0/sprint/37/issue",
          bodyJson: '{"issues":["SYN-1"]}',
          maxBodyBytes: 1000,
          timeoutMs: 1000,
        });
        throw new JiraAcknowledgedMutationError(new TypeError("Synthetic private member content"), {
          sprintId: "37",
          issueKeys: ["SYN-1"],
        });
      },
    };
    expect(await executeJiraChatMutation(input)).toMatchObject({
      data: { outcome: "succeeded-unconfirmed", sprintId: "37", issueKeys: ["SYN-1"] },
    });
    const record = diagnostic.mock.calls[0]?.[0];
    expect(record).toMatchObject({
      operation: "jira.mutation-execution-failed",
      errorClass: "JiraAcknowledgedMutationError",
    });
    expect(record?.causeChain).toContain("TypeError");
    expect(record?.frames?.length ?? 0).toBeGreaterThan(0);
    expect(JSON.stringify(diagnostic.mock.calls)).not.toMatch(
      /Synthetic private|SYN-1|jira\.example/u,
    );
    expect(await executeJiraChatMutation(input)).toMatchObject({
      data: { outcome: "succeeded-unconfirmed", replayed: true },
    });
    expect(f.effects).toHaveBeenCalledOnce();
  } finally {
    diagnostic.mockRestore();
  }
});
it("retains a truncated 201 acknowledgement and replays the canonical action without another effect", async () => {
  const f = fixture();
  f.effects.mockImplementation(() =>
    Promise.resolve(
      new Response(JSON.stringify({ key: "SYN-1", id: "10001", padding: "x".repeat(2000) }), {
        status: 201,
      }),
    ),
  );
  const observedResponses: boolean[] = [];
  const execute: JiraChatMutationExecution["execute"] = (http, lifecycle) =>
    f.input.execute(async (request) => {
      const response = await http(request);
      expect(response).toMatchObject({ kind: "response", status: 201, truncated: true });
      observedResponses.push(response.kind === "response" && response.truncated);
      return response;
    }, lifecycle);
  const input = { ...f.input, execute };
  expect(await executeJiraChatMutation(input)).toMatchObject({
    data: { outcome: "succeeded-unconfirmed" },
    isError: true,
  });
  expect(observedResponses).toEqual([true]);
  expect(f.input.journal?.find(f.input.intent.invocationId)).toMatchObject({
    phase: "settled",
    outcome: "succeeded-unconfirmed",
    httpStatus: 201,
  });
  expect(
    await executeJiraChatMutation({
      ...input,
      intent: { ...input.intent, invocationId: "duplicate-truncated-delivery" },
    }),
  ).toMatchObject({
    data: { outcome: "succeeded-unconfirmed", replayed: true },
  });
  expect(observedResponses).toEqual([true]);
  expect(f.effects).toHaveBeenCalledOnce();
  expect(f.input.journal?.find("duplicate-truncated-delivery")).toBeUndefined();
  expect(
    f.logs.events
      .filter((event) => event.extra?.event === "settled" || event.extra?.event === "replayed")
      .map((event) => event.extra?.outcome),
  ).toEqual(["succeeded-unconfirmed", "succeeded-unconfirmed"]);
});
it("blocks another mutation in the turn after acknowledgement without a validated result", async () => {
  const f = fixture();
  f.effects.mockImplementation(() => Promise.resolve(new Response("not-json", { status: 201 })));
  await executeJiraChatMutation(f.input);
  const next = {
    ...f.input,
    intent: { ...f.input.intent, invocationId: "changed-action", actionDigest: "c".repeat(64) },
  };
  expect(await executeJiraChatMutation(next)).toMatchObject({
    data: { outcome: "not-dispatched", reason: "conflict" },
  });
  expect(f.effects).toHaveBeenCalledOnce();
});
it("retains unknown effect after a lost response", async () => {
  const f = fixture();
  f.effects.mockImplementation(() => Promise.reject(new Error("synthetic lost response")));
  expect(await executeJiraChatMutation(f.input)).toMatchObject({ data: { outcome: "unknown" } });
  expect(f.effects).toHaveBeenCalledOnce();
});
it("refuses a missing journal or authority before executing provider code", async () => {
  const f = fixture();
  const execute = vi.fn(f.input.execute);
  expect(await executeJiraChatMutation({ ...f.input, journal: undefined, execute })).toMatchObject({
    data: { outcome: "pending" },
  });
  expect(
    await executeJiraChatMutation({ ...f.input, beforeEffect: () => false, execute }),
  ).toMatchObject({ data: { outcome: "pending" } });
  expect(execute).not.toHaveBeenCalled();
  expect(f.effects).not.toHaveBeenCalled();
});
it("revalidates admission at final dispatch after initial authority admission", async () => {
  const f = fixture();
  let admitted = true;
  const input = {
    ...f.input,
    beforeEffect: (): boolean => admitted,
    execute: async (
      http: Parameters<JiraChatMutationExecution["execute"]>[0],
      lifecycle: Parameters<JiraChatMutationExecution["execute"]>[1],
    ): Promise<JiraMutationAttempt> => {
      admitted = false;
      return f.input.execute(http, lifecycle);
    },
  };
  expect(await executeJiraChatMutation(input)).toMatchObject({ data: { outcome: "rejected" } });
  expect(f.effects).not.toHaveBeenCalled();
});

it("does not take ownership of a concurrent duplicate while the first invocation prepares", async () => {
  const f = fixture();
  let release: (() => void) | undefined;
  let entered: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const input = {
    ...f.input,
    execute: async (
      http: Parameters<JiraChatMutationExecution["execute"]>[0],
      lifecycle: Parameters<JiraChatMutationExecution["execute"]>[1],
    ): Promise<JiraMutationAttempt> => {
      entered?.();
      await held;
      return f.input.execute(http, lifecycle);
    },
  };
  const first = executeJiraChatMutation(input);
  try {
    await ready;
    expect(await executeJiraChatMutation(input)).toMatchObject({
      data: { outcome: "pending", replayed: true },
    });
    expect(f.effects).not.toHaveBeenCalled();
    release?.();
    expect(await first).toMatchObject({ data: { outcome: "succeeded" } });
    expect(f.effects).toHaveBeenCalledOnce();
  } finally {
    release?.();
    await first;
  }
});
it("admits at most one mutation HTTP request from a provider invocation", async () => {
  const f = fixture();
  const execute: JiraChatMutationExecution["execute"] = async (http, lifecycle) => {
    await f.input.execute(http, lifecycle);
    return f.input.execute(http, lifecycle);
  };
  expect(await executeJiraChatMutation({ ...f.input, execute })).toMatchObject({
    data: { outcome: "succeeded-unconfirmed" },
  });
  expect(f.effects).toHaveBeenCalledOnce();
});
it("preserves acknowledgement when the response stream fails before yielding a body", async () => {
  const f = fixture();
  f.effects.mockImplementation(() =>
    Promise.resolve(
      new Response(
        new ReadableStream(
          {
            pull(controller): void {
              controller.error(new Error("synthetic stream loss"));
            },
          },
          { highWaterMark: 0 },
        ),
        { status: 201 },
      ),
    ),
  );
  expect(await executeJiraChatMutation(f.input)).toMatchObject({
    data: { outcome: "succeeded-unconfirmed" },
  });
  expect(f.input.journal?.find(f.input.intent.invocationId)).toMatchObject({
    outcome: "succeeded-unconfirmed",
    httpStatus: 201,
  });
});
it("does not treat metadata responses as mutation acknowledgements", async () => {
  const f = fixture();
  const calls = f.effects.getMockImplementation();
  f.effects.mockImplementation((url, init) => {
    if (init?.method === "GET") {
      expect(f.input.journal?.find(f.input.intent.invocationId)).toMatchObject({
        phase: "prepared",
        httpStatus: null,
      });
      return Promise.resolve(new Response("{}", { status: 200 }));
    }
    if (calls === undefined) throw new Error("Expected fetch implementation");
    return calls(url, init);
  });
  const execute: JiraChatMutationExecution["execute"] = async (http, lifecycle) => {
    await http({
      method: "GET",
      url: "https://jira.example.invalid/rest/api/2/issue/createmeta",
      timeoutMs: 1000,
      maxBodyBytes: 1000,
    });
    expect(f.input.journal?.find(f.input.intent.invocationId)).toMatchObject({
      phase: "prepared",
      httpStatus: null,
    });
    return f.input.execute(http, lifecycle);
  };
  expect(await executeJiraChatMutation({ ...f.input, execute })).toMatchObject({
    data: { outcome: "succeeded" },
  });
  expect(f.effects).toHaveBeenCalledTimes(2);
});
it("claims only the mutation, keeping metadata, confirmation and replay separate", async () => {
  const f = fixture();
  const beforeMutation = vi.fn(() => {
    expect(f.input.journal?.find(f.input.intent.invocationId)?.phase).toBe("prepared");
    expect(f.effects).toHaveBeenCalledOnce();
    return true;
  });
  const write = f.effects.getMockImplementation();
  f.effects.mockImplementation((url, init) => {
    if (init?.method === "GET") return Promise.resolve(new Response("{}"));
    if (write === undefined) throw new Error("Expected write implementation");
    expect(beforeMutation).toHaveBeenCalledOnce();
    return write(url, init);
  });
  const input: JiraChatMutationExecution = {
    ...f.input,
    beforeMutation,
    execute: async (http, lifecycle) => {
      const read = {
        method: "GET",
        url: "https://jira.example.invalid/rest/api/2/issue/createmeta",
        timeoutMs: 1000,
        maxBodyBytes: 1000,
      } as const;
      await http(read);
      expect(beforeMutation).not.toHaveBeenCalled();
      const outcome = await f.input.execute(http, lifecycle);
      await http(read);
      return outcome;
    },
  };
  expect(await executeJiraChatMutation(input)).toMatchObject({ data: { outcome: "succeeded" } });
  expect(await executeJiraChatMutation(input)).toMatchObject({ data: { replayed: true } });
  expect(beforeMutation).toHaveBeenCalledOnce();
  expect(f.effects).toHaveBeenCalledTimes(3);
});
it("rejects an asynchronous mutation claim before any credential-bearing dispatch", async () => {
  const f = fixture();
  const beforeMutation = (() => Promise.resolve(true)) as unknown as () => boolean;
  expect(await executeJiraChatMutation({ ...f.input, beforeMutation })).toMatchObject({
    data: { outcome: "rejected" },
  });
  expect(f.effects).not.toHaveBeenCalled();
});
it("retains acknowledged success uncertainty when authority is lost before confirmation", async () => {
  const f = fixture();
  let current = true;
  const input: JiraChatMutationExecution = {
    ...f.input,
    beforeEffect: () => current,
    httpPortFactory: (lifecycle) =>
      f.input.httpPortFactory({
        ...lifecycle,
        onResponse: (request, status) => {
          const observed = lifecycle.onResponse?.(request, status);
          expect(f.input.journal?.find(f.input.intent.invocationId)).toMatchObject({
            phase: "acknowledged",
            httpStatus: 201,
          });
          current = false;
          return observed === true;
        },
      }),
    execute: async (http, lifecycle) => {
      const result = await f.input.execute(http, lifecycle);
      await http({
        method: "GET",
        url: "https://jira.example.invalid/rest/api/2/issue/SYN-1",
        timeoutMs: 1000,
        maxBodyBytes: 1000,
      });
      return result;
    },
  };
  expect(await executeJiraChatMutation(input)).toMatchObject({
    data: { outcome: "succeeded-unconfirmed" },
  });
  expect(f.effects).toHaveBeenCalledOnce();
  expect(f.input.journal?.find(f.input.intent.invocationId)?.outcome).toBe("succeeded-unconfirmed");
});
it("does not confirm creation without its required returned identities", async () => {
  const f = fixture();
  f.effects.mockImplementation(() => Promise.resolve(new Response("{}", { status: 201 })));
  expect(await executeJiraChatMutation(f.input)).toMatchObject({
    data: { outcome: "succeeded-unconfirmed", reason: "malformed-payload" },
  });
});
it("retains acknowledged uncertainty when terminal persistence fails", async () => {
  const f = fixture();
  const journal = f.input.journal;
  if (journal === undefined) throw new Error("Expected journal");
  const broken = {
    find: journal.find.bind(journal),
    prepare: journal.prepare.bind(journal),
    beginDispatch: journal.beginDispatch.bind(journal),
    acknowledge: journal.acknowledge.bind(journal),
    acknowledgeMcp: journal.acknowledgeMcp.bind(journal),
    settle: (): never => {
      throw new Error("synthetic persistence failure");
    },
  };
  expect(await executeJiraChatMutation({ ...f.input, journal: broken })).toMatchObject({
    data: { outcome: "succeeded-unconfirmed" },
  });
  expect(await executeJiraChatMutation({ ...f.input, journal: broken })).toMatchObject({
    data: { outcome: "pending", replayed: true },
  });
  expect(f.effects).toHaveBeenCalledOnce();
});

it.each(["prepared", "dispatched", "acknowledged"] as const)(
  "keeps an orphaned %s record unresolved across restart without taking ownership",
  async (phase) => {
    const directory = mkdtempSync(join(tmpdir(), "keiko-mutation-replay-"));
    const path = join(directory, "ui.sqlite");
    try {
      const f = fixture(path);
      const journal = f.input.journal;
      if (journal === undefined) throw new Error("Expected journal");
      journal.prepare(f.input.intent);
      if (phase !== "prepared") journal.beginDispatch(f.input.intent.invocationId, () => true);
      if (phase === "acknowledged") journal.acknowledge(f.input.intent.invocationId, 201);
      f.close();
      const reopened = createNodeUiStore(path);
      try {
        const execute = vi.fn(f.input.execute);
        expect(
          await executeJiraChatMutation({
            ...f.input,
            journal: reopened.chatToolMutations,
            execute,
          }),
        ).toMatchObject({ data: { outcome: "pending" }, isError: true });
        expect(reopened.chatToolMutations?.find(f.input.intent.invocationId)).toMatchObject({
          phase,
          outcome: null,
        });
        expect(execute).not.toHaveBeenCalled();
        expect(f.effects).not.toHaveBeenCalled();
      } finally {
        reopened.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
it("keeps a replay pending until the owner settles a pre-dispatch cancellation", async () => {
  const f = fixture();
  const controller = new AbortController();
  let release: (() => void) | undefined;
  let entered: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const input: JiraChatMutationExecution = {
    ...f.input,
    execute: async (http, lifecycle) => {
      entered?.();
      await held;
      return f.input.execute(
        (request) => http({ ...request, signal: controller.signal }),
        lifecycle,
      );
    },
  };
  const owner = executeJiraChatMutation(input);
  try {
    await ready;
    expect(await executeJiraChatMutation(input)).toMatchObject({
      data: { outcome: "pending", replayed: true },
    });
    controller.abort();
    release?.();
    expect(await owner).toMatchObject({ data: { outcome: "rejected" } });
    expect(await executeJiraChatMutation(input)).toMatchObject({
      data: { outcome: "rejected", replayed: true },
    });
    expect(f.effects).not.toHaveBeenCalled();
  } finally {
    release?.();
    await owner;
  }
});
it("does not turn revoked admission into a no-effect claim while an HTTP attempt remains outstanding", async () => {
  const f = fixture();
  let reject: ((error: Error) => void) | undefined;
  let entered: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.effects.mockImplementation(
    () =>
      new Promise<Response>((_resolve, rejectAttempt) => {
        reject = rejectAttempt;
        entered?.();
      }),
  );
  const owner = executeJiraChatMutation(f.input);
  try {
    await ready;
    expect(await executeJiraChatMutation({ ...f.input, beforeEffect: () => false })).toMatchObject({
      data: { outcome: "pending", reason: "permission-denied" },
    });
    expect(await executeJiraChatMutation(f.input)).toMatchObject({
      data: { outcome: "pending", replayed: true },
    });
    reject?.(new Error("synthetic interrupted response"));
    expect(await owner).toMatchObject({ data: { outcome: "unknown" } });
    expect(await executeJiraChatMutation(f.input)).toMatchObject({
      data: { outcome: "unknown", replayed: true },
    });
    expect(f.effects).toHaveBeenCalledOnce();
  } finally {
    reject?.(new Error("synthetic cleanup"));
    await owner;
  }
});

const TAB_WRITES = [
  "jira.create-screen-tab",
  "jira.rename-screen-tab",
  "jira.delete-screen-tab",
] as const;
type TabWrite = (typeof TAB_WRITES)[number];
function tabArguments(operation: TabWrite): CatalogJsonObject {
  const screen = { screenId: "11", expectedScreenName: "Review screen" };
  if (operation === "jira.create-screen-tab") return { ...screen, name: "Implementation" };
  const tab = { ...screen, tabId: "21", expectedName: "Fields" };
  return operation === "jira.rename-screen-tab"
    ? { ...tab, name: "Implementation" }
    : { ...tab, expectedFieldIds: ["summary"] };
}
function managedAttempt(
  f: ReturnType<typeof fixture>,
  operation: JiraMutationOperation,
  args: CatalogJsonObject,
): JiraChatMutationExecution["execute"] {
  return async (http) => {
    let attempted: JiraMutationAttempt = { ok: false, reason: "unavailable" };
    const provider = createJiraProviderForCatalog(
      () => ({ deployment: "data-center", baseUrl: "https://jira.example.invalid", http }),
      [operation],
      async (_operation, _args, _context, executeNative) => {
        attempted = await executeNative(http);
        return { data: { outcome: "pending" } };
      },
    );
    const tool = provider.tools()[0];
    if (tool === undefined) throw new TypeError("Missing selected Jira mutation tool");
    await tool.execute(args, {
      invocationId: f.input.intent.invocationId,
      correlationId: f.input.intent.correlationId,
      signal: new AbortController().signal,
      beforeEffect: () => true,
    });
    return attempted;
  };
}
type TabFixtureObservation = "confirmed" | "denied-readback" | "lost-ack";
interface FixtureTab {
  readonly id: number;
  readonly name: string;
}
function tabWriteResponse(
  f: ReturnType<typeof fixture>,
  operation: TabWrite,
  observation: TabFixtureObservation,
): Promise<Response> {
  expect(f.input.journal?.find(f.input.intent.invocationId)?.phase).toBe("dispatched");
  if (observation === "lost-ack")
    return Promise.reject(new Error("Synthetic lost screen-tab response"));
  if (operation === "jira.delete-screen-tab")
    return Promise.resolve(new Response(null, { status: 204 }));
  return fixtureJson({
    id: operation === "jira.create-screen-tab" ? 23 : 21,
    name: "Implementation",
  });
}
function observedTabs(
  operation: TabWrite,
  original: readonly FixtureTab[],
  changed: boolean,
): readonly (FixtureTab | undefined)[] {
  if (!changed) return original;
  if (operation === "jira.create-screen-tab")
    return [...original, { id: 23, name: "Implementation" }];
  if (operation === "jira.rename-screen-tab")
    return [{ id: 21, name: "Implementation" }, original[1]];
  return [original[1]];
}
function tabReadResponse(
  url: URL,
  operation: TabWrite,
  original: readonly FixtureTab[],
  changed: boolean,
): Promise<Response> {
  if (url.pathname.endsWith("/screens"))
    return fixtureJson({
      startAt: 0,
      maxResults: 100,
      total: 1,
      isLast: true,
      screens: [{ id: 11, name: "Review screen" }],
    });
  if (url.pathname.endsWith("/fields")) return fixtureJson([{ id: "summary", name: "Summary" }]);
  return fixtureJson(observedTabs(operation, original, changed));
}
function tabFixture(
  operation: TabWrite,
  observation: TabFixtureObservation,
  path = ":memory:",
): ReturnType<typeof fixture> {
  const f = fixture(path);
  let changed = false;
  const original = [
    { id: 21, name: "Fields" },
    { id: 22, name: "Other" },
  ];
  f.effects.mockImplementation((input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? "GET";
    if (method !== "GET") {
      changed = true;
      return tabWriteResponse(f, operation, observation);
    }
    if (changed && observation === "denied-readback")
      return fixtureJson({ errorMessages: ["Not permitted"] }, 403);
    return tabReadResponse(url, operation, original, changed);
  });
  const execute = managedAttempt(f, operation, tabArguments(operation));
  return { ...f, input: { ...f.input, intent: { ...f.input.intent, operation }, execute } };
}
it.each(TAB_WRITES)(
  "journals one real %s effect and its independent same-parent readback",
  async (operation) => {
    const f = tabFixture(operation, "confirmed");
    expect(await executeJiraChatMutation(f.input)).toMatchObject({
      data: {
        outcome: "succeeded",
        screenId: "11",
        tabId: operation === "jira.create-screen-tab" ? "23" : "21",
      },
    });
    expect(await executeJiraChatMutation(f.input)).toMatchObject({
      data: { outcome: "succeeded", replayed: true },
    });
    expect(f.effects.mock.calls.filter(([, init]) => init?.method !== "GET")).toHaveLength(1);
    expect(f.input.journal?.find(f.input.intent.invocationId)).toMatchObject({
      phase: "settled",
      outcome: "succeeded",
    });
    expect(f.logs.lines().join()).not.toMatch(/Review screen|Implementation|jira\.example/u);
  },
);
it.each(TAB_WRITES)(
  "retains exact %s acknowledgement IDs when readback is denied without replay",
  async (operation) => {
    const f = tabFixture(operation, "denied-readback");
    expect(await executeJiraChatMutation(f.input)).toMatchObject({
      data: {
        outcome: "succeeded-unconfirmed",
        screenId: "11",
        tabId: operation === "jira.create-screen-tab" ? "23" : "21",
      },
    });
    const observedRequests = f.effects.mock.calls.length;
    expect(await executeJiraChatMutation(f.input)).toMatchObject({
      data: { outcome: "succeeded-unconfirmed", replayed: true },
    });
    expect(f.effects).toHaveBeenCalledTimes(observedRequests);
    expect(f.effects.mock.calls.filter(([, init]) => init?.method !== "GET")).toHaveLength(1);
  },
);
it.each(TAB_WRITES)(
  "keeps %s lost acknowledgement unknown with no provider call after store reload",
  async (operation) => {
    const directory = mkdtempSync(join(tmpdir(), "keiko-tab-replay-"));
    const path = join(directory, "ui.sqlite");
    try {
      const f = tabFixture(operation, "lost-ack", path);
      const observed = await executeJiraChatMutation(f.input);
      expect(observed).toMatchObject({ data: { outcome: "unknown", screenId: "11" } });
      if (operation === "jira.create-screen-tab") expect(observed.data).not.toHaveProperty("tabId");
      else expect(observed.data.tabId).toBe("21");
      f.close();
      const reopened = createNodeUiStore(path);
      try {
        const execute = vi.fn(f.input.execute);
        expect(
          await executeJiraChatMutation({
            ...f.input,
            journal: reopened.chatToolMutations,
            execute,
          }),
        ).toMatchObject({ data: { outcome: "unknown", replayed: true } });
        expect(execute).not.toHaveBeenCalled();
        expect(f.effects.mock.calls.filter(([, init]) => init?.method !== "GET")).toHaveLength(1);
      } finally {
        reopened.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
it.each([
  ["jira.create-screen-tab", 400, "field-validation", true, "rejected"],
  ["jira.rename-screen-tab", 400, "field-validation", true, "rejected"],
  ["jira.delete-screen-tab", 400, "field-validation", true, "rejected"],
  ["jira.delete-screen-tab", 412, "field-validation", true, "rejected"],
  ["jira.create-screen-tab", 401, "permission-denied", true, "rejected"],
  ["jira.rename-screen-tab", 401, "permission-denied", true, "rejected"],
  ["jira.delete-screen-tab", 401, "permission-denied", true, "rejected"],
  ["jira.create-screen-tab", 401, "auth-failed", true, "unknown"],
  ["jira.rename-screen-tab", 401, "permission-denied", false, "unknown"],
  ["jira.delete-screen-tab", 412, "field-validation", false, "unknown"],
  ["jira.create-screen-tab", 412, "field-validation", true, "unknown"],
  ["jira.rename-screen-tab", 412, "field-validation", true, "unknown"],
  ["jira.delete-screen-tab", 409, "field-validation", true, "unknown"],
  ["jira.create-screen-tab", 403, "permission-denied", true, "unknown"],
  ["jira.rename-screen-tab", 503, "unavailable", true, "unknown"],
] as const)(
  "settles only documented %s status%s with the required proof (%s,%s)",
  async (operation, status, reason, document, outcome) => {
    const f = fixture();
    f.effects.mockImplementation(() =>
      Promise.resolve(
        new Response(document ? '{"errorMessages":["Native refusal"]}' : "", { status }),
      ),
    );
    const method =
      operation === "jira.create-screen-tab"
        ? "POST"
        : operation === "jira.rename-screen-tab"
          ? "PUT"
          : "DELETE";
    const path = operation === "jira.create-screen-tab" ? "screens/11/tabs" : "screens/11/tabs/21";
    const input: JiraChatMutationExecution = {
      ...f.input,
      intent: { ...f.input.intent, operation },
      execute: async (http) => {
        await http({
          method,
          url: `https://jira.example.invalid/rest/api/2/${path}`,
          ...(method === "DELETE" ? {} : { bodyJson: "{}" }),
          maxBodyBytes: 1000,
          timeoutMs: 1000,
        });
        return {
          ok: false,
          reason,
          ...(document ? { detail: { messages: ["Native refusal"] } } : {}),
        };
      },
    };
    expect(await executeJiraChatMutation(input)).toMatchObject({ data: { outcome } });
    expect(await executeJiraChatMutation(input)).toMatchObject({
      data: { outcome, replayed: true },
    });
    expect(f.effects).toHaveBeenCalledOnce();
  },
);
