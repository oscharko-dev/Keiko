import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createServer } from "node:http";

const DEFAULT_PORT = 42186;
const VECTOR_DIMENSIONS = 8;
const MAX_BODY_BYTES = 1_000_000;

function jsonResponse(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function vectorFor(input, index) {
  let seed = index + 17;
  for (let i = 0; i < input.length; i += 1) {
    seed = (seed * 31 + input.charCodeAt(i)) % 9973;
  }
  return Array.from({ length: VECTOR_DIMENSIONS }, (_, i) => ((seed + i * 53) % 1000) / 1000);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

async function handleEmbeddings(req, res) {
  const body = await readJsonBody(req);
  const rawInput = body.input;
  const inputs = Array.isArray(rawInput) ? rawInput : [rawInput];
  jsonResponse(res, 200, {
    object: "list",
    model: typeof body.model === "string" ? body.model : "e2e-embedding-model",
    data: inputs.map((input, index) => ({
      object: "embedding",
      index,
      embedding: vectorFor(String(input ?? ""), index),
    })),
    usage: { prompt_tokens: inputs.length, total_tokens: inputs.length },
  });
}

async function handleChat(req, res) {
  const body = await readJsonBody(req);
  jsonResponse(res, 200, {
    id: "chatcmpl-local-knowledge-e2e",
    object: "chat.completion",
    model: typeof body.model === "string" ? body.model : "e2e-chat-model",
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        message: { role: "assistant", content: "Local Knowledge E2E fixture response." },
      },
    ],
  });
}

async function handleRequest(req, res) {
  try {
    if (req.method === "GET" && req.url === "/v1/models") {
      jsonResponse(res, 200, {
        object: "list",
        data: [{ id: "e2e-chat-model" }, { id: "e2e-embedding-model" }],
      });
      return;
    }
    if (req.method === "POST" && req.url === "/v1/embeddings") {
      await handleEmbeddings(req, res);
      return;
    }
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      await handleChat(req, res);
      return;
    }
    jsonResponse(res, 404, { error: "not found" });
  } catch {
    if (!res.headersSent) jsonResponse(res, 400, { error: "invalid request" });
  }
}

const port = Number(process.env.KEIKO_LK_E2E_MOCK_GATEWAY_PORT ?? DEFAULT_PORT);
const server = createServer((req, res) => {
  void handleRequest(req, res);
});
await new Promise((resolve) => {
  server.listen(port, "127.0.0.1", resolve);
});

if (process.env.KEIKO_INITIAL_PROJECT_PATH !== undefined) {
  mkdirSync(process.env.KEIKO_INITIAL_PROJECT_PATH, { recursive: true });
}

const child = spawn(process.execPath, ["scripts/dev-runner.mjs"], {
  env: process.env,
  stdio: "inherit",
});

function shutdown(signal) {
  child.kill(signal);
  server.close(() => {
    process.exit(signal === "SIGTERM" ? 0 : 130);
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
child.on("exit", (code, signal) => {
  server.close(() => {
    if (signal !== null) process.kill(process.pid, signal);
    process.exit(code ?? 1);
  });
});
