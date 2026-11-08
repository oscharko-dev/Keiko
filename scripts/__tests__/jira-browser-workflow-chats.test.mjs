import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chromium } from "@playwright/test";

const owners = vi.hoisted(() => ({
  openBrowser: vi.fn(),
  createPod: vi.fn(),
  compose: vi.fn(),
  bind: vi.fn(),
  mode: vi.fn(),
  openConnectors: vi.fn(),
  closeConnectors: vi.fn(),
  mint: vi.fn(() => "private-test-attestation"),
  fragment: vi.fn(() => "#private-test-pairing"),
}));

vi.mock("../testing/jira-chat-lab/browser-read.mjs", () => ({
  openBrowser: owners.openBrowser,
  createPod: owners.createPod,
}));
vi.mock("../../tests/e2e/support/chat-composer.ts", () => ({
  openChatComposer: owners.compose,
}));
vi.mock("../lib/workspace-storage-fixture.mjs", () => ({
  workspaceStorageArgs: async () => ({ storageKeys: { workspace: "owned-store-workspace" } }),
}));
vi.mock("../testing/jira-chat-lab/browser-connections.mjs", async (importOriginal) => ({
  ...(await importOriginal()),
  connectPodFromPanel: owners.bind,
  selectAccessMode: owners.mode,
  openConnectors: owners.openConnectors,
  closeConnectors: owners.closeConnectors,
}));
vi.mock(
  "../../packages/keiko-server/dist/coding-app-session/launcherSessionPairingPort.js",
  () => ({
    mintLauncherPairingAttestation: owners.mint,
  }),
);
vi.mock("@oscharko-dev/keiko-contracts/runtime/coding-app-session-pairing", () => ({
  encodeCodingAppSessionPairingFragment: owners.fragment,
}));

import {
  focusWorkflowChat,
  openWorkflowBrowser,
  openWorkflowChat,
  redeemWorkflowBrowserSession,
} from "../testing/jira-chat-lab/browser-workflow-turn.mjs";

const CONTEXT = {
  origin: "http://127.0.0.1:1987",
  projectPath: "/fixture/limit-workspace",
  modelId: "fixture-conversation-model",
  secret: "private-launcher-fixture",
  session: { directory: "/fixture/private-session" },
};
const FULL = { mode: "autonomous-delivery", administration: true };

function response(method, path, body, status = 200) {
  return {
    request: () => ({ method: () => method }),
    url: () => CONTEXT.origin + path,
    status: () => status,
    json: async () => structuredClone(body),
    finished: async () => null,
  };
}

function historyRow(page, chatId) {
  const input = {
    fill: vi.fn(async (title) => {
      page.editTitle = title;
    }),
    press: vi.fn(async () => {
      page.chats.get(chatId).title = page.editTitle;
    }),
    waitFor: vi.fn(),
  };
  return {
    locator: (selector) => {
      expect(selector).toBe(".chat-history-open");
      return {
        click: async () => {
          expect(page.chats.has(chatId)).toBe(true);
          page.active = chatId;
          if (!page.windows.has(chatId)) page.windows.set(chatId, `window-${chatId}`);
        },
      };
    },
    getByRole: (role) => (role === "textbox" ? input : { click: vi.fn() }),
  };
}

function region(page, chatId) {
  const control = {
    getAttribute: async () => String(page.chats.get(chatId).jiraAdministrationEnabled === true),
    click: async () => {
      page.chats.get(chatId).jiraAdministrationEnabled = true;
    },
    and: () => ({ waitFor: vi.fn() }),
  };
  return {
    chatId,
    page: () => page,
    getByRole: (role) => {
      if (role === "textbox") return { waitFor: vi.fn(), fill: page.fillMessage };
      if (role === "combobox")
        return {
          click: async () => {
            page.modelChat = chatId;
          },
        };
      if (role === "switch") return control;
      throw new TypeError("Unexpected fixture control");
    },
  };
}

