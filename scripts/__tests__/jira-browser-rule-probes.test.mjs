// Hermetic W12 workflow tests: the browser and independent native HTTP read are injected doubles.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URL } from "node:url";
import { memoryLimitIntent } from "./helpers/limit-run-intent.mjs";

const ports = vi.hoisted(() => ({
  turn: vi.fn(),
  mode: vi.fn(),
  native: vi.fn(),
  visible: vi.fn(),
}));
vi.mock("../testing/jira-chat-lab/browser-workflow-turn.mjs", () => ({
  sendBrowserTurn: ports.turn,
  openWorkflowBrowser: vi.fn(() => {
    throw new Error("An already-open page must be reused");
  }),
}));
vi.mock("../testing/jira-chat-lab/browser-connections.mjs", () => ({
  selectAccessMode: ports.mode,
}));
vi.mock("../testing/jira-chat-lab/browser-rules-knowledge-setup.mjs", () => ({
  browserKnowledgeDocuments: vi.fn(),
  createBrowserKnowledgePod: vi.fn(),
  uploadBrowserSkill: vi.fn(),
  removeBrowserSkill: vi.fn(),
}));
vi.mock("../testing/jira-chat-lab/chat-read.mjs", () => ({ withLiveChat: vi.fn() }));
vi.mock("../lib/workspace-storage-fixture.mjs", () => ({
  workspaceStorageArgs: async () => ({ storageKeys: { workspace: "fixture-workspace" } }),
}));
vi.mock("../testing/jira-chat-lab/lab-client.mjs", async () => {
  const fs = await import("node:fs");
  return {
    labRequest: ports.native,
    basicAuth: () => {
      throw new Error("The supplied read-only oracle identity must be used");
    },
    labSessionConnection: () => ({ httpsOrigin: "https://jira.synthetic.invalid" }),
    readPrivateFile: (path) => fs.readFileSync(path, "utf8"),
    loadSession: vi.fn(),
  };
});
vi.mock("@playwright/test", () => ({ expect: () => ({ toBeVisible: ports.visible }) }));

import * as journey from "../testing/jira-chat-lab/browser-rules-knowledge-journey.mjs";
import { rulesKnowledgeArguments } from "../testing/jira-chat-lab/browser-rules-knowledge.mjs";
import { resolveLimitBrowser } from "../testing/jira-chat-lab/limit-run-browser.mjs";

const MODES = ["governed-assist", "supervised-coding", "autonomous-delivery"];
const CHAT_ID = "11111111-1111-4111-8111-111111111111";
const roots = [];
let issues;

function refusal(template = "LIM7/Epic") {
  return {
    decisions: 0,
    exchanges: [
      {
        call: { name: "jira_create", arguments: {} },
        result: {
          toolRef: { canonicalId: "keiko.jira.create", contractVersion: 1 },
          status: "failed",
          reason: "provider-reported-error",
          effectStarted: false,
          data: {
            outcome: "rejected",
            reason: "field-validation",
            violations: [{ ruleId: "summary-pattern", template }],
          },
        },
      },
    ],
  };
}

