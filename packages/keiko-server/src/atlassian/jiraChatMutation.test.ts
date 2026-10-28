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
