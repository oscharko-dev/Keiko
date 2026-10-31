import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi, type Mock } from "vitest";
import type { JiraMutationAttempt } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { buildUiStoreOverDatabase, createNodeUiStore } from "../store/index.js";
import { runMigrations } from "../store/schema.js";
import { createChatToolMutationStore } from "../store/chatToolMutations.js";
import type { JiraChatToolMutationIntent as ChatToolMutationIntent } from "../store/chatToolMutationTypes.js";
import { createBufferedServerLogSink } from "../../../../tests/support/buffered-server-log.js";
import { executeJiraChatMutation, type JiraChatMutationExecution } from "./jiraChatMutation.js";
import { createGatewayAtlassianHttpBodyPort } from "./httpPort.js";

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
  const execute: JiraChatMutationExecution["execute"] = (http) =>
    f.input.execute(async (request) => {
      const response = await http(request);
      expect(response).toMatchObject({ kind: "response", status: 201, truncated: true });
      observedResponses.push(response.kind === "response" && response.truncated);
      return response;
    });
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
    ): Promise<JiraMutationAttempt> => {
      admitted = false;
      return f.input.execute(http);
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
    ): Promise<JiraMutationAttempt> => {
      entered?.();
      await held;
      return f.input.execute(http);
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
  const execute: JiraChatMutationExecution["execute"] = async (http) => {
    await f.input.execute(http);
    return f.input.execute(http);
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
  const execute: JiraChatMutationExecution["execute"] = async (http) => {
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
    return f.input.execute(http);
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
    execute: async (http) => {
      const read = {
        method: "GET",
        url: "https://jira.example.invalid/rest/api/2/issue/createmeta",
        timeoutMs: 1000,
        maxBodyBytes: 1000,
      } as const;
      await http(read);
      expect(beforeMutation).not.toHaveBeenCalled();
      const outcome = await f.input.execute(http);
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
    execute: async (http) => {
      const result = await f.input.execute(http);
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
    execute: async (http) => {
      entered?.();
      await held;
      return f.input.execute((request) => http({ ...request, signal: controller.signal }));
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
