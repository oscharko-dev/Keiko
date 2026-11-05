// The lab's scripted model: an OpenAI-compatible loopback server the Keiko instance is pointed at in
// offline mode (#4207). Two model ids share it. The answerer replies with a fixed "OK." during
// learning turns and, during probes, echoes exactly the memory bodies the product supplied in its
// prompt, so an offline answer measures retrieval and injection, never a model's own knowledge. The
// learner replies with whatever the scenario queued for the next extraction call, which is how the
// lab proves the pipeline with a correct learner and with deliberately broken ones.
import { createServer } from "node:http";
import { Buffer } from "node:buffer";

export const ANSWERER_MODEL_ID = "memory-lab-answerer";
export const LEARNER_MODEL_ID = "memory-lab-learner";
const ANSWER_MODES = Object.freeze(["ok", "echo"]);
const MEMORY_FENCE_START = "===UNTRUSTED_MEMORY_CONTEXT_START===";
const MEMORY_FENCE_END = "===UNTRUSTED_MEMORY_CONTEXT_END===";
const OK_ANSWER = "OK.";
const NO_MEMORY_ANSWER = "Ich weiss es nicht.";
const ECHO_PREFIX = "Erinnerungen: ";

/** Memory bodies the product placed inside its untrusted fence, in prompt order. */
export function memoryBodiesInPrompt(messages) {
  const text = messages
    .filter((message) => message.role === "user")
    .map((message) => (typeof message.content === "string" ? message.content : ""))
    .join("\n");
  const start = text.indexOf(MEMORY_FENCE_START);
  const end = text.indexOf(MEMORY_FENCE_END);
  if (start < 0 || end < start) return [];
  return text
    .slice(start + MEMORY_FENCE_START.length, end)
    .split("\n")
    .filter((line) => line.startsWith("- "))
    .map((line) =>
      line
        .slice(2)
        .replace(/^\(top signal: [^)]*\)\s*/u, "")
        .trim(),
    )
    .filter((line) => line.length > 0);
}

function tokenEstimate(text) {
  return Math.max(1, Math.ceil(text.length / 4));
}

function completionBody(model, content, promptChars) {
  return {
    id: "chatcmpl-memory-lab",
    object: "chat.completion",
    created: 0,
    model,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: {
      prompt_tokens: tokenEstimate("x".repeat(promptChars)),
      completion_tokens: tokenEstimate(content),
      total_tokens: tokenEstimate("x".repeat(promptChars)) + tokenEstimate(content),
    },
  };
}

function chunk(model, delta, finishReason, usage) {
  const payload = {
    id: "chatcmpl-memory-lab",
    object: "chat.completion.chunk",
    created: 0,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(usage === undefined ? {} : { usage }),
  };
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function writeStream(res, model, content, promptChars) {
  const usage = completionBody(model, content, promptChars).usage;
  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
  res.write(chunk(model, { role: "assistant" }, null));
  res.write(chunk(model, { content }, null));
  res.write(chunk(model, {}, "stop", usage));
  res.write("data: [DONE]\n\n");
  res.end();
}

function writeJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  for await (const piece of req) chunks.push(piece);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function promptChars(messages) {
  return messages.reduce(
    (sum, message) => sum + (typeof message.content === "string" ? message.content.length : 0),
    0,
  );
}

/**
 * Starts the scripted model on an ephemeral loopback port. The returned object is also usable as the
 * `proxy` of `startObservedBff`, so the instance's close tears the fixture down with the server.
 */
export async function startScriptedModelServer({ retainBodies = true } = {}) {
  const state = {
    answerMode: "ok",
    learnerQueue: [],
    requests: [],
    learnerCalls: 0,
    phase: "startup",
  };
  const server = createServer((req, res) => {
    void handle(req, res, state, retainBodies).catch((error) => {
      writeJson(res, 500, { error: { message: error.message } });
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  return {
    server,
    port,
    baseUrl: `http://127.0.0.1:${String(port)}/v1`,
    address: () => server.address(),
    close: (callback) => server.close(callback),
    closeAllConnections: () => server.closeAllConnections(),
    setAnswerMode(mode) {
      if (!ANSWER_MODES.includes(mode)) throw new RangeError(`unknown answer mode ${mode}`);
      state.answerMode = mode;
    },
    queueLearner(items) {
      state.learnerQueue.push(items);
    },
    clearLearner() {
      state.learnerQueue.length = 0;
    },
    setPhase(phase) {
      state.phase = phase;
    },
    requests: () => state.requests.slice(),
    learnerCalls: () => state.learnerCalls,
    pendingLearner: () => state.learnerQueue.length,
  };
}

async function handle(req, res, state, retainBodies) {
  if (req.method === "GET" && req.url === "/healthz") return writeJson(res, 200, { ok: true });
  if (req.method === "GET" && req.url === "/v1/models")
    return writeJson(res, 200, {
      object: "list",
      data: [ANSWERER_MODEL_ID, LEARNER_MODEL_ID].map((id) => ({ id, object: "model" })),
    });
  if (req.method !== "POST" || req.url !== "/v1/chat/completions")
    return writeJson(res, 404, { error: { message: "not found" } });
  const body = await readJson(req);
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const content = answerFor(body.model, messages, state);
  const chars = promptChars(messages);
  state.requests.push({ phase: state.phase, ...journalEntry(body, messages, chars, retainBodies) });
  if (body.stream === true) return writeStream(res, body.model, content, chars);
  return writeJson(res, 200, completionBody(body.model, content, chars));
}

function journalEntry(body, messages, chars, retainBodies) {
  const bodies = memoryBodiesInPrompt(messages);
  return {
    model: body.model,
    stream: body.stream === true,
    messageCount: messages.length,
    promptChars: chars,
    memoryCount: bodies.length,
    ...(retainBodies ? { memoryBodies: bodies } : {}),
  };
}

function answerFor(model, messages, state) {
  if (model === LEARNER_MODEL_ID) {
    state.learnerCalls += 1;
    const items = state.learnerQueue.shift() ?? [];
    return JSON.stringify({ items: items.map(learnerItem) });
  }
  if (state.answerMode === "ok") return OK_ANSWER;
  const bodies = memoryBodiesInPrompt(messages);
  return bodies.length === 0 ? NO_MEMORY_ANSWER : `${ECHO_PREFIX}${bodies.join(" | ")}`;
}

function learnerItem(item) {
  return {
    body: item.body,
    evidence: item.evidence ?? item.body,
    about: item.about ?? "self",
    type: item.type,
    relation: item.relation ?? "new",
    related: item.related ?? null,
  };
}
