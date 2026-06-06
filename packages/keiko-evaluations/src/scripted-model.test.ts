// Tests for createScriptedModelPort (ADR-0012 D4). Covers: in-order replay, last-entry repeat,
// Error entry rejects, empty script rejects with a descriptive message, callCount increments,
// and signal param accepted. All pure unit tests — no IO, no network.

import { describe, expect, it } from "vitest";
import { createScriptedModelPort } from "./scripted-model.js";
import type { NormalizedResponse } from "@oscharko-dev/keiko-model-gateway";

function makeResponse(content: string, modelId = "m"): NormalizedResponse {
  return {
    modelId,
    content,
    finishReason: "stop",
    toolCalls: [],
    structuredOutput: null,
    usage: {
      requestId: "r",
      promptTokens: 1,
      completionTokens: 1,
      latencyMs: 1,
      costClass: "low",
    },
  };
}

const SIGNAL = new AbortController().signal;

const BASE_REQUEST = {
  messages: [{ role: "user" as const, content: "hello" }],
  modelId: "m",
  tools: [],
};

describe("createScriptedModelPort", () => {
  describe("in-order replay", () => {
    it("returns the first entry on the first call", async () => {
      const r0 = makeResponse("first");
      const r1 = makeResponse("second");
      const port = createScriptedModelPort([r0, r1]);

      const result = await port.call(BASE_REQUEST, SIGNAL);

      expect(result.content).toBe("first");
    });

    it("returns the second entry on the second call", async () => {
      const r0 = makeResponse("first");
      const r1 = makeResponse("second");
      const port = createScriptedModelPort([r0, r1]);

      await port.call(BASE_REQUEST, SIGNAL);
      const result = await port.call(BASE_REQUEST, SIGNAL);

      expect(result.content).toBe("second");
    });

    it("returns entries in script order across three calls", async () => {
      const entries = [makeResponse("a"), makeResponse("b"), makeResponse("c")];
      const port2 = createScriptedModelPort(entries);
      const a = await port2.call(BASE_REQUEST, SIGNAL);
      const b = await port2.call(BASE_REQUEST, SIGNAL);
      const c = await port2.call(BASE_REQUEST, SIGNAL);
      expect([a.content, b.content, c.content]).toEqual(["a", "b", "c"]);
    });
  });

  describe("last-entry repeat", () => {
    it("repeats the last entry when calls exceed the script length", async () => {
      const port = createScriptedModelPort([makeResponse("only")]);

      await port.call(BASE_REQUEST, SIGNAL); // call 1 — consumes entry 0
      const second = await port.call(BASE_REQUEST, SIGNAL); // call 2 — repeats last
      const third = await port.call(BASE_REQUEST, SIGNAL); // call 3 — still repeats

      expect(second.content).toBe("only");
      expect(third.content).toBe("only");
    });

    it("repeats the last entry of a two-entry script after exhaustion", async () => {
      const port = createScriptedModelPort([makeResponse("first"), makeResponse("last")]);

      await port.call(BASE_REQUEST, SIGNAL);
      await port.call(BASE_REQUEST, SIGNAL);
      const overflow = await port.call(BASE_REQUEST, SIGNAL);

      expect(overflow.content).toBe("last");
    });
  });

  describe("Error entry rejects", () => {
    it("rejects when the current script entry is an Error", async () => {
      const err = new Error("scripted failure");
      const port = createScriptedModelPort([err]);

      await expect(port.call(BASE_REQUEST, SIGNAL)).rejects.toThrow("scripted failure");
    });

    it("rejects with the scripted Error instance (not a copy)", async () => {
      const err = new Error("exact error");
      const port = createScriptedModelPort([err]);

      await expect(port.call(BASE_REQUEST, SIGNAL)).rejects.toBe(err);
    });

    it("repeats the Error on subsequent calls once the script is exhausted", async () => {
      const err = new Error("repeated error");
      const port = createScriptedModelPort([makeResponse("ok"), err]);

      await port.call(BASE_REQUEST, SIGNAL);
      await expect(port.call(BASE_REQUEST, SIGNAL)).rejects.toBe(err);
      await expect(port.call(BASE_REQUEST, SIGNAL)).rejects.toBe(err); // repeats last
    });
  });

  describe("empty script", () => {
    it("rejects with a descriptive error message when the script is empty", async () => {
      const port = createScriptedModelPort([]);

      await expect(port.call(BASE_REQUEST, SIGNAL)).rejects.toThrow(/empty script/i);
    });

    it("does not silently return undefined on an empty script", async () => {
      const port = createScriptedModelPort([]);

      const promise = port.call(BASE_REQUEST, SIGNAL);
      await expect(promise).rejects.toBeInstanceOf(Error);
    });
  });

  describe("callCount", () => {
    it("starts at zero before any call", () => {
      const port = createScriptedModelPort([makeResponse("x")]);
      expect(port.callCount()).toBe(0);
    });

    it("increments by one after each call", async () => {
      const port = createScriptedModelPort([makeResponse("x")]);

      await port.call(BASE_REQUEST, SIGNAL);
      expect(port.callCount()).toBe(1);

      await port.call(BASE_REQUEST, SIGNAL);
      expect(port.callCount()).toBe(2);
    });

    it("increments even when the call rejects (Error entry)", async () => {
      const port = createScriptedModelPort([new Error("boom")]);

      await port.call(BASE_REQUEST, SIGNAL).catch(() => undefined);
      expect(port.callCount()).toBe(1);
    });

    it("increments callCount on an empty-script call before rejecting", async () => {
      const port = createScriptedModelPort([]);
      await port.call(BASE_REQUEST, SIGNAL).catch(() => undefined);
      expect(port.callCount()).toBe(1);
    });
  });

  describe("signal param accepted", () => {
    it("accepts a live AbortSignal without throwing", async () => {
      const port = createScriptedModelPort([makeResponse("ok")]);
      const controller = new AbortController();

      const result = await port.call(BASE_REQUEST, controller.signal);

      expect(result.content).toBe("ok");
    });

    it("accepts an already-aborted signal — offline replay does not observe abort", async () => {
      const port = createScriptedModelPort([makeResponse("ok")]);
      const controller = new AbortController();
      controller.abort();

      const result = await port.call(BASE_REQUEST, controller.signal);
      expect(result.content).toBe("ok");
    });
  });
});
