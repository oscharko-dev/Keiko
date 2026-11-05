// The model writer (#4208) against a fake OpenAI-compatible endpoint: no network, no provider SDK. It
// proves that the model never sees a fact, that every request is bounded and retried, that text which
// states a fact or breaks the marker contract never reaches the corpus, and that errors name a status
// or an error class and never echo a response body.
import { describe, expect, it } from "vitest";
import { validateBlueprint } from "../testing/memory-lab/corpus/blueprint.mjs";
import { CorpusError, generateScenario } from "../testing/memory-lab/corpus/generate.mjs";
import { createModelWriter, parseJsonArray } from "../testing/memory-lab/corpus/writer-model.mjs";
import { createRandom } from "../testing/memory-lab/corpus/random.mjs";
import { deriveOracle } from "../testing/memory-lab/corpus/oracle.mjs";
import { createCleanTester } from "../testing/memory-lab/corpus/realize.mjs";
import { FACT_MARKER } from "../testing/memory-lab/corpus/writer-port.mjs";
import { fixtureBlueprint } from "./support/memory-lab-corpus-fixture.mjs";

const ENDPOINT = "http://127.0.0.1:4000/v1";

function content(text) {
  return { status: 200, content: text };
}

// A well-behaved model: it answers each kind of request with generic text.
function wellBehaved(prompt) {
  const count = Number(/Write (\d+) /u.exec(prompt)?.[1] ?? 10);
  if (prompt.includes("independent exchanges"))
    return Array.from({ length: count }, (_, index) => ({
      user: `Could you outline step ${String(index)} of the rollout plan?`,
      assistant: `Here is an outline for step ${String(index)}.`,
    }));
  if (prompt.includes(FACT_MARKER))
    return Array.from(
      { length: count },
      (_, index) =>
        `Variant ${String(index)}: I am sorting my inbox today. ${FACT_MARKER} Could you suggest an order for the rest?`,
    );
  return Array.from({ length: count }, (_, index) => `Generic sentence number ${String(index)}.`);
}

function fakeEndpoint(respond = (prompt) => content(JSON.stringify(wellBehaved(prompt)))) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    const prompt = body.messages.at(-1).content;
    calls.push({ url, init, body, prompt });
    const reply = respond(prompt, calls.length);
    if (reply instanceof Error) throw reply;
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      json: async () => {
        if (reply.malformed) throw new SyntaxError("Unexpected token");
        return {
          choices: [
            {
              finish_reason: reply.finishReason,
              message: { content: reply.content, reasoning_content: reply.reasoning },
            },
          ],
        };
      },
    };
  };
  return { calls, fetchImpl };
}

function writerOver(endpoint, extra = {}) {
  return createModelWriter({
    endpoint: ENDPOINT,
    model: "lab-model",
    apiKey: "test-key-value",
    fetchImpl: endpoint.fetchImpl,
    sleep: async () => undefined,
    retryDelayMs: 0,
    ...extra,
  });
}

function generate(writer) {
  return generateScenario(validateBlueprint(fixtureBlueprint()), { size: 100, seed: 4, writer });
}

