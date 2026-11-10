import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URL } from "node:url";

const ports = vi.hoisted(() => ({
  browser: vi.fn(),
  language: vi.fn(),
  native: vi.fn(),
  axe: vi.fn(),
}));
vi.mock("../testing/jira-chat-lab/limit-run-browser.mjs", () => ({
  resolveLimitBrowser: ports.browser,
}));
vi.mock("../testing/jira-chat-lab/limit-run-language.mjs", () => ({
  changeLimitUiLanguage: ports.language,
}));
vi.mock("../testing/jira-chat-lab/project-agile-oracles.mjs", async (original) => ({
  ...(await original()),
  projectAgileRead: ports.native,
}));
vi.mock("../../tests/e2e/support/axe.ts", async (original) => ({
  ...(await original()),
  runAxe: ports.axe,
}));

import { assertCardsReadable, setUiLanguage } from "../testing/jira-chat-lab/browser-a11y.mjs";
import { RESULT_CARDS } from "../testing/jira-chat-lab/browser-card-readability.mjs";

const CHAT = "01234567-89ab-4cde-8fab-0123456789ab";
const OTHER_CHAT = "11234567-89ab-4cde-8fab-0123456789ab";
const CARD_SELECTOR = RESULT_CARDS;
const roots = [];
let active;
function card(body = "LIM7-1 and LIM7-2", extra = {}) {
  return {
    title: "Issues found",
    outcome: "Completed",
    body,
    links: [
      "https://jira.synthetic.invalid/browse/LIM7-1",
      "https://jira.synthetic.invalid/browse/LIM7-2",
    ],
    ...extra,
  };
}
function issue(key) {
  return {
    id: key.split("-").at(-1),
    key,
    fields: { project: { key: "LIM7" }, summary: "private issue body", labels: [] },
  };
}
function cardLocator(value) {
  return {
    isVisible: async () => value.visible !== false,
    innerText: async () => `${value.title}\n${value.outcome}\n${value.body}`,
    locator: (selector) => {
      if (selector === "pre") return { count: async () => value.pre ?? 0 };
      const outputs = [value.outcome, ...(value.extraOutputs ?? [])];
      if (selector === ":scope > strong") return { innerText: async () => value.title };
      // Playwright strict mode: a text read of a multi-match locator throws.
      if (selector === ":scope > output")
        return {
          count: async () => outputs.length,
          nth: (index) => ({ innerText: async () => outputs[index] }),
          innerText: async () => {
            if (outputs.length !== 1) throw new Error("strict mode violation");
            return outputs[0];
          },
        };
      expect(selector).toBe(":scope > strong + output");
      return { innerText: async () => value.outcome };
    },
    getByRole: (role) => {
      expect(role).toBe("link");
      return {
        count: async () => value.links.length,
        nth: (index) => ({
          isVisible: async () => true,
          getAttribute: async (name) => {
            expect(name).toBe("href");
            return value.links[index];
          },
        }),
      };
    },
  };
}
function cardsLocator(state) {
  return {
    count: async () => state.cards.length,
    nth: (index) => cardLocator(state.cards[index]),
    first: () => ({
      waitFor: async (options) => {
        expect(options).toEqual({ state: "visible" });
        if (!state.cards.some((value) => value.visible !== false))
          throw new Error("Cards unavailable");
      },
    }),
  };
}
function browserPage(state, options) {
  const listeners = new Set();
  const page = {
    url: () => "http://127.0.0.1:4288/",
    locator: (selector) => {
      expect(selector).toBe("html");
      return { getAttribute: async () => state.locale };
    },
    on: vi.fn((event, listener) => {
      expect(event).toBe("request");
      listeners.add(listener);
    }),
    off: vi.fn((event, listener) => {
      expect(event).toBe("request");
      listeners.delete(listener);
    }),
    request: {
      get: vi.fn(async (path) => {
        const url = new URL(path, page.url());
        expect(url.pathname).toBe("/api/chats/messages");
        expect(url.searchParams.get("chatId")).toBe(state.chatId);
        expect(url.searchParams.get("projectPath")).toBe("/synthetic/workspace");
        return {
          status: () => (options.historyUnavailable ? 503 : 200),
          json: async () => ({ messages: state.messages }),
        };
      }),
    },
    reload: vi.fn(async () => {
      state.reloads += 1;
      options.afterReload?.(state);
      if (options.abortReload) state.controller.abort(new Error("private abort reason"));
      const path = options.replayPath ?? "/api/desktop/chat/stream";
      if (options.replayMethod)
        for (const listener of listeners)
          listener({
            method: () => options.replayMethod,
            url: () => new URL(path, page.url()).href,
          });
    }),
  };
  return { page, listeners };
}
function memoryIntent() {
  let state = {};
  return {
    get state() {
      return structuredClone(state);
    },
    record: vi.fn(async (name, value) => {
      state = { ...state, [name]: structuredClone(value) };
    }),
    update: vi.fn(async (patch) => {
      state = { ...state, ...structuredClone(patch) };
    }),
  };
}
function fixture(options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "keiko-ac9-"));
  roots.push(directory);
  const state = {
    locale: "de",
    cards: [card()],
    chatId: CHAT,
    reloads: 0,
    messages: [{ id: "m1", role: "assistant", content: "private answer body" }],
    controller: new globalThis.AbortController(),
    native: new Map([1, 2].map((id) => [`LIM7-${id}`, issue(`LIM7-${id}`)])),
  };
  const { page, listeners } = browserPage(state, options);
  const region = {
    getAttribute: async (name) => {
      expect(name).toBe("data-window-id");
      return "chat-window";
    },
    waitFor: vi.fn(async (wait) => {
      expect(wait).toEqual({ state: "visible" });
    }),
    locator: (selector) => {
      expect(selector).toBe(CARD_SELECTOR);
      return cardsLocator(state);
    },
  };
  const ctx = {
    sessionDir: directory,
    session: { oracleAuthorization: "synthetic-private-oracle" },
    page,
    projectKey: "LIM7",
    locale: "de",
    modelId: "fixture-model",
    signal: state.controller.signal,
    intent: memoryIntent(),
    chat: { id: state.chatId, projectPath: "/synthetic/workspace" },
    region,
  };
  active = { ctx, state, region, page, listeners, options };
  return active;
}
function nativeResponse(path) {
  const url = new URL(path, "https://jira.synthetic.invalid");
  expect(url.pathname).toBe("/rest/api/2/search");
  expect(url.searchParams.get("fields")).toBe("*all");
  expect(url.searchParams.get("startAt")).toBe("0");
  expect(url.searchParams.get("maxResults")).toBe("50");
  const match = /^project = LIM7 AND key in \((.+)\) ORDER BY key ASC$/u.exec(
    url.searchParams.get("jql"),
  );
  expect(match).not.toBeNull();
  const keys = match[1].split(",").map((value) => JSON.parse(value));
  expect(keys.length).toBeLessThanOrEqual(50);
  const issues = keys
    .filter((key) => active.state.native.has(key))
    .map((key) => active.state.native.get(key));
  return { startAt: 0, total: issues.length, issues };
}
beforeEach(() => {
  vi.clearAllMocks();
  ports.browser.mockImplementation(async (ctx) => {
    expect(ctx).toBe(active.ctx);
    return {
      page: active.page,
      region: active.region,
      chat: { id: active.state.chatId, projectPath: "/synthetic/workspace" },
      context: { session: ctx.session },
    };
  });
  ports.language.mockImplementation(async (ctx, locale) => {
    active.state.locale = locale;
    ctx.locale = locale;
  });
  ports.native.mockImplementation(async (session, path) => {
    expect(session).toBe(active.ctx.session);
    return structuredClone(nativeResponse(path));
  });
  ports.axe.mockImplementation(async (page, selector) => {
    expect(page).toBe(active.page);
    expect(selector).toBe('.window[data-window-id="chat-window"]');
    return active.options.violations ?? [];
  });
});
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("AC9 explicit UI language", () => {
  it.each(["en", "de"])(
    "delegates %s to the existing language owner and emits a StepResult",
    async (locale) => {
      const f = fixture();
      const result = await setUiLanguage(f.ctx, locale);
      expect(result).toMatchObject({
        step: `ac9-ui-language-${locale}`,
        status: "green",
        detail: "ui-language-confirmed",
        counts: { changes: Number(locale === "en") },
      });
      expect(ports.language).toHaveBeenCalledWith(f.ctx, locale);
      expect(ports.native).not.toHaveBeenCalled();
      expect(f.state.locale).toBe(locale);
    },
  );
  it("supports repeated explicit EN→DE→EN requests without replaying a Chat", async () => {
    const f = fixture();
    for (const locale of ["en", "de", "en"])
      expect((await setUiLanguage(f.ctx, locale)).status).toBe("green");
    expect(ports.language).toHaveBeenCalledTimes(3);
    expect(f.page.reload).not.toHaveBeenCalled();
    expect(f.state.locale).toBe("en");
  });
  it("never reports green when the ordinary Settings owner fails", async () => {
    const f = fixture();
    ports.language.mockRejectedValueOnce(new Error("private UI failure body"));
    const result = await setUiLanguage(f.ctx, "en");
    expect(result.status).toBe("unverified");
    expect(result.detail).toBe("ui-language-unavailable");
    expect(JSON.stringify(f.ctx.intent.state)).not.toContain("private UI failure body");
  });
  it.each(["fr", "../en"])(
    "rejects invalid locale %s without touching Settings",
    async (locale) => {
      const f = fixture();
      await expect(setUiLanguage(f.ctx, locale)).rejects.toThrow("Unsupported");
      expect(ports.language).not.toHaveBeenCalled();
    },
  );
});

