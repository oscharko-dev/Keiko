import { afterEach, describe, expect, it } from "vitest";
import {
  ANSWERER_MODEL_ID,
  LEARNER_MODEL_ID,
  memoryBodiesInPrompt,
  startScriptedModelServer,
} from "../testing/memory-lab/scripted-model.mjs";

const FENCED =
  "User message:\nWie?\n\nIncluded memory context:\n===UNTRUSTED_MEMORY_CONTEXT_START===\n# Relevant memories\n- (top signal: relevance) Ich bevorzuge Tabellen.\n- Zweiter Eintrag.\n===UNTRUSTED_MEMORY_CONTEXT_END===\n";

async function complete(fixture, body) {
  const response = await globalThis.fetch(`${fixture.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, text: await response.text() };
}

describe("memory lab scripted model", () => {
  let fixture;
  afterEach(async () => {
    if (fixture) await new Promise((resolve) => fixture.close(resolve));
    fixture = undefined;
  });

  it("extracts memory bodies from the product's untrusted fence", () => {
    expect(memoryBodiesInPrompt([{ role: "user", content: FENCED }])).toEqual([
      "Ich bevorzuge Tabellen.",
      "Zweiter Eintrag.",
    ]);
    expect(memoryBodiesInPrompt([{ role: "user", content: "no fence" }])).toEqual([]);
  });

  it("answers OK during learning and echoes supplied memories during probes", async () => {
    fixture = await startScriptedModelServer();
    const first = await complete(fixture, {
      model: ANSWERER_MODEL_ID,
      messages: [{ role: "user", content: FENCED }],
    });
    expect(JSON.parse(first.text).choices[0].message.content).toBe("OK.");
    fixture.setAnswerMode("echo");
    const echoed = await complete(fixture, {
      model: ANSWERER_MODEL_ID,
      messages: [{ role: "user", content: FENCED }],
    });
    expect(JSON.parse(echoed.text).choices[0].message.content).toBe(
      "Erinnerungen: Ich bevorzuge Tabellen. | Zweiter Eintrag.",
    );
    const blank = await complete(fixture, {
      model: ANSWERER_MODEL_ID,
      messages: [{ role: "user", content: "Farbe?" }],
    });
    expect(JSON.parse(blank.text).choices[0].message.content).toBe("Ich weiss es nicht.");
    expect(fixture.requests().map((entry) => entry.memoryCount)).toEqual([2, 2, 0]);
    expect(() => fixture.setAnswerMode("loud")).toThrow(RangeError);
  });

  it("serves queued learner items once, then empty lists, and counts its calls", async () => {
    fixture = await startScriptedModelServer();
    fixture.queueLearner([{ body: "Ich mag Tabellen.", type: "preference" }]);
    const first = await complete(fixture, {
      model: LEARNER_MODEL_ID,
      messages: [{ role: "user", content: "Ich mag Tabellen." }],
    });
    const items = JSON.parse(JSON.parse(first.text).choices[0].message.content).items;
    expect(items).toEqual([
      {
        body: "Ich mag Tabellen.",
        type: "preference",
        confidence: 0.8,
        scope: "user",
        source: "user",
        tags: [],
      },
    ]);
    const second = await complete(fixture, { model: LEARNER_MODEL_ID, messages: [] });
    expect(JSON.parse(JSON.parse(second.text).choices[0].message.content).items).toEqual([]);
    expect(fixture.learnerCalls()).toBe(2);
    fixture.queueLearner([]);
    expect(fixture.pendingLearner()).toBe(1);
    fixture.clearLearner();
    expect(fixture.pendingLearner()).toBe(0);
  });

  it("streams the OpenAI chunk shape with a usage frame and DONE", async () => {
    fixture = await startScriptedModelServer();
    const { status, text } = await complete(fixture, {
      model: ANSWERER_MODEL_ID,
      stream: true,
      messages: [{ role: "user", content: "x" }],
    });
    expect(status).toBe(200);
    const frames = text
      .split("\n\n")
      .filter((frame) => frame.startsWith("data: "))
      .map((frame) => frame.slice(6));
    expect(frames.at(-1)).toBe("[DONE]");
    const payloads = frames.slice(0, -1).map((frame) => JSON.parse(frame));
    expect(payloads[0].choices[0].delta).toEqual({ role: "assistant" });
    expect(payloads[1].choices[0].delta).toEqual({ content: "OK." });
    expect(payloads[2].choices[0].finish_reason).toBe("stop");
    expect(payloads[2].usage.total_tokens).toBeGreaterThan(0);
  });

  it("lists both model ids and refuses unknown routes", async () => {
    fixture = await startScriptedModelServer();
    const models = await globalThis.fetch(`${fixture.baseUrl}/models`);
    expect((await models.json()).data.map((model) => model.id)).toEqual([
      ANSWERER_MODEL_ID,
      LEARNER_MODEL_ID,
    ]);
    const missing = await globalThis.fetch(`${fixture.baseUrl}/nope`);
    expect(missing.status).toBe(404);
  });
});
