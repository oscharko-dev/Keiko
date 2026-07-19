#!/usr/bin/env node

import { createServer } from "node:http";

const PORT = Number(process.env.KEIKO_E2E_MODEL_PORT ?? "32554");
const HOST = "127.0.0.1";
const REPLY_MARKER = "KEIKO_M1_CERT_STREAM_OK";
const REPLY_TOKENS = [REPLY_MARKER, " deterministic", " response."];

const CANDIDATES = [
  ["M1_GOVERNED_CAPTURE", "M1_GOVERNED_CAPTURE: The fixture uses a governed release cadence."],
  [
    "M1_SUPERVISED_CAPTURE",
    "M1_SUPERVISED_CAPTURE: The certified-supervised detail is a weekly release cadence.",
  ],
  [
    "M1_AUTONOMOUS_CAPTURE",
    "M1_AUTONOMOUS_CAPTURE: The fixture silently learns an autonomous release preference.",
  ],
  ["M1_VOICE_CAPTURE", "M1_VOICE_CAPTURE: The fixture uses voice-first release notes."],
  [
    "M1_REPEAT_CORRECTION",
    "M1_REPEAT_CORRECTION: The fixture repeated a correction to an existing release detail.",
  ],
  [
    "M1_FIRST_CORRECTION",
    "M1_FIRST_CORRECTION: The fixture supplied a first correction to a build detail.",
  ],
  ["M1_DISABLED_CAPTURE", "M1_DISABLED_CAPTURE: This candidate must remain disabled."],
];

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(""));
  });
}

function chunkFrame(delta, finishReason) {
  return `data: ${JSON.stringify({
    id: "chatcmpl-m1-cert",
    object: "chat.completion.chunk",
    created: 0,
    model: "e2e-chat-model",
    choices: [{ index: 0, delta, finish_reason: finishReason ?? null }],
  })}\n\n`;
}

function streamCompletion(res) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  res.write(chunkFrame({ role: "assistant", content: "" }));
  for (const token of REPLY_TOKENS) res.write(chunkFrame({ content: token }));
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

function salienceContent(rawRequest) {
  const match = CANDIDATES.find(([marker]) => rawRequest.includes(marker));
  if (match === undefined) return "[]";
  return JSON.stringify([
    {
      source: "user",
      body: match[1],
      type: "fact",
      confidence: 0.91,
      scope: "project",
      tags: ["m1-certification"],
    },
  ]);
}

function bufferedCompletion(res, rawRequest) {
  const body = {
    id: "chatcmpl-m1-cert",
    object: "chat.completion",
    created: 0,
    model: "e2e-chat-model",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: salienceContent(rawRequest) },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 },
  };
  res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
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
    let stream = false;
    try {
      stream = JSON.parse(raw || "{}").stream === true;
    } catch {
      stream = false;
    }
    if (stream) streamCompletion(res);
    else bufferedCompletion(res, raw);
  });
});

server.listen(PORT, HOST);

function shutdown() {
  server.close(() => process.exit(0));
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
