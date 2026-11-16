#!/usr/bin/env node

import { createServer } from "node:http";

import { isSalienceRequest, readBody, salienceReply } from "./salience-model-mock.mjs";

const PORT = Number(process.env.KEIKO_E2E_MODEL_PORT ?? "32554");
const HOST = "127.0.0.1";
const REPLY_MARKER = "KEIKO_M1_CERT_STREAM_OK";
const REPLY_TOKENS = [REPLY_MARKER, " deterministic", " response."];
const REPLY_TEXT = REPLY_TOKENS.join("");

// The markers whose turns this mock extracts (see salienceReply).
const CANDIDATE_MARKERS = [
  "M1_GOVERNED_CAPTURE",
  "M1_SUPERVISED_CAPTURE",
  "M1_AUTONOMOUS_CAPTURE",
  "M1_VOICE_CAPTURE",
  "M1_REPEAT_CORRECTION",
  "M1_FIRST_CORRECTION",
  "M1_DISABLED_CAPTURE",
  // #4206: proposed as facts so that the product, not the model, refuses them.
  "M1_DENIED_HEALTH",
  "M1_DENIED_THIRD_PARTY",
  "M1_DENIED_CONFIDENTIAL",
  "M1_DENIED_IBAN",
  "M1_DENIED_CUSTOMER",
];

function chunkFrame(delta, finishReason) {
  return `data: ${JSON.stringify({
    id: "chatcmpl-m1-cert",
    object: "chat.completion.chunk",
    created: 0,
    model: "e2e-chat-model",
    choices: [{ index: 0, delta, finish_reason: finishReason ?? null }],
  })}\n\n`;
}

// Code points per streamed delta of any answer other than the reply.
const STREAM_SLICE_LENGTH = 16;

// The answer as the deltas a provider streams: the reply keeps its fixed tokens, and any other
// answer arrives in fixed slices of code points, so the reader must reassemble it exactly.
function streamTokens(content) {
  if (content === REPLY_TEXT) return REPLY_TOKENS;
  const points = Array.from(content);
  const tokens = [];
  for (let index = 0; index < points.length; index += STREAM_SLICE_LENGTH) {
    tokens.push(points.slice(index, index + STREAM_SLICE_LENGTH).join(""));
  }
  return tokens;
}

// The gateway streams upstream for buffered calls too (ADR-0003), so the salience-extraction call
// arrives with `stream: true`. A stream answers the same content a buffered call would; one that
// always streamed the chat reply answered every extraction with prose that is not JSON (#4206).
function streamCompletion(res, content) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  res.write(chunkFrame({ role: "assistant", content: "" }));
  for (const token of streamTokens(content)) res.write(chunkFrame({ content: token }));
  res.write(
    `data: ${JSON.stringify({
      id: "chatcmpl-m1-cert",
      object: "chat.completion.chunk",
      created: 0,
      model: "e2e-chat-model",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 },
    })}\n\n`,
  );
  res.write("data: [DONE]\n\n");
  res.end();
}

function parseRequest(rawRequest) {
  let parsed;
  try {
    parsed = JSON.parse(rawRequest);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  if (!Array.isArray(parsed.messages)) return null;
  const messages = parsed.messages;
  if (
    !messages.every(
      (message) =>
        typeof message === "object" &&
        message !== null &&
        !Array.isArray(message) &&
        typeof message.role === "string" &&
        typeof message.content === "string",
    )
  ) {
    return null;
  }
  return { messages, stream: parsed.stream === true };
}

function completionContent(messages) {
  return isSalienceRequest(messages) ? salienceReply(messages, CANDIDATE_MARKERS) : REPLY_TEXT;
}

function bufferedCompletion(res, content) {
  const body = {
    id: "chatcmpl-m1-cert",
    object: "chat.completion",
    created: 0,
    model: "e2e-chat-model",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 },
  };
  res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function invalidRequest(res) {
  res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ error: "invalid fixture model request" }));
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${HOST}:${String(PORT)}`);
  if (req.method === "GET" && url.pathname === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }
  if (req.method !== "POST" || !url.pathname.endsWith("/chat/completions")) {
    res.writeHead(404).end();
    return;
  }
  void readBody(req).then((raw) => {
    const request = parseRequest(raw);
    if (request === null) {
      invalidRequest(res);
      return;
    }
    const content = completionContent(request.messages);
    if (request.stream) streamCompletion(res, content);
    else bufferedCompletion(res, content);
  });
});

server.listen(PORT, HOST);

function shutdown() {
  server.close(() => process.exit(0));
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
