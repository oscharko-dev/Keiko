import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createLimitRunContext,
  createLimitRunIntent,
  openLimitRunChats,
  runBrowserLimitRun,
} from "../testing/jira-chat-lab/browser-limit-run.mjs";
import { assertWorkflowChatConfiguration } from "../testing/jira-chat-lab/browser-workflow-turn.mjs";

const directories = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
const MODEL = "fixture-conversation-model";
const PRIVATE = "PAT_FIXTURE_NOT_INTENT_DATA";
const SLOTS = ["document", "report", "denied"];
const READY = {
  document: {
    phase: "ready",
    chatId: "document-chat",
    windowId: "document-window",
    podId: "permitted-pod",
    actorClass: "permitted",
  },
  report: {
    phase: "ready",
    chatId: "report-chat",
    windowId: "report-window",
    podId: "permitted-pod",
    actorClass: "permitted",
  },
  denied: {
    phase: "ready",
    chatId: "denied-chat",
    windowId: "denied-window",
    podId: "restricted-pod",
    actorClass: "restricted",
  },
};

function pageFixture(name, events) {
  return {
    name,
    regions: Object.fromEntries(SLOTS.map((slot) => [slot, { pageName: name, slot }])),
    reload: vi.fn(async () => {
      events.push("reload");
    }),
  };
}

function fixture({ recovery = true } = {}) {
  const sessionDir = mkdtempSync(join(tmpdir(), "keiko-limit-context-"));
  directories.push(sessionDir);
  const intent = createLimitRunIntent(sessionDir, { projectKey: "LIM7", modelId: MODEL });
  const events = [];
  const page = pageFixture("initial-page", events);
  const browser = { close: vi.fn() };
  const controller = new globalThis.AbortController();
  const options = {
    sessionDir,
    projectKey: "LIM7",
    modelId: MODEL,
    permittedToken: "/private-fixture/permitted-pat",
    deniedToken: "/private-fixture/restricted-pat",
  };
  const live = {
    session: {},
    root: "/fixture/owned-state",
    origin: "http://127.0.0.1:1987",
    projectPath: "/fixture/workspace",
    modelId: MODEL,
    cookie: "initial-cookie",
    secret: "initial-launcher-secret",
  };
  if (recovery)
    live.restartServer = vi.fn(async ({ signal }) => {
      events.push("restart");
      signal.throwIfAborted();
      live.cookie = "renewed-cookie";
      live.secret = "renewed-launcher-secret";
      return { restarted: true };
    });
  return {
    sessionDir,
    intent,
    events,
    page,
    browser,
    controller,
    options,
    live,
    created: {},
    observedSends: [],
    creations: { chats: 0, pods: 0 },
  };
}

function chatFixture(f, slot, chatId, podId) {
  return {
    id: chatId,
    projectPath: f.live.projectPath,
    selectedModel: MODEL,
    title: "Private fixture Chat title",
    rawPrivateBody: PRIVATE,
    toolMode: "autonomous-delivery",
    effectiveToolMode: "autonomous-delivery",
    jiraAdministrationEnabled: true,
    jiraPodBinding: { podId },
    ...(slot === "document" ? { localKnowledgeScopes: [{ capsuleId: "lastenheft-pod" }] } : {}),
  };
}