describe("model writer", () => {
  it("builds a valid scenario from a well-behaved model and never shows it a fact", async () => {
    const endpoint = fakeEndpoint();
    const { scenario } = await generate(writerOver(endpoint));
    expect(scenario.turns).toHaveLength(50);
    const fixture = fixtureBlueprint();
    const secrets = [
      ...fixture.facts.flatMap((fact) => [fact.seed, ...fact.terms.flat()]),
      ...fixture.traps.map((trap) => trap.text),
      "Harrowgate",
    ];
    for (const call of endpoint.calls) {
      const sent = JSON.stringify(call.body);
      for (const secret of secrets) expect(sent, secret).not.toContain(secret);
    }
    expect(endpoint.calls.length).toBeLessThan(40);
  });

  it("posts a bounded, authenticated, non-streaming chat request with a timeout", async () => {
    const endpoint = fakeEndpoint();
    await generate(writerOver(endpoint, { timeoutMs: 5000 }));
    const [first] = endpoint.calls;
    expect(first.url).toBe(`${ENDPOINT}/chat/completions`);
    expect(first.init.method).toBe("POST");
    expect(first.init.headers.authorization).toBe("Bearer test-key-value");
    expect(first.body).toMatchObject({ model: "lab-model", stream: false });
    expect(first.init.signal).toBeInstanceOf(globalThis.AbortSignal);
    for (const call of endpoint.calls) {
      expect(call.body.max_tokens).toBeGreaterThan(0);
      expect(call.body.max_tokens).toBeLessThanOrEqual(4096 + 8192);
      expect(call.body.messages[0].role).toBe("system");
    }
    const anonymous = fakeEndpoint();
    await generate(writerOver(anonymous, { apiKey: undefined }));
    expect(anonymous.calls[0].init.headers.authorization).toBeUndefined();
  });

  it("reserves reasoning tokens in addition to the answer budget (#4247)", async () => {
    const endpoint = fakeEndpoint();
    await writerOver(endpoint).exchanges({
      language: "en",
      role: "analyst",
      count: 3,
      random: createRandom(1),
      isClean: () => true,
    });
    expect(endpoint.calls[0].body.max_tokens).toBe(620 + 8192);
  });

  it("names an exhausted output budget with no answer without echoing reasoning (#4247)", async () => {
    const endpoint = fakeEndpoint(() => ({
      status: 200,
      content: "",
      finishReason: "length",
      reasoning: "PRIVATE REASONING",
    }));
    const failure = generate(writerOver(endpoint));
    await expect(failure).rejects.toThrow(/finish_reason=length.*no answer/u);
    await failure.catch((error) => expect(error.message).not.toContain("PRIVATE REASONING"));
    expect(endpoint.calls).toHaveLength(3);
  });

  it("accepts an endpoint that already names the completions route", async () => {
    const endpoint = fakeEndpoint();
    await generate(writerOver(endpoint, { endpoint: `${ENDPOINT}/chat/completions` }));
    expect(new Set(endpoint.calls.map((call) => call.url))).toEqual(
      new Set([`${ENDPOINT}/chat/completions`]),
    );
    const trailing = fakeEndpoint();
    await generate(writerOver(trailing, { endpoint: `${ENDPOINT}//` }));
    expect(trailing.calls[0].url).toBe(`${ENDPOINT}/chat/completions`);
  });

  it("requests the shortfall again when exchanges state a fact", async () => {
    let first = true;
    const endpoint = fakeEndpoint((prompt) => {
      const items = wellBehaved(prompt);
      if (prompt.includes("independent exchanges") && first) {
        first = false;
        items[0] = { user: "I prefer line charts for my reports.", assistant: "Understood." };
        items[1] = { user: "Fine.", assistant: "I am a senior analyst, so yes." };
      }
      return content(JSON.stringify(items));
    });
    const writer = writerOver(endpoint);
    const exchanges = await writer.exchanges({
      language: "en",
      role: "analyst",
      count: 10,
      random: createRandom(1),
      isClean: (text) => !/line chart|senior analyst/u.test(text),
    });
    expect(exchanges).toHaveLength(10);
    expect(
      exchanges.every((item) => !/line chart|senior analyst/u.test(item.user + item.assistant)),
    ).toBe(true);
    expect(
      endpoint.calls.filter((call) => call.prompt.includes("independent exchanges")),
    ).toHaveLength(2);
  });

  it("samples paragraphs and sentences from a pool requested once", async () => {
    const endpoint = fakeEndpoint();
    const writer = writerOver(endpoint);
    const base = {
      language: "en",
      role: "analyst",
      random: createRandom(1),
      isClean: () => true,
    };
    const first = await writer.paragraph({ ...base, hardness: "embedded" });
    const second = await writer.paragraph({ ...base, hardness: "embedded" });
    expect(first).toContain(FACT_MARKER);
    expect(second).toContain(FACT_MARKER);
    await writer.sentence({ ...base, kind: "ack" });
    await writer.sentence({ ...base, kind: "ack" });
    await writer.sentence({ ...base, kind: "lead-answer" });
    expect(endpoint.calls).toHaveLength(3);
  });

  it("drops paragraphs without exactly one marker and pooled text that states a fact", async () => {
    const endpoint = fakeEndpoint(() =>
      content(
        JSON.stringify([
          "No marker here at all.",
          `Two ${FACT_MARKER} markers ${FACT_MARKER} here.`,
          `Fine ${FACT_MARKER} paragraph one.`,
          `Fine ${FACT_MARKER} but it says line charts.`,
          42,
        ]),
      ),
    );
    const writer = writerOver(endpoint);
    const request = {
      language: "en",
      role: "analyst",
      hardness: "embedded",
      random: createRandom(1),
      isClean: (text) => !text.includes("line chart"),
    };
    expect(await writer.paragraph(request)).toBe(`Fine ${FACT_MARKER} paragraph one.`);
    const other = { ...request, isClean: (text) => text.includes("line chart") };
    expect(await writer.paragraph(other)).toBe(`Fine ${FACT_MARKER} but it says line charts.`);
    const none = { ...request, isClean: () => false };
    await expect(writer.paragraph(none)).rejects.toThrow(/states a fact of the blueprint/u);
  });

  it("reads a JSON array out of a fenced or chatty answer", () => {
    expect(parseJsonArray('```json\n["a", "b"]\n```')).toEqual(["a", "b"]);
    expect(parseJsonArray('Sure! Here you go: ["a"] Hope that helps.')).toEqual(["a"]);
    expect(parseJsonArray("no array here")).toBeUndefined();
    expect(parseJsonArray("[not json]")).toBeUndefined();
    expect(parseJsonArray('{"items": 1}')).toBeUndefined();
  });
});

