import { expect, it, vi } from "vitest";
import {
  createChatTurnSerializer,
  CHAT_TURN_WAIT_CANCELLED,
} from "../../packages/keiko-server/dist/chat-turn-serializer.js";
import { drainLiveChatTurns } from "../testing/jira-chat-lab/chat-lifecycle.mjs";

function fixture() {
  const chatTurnSerializer = createChatTurnSerializer();
  const store = { listChats: vi.fn(() => [{ id: "owned-chat" }]) };
  return { chatTurnSerializer, store };
}

it("waits for underlying work after the HTTP-facing cancellation has already settled", async () => {
  const deps = fixture();
  const controller = new globalThis.AbortController();
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  const request = deps.chatTurnSerializer.runExclusive(
    "owned-chat",
    controller.signal,
    () => {
      started.resolve();
      return release.promise;
    },
    controller,
  );
  await started.promise;
  controller.abort();
  expect(await request).toBe(CHAT_TURN_WAIT_CANCELLED);
  let drained = false;
  const pending = drainLiveChatTurns(deps, "/synthetic").then(() => {
    drained = true;
  });
  await Promise.resolve();
  expect(drained).toBe(false);
  release.resolve();
  await pending;
  expect(drained).toBe(true);
  expect(deps.store.listChats).toHaveBeenCalledWith("/synthetic");
});

it("interrupts the existing generation controller and drains its cooperative cleanup", async () => {
  const deps = fixture();
  const controller = new globalThis.AbortController();
  const started = Promise.withResolvers();
  const work = deps.chatTurnSerializer.runExclusive(
    "owned-chat",
    controller.signal,
    () =>
      new Promise((resolve) => {
        controller.signal.addEventListener("abort", () => resolve(), { once: true });
        started.resolve();
      }),
    controller,
  );
  await started.promise;
  await drainLiveChatTurns(deps, "/synthetic");
  expect(controller.signal.aborted).toBe(true);
  await work;
});

it("fails the bounded drain instead of pretending noncooperative work is safe to dispose", async () => {
  const deps = fixture();
  const controller = new globalThis.AbortController();
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  const work = deps.chatTurnSerializer.runExclusive(
    "owned-chat",
    controller.signal,
    () => {
      started.resolve();
      return release.promise;
    },
    controller,
  );
  await started.promise;
  await expect(drainLiveChatTurns(deps, "/synthetic", 5)).rejects.toThrow(
    "preserve the open store",
  );
  release.resolve();
  await work;
});