function context() {
  const root = mkdtempSync(join(tmpdir(), "keiko-w12-probes-"));
  roots.push(root);
  const region = {
    filter: vi.fn(function () {
      return this;
    }),
    count: vi.fn(async () => 1),
    getAttribute: vi.fn(async (key) => {
      if (key === "lang") return "en";
      return key === "data-window-id" ? "fixture-chat-window" : null;
    }),
    getByRole: vi.fn(function () {
      return this;
    }),
    last: vi.fn(function () {
      return this;
    }),
    click: vi.fn(async () => undefined),
  };
  const requests = [];
  const page = {
    locator: vi.fn(() => region),
    getByRole: vi.fn(() => region),
    url: () => "http://127.0.0.1:32209/",
    context: () => ({
      // The product scopes its session cookie to each consuming API path, never to the origin.
      cookies: async (urls) =>
        urls === undefined
          ? [
              {
                name: "fixture-session",
                value: "synthetic-cookie",
                domain: "127.0.0.1",
                path: "/api/chats",
              },
              {
                name: "fixture-session",
                value: "synthetic-cookie",
                domain: "127.0.0.1",
                path: "/api/skills",
              },
              {
                name: "foreign-session",
                value: "foreign-cookie",
                domain: "foreign.invalid",
                path: "/",
              },
            ]
          : [],
    }),
    evaluate: vi.fn(async (_read, key) =>
      key === "fixture-workspace"
        ? [{ id: "fixture-chat-window", type: "chat", cfg: { chatId: CHAT_ID } }]
        : key,
    ),
    request: {
      get: vi.fn(async (path) => {
        requests.push(path);
        const value = path.startsWith("/api/projects")
          ? { projects: [{ path: "/synthetic/workspace" }] }
          : {
              chats: [
                {
                  id: CHAT_ID,
                  title: "Runtime chat",
                  projectPath: "/synthetic/workspace",
                  selectedModel: "fixture-model",
                },
              ],
            };
        return { status: () => 200, ok: () => true, json: async () => value };
      }),
    },
  };
  return {
    sessionDir: root,
    session: { directory: root, oracleAuthorization: "fixture-oracle" },
    page,
    projectKey: "LIM7",
    locale: "en",
    modelId: "fixture-model",
    chat: { id: CHAT_ID, projectPath: "/synthetic/workspace" },
    turn: ports.turn,
    intent: memoryLimitIntent(),
    signal: new globalThis.AbortController().signal,
    requests,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  issues = [{ id: "1", key: "LIM7-1", fields: { summary: "Synthetic baseline", labels: [] } }];
  ports.native.mockImplementation(async (_session, method, path) => {
    expect(method).toBe("GET");
    const url = new URL(path, "https://jira.synthetic.invalid");
    expect(url.pathname).toBe("/rest/api/2/search");
    expect(url.searchParams.get("jql")).toBe("project = LIM7 ORDER BY id ASC");
    return {
      status: 200,
      value: { startAt: 0, total: issues.length, issues: structuredClone(issues) },
    };
  });
  ports.turn.mockImplementation(async () => refusal());
});
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("W12 runtime project and formal refusal probes", () => {
  it.each(["turn", "chat"])(
    "requires the orchestrator's %s instead of adopting another owner",
    async (field) => {
      const ctx = context();
      ctx[field] = undefined;
      expect(await journey.runRuleProbes(ctx, { modes: MODES })).toMatchObject({
        status: "unverified",
      });
      expect(ports.turn).not.toHaveBeenCalled();
      expect(ports.mode).not.toHaveBeenCalled();
    },
  );
  it("keeps the REQ default exclusively in the legacy CLI's optional fifth argument", () => {
    const args = ["/synthetic/session", "model-a", "embed-b", "7"];
    expect(rulesKnowledgeArguments(args).projectKey).toBe("REQ");
    expect(rulesKnowledgeArguments([...args, "LIM7"]).projectKey).toBe("LIM7");
    expect(() => rulesKnowledgeArguments([...args, "LIM7 OR 1=1"])).toThrow();
    expect(() => rulesKnowledgeArguments([...args, "LIM7", "extra"])).toThrow();
  });

  it("exports the fixed async building-block contract", () => {
    expect(journey.runRuleProbes).toBeTypeOf("function");
  });

  it("proves three actual scoped refusals with independent before/after reads and no approval", async () => {
    const ctx = context();
    const result = await journey.runRuleProbes(ctx, { modes: MODES });
    expect(result).toMatchObject({
      step: "w12-rule-probes",
      status: "green",
      counts: {
        requestedModes: 3,
        probedModes: 3,
        refusals: 3,
        nativeWrites: 0,
        approvals: 0,
      },
    });
    expect(ports.mode.mock.calls.map((call) => call[2])).toEqual(MODES);
    expect(ports.turn).toHaveBeenCalledTimes(3);
    expect(ports.native.mock.calls.length).toBeGreaterThanOrEqual(6);
    for (const call of ports.turn.mock.calls) {
      expect(call[0]).toBe(ctx.chat);
      expect(call[1]).toContain("Projekt LIM7");
      expect(call[1]).not.toContain("REQ");
      expect(call[2].operations).toEqual(["jira.create"]);
      expect(call[2].beforeDecision).toBeTypeOf("function");
    }
    const evidence = JSON.stringify(ctx.intent.state["w12-rule-probes"]);
    expect(evidence).not.toContain("synthetic-cookie");
    expect(evidence).not.toContain("Synthetic baseline");
  });

  it.each(["assistant-prose", "wrong-project", "effect-started", "native-change", "approval"])(
    "refuses green for %s and stops without replay",
    async (fault) => {
      const ctx = context();
      ports.turn.mockImplementation(async (_chat, _prompt, options) => {
        if (fault === "approval") await options.beforeDecision();
        const result = refusal(fault === "wrong-project" ? "REQ/Epic" : "LIM7/Epic");
        if (fault === "assistant-prose") result.exchanges = [];
        if (fault === "effect-started") result.exchanges[0].effectStarted = true;
        if (fault === "native-change") issues[0].fields.summary = "Changed baseline";
        return result;
      });
      const result = await journey.runRuleProbes(ctx, { modes: MODES });
      expect(result.status).toBe("red");
      expect(ports.turn).toHaveBeenCalledTimes(1);
      expect((await journey.runRuleProbes(ctx, { modes: MODES })).status).toBe("unverified");
      expect(ports.turn).toHaveBeenCalledTimes(1);
    },
  );

  it("reverifies completed native state without resubmitting any browser turn", async () => {
    const ctx = context();
    const first = await journey.runRuleProbes(ctx, { modes: MODES });
    const second = await journey.runRuleProbes(ctx, { modes: MODES });
    expect(first.status).toBe("green");
    expect(second.status).toBe("green");
    expect(ports.turn).toHaveBeenCalledTimes(3);
    issues[0].fields.labels.push("changed");
    expect((await journey.runRuleProbes(ctx, { modes: MODES })).status).toBe("red");
    expect(ports.turn).toHaveBeenCalledTimes(3);
  });

  it.each(["different-chat", "different-model"])(
    "does not reuse completed proof for %s despite identical native Jira state",
    async (fault) => {
      const ctx = context();
      expect((await journey.runRuleProbes(ctx, { modes: MODES })).status).toBe("green");
      const originalRead = ctx.page.request.get.getMockImplementation();
      const originalWorkspace = ctx.page.evaluate.getMockImplementation();
      const chatId = fault === "different-chat" ? "22222222-2222-4222-8222-222222222222" : CHAT_ID;
      ctx.page.evaluate.mockImplementation(async (_read, key) =>
        key === "fixture-workspace"
          ? [{ id: "fixture-chat-window", type: "chat", cfg: { chatId } }]
          : key,
      );
      ctx.page.request.get.mockImplementation(async (path) => ({
        status: () => 200,
        json: async () =>
          path === "/api/projects"
            ? { projects: [{ path: "/synthetic/workspace" }] }
            : {
                chats: [
                  {
                    id: chatId,
                    projectPath: "/synthetic/workspace",
                    selectedModel: fault === "different-model" ? "other-model" : ctx.modelId,
                  },
                ],
              },
      }));
      expect(await journey.runRuleProbes(ctx, { modes: MODES })).toMatchObject({
        status: "unverified",
        detail: "rule-probe-readback-unavailable",
        counts: { refusals: 3, probedModes: 3 },
      });
      ctx.page.request.get.mockImplementation(originalRead);
      ctx.page.evaluate.mockImplementation(originalWorkspace);
      expect((await journey.runRuleProbes(ctx, { modes: MODES })).status).toBe("green");
      expect(ports.turn).toHaveBeenCalledTimes(3);
      expect(ports.mode).toHaveBeenCalledTimes(3);
    },
  );
});

