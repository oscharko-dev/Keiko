import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi, type Mock } from "vitest";
import type { JiraMutationAttempt } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { buildUiStoreOverDatabase, createNodeUiStore } from "../store/index.js";
import { runMigrations } from "../store/schema.js";
import { createChatToolMutationStore } from "../store/chatToolMutations.js";
import type { JiraChatToolMutationIntent as ChatToolMutationIntent } from "../store/chatToolMutationTypes.js";
import { createBufferedServerLogSink } from "../../../../tests/support/buffered-server-log.js";
import {
  syntheticJira,
  type SyntheticJira,
} from "../../../../tests/support/jira-synthetic-draft-remote.js";
import { field } from "../../../../tests/support/jira-managed-remote.js";
import { podFixture, specification } from "../_requirementSupport.js";
import { openTraceSession, type TraceSession } from "../requirement-trace.js";
import { executeJiraChatMutation, type JiraChatMutationExecution } from "./jiraChatMutation.js";
import { executeJiraChatDraft, type JiraChatDraftExecution } from "./jiraChatDraft.js";
import { createGatewayAtlassianHttpBodyPort } from "./httpPort.js";
import {
  permissiveJiraTemplates,
  SYNTHETIC_ISSUE_TYPES,
} from "../../../../tests/support/jira-test-templates.js";
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
it("does not create a second issue when a timed-out create is retried under a fresh invocation after reopening", async () => {
  const directory = mkdtempSync(join(tmpdir(), "keiko-create-timeout-"));
  cleanup.push(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  const path = join(directory, "ui.sqlite");
  const f = fixture(path);
  let createdIssues = 0;
  f.effects.mockImplementation(() => {
    createdIssues += 1;
    return Promise.reject(new DOMException("Synthetic acknowledgement lost", "TimeoutError"));
  });
  expect(await executeJiraChatMutation(f.input)).toMatchObject({ data: { outcome: "unknown" } });
  const execute = vi.fn(f.input.execute);
  expect(
    await executeJiraChatMutation({
      ...f.input,
      execute,
      intent: { ...f.input.intent, invocationId: "retry-before-restart" },
    }),
  ).toMatchObject({
    data: { outcome: "unknown", replayed: true },
    isError: true,
  });
  f.close();
  const reopened = buildUiStoreOverDatabase(new DatabaseSync(path));
  cleanup.push(() => {
    reopened.close();
  });
  expect(
    await executeJiraChatMutation({
      ...f.input,
      journal: reopened.chatToolMutations,
      execute,
      intent: { ...f.input.intent, invocationId: "retry-after-timeout" },
    }),
  ).toMatchObject({
    data: { outcome: "unknown", replayed: true },
    isError: true,
  });
  expect(execute).not.toHaveBeenCalled();
  expect(f.effects).toHaveBeenCalledOnce();
  expect(createdIssues).toBe(1);
});
it("survives SIGKILL after create dispatch without issuing another create on resume", async () => {
  const directory = mkdtempSync(join(tmpdir(), "keiko-create-crash-"));
  cleanup.push(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  const path = join(directory, "ui.sqlite");
  const marker = join(directory, "remote-effects");
  const f = fixture(path);
  f.close();
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { appendFileSync } from "node:fs";
    import { DatabaseSync } from "node:sqlite";
    import { buildUiStoreOverDatabase } from "./packages/keiko-server/dist/store/index.js";
    import { executeJiraChatMutation } from "./packages/keiko-server/dist/atlassian/jiraChatMutation.js";
    import { createGatewayAtlassianHttpBodyPort } from "./packages/keiko-server/dist/atlassian/httpPort.js";
    const [path, marker, serialized] = process.argv.slice(1);
    const store = buildUiStoreOverDatabase(new DatabaseSync(path));
    const intent = JSON.parse(serialized);
    await executeJiraChatMutation({ journal: store.chatToolMutations, intent,
      beforeEffect: () => true, beforeMutation: () => true,
      httpPortFactory: (lifecycle) => createGatewayAtlassianHttpBodyPort({ ...lifecycle,
        baseUrl: "https://jira.example.invalid", authRef: "synthetic-ref",
        credentials: { resolveForExecution: () => ({ scheme: "bearer-pat", apiToken: "synthetic-test-pat" }) },
        fetchImpl: () => {
          appendFileSync(marker, "issue-created\\n");
          process.kill(process.pid, "SIGKILL");
          return new Promise(() => {});
        },
      }),
      execute: async (http) => {
        await http({ method: "POST", url: "https://jira.example.invalid/rest/api/2/issue",
          bodyJson: "{}", maxBodyBytes: 1000, timeoutMs: 1000 });
        return { ok: false, reason: "unavailable" };
      },
    });
  `,
      path,
      marker,
      JSON.stringify(f.input.intent),
    ],
    {
      encoding: "utf8",
      timeout: 10_000,
      env: { ...process.env, KEIKO_OS_KEYCHAIN: "off", KEIKO_STATE_DIR: directory },
    },
  );
  expect(child.error).toBeUndefined();
  expect(child.signal, child.stderr).toBe("SIGKILL");
  expect(readFileSync(marker, "utf8")).toBe("issue-created\n");
  const reopened = buildUiStoreOverDatabase(new DatabaseSync(path));
  let replayOpen = true;
  cleanup.push(() => {
    if (replayOpen) reopened.close();
  });
  expect(reopened.chatToolMutations?.find(f.input.intent.invocationId)?.phase).toBe("dispatched");
  const execute = vi.fn(f.input.execute);
  const resumed = {
    ...f.input,
    journal: reopened.chatToolMutations,
    execute,
    intent: { ...f.input.intent, invocationId: "resume-after-crash" },
  };
  expect(await executeJiraChatMutation(resumed)).toMatchObject({
    data: { outcome: "pending", replayed: true },
    isError: true,
  });
  expect(execute).not.toHaveBeenCalled();
  expect(f.effects).not.toHaveBeenCalled();
  expect(readFileSync(marker, "utf8")).toBe("issue-created\n");
  reopened.close();
  replayOpen = false;
  const restarted = createNodeUiStore(path);
  cleanup.push(() => {
    restarted.close();
  });
  expect(
    await executeJiraChatMutation({ ...resumed, journal: restarted.chatToolMutations }),
  ).toMatchObject({
    data: { outcome: "pending" },
    isError: true,
  });
  expect(execute).not.toHaveBeenCalled();
  expect(f.effects).not.toHaveBeenCalled();
  expect(readFileSync(marker, "utf8")).toBe("issue-created\n");
});

function execution(jira: SyntheticJira, args: CatalogJsonObject): JiraChatDraftExecution {
  const f = fixture();
  f.effects.mockImplementation(jira.fetch);
  return {
    ...f.input,
    intent: { ...f.input.intent, operation: "jira.draft" },
    arguments: args,
    deselected: [],
    context: {
      invocationId: "claim-batch",
      correlationId: "claim-batch-proof",
      signal: new AbortController().signal,
      beforeEffect: () => true,
    },
    connection: {
      baseUrl: "https://jira.example.invalid",
      deployment: "data-center",
      issueTemplates: () => permissiveJiraTemplates(["SYN"], SYNTHETIC_ISSUE_TYPES),
    },
  };
}
async function hierarchyMetadata(response: Response): Promise<Response> {
  const page = (await response.json()) as { values: Record<string, unknown>[] };
  const values = [
    ...page.values,
    {
      ...field("customfield_10010", "string"),
      name: "Epic Link",
      schema: { type: "string", custom: "com.pyxis.greenhopper.jira:gh-epic-link" },
    },
    {
      ...field("customfield_10011", "string"),
      name: "Epic Name",
      schema: { type: "string", custom: "com.pyxis.greenhopper.jira:gh-epic-label" },
    },
  ];
  return Response.json({ values, start: 0, size: values.length, total: values.length, last: true });
}
function hierarchyRemote(): SyntheticJira {
  const jira = syntheticJira();
  const original = jira.fetch.getMockImplementation();
  if (original === undefined) throw new TypeError("Missing synthetic transport");
  jira.fetch.mockImplementation(async (input, init) => {
    if ((init?.method ?? "GET") !== "GET") return original(input, init);
    const url = new URL(input instanceof Request ? input.url : String(input));
    const types: Readonly<Record<string, string>> = {
      "10000": "Epic",
      "10001": "Story",
      "10002": "Sub-task",
    };
    const typeId = /\/issuetype\/(\d+)$/u.exec(url.pathname)?.[1];
    if (typeId !== undefined)
      return Response.json({ id: typeId, name: types[typeId], subtask: typeId === "10002" });
    const response = await original(input, init);
    return url.pathname.includes("createmeta") ? hierarchyMetadata(response) : response;
  });
  return jira;
}
function requirementHierarchy(ids: readonly string[]): CatalogJsonObject {
  return {
    items: ids.map((id, index) => {
      const story = index % 2 === 1;
      const number = index + 1;
      return {
        ref: id,
        projectId: "10000",
        issueTypeId: index === 0 ? "10000" : story ? "10001" : "10002",
        fields: {
          summary: `${index === 0 ? "Epic" : story ? "Story" : "Sub-task"} ${id}`,
          description: `h2. Acceptance criteria\n* Thema ${String(number)} ist verfügbar.\n* Fehler zu Thema ${String(number)} werden gemeldet.`,
          ...(index === 0 ? { customfield_10011: "Requirement delivery" } : {}),
        },
        requirementIds: [id],
        ...(index === 0
          ? {}
          : {
              parent: {
                fieldId: story ? "customfield_10010" : "parent",
                ref: ids[story ? 0 : index - 1] ?? "",
              },
            }),
      };
    }),
  };
}
it("resumes a 251-requirement document as an Epic, 125 Stories and 125 Sub-tasks with source references and no duplicates", async () => {
  const spec = specification(251);
  const source = await podFixture([
    { capsuleId: "claim-source", text: spec.text, name: "Claim specification.md" },
  ]);
  cleanup.push(source.cleanup);
  const openTrace = (): TraceSession =>
    openTraceSession(source.deps, {
      chatId: source.chatId,
      userMessageId: "claim-source-turn",
      correlationId: "claim-source-proof",
    });
  const trace = openTrace();
  expect(trace.unitCount()).toBe(251);
  trace.close();
  const jira = hierarchyRemote();
  const args = requirementHierarchy(spec.ids);
  const first = await executeJiraChatDraft({
    ...execution(jira, args),
    openTrace,
    beforeMutation: () => jira.issues.length < 21,
  });
  expect(first.isError).toBe(true);
  expect(jira.issues).toHaveLength(21);
  const resumed = await executeJiraChatDraft({ ...execution(jira, args), openTrace });
  expect(resumed.data, JSON.stringify(resumed.data)).toMatchObject({
    createdCount: 230,
    existingCount: 21,
    pendingCount: 0,
  });
  expect(jira.issues).toHaveLength(251);
  expect(jira.posts()).toHaveLength(251);
  expect(new Set(jira.issues.map((issue) => issue.fields.summary)).size).toBe(251);
  expect(
    jira.issues.filter((issue) => (issue.fields.issuetype as { id: string }).id === "10000"),
  ).toHaveLength(1);
  expect(
    jira.issues.filter((issue) => (issue.fields.issuetype as { id: string }).id === "10001"),
  ).toHaveLength(125);
  expect(
    jira.issues.filter((issue) => (issue.fields.issuetype as { id: string }).id === "10002"),
  ).toHaveLength(125);
  for (const [index, issue] of jira.issues.entries()) {
    expect(issue.fields.description).toContain(spec.ids[index]);
    expect(issue.fields.description).toContain("Claim specification.md");
    expect(issue.fields.labels).toContain("keiko-requirement");
    if (index % 2 === 1) expect(issue.fields.customfield_10010).toBe(jira.issues[0]?.key);
    if (index > 0 && index % 2 === 0)
      expect(issue.fields.parent).toEqual({ key: jira.issues[index - 1]?.key });
  }
});
