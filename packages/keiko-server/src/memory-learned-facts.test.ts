// Issue #4212 acceptance on the real vault: what a person says replaces, confirms or leaves a learned
// fact. Every scripted model reply goes through the real extractor, the real admission and relation
// checks and the real store.

import { Readable } from "node:stream";
import { Socket } from "node:net";
import type { IncomingMessage } from "node:http";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CodingWorkbenchMode, NormalizedResponse } from "@oscharko-dev/keiko-contracts";
import type {
  ConversationId,
  MemoryRecord,
  ProjectId,
  UserId,
  WorkspaceId,
} from "@oscharko-dev/keiko-contracts/memory";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
import {
  FACT_CHANGE_BASES,
  FACT_DROP_REASONS,
  FACT_RELATION_LABELS,
} from "@oscharko-dev/keiko-memory-capture";
import {
  planMemoryMaintenance,
  type MemoryMaintenancePlan,
} from "@oscharko-dev/keiko-memory-governance";
import { createMemoryVault, type MemoryVaultStore } from "@oscharko-dev/keiko-memory-vault";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";
import { resetServerLogger } from "../../../tests/support/activity-log-test-support.js";
import { createBufferedServerLogSink } from "../../../tests/support/buffered-server-log.js";
import {
  buildMemoryResult,
  collectMemoryActions,
  recordConversationMemoryUse,
  type SendDesktopChatRequest,
} from "./chat-handlers.js";
import { buildRedactor, createRunRegistry, type UiHandlerDeps } from "./index.js";
import {
  conversationMemoryScopes,
  type ConversationMemoryRuntimeContext,
} from "./memory-conversation-context.js";
import { handleAcceptMemoryProposal } from "./memory-handlers.js";
import {
  MEMORY_LEARN_CHANGE_BASES,
  MEMORY_LEARN_DROP_REASONS,
  MEMORY_LEARN_RELATION_LABELS,
} from "./memory-learned-facts-log.js";
import { captureSalientFromTurn } from "./memory-salience.js";
import { createServerLogger, setServerLogger } from "./observability/index.js";
import type { RouteContext } from "./routes.js";
import { createInMemoryUiStore } from "./store/index.js";

const DAY_MS = 86_400_000;

interface ScriptedItem {
  readonly body: string;
  readonly evidence?: string;
  readonly about?: string;
  readonly type?: string;
  readonly relation?: string;
  readonly related?: number | null;
}

let vaults: MemoryVaultStore[] = [];
let directories: string[] = [];

afterEach(() => {
  for (const vault of vaults) vault.close();
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  vaults = [];
  directories = [];
  resetServerLogger();
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), "keiko-learned-facts-"));
  directories.push(directory);
  return directory;
}

function makeVault(): MemoryVaultStore {
  const vault = createMemoryVault({
    memoryDir: temporaryDirectory(),
    redactString: (value) => value,
  });
  vaults.push(vault);
  return vault;
}

function context(): ConversationMemoryRuntimeContext {
  const path = temporaryDirectory();
  return {
    userId: "local-operator" as UserId,
    workspaceId: path as WorkspaceId,
    projectId: path as ProjectId,
    conversationId: "chat-1" as ConversationId,
  };
}

function scriptedModel(items: readonly ScriptedItem[]): ModelPort {
  const content = JSON.stringify({
    items: items.map((item) => ({
      evidence: item.body,
      about: "self",
      type: "preference",
      relation: "new",
      related: null,
      ...item,
    })),
  });
  return {
    call(request): Promise<NormalizedResponse> {
      return Promise.resolve({
        modelId: request.modelId,
        content,
        finishReason: "stop",
        toolCalls: [],
        structuredOutput: null,
        usage: {
          requestId: "learned-facts-test",
          promptTokens: 1,
          completionTokens: 1,
          latencyMs: 1,
          costClass: "high",
        },
      });
    },
  };
}

function makeDeps(
  vault: MemoryVaultStore,
  items: readonly ScriptedItem[],
  mode: CodingWorkbenchMode = "autonomous-delivery",
): UiHandlerDeps {
  return {
    config: undefined,
    configPresent: false,
    evidenceStore: { put: () => "", list: () => [], get: () => undefined, delete: () => undefined },
    env: {},
    redactor: buildRedactor({}),
    registry: createRunRegistry(),
    modelPortFactory: () => scriptedModel(items),
    store: createInMemoryUiStore(),
    memoryVault: vault,
    codingRuntimeDeploymentCeiling: mode,
  };
}