describe("AC9 current Chat result cards", () => {
  it("checks real card structure, independent scoped native keys, severe axe findings and stable reload without Chat writes", async () => {
    const f = fixture();
    const result = await assertCardsReadable(f.ctx, { reload: true });
    expect(result).toMatchObject({
      step: "ac9-cards-readable",
      status: "green",
      detail: "cards-readable-confirmed",
      counts: { cards: 1, keys: 2, links: 2, serious: 0, critical: 0, chatWrites: 0, reloads: 1 },
    });
    expect(ports.browser).toHaveBeenCalledTimes(2);
    expect(ports.axe).toHaveBeenCalledTimes(2);
    expect(ports.native).toHaveBeenCalledTimes(2);
    expect(f.page.request.get).toHaveBeenCalledTimes(2);
    expect(f.page.reload).toHaveBeenCalledTimes(1);
    expect(f.listeners.size).toBe(0);
    const saved = JSON.stringify(f.ctx.intent.state);
    for (const secret of [
      "private answer body",
      "private issue body",
      "jira.synthetic.invalid",
      "synthetic-private-oracle",
      "LIM7-1",
    ])
      expect(saved).not.toContain(secret);
    expect(JSON.parse(saved)["ac9-cards-readable"].resources).toMatchObject({
      chatId: CHAT,
      cardDigest: expect.stringMatching(/^[a-f\d]{64}$/u),
      keyDigest: expect.stringMatching(/^[a-f\d]{64}$/u),
      linkDigest: expect.stringMatching(/^[a-f\d]{64}$/u),
    });
  });
  it("does not mistake LH requirement references for Jira issue keys", async () => {
    const f = fixture();
    f.state.cards = [
      card("Requirement [LH-901] affects LIM7-1", {
        links: ["https://jira.synthetic.invalid/browse/LIM7-1"],
      }),
    ];
    const result = await assertCardsReadable(f.ctx, { reload: true });
    expect(result.status).toBe("green");
    expect(result.counts.keys).toBe(1);
    expect(
      ports.native.mock.calls.every(
        ([, path]) =>
          !new URL(path, "https://jira.synthetic.invalid").searchParams
            .get("jql")
            .includes("LH-901"),
      ),
    ).toBe(true);
  });
  it("binds an issue key from its actual browse link even when the card uses a human link label", async () => {
    const f = fixture();
    f.state.cards = [
      card("Requirement LH-901", { links: ["https://jira.synthetic.invalid/browse/LIM7-1"] }),
    ];
    const result = await assertCardsReadable(f.ctx, { reload: true });
    expect(result.status).toBe("green");
    expect(result.counts.keys).toBe(1);
  });
  it("uses only the canonical intent handle without creating a second journal", async () => {
    const f = fixture();
    const result = await assertCardsReadable(f.ctx, { reload: true });
    expect(result.status).toBe("green");
    expect(f.ctx.intent.record).toHaveBeenCalled();
    expect(f.ctx.intent.record.mock.calls.every(([step]) => step === "ac9-cards-readable")).toBe(
      true,
    );
    expect(readdirSync(f.ctx.sessionDir)).toEqual([]);
    const snapshot = f.ctx.intent.state;
    snapshot["ac9-cards-readable"].phase = "prepared";
    expect(f.ctx.intent.state["ac9-cards-readable"].phase).toBe("completed");
  });
  it("validates visible keys in bounded batches rather than reading a whole large project", async () => {
    const f = fixture();
    const keys = Array.from({ length: 121 }, (_, index) => `LIM7-${index + 1}`);
    f.state.cards = [card(keys.join(" "), { links: [] })];
    f.state.native = new Map(keys.map((key) => [key, issue(key)]));
    const result = await assertCardsReadable(f.ctx, { reload: true });
    expect(result.status).toBe("green");
    expect(result.counts.keys).toBe(121);
    expect(ports.native).toHaveBeenCalledTimes(6);
  });
  it("audits the provided report Chat without rebinding the document Chat", async () => {
    const f = fixture();
    const document = f.ctx.chat;
    f.ctx.reportChat = { id: OTHER_CHAT, projectPath: "/synthetic/workspace" };
    f.state.chatId = OTHER_CHAT;
    const result = await assertCardsReadable(f.ctx, { reload: true });
    expect(result.status).toBe("green");
    expect(f.ctx.chat).toBe(document);
    expect(f.ctx.chat.id).toBe(CHAT);
    expect(f.ctx.intent.state["ac9-cards-readable"].resources.chatId).toBe(OTHER_CHAT);
  });
  it("allows a fresh current card set and a different role Chat on another explicit call", async () => {
    const f = fixture();
    expect((await assertCardsReadable(f.ctx, { reload: true })).status).toBe("green");
    f.state.chatId = OTHER_CHAT;
    f.ctx.chat = { id: OTHER_CHAT, projectPath: "/synthetic/workspace" };
    f.state.cards = [card("LIM7-2", { links: ["https://jira.synthetic.invalid/browse/LIM7-2"] })];
    expect((await assertCardsReadable(f.ctx, { reload: true })).status).toBe("green");
    expect(f.ctx.intent.state["ac9-cards-readable"].resources.chatId).toBe(OTHER_CHAT);
  });
  it.each([
    ["generic English", { title: "Jira action" }],
    ["generic German", { title: "Jira-Aktion" }],
    ["raw pre", { pre: 1 }],
    ["raw JSON", { body: '{"items":[{"key":"LIM7-1"}]}' }],
    ["prefixed JSON", { body: 'Further details\n{"secret":1}' }],
    ["multiple JSON blocks", { body: 'First {"secret":1} then [1,2]' }],
    ["English fallback", { body: "A readable view of this result is unavailable." }],
    ["German fallback", { body: "Für dieses Ergebnis ist keine lesbare Ansicht verfügbar." }],
    ["empty heading", { title: "" }],
    ["empty outcome", { outcome: "" }],
  ])("rejects %s result cards without reloading", async (_name, overrides) => {
    const f = fixture();
    f.state.cards = [card("LIM7-1", overrides)];
    const result = await assertCardsReadable(f.ctx, { reload: true });
    expect(result).toMatchObject({ status: "red", detail: "cards-readability-failed" });
    expect(f.page.reload).not.toHaveBeenCalled();
    expect(f.listeners.size).toBe(0);
  });
  it("reads a report card whose read status is a second direct output", async () => {
    const f = fixture();
    f.state.cards = [card("LIM7-1", { extraOutputs: ["Complete: 7 issues read"] })];
    expect((await assertCardsReadable(f.ctx, { reload: true })).status).toBe("green");
  });
  it("rejects a report card whose read status output is empty", async () => {
    const f = fixture();
    f.state.cards = [card("LIM7-1", { extraOutputs: ["  "] })];
    expect(await assertCardsReadable(f.ctx, { reload: true })).toMatchObject({
      status: "red",
      detail: "cards-readability-failed",
    });
  });
  it("requires a visible actual result card", async () => {
    const f = fixture();
    f.state.cards = [card("LIM7-1", { visible: false })];
    expect((await assertCardsReadable(f.ctx, { reload: true })).status).toBe("red");
  });
  it.each(["serious", "critical"])(
    "rejects actual %s axe violations without accepting a baseline",
    async (impact) => {
      const f = fixture({
        violations: [{ id: "fixture-rule", impact, help: "private axe body", nodes: [] }],
      });
      const result = await assertCardsReadable(f.ctx, { reload: true });
      expect(result).toMatchObject({
        status: "red",
        detail: "cards-accessibility-failed",
        counts: { [impact]: 1 },
      });
      expect(f.page.reload).not.toHaveBeenCalled();
      expect(JSON.stringify(f.ctx.intent.state)).not.toContain("private axe body");
    },
  );
  it("keeps moderate/minor axe findings outside the specified severe threshold", async () => {
    const f = fixture({ violations: [{ impact: "moderate" }, { impact: "minor" }] });
    expect((await assertCardsReadable(f.ctx, { reload: true })).status).toBe("green");
  });
  it.each([
    [
      "keys",
      (state) => {
        state.native.set("LIM7-3", issue("LIM7-3"));
        state.cards = [card("LIM7-3")];
      },
    ],
    [
      "links",
      (state) => {
        state.cards[0].links = ["https://jira.synthetic.invalid/browse/LIM7-2"];
      },
    ],
    [
      "native issue",
      (state) => {
        state.native.get("LIM7-1").fields.labels.push("changed");
      },
    ],
    [
      "chat scope",
      (state) => {
        state.chatId = OTHER_CHAT;
      },
    ],
  ])("rejects changed %s within one reload invocation", async (_name, afterReload) => {
    const f = fixture({ afterReload });
    expect(await assertCardsReadable(f.ctx, { reload: true })).toMatchObject({
      status: "red",
      detail: "cards-reload-changed",
    });
  });
  it.each(["POST", "PATCH", "PUT", "DELETE"])(
    "detects %s Chat replay during reload without reading request bodies",
    async (replayMethod) => {
      const f = fixture({ replayMethod });
      expect(await assertCardsReadable(f.ctx, { reload: true })).toMatchObject({
        status: "red",
        detail: "cards-reload-replayed",
        counts: { chatWrites: 1 },
      });
      expect(f.listeners.size).toBe(0);
    },
  );
  it("ignores ordinary diagnostic POSTs and read-only Chat requests", async () => {
    const f = fixture({ replayMethod: "POST", replayPath: "/api/client-diagnostics" });
    expect((await assertCardsReadable(f.ctx, { reload: true })).status).toBe("green");
    f.options.replayMethod = "GET";
    f.options.replayPath = "/api/chats/messages";
    expect((await assertCardsReadable(f.ctx, { reload: true })).status).toBe("green");
  });
  it("detects an independently observed history change even without an intercepted request", async () => {
    const f = fixture({
      afterReload: (state) =>
        state.messages.push({ id: "m2", role: "user", content: "private replay body" }),
    });
    const result = await assertCardsReadable(f.ctx, { reload: true });
    expect(result).toMatchObject({ status: "red", detail: "cards-reload-replayed" });
    expect(JSON.stringify(f.ctx.intent.state)).not.toContain("private replay body");
  });
  it("never treats an unavailable independent readback as a green empty set", async () => {
    const f = fixture({ historyUnavailable: true });
    const result = await assertCardsReadable(f.ctx, { reload: true });
    expect(result).toMatchObject({ status: "unverified", detail: "cards-readback-unavailable" });
    expect(f.listeners.size).toBe(0);
  });
  it("stops an aborted audit, persists only a closed code and detaches the observer", async () => {
    const f = fixture({ abortReload: true });
    const result = await assertCardsReadable(f.ctx, { reload: true });
    expect(result).toMatchObject({ status: "unverified", detail: "cards-readable-aborted" });
    expect(f.listeners.size).toBe(0);
    expect(JSON.stringify(f.ctx.intent.state)).not.toContain("private abort reason");
  });
  it("refuses an already aborted context before resolving a Chat or changing its language", async () => {
    const f = fixture();
    f.state.controller.abort(new Error("already-aborted"));
    await expect(assertCardsReadable(f.ctx, { reload: true })).rejects.toMatchObject({
      name: "AbortError",
    });
    await expect(setUiLanguage(f.ctx, "en")).rejects.toMatchObject({ name: "AbortError" });
    expect(ports.browser).not.toHaveBeenCalled();
    expect(ports.language).not.toHaveBeenCalled();
    expect(f.page.reload).not.toHaveBeenCalled();
  });
  it("reverifies a retained pending read-only audit without any Chat submission", async () => {
    const f = fixture();
    ports.native.mockRejectedValueOnce(new Error("readback unavailable"));
    expect((await assertCardsReadable(f.ctx, { reload: true })).status).toBe("unverified");
    expect(f.ctx.intent.state["ac9-cards-readable"].phase).toBe("pending");
    expect((await assertCardsReadable(f.ctx, { reload: true })).status).toBe("green");
  });
});