function uiPage(chats = []) {
  const pending = [];
  const page = {
    chats: new Map(chats.map((chat) => [chat.id, structuredClone(chat)])),
    windows: new Map(),
    pods: new Map(),
    historyVisible: false,
    goto: vi.fn(),
    fillMessage: vi.fn(),
    addInitScript: vi.fn(),
    setDefaultTimeout: vi.fn(),
    waitForResponse: vi.fn(
      (predicate) => new Promise((resolve) => pending.push({ predicate, resolve })),
    ),
    emit: (observed) => {
      for (const item of pending.splice(0)) {
        expect(item.predicate(observed)).toBe(true);
        item.resolve(observed);
      }
    },
    request: {
      get: vi.fn(async () => response("GET", "/api/chats", { chats: [...page.chats.values()] })),
    },
    waitForFunction: vi.fn(async (_predicate, argument) => {
      expect(argument.key).toBe("owned-store-workspace");
      const windowId = page.windows.get(argument.id);
      if (!windowId) throw new TypeError("Missing bound fixture window");
      return { jsonValue: async () => windowId, dispose: vi.fn() };
    }),
  };
  page.getByRole = (role, options) => {
    if (role === "button")
      return {
        click: async () => {
          page.historyVisible = !page.historyVisible;
        },
      };
    if (role === "option")
      return {
        click: async () => {
          page.chats.get(page.modelChat).selectedModel = options.name;
          page.emit(response("PATCH", `/api/chats?id=${page.modelChat}`, {}));
        },
      };
    throw new TypeError("Unexpected fixture page role");
  };
  page.locator = (selector) => {
    if (selector === ".chat-history")
      return {
        isVisible: async () => page.historyVisible,
        waitFor: vi.fn(),
        locator: (row) => historyRow(page, /data-chat-id="([^"]+)"/u.exec(row)[1]),
      };
    const windowId = /data-window-id="([^"]+)"/u.exec(selector)?.[1];
    const chatId = [...page.windows].find(([, id]) => id === windowId)?.[0];
    return chatId ? region(page, chatId) : {};
  };
  page.goto.mockImplementation(async (url) => {
    if (url === CONTEXT.origin + "#private-test-pairing")
      page.emit(response("POST", "/api/coding-workbench/app-session/pair", {}));
  });
  return page;
}

function installOwners(page) {
  const browser = { close: vi.fn() };
  owners.openBrowser.mockResolvedValue({ browser, page });
  owners.compose.mockImplementation(async (target) => {
    await target.goto("/");
    const id = `chat-${target.chats.size + 1}`;
    const chat = {
      id,
      title: "New chat",
      projectPath: CONTEXT.projectPath,
      selectedModel: target.initialModel ?? CONTEXT.modelId,
      status: "open",
      jiraAdministrationEnabled: false,
    };
    target.chats.set(id, chat);
    target.windows.set(id, `window-${id}`);
    target.historyVisible = true;
    target.emit(response("POST", "/api/desktop/chats", { chat }, 201));
  });
  owners.createPod.mockImplementation(async (target, _session, options) => {
    let podId = options.podId;
    if (podId === undefined) {
      await options.onPhase?.({ phase: "pod-creation-may-have-started" });
      podId = `pod-${target.pods.size + 1}`;
    }
    target.pods.set(options.label, podId);
    await options.onPod?.({ podId });
    return { podId };
  });
  owners.bind.mockImplementation(async (target, selected, label) => {
    target.chats.get(selected.chatId).jiraPodBinding = { podId: target.pods.get(label) };
  });
  owners.mode.mockImplementation(async (target, selected, mode) => {
    target.chats.get(selected.chatId).toolMode = mode;
  });
  owners.openConnectors.mockImplementation(async (_target, selected) => selected);
  return browser;
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());