function uiPorts(f) {
  let sequence = 0;
  const ports = {
    assertWorkflowChatConfiguration,
    openWorkflowBrowser: vi.fn(async (_live, options) => {
      const slot = SLOTS[sequence++ % SLOTS.length];
      const chatId = options.chatId ?? READY[slot].chatId;
      const podId = options.podId ?? READY[slot].podId;
      if (options.chatId === undefined) {
        f.creations.chats += 1;
        await options.onPhase({
          phase: "chat-creation-may-have-started",
          actorClass: options.actorClass,
        });
      }
      await options.onChat({
        chatId,
        windowId: READY[slot].windowId,
        actorClass: options.actorClass,
        apiToken: PRIVATE,
        title: PRIVATE,
        cookie: PRIVATE,
        secret: PRIVATE,
      });
      if (options.podId === undefined) {
        f.creations.pods += 1;
        await options.onPhase({
          phase: "pod-creation-may-have-started",
          actorClass: options.actorClass,
        });
      }
      await options.onPod({ podId, actorClass: options.actorClass, apiToken: PRIVATE });
      const chat = chatFixture(f, slot, chatId, podId);
      const handle = {
        chat,
        podId,
        windowId: READY[slot].windowId,
        page: options.shared?.page ?? f.page,
        browser: options.shared?.browser ?? f.browser,
        region: f.page.regions[slot],
        focus: vi.fn(async (page) => {
          f.events.push(`focus:${slot}`);
          return {
            chat: structuredClone(chat),
            windowId: READY[slot].windowId,
            region: page.regions[slot],
          };
        }),
        close: vi.fn(async () => {
          if (slot === "document") await f.browser.close();
        }),
      };
      f.created[slot] = handle;
      return handle;
    }),
    sendBrowserTurn: vi.fn(async (page, region, context, chatId, prompt, options) => {
      f.events.push(`send:${chatId}`);
      f.observedSends.push({
        page,
        region,
        chatId,
        prompt,
        cookie: context.cookie,
        secret: context.secret,
        origin: context.origin,
        root: context.root,
      });
      await options.persist?.({ phase: "submitted", clientTurnId: "fixture-turn" });
      return { clientTurnId: "fixture-turn", decisions: 0 };
    }),
    redeemWorkflowBrowserSession: vi.fn(async (_page, context) => {
      f.events.push("redeem");
      f.redeemedCookie = context.cookie;
      f.redeemedSecret = context.secret;
    }),
  };
  return ports;
}

async function readyContext(options) {
  const f = fixture(options);
  f.ports = uiPorts(f);
  f.handles = await openLimitRunChats(f.live, f.options, f.intent, f.ports);
  f.ctx = await createLimitRunContext(
    f.live,
    f.handles,
    f.options,
    f.intent,
    f.controller.signal,
    f.ports,
  );
  f.ctx.checkLicense = vi.fn(async () => undefined);
  f.ctx.prepareTruth = vi.fn(async () => undefined);
  for (const handle of Object.values(f.handles)) handle.focus.mockClear();
  f.ports.sendBrowserTurn.mockClear();
  f.ports.redeemWorkflowBrowserSession.mockClear();
  f.events.length = 0;
  return f;
}

