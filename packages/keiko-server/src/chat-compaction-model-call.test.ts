import { describe, expect, it, vi } from "vitest";
import type { NormalizedResponse } from "@oscharko-dev/keiko-model-gateway";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
import {
  callChatCompactionModel,
  beginChatCompactionWork,
  chatCompactionWorkStopped,
  stopChatCompactionWork,
} from "./chat-compaction-model-call.js";

const request = {
  modelId: "fixture",
  messages: [{ role: "user" as const, content: "Synthetic data" }],
};

describe("bounded compaction model calls", () => {
  it("cancels and drains only its own graph and refuses subsequent queued work", async () => {
    const first = {},
      second = {};
    const work = beginChatCompactionWork(first);
    const peer = beginChatCompactionWork(second);
    if (work === undefined || peer === undefined) throw new Error("Missing initial work scope");
    let drained = false;
    const stopped = stopChatCompactionWork(first).then(() => {
      drained = true;
    });
    expect(work.signal.aborted).toBe(true);
    expect(peer.signal.aborted).toBe(false);
    expect(chatCompactionWorkStopped(first)).toBe(true);
    expect(chatCompactionWorkStopped(second)).toBe(false);
    expect(beginChatCompactionWork(first)).toBeUndefined();
    await Promise.resolve();
    expect(drained).toBe(false);
    work.finish();
    work.finish();
    await stopped;
    expect(drained).toBe(true);
    peer.finish();
    await stopChatCompactionWork(second);
    await stopChatCompactionWork(first);
  });

  it("times out even when a provider ignores its abort signal", async () => {
    const call: ModelPort["call"] = () => new Promise<NormalizedResponse>(() => undefined);
    await expect(
      callChatCompactionModel(call, request, new AbortController().signal, 10),
    ).rejects.toMatchObject({ code: "GATEWAY_TIMEOUT" });
  });

  it("propagates caller cancellation to a stalled provider", async () => {
    const controller = new AbortController();
    let observed: AbortSignal | undefined;
    const call: ModelPort["call"] = (_request, signal) => {
      observed = signal;
      return new Promise<NormalizedResponse>(() => undefined);
    };
    const result = callChatCompactionModel(call, request, controller.signal, 30_000);
    controller.abort();
    await expect(result).rejects.toMatchObject({ code: "GATEWAY_CANCELLED" });
    expect(observed?.aborted).toBe(true);
  });

  it("does not call the provider for a previously aborted request", async () => {
    const controller = new AbortController();
    controller.abort();
    const call = vi.fn<ModelPort["call"]>();
    await expect(
      callChatCompactionModel(call, request, controller.signal, 30_000),
    ).rejects.toThrow();
    expect(call).not.toHaveBeenCalled();
  });
});