function say(
  vault: MemoryVaultStore,
  ctx: ConversationMemoryRuntimeContext,
  content: string,
  items: readonly ScriptedItem[],
  mode?: CodingWorkbenchMode,
): Promise<unknown> {
  const request = { content, memory: { enabled: true } };
  return captureSalientFromTurn(makeDeps(vault, items, mode), request, ctx, "gpt-test", "ok");
}

function stated(body: string): ScriptedItem {
  return { body };
}

function recordsWith(
  vault: MemoryVaultStore,
  ctx: ConversationMemoryRuntimeContext,
  status: MemoryRecord["status"],
): readonly MemoryRecord[] {
  return conversationMemoryScopes(ctx).flatMap((scope) =>
    vault.listMemoriesByScope(scope, { status: [status], includeExpired: true }),
  );
}

function liveBodies(
  vault: MemoryVaultStore,
  ctx: ConversationMemoryRuntimeContext,
): readonly string[] {
  return recordsWith(vault, ctx, "accepted").map((record) => record.body);
}

function acceptRoute(id: string): RouteContext {
  return {
    correlationId: undefined,
    req: Readable.from([Buffer.from("{}")]) as unknown as IncomingMessage,
    res: { socket: new Socket() } as unknown as RouteContext["res"],
    params: { id },
    url: new URL(`http://127.0.0.1/api/memory/proposals/${id}/accept`),
  };
}