describe("the three ordinary limit-run Chats", () => {
  it("opens three Chats on one browser/page, sharing only the permitted Pod and explicitly selecting Full access", async () => {
    const f = fixture();
    const ports = uiPorts(f);
    const handles = await openLimitRunChats(f.live, f.options, f.intent, ports);
    expect(ports.openWorkflowBrowser).toHaveBeenCalledTimes(3);
    expect(f.creations).toEqual({ chats: 3, pods: 2 });
    const selected = ports.openWorkflowBrowser.mock.calls.map(([, options]) => options);
    expect(
      selected.map(({ mode, administration, jiraOnly, actorClass }) => ({
        mode,
        administration,
        jiraOnly,
        actorClass,
      })),
    ).toEqual([
      {
        mode: "autonomous-delivery",
        administration: true,
        jiraOnly: false,
        actorClass: "permitted",
      },
      {
        mode: "autonomous-delivery",
        administration: true,
        jiraOnly: true,
        actorClass: "permitted",
      },
      {
        mode: "autonomous-delivery",
        administration: true,
        jiraOnly: true,
        actorClass: "restricted",
      },
    ]);
    expect(selected[0].shared).toBeUndefined();
    expect(selected[1].shared).toBe(handles.document);
    expect(selected[2].shared).toBe(handles.document);
    expect(selected[1].podId).toBe("permitted-pod");
    expect(selected[2]).toMatchObject({
      label: "Limit Run Restricted",
      tokenFile: f.options.deniedToken,
    });
    expect(selected[0].tokenFile).toBe(f.options.permittedToken);
    expect(new Set(Object.values(handles).map((handle) => handle.page))).toEqual(new Set([f.page]));
    expect(new Set(Object.values(handles).map((handle) => handle.browser))).toEqual(
      new Set([f.browser]),
    );
    expect(handles.document.focus).toHaveBeenCalledWith(f.page);
    expect(f.intent.state.chats).toEqual(READY);
    const persisted = JSON.parse(readFileSync(f.intent.path, "utf8"));
    expect(persisted.data.chats).toEqual(READY);
    expect(JSON.stringify(persisted)).not.toContain(PRIVATE);
    expect(JSON.stringify(persisted.data.chats)).not.toMatch(
      /token|cookie|secret|title|projectPath/u,
    );
  });

  it("reopens only the recorded Chat/Pod IDs and preserves unrelated intent facts", async () => {
    const f = fixture();
    f.intent.record("chats", READY);
    f.intent.record("bulkEpics", { coveredIds: ["REQ-FA-001"] });
    const ports = uiPorts(f);
    await openLimitRunChats(f.live, f.options, f.intent, ports);
    expect(f.creations).toEqual({ chats: 0, pods: 0 });
    expect(
      ports.openWorkflowBrowser.mock.calls.map(([, options]) => ({
        chatId: options.chatId,
        podId: options.podId,
      })),
    ).toEqual([
      { chatId: "document-chat", podId: "permitted-pod" },
      { chatId: "report-chat", podId: "permitted-pod" },
      { chatId: "denied-chat", podId: "restricted-pod" },
    ]);
    expect(f.intent.state.bulkEpics).toEqual({ coveredIds: ["REQ-FA-001"] });
  });

  it.each([
    ["document", "chat-creation-may-have-started", "chatId"],
    ["report", "chat-creation-may-have-started", "chatId"],
    ["denied", "chat-creation-may-have-started", "chatId"],
    ["document", "pod-creation-may-have-started", "podId"],
    ["report", "pod-creation-may-have-started", "podId"],
    ["denied", "pod-creation-may-have-started", "podId"],
  ])("stops an uncertain %s %s without repeating creation", async (slot, phase, missing) => {
    const f = fixture();
    const saved = structuredClone(READY);
    saved[slot].phase = phase;
    Reflect.deleteProperty(saved[slot], missing);
    f.intent.record("chats", saved);
    const ports = uiPorts(f);
    await expect(openLimitRunChats(f.live, f.options, f.intent, ports)).rejects.toThrow(
      /reconciliation/u,
    );
    expect(f.creations).toEqual({ chats: 0, pods: 0 });
    expect(ports.sendBrowserTurn).not.toHaveBeenCalled();
    expect(
      ports.openWorkflowBrowser.mock.calls.every(
        ([, options]) => options.chatId !== READY[slot].chatId,
      ),
    ).toBe(true);
    expect(f.intent.state.chats[slot].phase).toBe(phase);
  });

  it("does not close the run's other handles when a later UI setup fails", async () => {
    const f = fixture();
    const ports = uiPorts(f);
    ports.openWorkflowBrowser
      .mockImplementationOnce(async () => {
        const handle = {
          chat: { id: "document-chat" },
          podId: "permitted-pod",
          windowId: "document-window",
          page: f.page,
          browser: f.browser,
          close: vi.fn(async () => f.browser.close()),
        };
        f.created.document = handle;
        return handle;
      })
      .mockRejectedValueOnce(new TypeError("UI setup failed"));
    await expect(openLimitRunChats(f.live, f.options, f.intent, ports)).rejects.toThrow(
      /UI setup failed/u,
    );
    expect(f.created.document.close).toHaveBeenCalledOnce();
    expect(f.browser.close).toHaveBeenCalledOnce();
    expect(ports.openWorkflowBrowser).toHaveBeenCalledTimes(2);
  });
});