describe("ordinary launcher pairing readiness", () => {
  it("waits for the real launcher pairing response and completed transfer before returning", async () => {
    const page = uiPage();
    page.goto.mockResolvedValueOnce(undefined);
    const finished = Promise.withResolvers();
    const transferObserved = Promise.withResolvers();
    const paired = response("POST", "/api/coding-workbench/app-session/pair", {});
    paired.finished = vi.fn(() => {
      transferObserved.resolve();
      return finished.promise;
    });
    const returned = vi.fn();
    const pending = redeemWorkflowBrowserSession(page, CONTEXT);
    void pending.then(returned, returned);
    await Promise.resolve();
    await Promise.resolve();
    expect(returned).not.toHaveBeenCalled();
    expect(page.waitForResponse).toHaveBeenCalledOnce();
    const [matches] = page.waitForResponse.mock.calls[0];
    expect(matches(paired)).toBe(true);
    expect(matches(response("GET", "/api/coding-workbench/app-session/pair", {}))).toBe(false);
    expect(matches(response("POST", "/api/chats", {}))).toBe(false);
    expect(
      matches({
        ...paired,
        url: () => "https://foreign.invalid/api/coding-workbench/app-session/pair",
      }),
    ).toBe(false);
    page.emit(paired);
    await transferObserved.promise;
    expect(returned).not.toHaveBeenCalled();
    expect(page.request.get).not.toHaveBeenCalled();
    finished.resolve(null);
    await pending;
    expect(returned).toHaveBeenCalledOnce();
    expect(paired.finished).toHaveBeenCalledOnce();
    expect(page.goto).toHaveBeenCalledExactlyOnceWith(CONTEXT.origin + "#private-test-pairing");
  });

  it("refuses a rejected real launcher pairing response before any Chat read", async () => {
    const page = uiPage();
    const paired = response("POST", "/api/coding-workbench/app-session/pair", {}, 401);
    paired.finished = vi.fn(async () => null);
    page.goto.mockImplementationOnce(async () => page.emit(paired));
    await expect(redeemWorkflowBrowserSession(page, CONTEXT)).rejects.toThrow(
      "Browser launcher pairing failed",
    );
    expect(paired.finished).toHaveBeenCalledOnce();
    expect(page.request.get).not.toHaveBeenCalled();
    expect(owners.compose).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "refuses a failed launcher pairing transfer without exposing its error: throws=%s",
    async (throws) => {
      const page = uiPage();
      const paired = response("POST", "/api/coding-workbench/app-session/pair", {});
      paired.finished = vi.fn(async () => {
        const error = new TypeError("private-launcher-value https://foreign.invalid/private");
        if (throws) throw error;
        return error;
      });
      page.goto.mockImplementationOnce(async () => page.emit(paired));
      await expect(redeemWorkflowBrowserSession(page, CONTEXT)).rejects.toEqual(
        new TypeError("Browser launcher pairing failed"),
      );
      expect(paired.finished).toHaveBeenCalledOnce();
      expect(page.request.get).not.toHaveBeenCalled();
      expect(owners.compose).not.toHaveBeenCalled();
    },
  );
});

describe("one ordinary browser owner for the three limit-run Chats", () => {
  it("uses one page, two Pods and three UI-created Chats with durable identity-only callbacks", async () => {
    const page = uiPage();
    const browser = installOwners(page);
    const checkpoints = [];
    const record = async (facts) => checkpoints.push(structuredClone(facts));
    const callbacks = { onPhase: record, onChat: record, onPod: record };
    const document = await openWorkflowBrowser(CONTEXT, {
      ...FULL,
      ...callbacks,
      label: "Limit Run Jira",
      title: "Limit document",
    });
    const report = await openWorkflowBrowser(CONTEXT, {
      ...FULL,
      ...callbacks,
      shared: document,
      podId: document.podId,
      jiraOnly: true,
      label: "Limit Run Jira",
      title: "Limit report",
    });
    const denied = await openWorkflowBrowser(CONTEXT, {
      ...FULL,
      ...callbacks,
      shared: document,
      actorClass: "restricted",
      jiraOnly: true,
      label: "Limit Run Restricted",
      tokenFile: "/fixture/private/restricted-token",
      title: "Limit denied",
    });
    expect(owners.openBrowser).toHaveBeenCalledExactlyOnceWith(undefined, CONTEXT.origin);
    expect(owners.compose.mock.calls.map(([target]) => target)).toEqual([page, page, page]);
    expect(new Set([document.chat.id, report.chat.id, denied.chat.id]).size).toBe(3);
    expect(document.podId).toBe(report.podId);
    expect(denied.podId).not.toBe(document.podId);
    expect([document, report, denied].map((handle) => handle.page)).toEqual([page, page, page]);
    expect([document, report, denied].map((handle) => handle.ownsBrowser)).toEqual([
      true,
      false,
      false,
    ]);
    expect(
      [...page.chats.values()].every(
        (chat) =>
          chat.toolMode === "autonomous-delivery" && chat.jiraAdministrationEnabled === true,
      ),
    ).toBe(true);
    expect(
      checkpoints.some((item) => item.actorClass === "restricted" && item.podId === denied.podId),
    ).toBe(true);
    for (const item of checkpoints)
      expect(
        Object.keys(item).every((key) =>
          ["phase", "chatId", "windowId", "podId", "actorClass"].includes(key),
        ),
      ).toBe(true);
    expect(JSON.stringify(checkpoints)).not.toMatch(/token|attestation|launcher|projectPath/u);
    expect(page.fillMessage).not.toHaveBeenCalled();
    await report.close();
    await denied.close();
    expect(browser.close).not.toHaveBeenCalled();
    await document.close();
    expect(browser.close).toHaveBeenCalledOnce();
  });

  it("reopens recorded IDs on the current page without creating or rebinding Chats or Pods", async () => {
    const page = uiPage();
    installOwners(page);
    const opened = await openWorkflowBrowser(CONTEXT, { ...FULL, label: "Limit Run Jira" });
    const recovered = uiPage([...page.chats.values()]);
    await redeemWorkflowBrowserSession(recovered, CONTEXT);
    const focused = await opened.focus(recovered);
    expect(focused.chat.id).toBe(opened.chat.id);
    expect(focused.region.page()).toBe(recovered);
    expect((await opened.regionFor(recovered)).page()).toBe(recovered);
    expect(owners.compose).toHaveBeenCalledOnce();
    expect(owners.createPod).toHaveBeenCalledOnce();
    expect(owners.bind).toHaveBeenCalledOnce();
    expect(recovered.goto).toHaveBeenCalledExactlyOnceWith(
      CONTEXT.origin + "#private-test-pairing",
    );
    expect(recovered.fillMessage).not.toHaveBeenCalled();
  });

  it("reuses a saved Chat through the history rather than creating a second one", async () => {
    const page = uiPage();
    installOwners(page);
    const created = await openWorkflowBrowser(CONTEXT, FULL);
    const resumed = await openWorkflowBrowser(CONTEXT, {
      ...FULL,
      shared: created,
      chatId: created.chat.id,
      podId: created.podId,
    });
    expect(resumed.chat.id).toBe(created.chat.id);
    expect(resumed.windowId).toBe(created.windowId);
    expect(owners.compose).toHaveBeenCalledOnce();
    expect(owners.openBrowser).toHaveBeenCalledOnce();
  });

  it("refuses a missing saved Chat before UI creation, focusing or any composer write", async () => {
    const page = uiPage();
    installOwners(page);
    await expect(openWorkflowChat(page, CONTEXT, { chatId: "missing-chat" })).rejects.toThrow();
    await expect(focusWorkflowChat(page, CONTEXT, 'wrong"selector')).rejects.toThrow();
    expect(owners.compose).not.toHaveBeenCalled();
    expect(owners.createPod).not.toHaveBeenCalled();
    expect(page.fillMessage).not.toHaveBeenCalled();
  });

  it.each([
    { label: "Other restricted label" },
    { mode: "governed-assist" },
    { administration: false },
    { jiraOnly: false },
  ])("refuses an invalid Restricted setup before opening a browser: %j", async (changed) => {
    const page = uiPage();
    installOwners(page);
    await expect(
      openWorkflowBrowser(CONTEXT, {
        ...FULL,
        actorClass: "restricted",
        label: "Limit Run Restricted",
        jiraOnly: true,
        ...changed,
      }),
    ).rejects.toThrow();
    expect(owners.openBrowser).not.toHaveBeenCalled();
    expect(owners.compose).not.toHaveBeenCalled();
  });

  it("does not create or bind a Pod when a Jira-only saved Chat carries knowledge", async () => {
    const chat = {
      id: "existing-chat",
      projectPath: CONTEXT.projectPath,
      localKnowledgeScope: { capsuleId: "document-source" },
      selectedModel: CONTEXT.modelId,
    };
    const page = uiPage([chat]);
    const browser = installOwners(page);
    await expect(
      openWorkflowBrowser(CONTEXT, {
        ...FULL,
        shared: { page, browser },
        chatId: chat.id,
        jiraOnly: true,
      }),
    ).rejects.toThrow(/borrow other sources/u);
    expect(owners.compose).not.toHaveBeenCalled();
    expect(owners.createPod).not.toHaveBeenCalled();
    expect(browser.close).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "closes only an owned browser after a durable phase refusal: borrowed=%s",
    async (borrowed) => {
      const page = uiPage();
      const browser = installOwners(page);
      await expect(
        openWorkflowBrowser(CONTEXT, {
          ...(borrowed ? { shared: { page, browser } } : {}),
          onPhase: () => {
            throw new TypeError("Private intent unavailable");
          },
        }),
      ).rejects.toThrow(/Private intent unavailable/u);
      expect(owners.compose).not.toHaveBeenCalled();
      expect(browser.close).toHaveBeenCalledTimes(borrowed ? 0 : 1);
    },
  );

  it("preserves the legacy default title, Ask mode and default Jira label", async () => {
    const page = uiPage();
    installOwners(page);
    const opened = await openWorkflowBrowser(CONTEXT);
    expect(opened.chat.title).toBe("Synthetic Jira browser Chat");
    expect(opened.chat.toolMode).toBe("governed-assist");
    expect(owners.bind.mock.calls[0][2]).toBe("Browser Jira");
  });

  it("observes the Chat History creator route, never the API creator", async () => {
    const page = uiPage();
    installOwners(page);
    await openWorkflowBrowser(CONTEXT);
    const creation = page.waitForResponse.mock.calls
      .map(([predicate]) => predicate)
      .find((predicate) => predicate(response("POST", "/api/desktop/chats", {}, 201)));
    expect(creation).toBeDefined();
    expect(creation(response("POST", "/api/chats", {}, 201))).toBe(false);
    expect(creation(response("GET", "/api/desktop/chats", {}))).toBe(false);
  });

  it("selects the requested model through its visible UI rather than an API write", async () => {
    const page = uiPage();
    page.initialModel = "other-fixture-model";
    installOwners(page);
    const opened = await openWorkflowBrowser(CONTEXT);
    expect(opened.chat.selectedModel).toBe(CONTEXT.modelId);
    expect(page.waitForResponse).toHaveBeenCalledTimes(3);
    expect(owners.compose).toHaveBeenCalledOnce();
    expect(page.fillMessage).not.toHaveBeenCalled();
  });
});

describe("existing browser bootstrap and Pod verification owners", () => {
  it("leaves browser storage native when no fixture Chat is supplied", async () => {
    const { openBrowser } = await vi.importActual("../testing/jira-chat-lab/browser-read.mjs");
    const page = uiPage();
    const browser = { newContext: vi.fn(async () => ({ newPage: async () => page })) };
    vi.spyOn(chromium, "launch").mockResolvedValue(browser);
    await expect(openBrowser(undefined, CONTEXT.origin)).resolves.toEqual({ browser, page });
    expect(page.addInitScript).not.toHaveBeenCalled();
  });

  it("keeps the existing explicit fixture-Chat bootstrap compatible", async () => {
    const { openBrowser } = await vi.importActual("../testing/jira-chat-lab/browser-read.mjs");
    const page = uiPage();
    const browser = { newContext: vi.fn(async () => ({ newPage: async () => page })) };
    vi.spyOn(chromium, "launch").mockResolvedValue(browser);
    await openBrowser({ id: "legacy-chat", title: "Legacy" }, CONTEXT.origin);
    expect(page.addInitScript).toHaveBeenCalledOnce();
  });

  it("admits only the one recorded verified Pod and exact label without any verification POST", async () => {
    const { assertVerifiedPod } = await vi.importActual(
      "../testing/jira-chat-lab/browser-connections.mjs",
    );
    const credential = {
      authRef: "private-auth",
      displayName: "Limit Run Restricted",
      livePod: {
        podId: "restricted-pod",
        verificationStatus: "ok",
        verificationRevision: 1,
      },
    };
    const get = vi.fn(async () =>
      response("GET", "/api/atlassian-connectors/credentials", { credentials: [credential] }),
    );
    const card = {
      getByRole: () => ({ click: vi.fn(), waitFor: vi.fn(), press: vi.fn() }),
      getByTestId: () => ({ count: async () => 0 }),
    };
    await expect(
      assertVerifiedPod({ request: { get } }, card, {
        podId: "restricted-pod",
        displayName: "Limit Run Restricted",
      }),
    ).resolves.toEqual(credential);
    await expect(
      assertVerifiedPod({ request: { get } }, card, {
        podId: "missing-pod",
        displayName: "Limit Run Restricted",
      }),
    ).rejects.toThrow();
    await expect(
      assertVerifiedPod({ request: { get } }, card, {
        podId: "restricted-pod",
        displayName: "Wrong label",
      }),
    ).rejects.toThrow();
    expect(get).toHaveBeenCalledTimes(3);
    expect(get.mock.calls.every(([path]) => path === "/api/atlassian-connectors/credentials")).toBe(
      true,
    );
  });
  it("reuses a recorded Pod without reading a PAT or opening a create form", async () => {
    const { createPod } = await vi.importActual("../testing/jira-chat-lab/browser-read.mjs");
    const credential = {
      authRef: "private-auth",
      displayName: "Limit Run Restricted",
      livePod: { podId: "restricted-pod", verificationStatus: "ok", verificationRevision: 1 },
    };
    const control = { click: vi.fn(), waitFor: vi.fn(), press: vi.fn() };
    const card = {
      filter: vi.fn(() => card),
      first: () => control,
      count: async () => 1,
      getAttribute: async () => credential.authRef,
      getByRole: () => control,
      getByTestId: () => ({ count: async () => 0 }),
    };
    const trigger = { click: vi.fn() };
    const hub = { getByTestId: () => card, getByText: vi.fn() };
    const title = { exactTitle: "Limit Run Restricted" };
    const page = {
      getByRole: (role) => (role === "button" ? trigger : hub),
      getByText: vi.fn(() => title),
      request: {
        get: async () =>
          response("GET", "/api/atlassian-connectors/credentials", { credentials: [credential] }),
      },
    };
    const onPod = vi.fn();
    await expect(
      createPod(
        page,
        { directory: "/missing-fixture-session" },
        {
          label: "Limit Run Restricted",
          podId: "restricted-pod",
          tokenFile: "/missing-fixture-session/never-read-pat",
          onPod,
        },
      ),
    ).resolves.toEqual({ podId: "restricted-pod" });
    expect(onPod).toHaveBeenCalledExactlyOnceWith({ podId: "restricted-pod" });
    expect(trigger.click).toHaveBeenCalledTimes(2);
    expect(control.click).toHaveBeenCalledOnce();
    // Playwright resolves a `has` locator inside the card, so it must be rooted at the page.
    expect(card.filter).toHaveBeenCalledExactlyOnceWith({ has: title });
    expect(page.getByText).toHaveBeenCalledExactlyOnceWith("Limit Run Restricted", { exact: true });
    expect(hub.getByText).not.toHaveBeenCalled();
  });
});