describe("W12 existing browser Chat binding", () => {
  it("pins the selected window and resolves only the matching native Chat and model", async () => {
    const ctx = context();
    const resolved = await resolveLimitBrowser(ctx);
    expect(resolved.page).toBe(ctx.page);
    expect(resolved.chat.id).toBe(CHAT_ID);
    expect(resolved.context).toMatchObject({
      projectPath: "/synthetic/workspace",
      modelId: ctx.modelId,
    });
    expect(ctx.page.locator).toHaveBeenCalledWith('.window[data-window-id="fixture-chat-window"]');
    expect(ctx.requests).toHaveLength(2);
    expect(ctx.requests[0]).toBe("/api/projects");
    const chatRead = new URL(ctx.requests[1], "http://127.0.0.1:32209");
    expect(chatRead.pathname).toBe("/api/chats");
    expect(chatRead.searchParams.get("id")).toBe(CHAT_ID);
    expect(chatRead.searchParams.get("projectPath")).toBe("/synthetic/workspace");
  });

  it.each([
    "wrong-model",
    "wrong-id",
    "duplicate-chat",
    "missing-window",
    "no-session",
    "split-session",
  ])("refuses an ambiguous or unpaired browser identity: %s", async (fault) => {
    const ctx = context();
    if (fault === "missing-window") ctx.page.evaluate.mockResolvedValue([]);
    else if (fault === "no-session") ctx.page.context = () => ({ cookies: async () => [] });
    else if (fault === "split-session")
      ctx.page.context = () => ({
        cookies: async () => [
          { name: "fixture-session", value: "first", domain: "127.0.0.1", path: "/api/chats" },
          { name: "fixture-session", value: "second", domain: "127.0.0.1", path: "/api/skills" },
        ],
      });
    else
      ctx.page.request.get.mockImplementation(async (path) => {
        const chat = {
          id: fault === "wrong-id" ? "22222222-2222-4222-8222-222222222222" : CHAT_ID,
          projectPath: "/synthetic/workspace",
          selectedModel: fault === "wrong-model" ? "other-model" : ctx.modelId,
        };
        const value =
          path === "/api/projects"
            ? { projects: [{ path: "/synthetic/workspace" }] }
            : {
                chats: fault === "duplicate-chat" ? [chat, chat] : [chat],
              };
        return { status: () => 200, json: async () => value };
      });
    await expect(resolveLimitBrowser(ctx)).rejects.toThrow();
    expect(ports.turn).not.toHaveBeenCalled();
  });
});
