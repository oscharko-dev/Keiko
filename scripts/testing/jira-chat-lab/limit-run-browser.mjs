// Bind the already-open human Chat to native browser state and read-only server metadata.
import assert from "node:assert/strict";
import { URL, URLSearchParams } from "node:url";
import { workspaceStorageArgs } from "../../lib/workspace-storage-fixture.mjs";

async function browserJson(page, path) {
  const response = await page.request.get(path);
  assert.equal(response.status(), 200, "Limit browser metadata must be readable");
  return response.json();
}

async function activeChatWindow(page) {
  const selected = page.locator('.window[data-top="true"]').filter({ has: page.locator(".chatw") });
  assert.equal(await selected.count(), 1, "Exactly one current Chat window is required");
  const windowId = await selected.getAttribute("data-window-id");
  assert.match(
    windowId,
    /^[A-Za-z0-9_-]{1,128}$/u,
    "The current window has a concrete DOM identity",
  );
  // Keep this fixed identity when a Skills or Settings dialog changes the top window.
  const region = page.locator(`.window[data-window-id="${windowId}"]`);
  assert.equal(await region.count(), 1);
  const { storageKeys } = await workspaceStorageArgs(page, undefined);
  const windows = await page.evaluate((key) => {
    const stored = globalThis.window.localStorage.getItem(key);
    return stored === null ? [] : JSON.parse(stored);
  }, storageKeys.workspace);
  assert.ok(Array.isArray(windows));
  const matches = windows.filter((entry) => entry.id === windowId && entry.type === "chat");
  assert.equal(matches.length, 1, "The selected DOM window must match its current owned workspace");
  const chatId = matches[0].cfg?.chatId;
  assert.match(chatId, /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/iu);
  return { region, chatId };
}

async function observedChat(page, chatId, modelId) {
  const { projects } = await browserJson(page, "/api/projects");
  assert.ok(Array.isArray(projects));
  const matches = [];
  for (const project of projects) {
    assert.equal(typeof project.path, "string");
    const query = new URLSearchParams({ projectPath: project.path, id: chatId });
    const { chats } = await browserJson(page, `/api/chats?${query}`);
    assert.ok(Array.isArray(chats));
    for (const chat of chats) {
      assert.equal(chat.id, chatId);
      assert.equal(chat.projectPath, project.path);
      assert.equal(
        chat.selectedModel,
        modelId,
        "The already-open Chat must use the requested model",
      );
      matches.push(chat);
    }
  }
  assert.equal(matches.length, 1, "One native Chat must match the selected workspace identity");
  return matches[0];
}

/**
 * The paired session's cookie header for direct API requests. The product scopes its session
 * cookie to each consuming API path, so none of them applies to the bare origin; every
 * projection carries the same bearer, and conflicting values for one name fail closed.
 */
async function pairedSessionCookie(page, hostname) {
  const host = hostname.replace(/^\[|\]$/gu, "");
  const values = new Map();
  for (const entry of await page.context().cookies()) {
    if (entry.domain !== host) continue;
    assert.ok(
      !values.has(entry.name) || values.get(entry.name) === entry.value,
      "One paired browser session must carry one value per cookie name",
    );
    values.set(entry.name, entry.value);
  }
  assert.ok(values.size > 0, "The existing browser session must already be paired");
  return [...values].map(([name, value]) => `${name}=${value}`).join("; ");
}

/** No Chat creation, pairing, storage rewrite or credential persistence; cookies stay in memory. */
export async function resolveLimitBrowser(ctx, expectedChat) {
  const page = ctx.page;
  const { origin, hostname } = new URL(page.url());
  assert.ok(new Set(["127.0.0.1", "localhost", "[::1]"]).has(hostname));
  const { region, chatId } = await activeChatWindow(page);
  const chat = await observedChat(page, chatId, ctx.modelId);
  const supplied =
    expectedChat === undefined
      ? [ctx.chat, ctx.reportChat, ctx.deniedChat].filter((value) => value !== undefined)
      : [expectedChat];
  assert.ok(
    supplied.some((value) => value?.id === chat.id && value.projectPath === chat.projectPath),
    "The visible Chat must be supplied by the orchestrator",
  );
  const cookie = await pairedSessionCookie(page, hostname);
  return {
    page,
    region,
    chat,
    context: {
      session: ctx.session,
      origin,
      cookie,
      projectPath: chat.projectPath,
      modelId: ctx.modelId,
    },
  };
}