describe("model writer failures", () => {
  it("retries a transient failure and then succeeds", async () => {
    const endpoint = fakeEndpoint((prompt, call) =>
      call <= 2 ? { status: 503, content: "" } : content(JSON.stringify(wellBehaved(prompt))),
    );
    await expect(generate(writerOver(endpoint))).resolves.toBeDefined();
    expect(endpoint.calls.length).toBeGreaterThan(3);
  });

  it("gives up after the bounded attempts and names the status, not the body", async () => {
    const endpoint = fakeEndpoint(() => ({ status: 503, content: "SECRET BODY of the provider" }));
    const failure = generate(writerOver(endpoint, { maxAttempts: 3 }));
    await expect(failure).rejects.toThrow(CorpusError);
    await expect(
      generate(writerOver(fakeEndpoint(() => ({ status: 503, content: "x" })))),
    ).rejects.toThrow(/failed after 3 attempts: HTTP 503/u);
    expect(endpoint.calls).toHaveLength(3);
    await failure.catch((error) => {
      expect(error.message).not.toContain("SECRET");
      expect(JSON.stringify(error.cause?.message ?? "")).not.toContain("SECRET");
    });
  });

  it("does not retry a refusal such as an invalid key", async () => {
    const endpoint = fakeEndpoint(() => ({ status: 401, content: "no" }));
    await expect(generate(writerOver(endpoint))).rejects.toThrow(
      /refused the request \(HTTP 401\)/u,
    );
    expect(endpoint.calls).toHaveLength(1);
  });

  it("retries a network error and a timeout, and reports the error class", async () => {
    const timeout = Object.assign(new Error("The operation was aborted due to timeout"), {
      name: "TimeoutError",
    });
    const flaky = fakeEndpoint((prompt, call) =>
      call === 1 ? timeout : content(JSON.stringify(wellBehaved(prompt))),
    );
    await expect(generate(writerOver(flaky))).resolves.toBeDefined();
    const broken = fakeEndpoint(() => new TypeError("fetch failed"));
    await expect(generate(writerOver(broken))).rejects.toThrow(/the request failed \(TypeError\)/u);
  });

  it("asks again when the answer is not JSON or holds no usable item", async () => {
    const malformed = fakeEndpoint(() => ({ status: 200, malformed: true }));
    await expect(generate(writerOver(malformed))).rejects.toThrow(/response was not JSON/u);
    const empty = fakeEndpoint(() => content("I cannot help with that."));
    await expect(generate(writerOver(empty))).rejects.toThrow(/returned no usable items/u);
    expect(empty.calls).toHaveLength(3);
    const noMessage = fakeEndpoint(() => ({ status: 200, content: undefined }));
    await expect(generate(writerOver(noMessage))).rejects.toThrow(/held no message/u);
  });

  it.each([
    ["blueprint-fact", "I prefer line charts for my reports."],
    ["memory-command", "Remember this for later."],
    ["reserved-marker", "Use [[PRIVATE MARKER]] please."],
    ["forbidden-value", "Contact me at reader@outside.net."],
  ])("names the %s filter refusal without echoing text (#4247)", async (kind, text) => {
    const endpoint = fakeEndpoint(() =>
      content(JSON.stringify([{ user: text, assistant: "Understood." }])),
    );
    const isClean = createCleanTester(deriveOracle(validateBlueprint(fixtureBlueprint())));
    const failure = writerOver(endpoint).exchanges({
      language: "en",
      role: "analyst",
      count: 3,
      random: createRandom(1),
      isClean,
      refusalClass: isClean.refusalClass,
    });
    await expect(failure).rejects.toThrow(new RegExp(`${kind}=3`, "u"));
    await failure.catch((error) => expect(error.message).not.toContain(text));
  });

  it("stops when the model writes exchanges that all state a fact", async () => {
    const endpoint = fakeEndpoint((prompt) =>
      content(
        JSON.stringify(
          wellBehaved(prompt).map((item) =>
            typeof item === "object"
              ? { user: "I prefer line charts for everything.", assistant: "Sure." }
              : item,
          ),
        ),
      ),
    );
    await expect(generate(writerOver(endpoint))).rejects.toThrow(/returned no usable items/u);
  });

  it("stops when the model keeps writing mostly unusable exchanges", async () => {
    const endpoint = fakeEndpoint((prompt) =>
      content(
        JSON.stringify(
          wellBehaved(prompt).map((item, index) =>
            typeof item === "object" && index > 0
              ? { user: "I prefer line charts for everything.", assistant: "Sure." }
              : item,
          ),
        ),
      ),
    );
    await expect(generate(writerOver(endpoint))).rejects.toThrow(
      /did not return enough clean exchanges/u,
    );
  });
});