describe("a changed fact replaces the older one", () => {
  it.each([
    ["a reversed preference", "I prefer tabs over spaces", "I prefer spaces over tabs"],
    [
      "a reversed German preference",
      "Ich bevorzuge Tabs über Spaces",
      "Ich bevorzuge Spaces über Tabs",
    ],
    ["a changed number", "I use PostgreSQL 14", "I use PostgreSQL 16"],
    ["a changed German number", "Ich nutze PostgreSQL 14", "Ich nutze PostgreSQL 16"],
    ["a changed polarity", "Ich mag Tabellen", "Ich mag keine Tabellen"],
  ])("supersedes on %s, with only the newer one retrievable", async (_name, older, newer) => {
    const vault = makeVault();
    const ctx = context();
    await say(vault, ctx, older, [stated(older)]);
    await say(vault, ctx, newer, [stated(newer)]);

    expect(liveBodies(vault, ctx)).toEqual([newer]);
    const [superseded] = recordsWith(vault, ctx, "superseded");
    expect(superseded?.body).toBe(older);
    expect(superseded?.validity.validUntil).toBeDefined();
    if (superseded === undefined) throw new Error("expected the older fact");
    expect(vault.listOutgoingEdges(superseded.id).map((edge) => edge.kind)).toEqual(["supersedes"]);

    const request = {
      content: newer,
      memory: { enabled: true, budgetTokens: 900, context: {} },
    } as unknown as SendDesktopChatRequest;
    const retrieved = await buildMemoryResult(request, makeDeps(vault, []), ctx);
    expect(retrieved.context.text).toContain(newer);
    expect(retrieved.context.text).not.toContain(older);
  });

  it.each([
    ["German", "Ich bevorzuge Tabellen", "Ab jetzt lieber Listen", "Lieber Listen"],
    ["German, normalized", "Ich bevorzuge Tabellen", "Ab jetzt lieber Listen", "Bevorzugt Listen"],
    ["English", "I prefer tables", "From now on I prefer lists", "I prefer lists"],
  ])(
    "replaces on a stated change in %s with the person's words",
    async (_language, older, said, body) => {
      const vault = makeVault();
      const ctx = context();
      await say(vault, ctx, older, [stated(older)]);
      await say(vault, ctx, said, [{ body, evidence: said, relation: "update", related: 1 }]);

      expect(liveBodies(vault, ctx)).toEqual([said]);
      expect(recordsWith(vault, ctx, "superseded").map((record) => record.body)).toEqual([older]);
    },
  );

  it("leaves two alike statements about different things standing, whatever the model says", async () => {
    const vault = makeVault();
    const ctx = context();
    const numbers = "Ich bevorzuge Tabellen für Zahlen";
    const text = "Ich bevorzuge Listen für Texte";
    await say(vault, ctx, numbers, [stated(numbers)]);
    await say(vault, ctx, text, [{ body: text, relation: "contradiction", related: 1 }]);

    expect([...liveBodies(vault, ctx)].sort()).toEqual([numbers, text].sort());
    expect(recordsWith(vault, ctx, "superseded")).toEqual([]);
  });

  it("does not take an unconfirmed relation for a change", async () => {
    const vault = makeVault();
    const ctx = context();
    await say(vault, ctx, "Ich mag Tee", [stated("Ich mag Tee")]);
    await say(vault, ctx, "Ich fahre Fahrrad", [
      { body: "Ich fahre Fahrrad", relation: "contradiction", related: 1 },
    ]);

    expect(liveBodies(vault, ctx)).toHaveLength(2);
  });

  it("waits for the person's approval in Ask mode and then replaces through the correction path", async () => {
    const vault = makeVault();
    const ctx = context();
    await say(
      vault,
      ctx,
      "I use PostgreSQL 14",
      [stated("I use PostgreSQL 14")],
      "governed-assist",
    );
    const [older] = recordsWith(vault, ctx, "proposed");
    if (older === undefined) throw new Error("expected the first proposal");
    const accept = makeDeps(vault, [], "governed-assist");
    expect((await handleAcceptMemoryProposal(acceptRoute(older.id), accept)).status).toBe(200);

    await say(
      vault,
      ctx,
      "I use PostgreSQL 16",
      [stated("I use PostgreSQL 16")],
      "governed-assist",
    );

    const [correction] = recordsWith(vault, ctx, "proposed");
    if (correction === undefined) throw new Error("expected a correction proposal");
    expect(correction.type).toBe("correction");
    expect(liveBodies(vault, ctx)).toEqual(["I use PostgreSQL 14"]);
    expect(vault.listOutgoingEdges(older.id).map((edge) => edge.kind)).toEqual(["corrects"]);

    expect((await handleAcceptMemoryProposal(acceptRoute(correction.id), accept)).status).toBe(200);
    expect(liveBodies(vault, ctx)).toEqual(["I use PostgreSQL 16"]);
    expect(recordsWith(vault, ctx, "superseded").map((record) => record.body)).toEqual([
      "I use PostgreSQL 14",
    ]);
  });

  it("lets a newer clear statement win over an older learned fact", async () => {
    const vault = makeVault();
    const ctx = context();
    await say(vault, ctx, "Ich bevorzuge Tabs über Spaces", [
      stated("Ich bevorzuge Tabs über Spaces"),
    ]);

    const request = {
      content: "Merke dir: Ich bevorzuge Spaces über Tabs",
      memory: { enabled: true },
    } as unknown as SendDesktopChatRequest;
    await collectMemoryActions(makeDeps(vault, []), request, ctx);

    expect(recordsWith(vault, ctx, "superseded").map((record) => record.body)).toEqual([
      "Ich bevorzuge Tabs über Spaces",
    ]);
    expect(liveBodies(vault, ctx)).toEqual(["Ich bevorzuge Spaces über Tabs"]);
  });

  it("keeps an earlier clear statement when a later clear one only reads alike", async () => {
    const vault = makeVault();
    const ctx = context();
    const deps = makeDeps(vault, []);
    const say = (content: string): ReturnType<typeof collectMemoryActions> =>
      collectMemoryActions(
        deps,
        { content, memory: { enabled: true } } as unknown as SendDesktopChatRequest,
        ctx,
      );
    await say("Merke dir: Ich mag Tee");
    await say("Merke dir: Ich mag Kaffee");

    expect(liveBodies(vault, ctx)).toHaveLength(2);
    expect(recordsWith(vault, ctx, "superseded")).toEqual([]);
  });
});