describe("explicit Chat routing and current session evidence", () => {
  it.each([undefined, {}, { id: "unregistered-chat" }, { id: "report-chat\n" }])(
    "rejects an unregistered Chat before any focus or send: %j",
    async (chat) => {
      const f = await readyContext();
      await expect(f.ctx.turn(chat, "Do not submit")).rejects.toThrow();
      expect(Object.values(f.handles).every((handle) => handle.focus.mock.calls.length === 0)).toBe(
        true,
      );
      expect(f.ports.sendBrowserTurn).not.toHaveBeenCalled();
    },
  );

  it("routes every allowed ID through its own focused region on the current page", async () => {
    const f = await readyContext();
    const current = pageFixture("current-page", f.events);
    f.ctx.page = current;
    const foreignPersist = vi.fn();
    for (const [slot, chat] of [
      ["document", f.ctx.chat],
      ["report", f.ctx.reportChat],
      ["denied", f.ctx.deniedChat],
    ]) {
      await f.ctx.turn(
        { id: chat.id, jiraPodBinding: { podId: "caller-forged-pod" } },
        `Prompt for ${slot}`,
        {
          operations: ["jira.comment"],
          persist: foreignPersist,
        },
      );
      expect(f.handles[slot].focus).toHaveBeenCalledExactlyOnceWith(current);
    }
    expect(f.observedSends.map(({ page, region, chatId }) => ({ page, region, chatId }))).toEqual([
      { page: current, region: current.regions.document, chatId: "document-chat" },
      { page: current, region: current.regions.report, chatId: "report-chat" },
      { page: current, region: current.regions.denied, chatId: "denied-chat" },
    ]);
    expect(f.ctx.region).toBe(f.page.regions.document);
    expect(f.ctx.activeChatId).toBe("denied-chat");
    expect(foreignPersist).not.toHaveBeenCalled();
    expect(f.intent.state.browserTurn).toEqual({
      chatId: "denied-chat",
      phase: "submitted",
      clientTurnId: "fixture-turn",
    });
  });

  it("reads the current live cookie and launcher secret instead of a copied pre-restart value", async () => {
    const f = await readyContext();
    await f.ctx.turn(f.ctx.reportChat, "First observation");
    f.live.cookie = "updated-cookie";
    f.live.secret = "updated-launcher-secret";
    await f.ctx.turn(f.ctx.reportChat, "Second observation");
    expect(f.observedSends.map(({ cookie, secret }) => ({ cookie, secret }))).toEqual([
      { cookie: "initial-cookie", secret: "initial-launcher-secret" },
      { cookie: "updated-cookie", secret: "updated-launcher-secret" },
    ]);
    expect(readFileSync(f.intent.path, "utf8")).not.toMatch(
      /initial-cookie|updated-cookie|launcher-secret/u,
    );
  });

  it("refuses a changed recorded binding before focusing the previously admitted Chat", async () => {
    const f = await readyContext();
    f.intent.record("chats", {
      ...f.intent.state.chats,
      report: { ...READY.report, podId: "foreign-pod" },
    });
    await expect(f.ctx.turn(f.ctx.reportChat, "Do not submit")).rejects.toThrow();
    expect(f.handles.report.focus).not.toHaveBeenCalled();
    expect(f.ports.sendBrowserTurn).not.toHaveBeenCalled();
  });

  it.each([
    { jiraPodBinding: { podId: "different-current-pod" } },
    { toolMode: "governed-assist" },
    { effectiveToolMode: "governed-assist" },
    { jiraAdministrationEnabled: false },
    { localKnowledgeScopes: [{ capsuleId: "foreign-knowledge" }] },
    { connectedScope: { kind: "workspace-root", root: "/foreign-workspace" } },
    { selectedModel: "other-model" },
    { projectPath: "/different-workspace" },
    { status: "closed" },
  ])("refuses a changed actual report Chat before sending: %j", async (changed) => {
    const f = await readyContext();
    f.handles.report.focus.mockResolvedValue({
      chat: { ...f.handles.report.chat, ...changed },
      windowId: "report-window",
      region: f.page.regions.report,
    });
    await expect(f.ctx.turn(f.ctx.reportChat, "Do not submit")).rejects.toThrow();
    expect(f.handles.report.focus).toHaveBeenCalledOnce();
    expect(f.ports.sendBrowserTurn).not.toHaveBeenCalled();
  });

  it("does not send when the UI focus fails or cancellation arrives during focus", async () => {
    const f = await readyContext();
    f.handles.report.focus.mockRejectedValueOnce(new TypeError("Focus unavailable"));
    await expect(f.ctx.turn(f.ctx.reportChat, "Do not submit")).rejects.toThrow(
      /Focus unavailable/u,
    );
    f.handles.report.focus.mockImplementationOnce(async () => {
      f.controller.abort();
      return {
        chat: f.handles.report.chat,
        windowId: "report-window",
        region: f.page.regions.report,
      };
    });
    await expect(f.ctx.turn(f.ctx.reportChat, "Still do not submit")).rejects.toThrow();
    expect(f.ports.sendBrowserTurn).not.toHaveBeenCalled();
  });
});

