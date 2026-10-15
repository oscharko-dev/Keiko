import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleReadChatDraft, handleSaveChatDraft } from "./chat-draft-routes.js";
import { API_ROUTES, type RouteContext } from "./routes.js";
import { createInMemoryUiStore } from "./store/index.js";
import type { UiStore } from "./store/types.js";
import { createCodingAppSessionChannel } from "./coding-app-session/sessionChannel.js";
import { createSessionRegistry } from "./coding-app-session/sessionRegistry.js";
import {
  createFakeSessionPairingPort,
  fakePairingRequestBody,
} from "./coding-app-session/_support.js";
import { APP_SESSION_COOKIE_NAME } from "./coding-app-session/sessionCookie.js";
import { createServerLogger, setServerLogger } from "./observability/index.js";
import { resetServerLogger } from "../../../tests/support/activity-log-test-support.js";
import { createBufferedServerLogSink } from "../../../tests/support/buffered-server-log.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";

const TEXT = "Synthetic private unsent draft";
const stores: UiStore[] = [];
function fixture(): {
  deps: Parameters<typeof handleReadChatDraft>[1];
  cookie: string;
  chatId: string;
} {
  const channel = createCodingAppSessionChannel({
    registry: createSessionRegistry(),
    pairingPort: createFakeSessionPairingPort(),
  });
  const paired = channel.pair(fakePairingRequestBody());
  if (!paired.paired) throw new Error("Pairing fixture failed");
  const store = createInMemoryUiStore();
  stores.push(store);
  const project = store.createProject(process.cwd());
  return {
    deps: { store, codingAppSessionChannel: channel },
    cookie: `${APP_SESSION_COOKIE_NAME}=${paired.cookieToken}`,
    chatId: store.createChat(project.path, "Draft", "model").id,
  };
}
function context(cookie: string, id: string, body: unknown = {}): RouteContext {
  const req = new IncomingMessage(new Socket());
  req.headers.cookie = cookie;
  req.headers["content-type"] = "application/json";
  req.push(JSON.stringify(body));
  req.push(null);
  return {
    req,
    res: new ServerResponse(req),
    params: { id },
    url: new URL(`http://localhost/api/chats/${id}/draft`),
    correlationId: "draft-test",
  };
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  resetServerLogger();
  vi.restoreAllMocks();
});

describe("private chat draft routes", () => {
  it("mounts authenticated reads and writes and retains the draft across requests", async () => {
    const { deps, cookie, chatId } = fixture();
    expect(API_ROUTES.some((route) => route.handler === handleReadChatDraft)).toBe(true);
    expect(API_ROUTES.some((route) => route.handler === handleSaveChatDraft)).toBe(true);
    expect((await handleReadChatDraft(context(cookie, chatId), deps)).body).toEqual({
      text: "",
      revision: 0,
    });
    const saved = await handleSaveChatDraft(
      context(cookie, chatId, { text: TEXT, expectedRevision: 0 }),
      deps,
    );
    expect(saved).toMatchObject({
      status: 200,
      body: { text: TEXT, revision: 1 },
      headers: { "Cache-Control": "no-store" },
    });
    expect((await handleReadChatDraft(context(cookie, chatId), deps)).body).toEqual(saved.body);
    expect(
      (
        await handleSaveChatDraft(
          context(cookie, chatId, { text: "stale", expectedRevision: 0 }),
          deps,
        )
      ).status,
    ).toBe(409);
    expect(deps.store.readChatDraft(chatId).text).toBe(TEXT);
  });

  it("refuses unpaired and revoked sessions before accessing draft content", async () => {
    const { deps, cookie, chatId } = fixture();
    const read = vi.spyOn(deps.store, "readChatDraft");
    const save = vi.spyOn(deps.store, "updateChatDraft");
    for (const handler of [handleReadChatDraft, handleSaveChatDraft])
      expect((await handler(context("", chatId), deps)).status).toBe(404);
    expect(read).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    const pending = handleSaveChatDraft(
      context(cookie, chatId, { text: TEXT, expectedRevision: 0 }),
      deps,
    );
    deps.codingAppSessionChannel?.signOut(cookie.split("=")[1]);
    expect((await pending).status).toBe(404);
    expect(save).not.toHaveBeenCalled();
  });

  it.each([
    {},
    { text: 42, expectedRevision: 0 },
    { text: "", expectedRevision: "0" },
    { text: "", expectedRevision: -1 },
    { text: "😀".repeat(64_001), expectedRevision: 0 },
  ])("rejects malformed or oversized content without a write", async (body) => {
    const { deps, cookie, chatId } = fixture();
    expect((await handleSaveChatDraft(context(cookie, chatId, body), deps)).status).toBe(400);
    expect(deps.store.readChatDraft(chatId)).toEqual({ text: "", revision: 0 });
  });

  it("bounds raw JSON while allowing escaped text within the canonical text limit", async () => {
    const { deps, cookie, chatId } = fixture();
    expect(
      (
        await handleSaveChatDraft(
          context(cookie, chatId, { text: "\u0000".repeat(256_000), expectedRevision: 0 }),
          deps,
        )
      ).status,
    ).toBe(200);
    expect(
      (await handleSaveChatDraft(context(cookie, chatId, { extra: "a".repeat(1_540_000) }), deps))
        .status,
    ).toBe(413);
    expect((await handleReadChatDraft(context(cookie, "missing"), deps)).status).toBe(404);
  });

  it("records body-free lifecycle evidence for success, rejection and storage failure", async () => {
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "debug" }));
    const { deps, cookie, chatId } = fixture();
    await handleSaveChatDraft(context(cookie, chatId, { text: TEXT, expectedRevision: 0 }), deps);
    await handleReadChatDraft(context("", chatId), deps);
    vi.spyOn(deps.store, "readChatDraft").mockImplementation(() => {
      throw new Error("private database detail");
    });
    await expect(handleReadChatDraft(context(cookie, chatId), deps)).rejects.toThrow(
      "private database detail",
    );
    const events = sink.events.filter((entry) => entry.op === "chat.draft.operation");
    expect(events.map((entry) => entry.extra?.phase)).toEqual([
      "started",
      "completed",
      "started",
      "rejected",
      "started",
      "failed",
    ]);
    for (const event of events)
      expectActivityLogProof("chat.draft.operation.lifecycle", formatActivityLogProofLine(event));
    expect(JSON.stringify(events)).not.toContain(TEXT);
    expect(JSON.stringify(events)).not.toContain(chatId);
    expect(JSON.stringify(events)).not.toContain("private database detail");
  });
});