describe("what the person repeats and what the answer repeats", () => {
  it("stores a repeated fact once and records the confirmation", async () => {
    const vault = makeVault();
    const ctx = context();
    const fact = "Ich bevorzuge Tabellen";
    await say(vault, ctx, fact, [stated(fact)]);
    await say(vault, ctx, fact, [{ body: fact, relation: "same", related: 1 }]);

    const records = recordsWith(vault, ctx, "accepted");
    expect(records.map((record) => record.body)).toEqual([fact]);
    const [record] = records;
    if (record === undefined) throw new Error("expected the fact");
    expect(vault.getAccessStats([record.id]).get(record.id)?.accessCount).toBe(1);
  });

  it.each([
    ["forgot", "forget"],
    ["edited", "edit"],
  ] as const)(
    "leaves alone a fact the person %s while the model was answering",
    async (_label, change) => {
      const sink = createBufferedServerLogSink();
      setServerLogger(createServerLogger({ sink, level: "info" }));
      const vault = makeVault();
      const ctx = context();
      const fact = "Ich bevorzuge Tabellen";
      await say(vault, ctx, fact, [stated(fact)]);
      const [record] = recordsWith(vault, ctx, "accepted");
      if (record === undefined) throw new Error("expected the fact");
      const deps = makeDeps(vault, []);
      const model = scriptedModel([{ body: fact, relation: "same", related: 1 }]);
      const changingModel: ModelPort = {
        call: (request, signal) => {
          if (change === "forget") {
            vault.deleteMemory(record.id, {
              tombstone: true,
              forgetterSurface: "test",
              nowMs: record.updatedAt + 1,
            });
          } else {
            vault.updateMemory(record.id, { body: "Ich bevorzuge Listen" }, record.updatedAt + 1);
          }
          return model.call(request, signal);
        },
      };

      await expect(
        captureSalientFromTurn(
          { ...deps, modelPortFactory: () => changingModel },
          { content: fact, memory: { enabled: true } },
          ctx,
          "gpt-test",
          "ok",
        ),
      ).resolves.toBeDefined();

      expect(vault.getAccessStats([record.id]).get(record.id)?.accessCount ?? 0).toBe(0);
      const relation = sink.events.filter((event) => event.op === "memory.learn.relation").at(-1);
      if (relation === undefined) throw new Error("expected a relation line");
      expect(
        expectActivityLogProof("memory.learn.relation.line", formatActivityLogProofLine(relation)),
      ).toMatchObject({ decision: "refused", label: "same" });
    },
  );

  it("does not strengthen a memory because an answer repeated it", async () => {
    const vault = makeVault();
    const ctx = context();
    const fact = "Ich bevorzuge Tabellen";
    await say(vault, ctx, fact, [stated(fact)]);
    const [record] = recordsWith(vault, ctx, "accepted");
    if (record === undefined) throw new Error("expected the fact");

    recordConversationMemoryUse(
      makeDeps(vault, []),
      { context: { memories: [{ memoryId: record.id, bodyExcerpt: fact }] } } as never,
      "Du bevorzugst Tabellen.",
      ctx,
    );

    const stats = vault.getAccessStats([record.id]).get(record.id);
    expect(stats?.accessCount ?? 0).toBe(0);
    expect(stats?.lastUsedAt).toBeGreaterThan(0);
  });

  it.each([
    ["a fresh", 1],
    ["an aged", 400],
  ])("leaves the retention of %s memory as it was when an answer used it", async (_l, days) => {
    const vault = makeVault();
    const ctx = context();
    const fact = "Ich bevorzuge Tabellen";
    await say(vault, ctx, fact, [stated(fact)]);
    const [record] = recordsWith(vault, ctx, "accepted");
    if (record === undefined) throw new Error("expected the fact");
    const nowMs = record.createdAt + days * DAY_MS;
    const plan = (): MemoryMaintenancePlan =>
      planMemoryMaintenance([record], vault.getAccessStats(), { nowMs });
    const before = plan();

    vault.recordUse([record.id], nowMs, ctx.conversationId);

    expect(vault.getAccessStats([record.id]).get(record.id)?.lastUsedAt).toBe(nowMs);
    expect(plan()).toEqual(before);
  });

  it("does change the retention of an aged memory the person recalled, as a control", async () => {
    const vault = makeVault();
    const ctx = context();
    const fact = "Ich bevorzuge Tabellen";
    await say(vault, ctx, fact, [stated(fact)]);
    const [record] = recordsWith(vault, ctx, "accepted");
    if (record === undefined) throw new Error("expected the fact");
    const nowMs = record.createdAt + 400 * DAY_MS;
    const plan = (): MemoryMaintenancePlan =>
      planMemoryMaintenance([record], vault.getAccessStats(), { nowMs });
    expect(plan().archive).toEqual([record.id]);

    vault.recordAccess([record.id], nowMs, ctx.conversationId);

    expect(plan().archive).toEqual([]);
  });
});