describe("owned server recovery and browser rebinding", () => {
  it("awaits the owned restart, reloads, redeems and reopens all saved IDs before restoring the active report Chat", async () => {
    const f = await readyContext();
    await f.ctx.focusChat(f.ctx.reportChat);
    f.events.length = 0;
    const answer = await f.ctx.recovery.restartServer({
      signal: new globalThis.AbortController().signal,
    });
    expect(answer).toMatchObject({ restarted: true });
    expect(Number.isInteger(answer.downtimeMs) && answer.downtimeMs >= 0).toBe(true);
    expect(f.live.restartServer).toHaveBeenCalledOnce();
    const supplied = f.live.restartServer.mock.calls[0][0];
    expect(Object.keys(supplied)).toEqual(["signal"]);
    expect(supplied.signal).toBeInstanceOf(globalThis.AbortSignal);
    expect(f.events).toEqual([
      "restart",
      "reload",
      "redeem",
      "focus:document",
      "focus:report",
      "focus:denied",
      "focus:report",
    ]);
    expect(f.page.reload).toHaveBeenCalledExactlyOnceWith({ waitUntil: "domcontentloaded" });
    expect(f.ports.redeemWorkflowBrowserSession).toHaveBeenCalledExactlyOnceWith(f.page, f.ctx);
    expect(f.redeemedCookie).toBe("renewed-cookie");
    expect(f.redeemedSecret).toBe("renewed-launcher-secret");
    expect(f.ctx.root).toBe("/fixture/owned-state");
    expect(f.ctx.origin).toBe("http://127.0.0.1:1987");
    expect(f.ctx.activeChatId).toBe("report-chat");
    expect(f.ctx.region).toBe(f.page.regions.document);
    expect(f.ports.openWorkflowBrowser).toHaveBeenCalledTimes(3);
    expect(f.creations).toEqual({ chats: 3, pods: 2 });
    expect(f.ports.sendBrowserTurn).not.toHaveBeenCalled();
    expect(f.intent.state.recovery).toEqual({
      phase: "recovered",
      count: 1,
      downtimeMs: answer.downtimeMs,
    });
  });

  it("awaits actual session redemption before reopening any Chat", async () => {
    const f = await readyContext();
    let finish;
    f.ports.redeemWorkflowBrowserSession.mockImplementation(async () => {
      f.events.push("redeem");
      await new Promise((resolve) => {
        finish = resolve;
      });
    });
    const recovering = f.ctx.recovery.restartServer();
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    expect(Object.values(f.handles).every((handle) => handle.focus.mock.calls.length === 0)).toBe(
      true,
    );
    expect(f.intent.state.recovery.phase).toBe("restarting");
    finish();
    await expect(recovering).resolves.toMatchObject({ restarted: true });
    expect(f.intent.state.recovery.phase).toBe("recovered");
  });

  it.each([
    "restart",
    "restart-refused",
    "state-change",
    "origin-change",
    "reload",
    "redeem",
    "focus",
  ])("retains a failed recovery and never reports green after %s failure", async (failure) => {
    const f = await readyContext();
    if (failure === "restart")
      f.live.restartServer.mockRejectedValue(new TypeError("Restart unavailable"));
    if (failure === "restart-refused") f.live.restartServer.mockResolvedValue({ restarted: false });
    if (failure === "state-change")
      f.live.restartServer.mockImplementation(async () => {
        f.live.root = "/foreign-state";
        return { restarted: true };
      });
    if (failure === "origin-change")
      f.live.restartServer.mockImplementation(async () => {
        f.live.origin = "http://127.0.0.1:2999";
        return { restarted: true };
      });
    if (failure === "reload") f.page.reload.mockRejectedValue(new TypeError("Reload unavailable"));
    if (failure === "redeem")
      f.ports.redeemWorkflowBrowserSession.mockRejectedValue(new TypeError("Pairing unavailable"));
    if (failure === "focus")
      f.handles.report.focus.mockRejectedValue(new TypeError("Saved Chat unavailable"));
    await expect(f.ctx.recovery.restartServer()).rejects.toThrow();
    expect(f.intent.state.recovery).toEqual({ phase: "failed", count: 1 });
    expect(f.ports.sendBrowserTurn).not.toHaveBeenCalled();
    expect(f.ports.openWorkflowBrowser).toHaveBeenCalledTimes(3);
    if (["state-change", "origin-change"].includes(failure))
      expect(f.page.reload).not.toHaveBeenCalled();
  });

  it.each(["run", "request"])(
    "does not restart when the %s signal is already aborted",
    async (source) => {
      const f = await readyContext();
      const request = new globalThis.AbortController();
      (source === "run" ? f.controller : request).abort();
      await expect(f.ctx.recovery.restartServer({ signal: request.signal })).rejects.toThrow();
      expect(f.live.restartServer).not.toHaveBeenCalled();
      expect(f.page.reload).not.toHaveBeenCalled();
      expect(f.intent.state.recovery).toBeUndefined();
    },
  );

  it("propagates cancellation during restart and performs no later UI work", async () => {
    const f = await readyContext();
    const request = new globalThis.AbortController();
    let finish;
    let actualSignal;
    f.live.restartServer.mockImplementation(({ signal }) => {
      actualSignal = signal;
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const recovering = f.ctx.recovery.restartServer({ signal: request.signal });
    const refused = expect(recovering).rejects.toThrow();
    request.abort();
    expect(actualSignal.aborted).toBe(true);
    finish({ restarted: true });
    await refused;
    expect(f.page.reload).not.toHaveBeenCalled();
    expect(f.ports.redeemWorkflowBrowserSession).not.toHaveBeenCalled();
    expect(f.intent.state.recovery).toEqual({ phase: "failed", count: 1 });
  });

  it("refuses concurrent or foreign-process restart requests without another restart", async () => {
    const f = await readyContext();
    let finish;
    f.live.restartServer.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const first = f.ctx.recovery.restartServer();
    await expect(f.ctx.recovery.restartServer()).rejects.toThrow(/already in progress/u);
    await expect(f.ctx.recovery.restartServer({ pid: 1234 })).rejects.toThrow();
    expect(f.live.restartServer).toHaveBeenCalledOnce();
    finish({ restarted: true });
    await expect(first).resolves.toMatchObject({ restarted: true });
  });

  it("leaves recovery unavailable when the owned live restart handle is absent", async () => {
    const f = await readyContext({ recovery: false });
    expect(f.ctx.recovery).toBeUndefined();
    expect(f.page.reload).not.toHaveBeenCalled();
    expect(f.ports.redeemWorkflowBrowserSession).not.toHaveBeenCalled();
  });
});

function stepResult(step) {
  return {
    step: step.toLowerCase(),
    status: "green",
    detail: "Independent fixture evidence",
    counts: { observed: 1 },
  };
}

function cardBlocks(f, failReport) {
  const cards = [];
  const blocks = Object.fromEntries(
    [
      "runProjectSetup",
      "installTemplates",
      "runRuleProbes",
      "stageLastenheft",
      "gradeBulkRefusals",
      "runHierarchyBulk",
      "runSprintBulk",
      "runProgressReport",
      "setUiLanguage",
    ].map((name) => [name, vi.fn(async () => stepResult(name))]),
  );
  blocks.createFaultPlan = vi.fn(() => ({ maybeInject: vi.fn() }));
  blocks.runBulkEpics = vi.fn(async () => {
    f.intent.record("bulkEpics", {
      seeded: Array.from({ length: 37 }, (_, index) => ({
        requirementId: `REQ-FA-${String(index + 1).padStart(3, "0")}`,
        ruleId: "summary-pattern",
      })),
    });
    return stepResult("bulk-epics");
  });
  blocks.simulateProgress = vi.fn(async () => {
    const evidenceFile = join(f.sessionDir, "progress-truth.json");
    writeFileSync(evidenceFile, JSON.stringify({ issues: 1 }), { mode: 0o600 });
    return { ...stepResult("progress"), evidenceFile };
  });
  blocks.assertCardsReadable = vi.fn(async (context) => {
    cards.push({ chatId: context.cardChat?.id, region: context.region, locale: context.locale });
    if (failReport && context.cardChat?.id === "report-chat")
      throw new TypeError("Report cards unavailable");
    return stepResult("cards");
  });
  return { blocks, cards };
}

describe("report-card context on the shared page", () => {
  it.each([false, true])(
    "uses report cards and restores document region even on failure=%s",
    async (failure) => {
      const f = await readyContext();
      const documentRegion = f.ctx.region;
      const { blocks, cards } = cardBlocks(f, failure);
      if (failure)
        await expect(runBrowserLimitRun(f.ctx, {}, blocks)).rejects.toThrow(
          /Report cards unavailable/u,
        );
      else
        await expect(runBrowserLimitRun(f.ctx, {}, blocks)).resolves.toMatchObject({
          status: "green",
        });
      expect(cards.slice(0, 4).map(({ chatId, region }) => ({ chatId, region }))).toEqual(
        Array.from({ length: 4 }, () => ({
          chatId: "document-chat",
          region: f.page.regions.document,
        })),
      );
      expect(cards.slice(4).map(({ chatId, region }) => ({ chatId, region }))).toEqual(
        Array.from({ length: failure ? 1 : 2 }, () => ({
          chatId: "report-chat",
          region: f.page.regions.report,
        })),
      );
      expect(f.ctx.region).toBe(documentRegion);
      expect(f.ctx).not.toHaveProperty("cardChat");
      expect(f.ctx.chat.id).toBe("document-chat");
      if (failure) expect(f.intent.state.orchestrator).toBeUndefined();
    },
  );
});
