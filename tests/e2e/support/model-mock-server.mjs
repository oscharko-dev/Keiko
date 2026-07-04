#!/usr/bin/env node
// GEN-TEST-RELEASE-GATE-002 / GEN-TEST-E2E-006 — deterministic local OpenAI-compatible model
// provider for the chat send/streaming release smoke.
//
// The e2e fixture (tests/e2e/fixtures/keiko.e2e.config.json) points the chat model at
// https://provider.invalid/v1 "so the smoke never calls the provider" — which is exactly why the
// central product flow (composer -> POST /api/desktop/chat/stream -> BFF -> gateway -> provider SSE
// -> streamed render -> persistence) had ZERO browser coverage. playwright.config.ts rewrites the
// runtime provider baseUrl to this loopback server (the gateway egress policy explicitly allows
// loopback; the config schema allows http:// for loopback hosts), so a real chat send exercises the
// whole path against a byte-deterministic answer instead of a real model.
//
// It speaks just enough of the OpenAI Chat Completions contract that keiko-model-gateway's
// openai-adapter accepts it: streaming emits `choices[0].delta.content` chunks + a final
// finish_reason/usage chunk + `data: [DONE]`; the buffered path returns a single completion.

import { createServer } from "node:http";

const PORT = Number(process.env.KEIKO_E2E_MODEL_PORT ?? "32186");
const HOST = "127.0.0.1";

// Byte-deterministic answer. The marker is asserted verbatim by chat-send.smoke.spec.ts, so a
// wiring regression (SSE framing dropped, gateway not dispatching, render not consuming deltas)
// changes what the browser shows and reddens the smoke.
const REPLY_MARKER = "KEIKO_E2E_STREAM_OK";
const REPLY_TOKENS = [REPLY_MARKER, " deterministic", " provider", " pong", " 4242."];
const REPLY_TEXT = REPLY_TOKENS.join("");

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(""));
  });
}

function chunkFrame(delta, finishReason) {
  const payload = {
    id: "chatcmpl-e2e",
    object: "chat.completion.chunk",
    created: 0,
    model: "e2e-chat-model",
    choices: [
      {
        index: 0,
        delta,
        finish_reason: finishReason ?? null,
      },
    ],
  };
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function streamCompletion(res) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  // Role announcement chunk, then one content delta per token (proves streaming, not one blob).
  res.write(chunkFrame({ role: "assistant", content: "" }));
  for (const token of REPLY_TOKENS) {
    res.write(chunkFrame({ content: token }));
  }
  // Terminal chunk: finish_reason + usage (adapter requests stream_options.include_usage).
  const usageFrame = {
    id: "chatcmpl-e2e",
    object: "chat.completion.chunk",
    created: 0,
    model: "e2e-chat-model",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: {
      prompt_tokens: 8,
      completion_tokens: REPLY_TOKENS.length,
      total_tokens: 8 + REPLY_TOKENS.length,
    },
  };
  res.write(`data: ${JSON.stringify(usageFrame)}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

function bufferedCompletion(res) {
  const body = {
    id: "chatcmpl-e2e",
    object: "chat.completion",
    created: 0,
    model: "e2e-chat-model",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: REPLY_TEXT },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 8,
      completion_tokens: REPLY_TOKENS.length,
      total_tokens: 8 + REPLY_TOKENS.length,
    },
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
  if (req.method === "POST" && url.pathname.endsWith("/chat/completions")) {
    void readBody(req).then((raw) => {
      let wantsStream = false;
      try {
        wantsStream = JSON.parse(raw || "{}").stream === true;
      } catch {
        // Malformed body → fall back to the buffered (non-stream) completion.
      }
      if (wantsStream) {
        streamCompletion(res);
      } else {
        bufferedCompletion(res);
      }
    });
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { message: "not found", type: "invalid_request_error" } }));
});

server.listen(PORT, HOST, () => {
  // webServer readiness signal for Playwright.
  console.log(`[e2e-model-mock] listening on http://${HOST}:${String(PORT)}`);
});