describe("nothing the person did not write is stored", () => {
  const SAID = "Heute war viel los. Ich arbeite gerne morgens.";

  it.each([
    ["invents a fact", { body: "Ich wohne in Hamburg", evidence: "Ich wohne in Hamburg" }],
    [
      "paraphrases the evidence",
      { body: "Ich arbeite gerne morgens", evidence: "Ich arbeite am liebsten früh" },
    ],
    ["returns evidence not in the text", { body: "Ich mag Tee", evidence: "Ich mag Tee" }],
    ["attributes it to someone else", { body: "Ich arbeite gerne morgens", about: "other" }],
  ])("stores nothing when the model %s", async (_name, item) => {
    const vault = makeVault();
    const ctx = context();
    await say(vault, ctx, SAID, [item]);
    expect(recordsWith(vault, ctx, "accepted")).toEqual([]);
    expect(recordsWith(vault, ctx, "proposed")).toEqual([]);
  });

  it("stores only the person's words when the model adds words to its statement", async () => {
    const vault = makeVault();
    const ctx = context();
    await say(vault, ctx, SAID, [
      { body: "Ich arbeite gerne morgens in Berlin", evidence: "Ich arbeite gerne morgens" },
    ]);

    expect(liveBodies(vault, ctx)).toEqual(["Ich arbeite gerne morgens"]);
    expect(JSON.stringify(recordsWith(vault, ctx, "accepted"))).not.toContain("Berlin");
  });

  it("keeps a genuine fact inside a longer sentence as one body with its exact words", async () => {
    const vault = makeVault();
    const ctx = context();
    await say(vault, ctx, SAID, [
      { body: "Ich arbeite gerne morgens", evidence: "Ich arbeite gerne morgens." },
    ]);

    const [record] = recordsWith(vault, ctx, "accepted");
    expect(record?.body).toBe("Ich arbeite gerne morgens.");
    expect(record?.provenance.evidenceSpan).toBe("Ich arbeite gerne morgens.");
    expect(record?.body).not.toContain("Heute");
  });

  it.each([
    ["a German phone number", "Meine Nummer ist 0171 2345678"],
    ["an international phone number", "My number is +1 415 555 0100"],
    ["a North American phone number", "My number is (415) 555-0100"],
    ["a German IBAN", "Meine IBAN ist DE89 3704 0044 0532 0130 00"],
    ["a foreign IBAN", "My IBAN is GB82 WEST 1234 5698 7654 32"],
    ["a customer number", "Meine Kundennummer ist 884213"],
    ["a customer id", "My customer id is 884213"],
    ["a credential", "My password=FAKE-TEST-PLACEHOLDER-VALUE"],
  ])("never stores %s", async (_name, said) => {
    const vault = makeVault();
    const ctx = context();
    await say(vault, ctx, said, [{ body: said, type: "fact" }]);
    expect(
      conversationMemoryScopes(ctx).flatMap((scope) => vault.listMemoriesByScope(scope)),
    ).toEqual([]);
  });
});

describe("what a fact keeps from the person's words", () => {
  // Lab regression (#4212): storing the model's paraphrase lost the words a later question uses,
  // so the answer received no memory and answer accuracy fell below the baseline.
  it.each([
    [
      "If I preferred tables, I would have told you. I actually like plain text.",
      "Prefers plain text.",
      "I actually like plain text",
      "How do I like my answers formatted?",
    ],
    [
      "Ich bevorzuge Tabellen, wenn du mir Zahlen zeigst.",
      "Bevorzugt Tabellen bei Zahlen",
      "Ich bevorzuge Tabellen, wenn du mir Zahlen zeigst",
      "Wie sollst du mir Zahlen zeigen?",
    ],
  ])(
    "stores the person's words, never the model's paraphrase: %s",
    async (said, body, evidence, question) => {
      const vault = makeVault();
      const ctx = context();
      await say(vault, ctx, said, [{ body, evidence, type: "preference" }]);

      expect(liveBodies(vault, ctx)).toEqual([evidence]);
      const request = {
        content: question,
        memory: { enabled: true, budgetTokens: 900, context: {} },
      } as unknown as SendDesktopChatRequest;
      const retrieved = await buildMemoryResult(request, makeDeps(vault, []), ctx);
      expect(retrieved.context.text).toContain(evidence);
    },
  );

  it("carries a decision's reason in the payload", async () => {
    const vault = makeVault();
    const ctx = context();
    const said = "Ich habe mich für eine lokale Warteschlange entschieden, weil sie offline läuft.";
    await say(vault, ctx, said, [
      {
        body: "Ich habe mich für eine lokale Warteschlange entschieden",
        evidence: "Ich habe mich für eine lokale Warteschlange entschieden",
        type: "decision",
      },
    ]);

    const [record] = recordsWith(vault, ctx, "accepted");
    expect(record?.payload).toEqual({
      kind: "key-value",
      entries: [
        { key: "decision", value: "Ich habe mich für eine lokale Warteschlange entschieden" },
        { key: "reason", value: "sie offline läuft" },
      ],
    });
  });

  it.each(["Ich nutze bis März Tabellen", "I use tables until March"])(
    "closes the validity at a stated end: %s",
    async (said) => {
      const vault = makeVault();
      const ctx = context();
      await say(vault, ctx, said, [stated(said)]);

      const [record] = recordsWith(vault, ctx, "accepted");
      expect(record?.validity.validUntil).toBeGreaterThan(Date.now());
    },
  );
});

describe("what stays out of the way of a learned fact", () => {
  it("admits the person's own clause beside someone else's", async () => {
    const vault = makeVault();
    const ctx = context();
    const clause = "ich führe meine Zahlen immer im Wiki";
    await say(vault, ctx, `Frau Ostrander rechnet alles in Excel, ${clause}.`, [stated(clause)]);

    expect(liveBodies(vault, ctx)).toEqual(["Ich führe meine Zahlen immer im Wiki"]);
  });

  it("keeps a fact in the person's own scope, whatever scope the model names", async () => {
    const vault = makeVault();
    const ctx = context();
    const fact = "Ich nutze Tabellen";
    const item = { ...stated(fact), scope: "project" } as ScriptedItem;
    await say(vault, ctx, fact, [item]);

    expect(recordsWith(vault, ctx, "accepted").map((record) => record.scope.kind)).toEqual([
      "user",
    ]);
  });

  it("leaves a thin fact with no subject waiting for approval when supervised", async () => {
    const vault = makeVault();
    const ctx = context();
    await say(vault, ctx, "Ich bevorzuge Tabellen", [stated("Ich bevorzuge Tabellen")]);
    const change = "Ab jetzt lieber Listen in allen langen Berichten";
    await say(
      vault,
      ctx,
      change,
      [{ body: "Bevorzugt Listen", evidence: change, relation: "update", related: 1 }],
      "supervised-coding",
    );

    const [waiting] = recordsWith(vault, ctx, "proposed");
    expect(waiting?.body).toBe(change);
    expect(waiting?.provenance.confidence).toBe(0.4);
    expect(liveBodies(vault, ctx)).toContain("Ich bevorzuge Tabellen");
  });

  it("does not replace what the person stated clearly or what lies outside their scope", async () => {
    const vault = makeVault();
    const ctx = context();
    const deps = makeDeps(vault, []);
    await collectMemoryActions(
      deps,
      {
        chatId: "chat-1",
        content: "Merke dir, dass ich Jira nutze.",
        memory: { enabled: true },
      } as never,
      ctx,
    );
    const clear = liveBodies(vault, ctx);
    expect(clear).toHaveLength(1);
    await say(vault, ctx, "Ich nutze kein Jira", [stated("Ich nutze kein Jira")]);

    expect(liveBodies(vault, ctx)).toEqual(
      expect.arrayContaining([...clear, "Ich nutze kein Jira"]),
    );
    expect(recordsWith(vault, ctx, "superseded")).toEqual([]);
  });

  it("does not learn a fact the person forgot while the capture was still running", async () => {
    const vault = makeVault();
    const ctx = context();
    const statement = "Ich bevorzuge Tabellen, wenn du mir Zahlen zeigst.";
    vault.recordForgottenStatements(
      conversationMemoryScopes(ctx).map((scope) => ({
        scope,
        body: statement,
        forgetterSurface: "chat-statement",
        reviewerId: "local-operator",
        reason: "explicit-user-request",
        nowMs: Date.now(),
      })) as never,
    );
    await say(vault, ctx, statement, [
      { body: "Bevorzugt Tabellen", evidence: "Ich bevorzuge Tabellen" },
    ]);

    expect(liveBodies(vault, ctx)).toEqual([]);
  });

  it("keeps a correction and its link to the older fact together", async () => {
    const vault = makeVault();
    const ctx = context();
    await say(vault, ctx, "Ich nutze PostgreSQL 14", [stated("Ich nutze PostgreSQL 14")]);
    const faulty: MemoryVaultStore = {
      ...vault,
      applyGraphMutation: (): never => {
        throw new Error("storage refused");
      },
    };
    await say(
      faulty,
      ctx,
      "Ich nutze PostgreSQL 16",
      [stated("Ich nutze PostgreSQL 16")],
      "governed-assist",
    ).catch(() => undefined);

    expect(recordsWith(vault, ctx, "proposed")).toEqual([]);
  });
});

describe("what a pronoun and a team's decision become", () => {
  function userMessage(
    deps: UiHandlerDeps,
    chatId: string,
    content: string,
    at: number,
  ): ReturnType<UiHandlerDeps["store"]["createMessage"]> {
    return deps.store.createMessage({
      chatId,
      role: "user",
      content,
      timestamp: at,
      runId: undefined,
      workflowId: undefined,
      workflowStatus: undefined,
      shortResult: undefined,
      taskType: undefined,
    });
  }

  it("resolves a pronoun from the person's previous message in the same chat", async () => {
    const vault = makeVault();
    const base = context();
    const body = "Meine Berichte beginnen immer mit einer Zusammenfassung";
    const evidence = "Sie beginnen immer mit einer Zusammenfassung";
    const deps = makeDeps(vault, [{ body, evidence, type: "procedural" }]);
    deps.store.createProject(base.projectId, "Fixture");
    const chatId = deps.store.createChat(base.projectId, "Fixture", "gpt-test").id;
    const ctx = { ...base, conversationId: chatId as ConversationId };
    userMessage(deps, chatId, "Ich habe eine neue Regel fuer meine Berichte.", 1);
    const current = userMessage(deps, chatId, `${evidence}.`, 2);
    const request = {
      content: current.content,
      sourceMessageId: current.id,
      memory: { enabled: true },
    };
    await captureSalientFromTurn(deps, request, ctx, "gpt-test", "ok");

    expect(liveBodies(vault, ctx)).toEqual([body]);
  });

  it("stores a team's decision in the project", async () => {
    const vault = makeVault();
    const ctx = context();
    const decision = "We decided as a team to release only on Tuesdays.";
    await say(vault, ctx, decision, [{ body: decision, about: "team", type: "decision" }]);

    expect(recordsWith(vault, ctx, "accepted").map((record) => record.scope.kind)).toEqual([
      "project",
    ]);
  });
});

// The person changes a stored fact while the model call of a capture is still running.
function changingDuringCall(model: ModelPort, change: () => void): ModelPort {
  let changed = false;
  return {
    call(request, signal): Promise<NormalizedResponse> {
      if (!changed) {
        changed = true;
        change();
      }
      return model.call(request, signal);
    },
  };
}

function changeWhileRunning(vault: MemoryVaultStore, ctx: ConversationMemoryRuntimeContext): void {
  const [older] = recordsWith(vault, ctx, "accepted");
  if (older === undefined) throw new Error("expected a stored fact");
  vault.updateMemory(older.id, { tags: ["edited"] }, older.updatedAt + 1);
}

describe("a replacement that cannot complete", () => {
  async function replaceWith(
    fault: (vault: MemoryVaultStore) => MemoryVaultStore,
  ): Promise<{ vault: MemoryVaultStore; ctx: ConversationMemoryRuntimeContext; failures: number }> {
    const vault = makeVault();
    const ctx = context();
    await say(vault, ctx, "Ich nutze PostgreSQL 14", [stated("Ich nutze PostgreSQL 14")]);
    let failures = 0;
    const deps: UiHandlerDeps = {
      ...makeDeps(fault(vault), [stated("Ich nutze PostgreSQL 16")]),
      diagnostics: {
        record: (): void => {
          failures += 1;
        },
      },
    };
    await captureSalientFromTurn(
      deps,
      { content: "Ich nutze PostgreSQL 16", memory: { enabled: true } },
      ctx,
      "gpt-test",
      "ok",
    );
    return { vault, ctx, failures };
  }

  it("keeps the older fact and reports the failure when the transaction throws", async () => {
    const { vault, ctx, failures } = await replaceWith((real) => ({
      ...real,
      applyGraphMutation: (): never => {
        throw new Error("storage refused");
      },
    }));

    expect(liveBodies(vault, ctx)).toEqual(["Ich nutze PostgreSQL 14"]);
    expect(recordsWith(vault, ctx, "superseded")).toEqual([]);
    expect(failures).toBeGreaterThan(0);
  });

  it("keeps the fact the person changed while the capture was still running", async () => {
    const vault = makeVault();
    const ctx = context();
    await say(vault, ctx, "Ich nutze PostgreSQL 14", [stated("Ich nutze PostgreSQL 14")]);
    let failures = 0;
    const deps: UiHandlerDeps = {
      ...makeDeps(vault, [stated("Ich nutze PostgreSQL 16")]),
      modelPortFactory: () =>
        changingDuringCall(scriptedModel([stated("Ich nutze PostgreSQL 16")]), () => {
          changeWhileRunning(vault, ctx);
        }),
      diagnostics: {
        record: (diagnostic): void => {
          if (diagnostic.source === "memory-salience.settleCandidate") failures += 1;
        },
      },
    };
    await captureSalientFromTurn(
      deps,
      { content: "Ich nutze PostgreSQL 16", memory: { enabled: true } },
      ctx,
      "gpt-test",
      "ok",
    );

    expect(liveBodies(vault, ctx)).toEqual(["Ich nutze PostgreSQL 14"]);
    expect(recordsWith(vault, ctx, "superseded")).toEqual([]);
    expect(failures).toBe(1);
  });

  it("still settles the turn's other facts when one replacement lost its race", async () => {
    const vault = makeVault();
    const ctx = context();
    await say(vault, ctx, "Ich nutze PostgreSQL 14", [stated("Ich nutze PostgreSQL 14")]);
    const items = [stated("Ich nutze PostgreSQL 16"), stated("Ich trinke gern Tee")];
    let failures = 0;
    const deps: UiHandlerDeps = {
      ...makeDeps(vault, items),
      modelPortFactory: () =>
        changingDuringCall(scriptedModel(items), () => {
          changeWhileRunning(vault, ctx);
        }),
      diagnostics: {
        record: (diagnostic): void => {
          if (diagnostic.source === "memory-salience.settleCandidate") failures += 1;
        },
      },
    };
    await captureSalientFromTurn(
      deps,
      { content: "Ich nutze PostgreSQL 16. Ich trinke gern Tee.", memory: { enabled: true } },
      ctx,
      "gpt-test",
      "ok",
    );

    expect([...liveBodies(vault, ctx)].sort()).toEqual([
      "Ich nutze PostgreSQL 14",
      "Ich trinke gern Tee",
    ]);
    expect(recordsWith(vault, ctx, "superseded")).toEqual([]);
    expect(failures).toBe(1);
  });
});

describe("learning leaves body-free evidence", () => {
  it("counts the person's message the fact came from", async () => {
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "info" }));
    const vault = makeVault();
    const ctx = context();
    const fact = "Ich nutze Tabellen";
    await captureSalientFromTurn(
      makeDeps(vault, [stated(fact)]),
      { content: fact, sourceMessageId: "message-7", memory: { enabled: true } },
      ctx,
      "gpt-test",
      "ok",
    );

    const extraction = sink.events.find((event) => event.op === "memory.learn.extraction");
    if (extraction === undefined) throw new Error("expected an extraction line");
    expect(
      expectActivityLogProof(
        "memory.learn.extraction.line",
        formatActivityLogProofLine(extraction),
      ),
    ).toMatchObject({ sourceMessageCount: 1 });
    const [record] = recordsWith(vault, ctx, "accepted");
    expect(record?.provenance.sourceMessageIds).toEqual(["message-7"]);
  });

  it("logs every reason capture can report", () => {
    expect(MEMORY_LEARN_DROP_REASONS).toEqual(expect.arrayContaining([...FACT_DROP_REASONS]));
    expect(MEMORY_LEARN_RELATION_LABELS).toEqual([...FACT_RELATION_LABELS]);
    expect(MEMORY_LEARN_CHANGE_BASES).toEqual([...FACT_CHANGE_BASES]);
  });

  it("records extraction, drops and the relation with closed values only", async () => {
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "info" }));
    const vault = makeVault();
    const ctx = context();
    await say(vault, ctx, "Ich nutze PostgreSQL 14", [stated("Ich nutze PostgreSQL 14")]);
    await say(vault, ctx, "Ich nutze PostgreSQL 16", [
      stated("Ich nutze PostgreSQL 16"),
      { body: "Ich wohne in Hamburg", evidence: "Ich wohne in Hamburg" },
    ]);

    const event = (op: string, index = 0): Record<string, unknown> => {
      const found = sink.events.filter((candidate) => candidate.op === op)[index];
      if (found === undefined) throw new Error(`expected a ${op} line`);
      return found as unknown as Record<string, unknown>;
    };

    expect(
      expectActivityLogProof(
        "memory.learn.extraction.line",
        formatActivityLogProofLine(event("memory.learn.extraction", 1)),
      ),
    ).toMatchObject({
      rawItemCount: 2,
      admittedCount: 1,
      knownFactCount: 1,
      sourceMessageCount: 0,
    });
    expect(
      expectActivityLogProof(
        "memory.learn.dropped.line",
        formatActivityLogProofLine(event("memory.learn.dropped")),
      ),
    ).toMatchObject({
      reason: "evidence-not-verbatim",
      count: 1,
    });
    expect(
      expectActivityLogProof(
        "memory.learn.relation.line",
        formatActivityLogProofLine(event("memory.learn.relation", 1)),
      ),
    ).toMatchObject({
      label: "new",
      decision: "superseded",
      basis: "number-changed",
    });
    const text = sink.lines().join("\n");
    for (const word of ["PostgreSQL", "Hamburg"]) expect(text).not.toContain(word);
  });
});
