import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { clearTimeout, setTimeout } from "node:timers";

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

// KEIKO-0406 diagnostic, body-free per AGENTS.md §7. Deliberately NOT error.message: V8's
// JSON.parse echoes a snippet of the input it choked on ("Unexpected token 'o', \"not-json\" is
// not valid JSON"), so logging the message would put request-body bytes — a credential in the
// wrong request — into the CI log. The error's TYPE plus the frame that threw carries the whole
// diagnostic this exists for: it separates "the client sent something malformed" from "this
// fixture has a bug" without reproducing anything the client sent (review finding on #3159).
// process.stderr.write rather than console.error: `console` is not a declared global for
// tests/e2e/fixtures/*.js, and widening that for one diagnostic line is the wrong trade.
function reportRequestFailure(error) {
  const kind = error instanceof Error ? error.constructor.name : typeof error;
  const frame =
    error instanceof Error && typeof error.stack === "string"
      ? (/\n\s*at\s+(.+)/u.exec(error.stack)?.[1] ?? "unknown site")
      : "unknown site";
  process.stderr.write(`[local-knowledge-e2e-server] request failed: ${kind} at ${frame}\n`);
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
  } catch (error) {
    // KEIKO-0406: a malformed body, an over-size rejection from readJsonBody and an internal bug in
    // handleEmbeddings/handleChat/vectorFor all collapse to the same cause-less 400. Without this
    // line a failing local-knowledge E2E run gives the operator no way to tell "the client sent
    // something bad" from "this fixture has a bug". See reportRequestFailure for what is and is
    // not written, and why.
    reportRequestFailure(error);
    if (!res.headersSent) jsonResponse(res, 400, { error: "invalid request" });
  }
}

// KEIKO-0999: name the offending env var and its observed value in the error message so a
// misconfigured invocation (`KEIKO_LK_E2E_MOCK_GATEWAY_PORT=abc node …`) tells the operator
// which variable to fix, rather than surfacing Node's generic ERR_SOCKET_BAD_PORT.
function resolveGatewayPort(raw) {
  if (raw === undefined) return DEFAULT_PORT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) {
    throw new Error(
      `KEIKO_LK_E2E_MOCK_GATEWAY_PORT must be an integer in [0, 65535]; received ${JSON.stringify(raw)}`,
    );
  }
  return parsed;
}
const port = resolveGatewayPort(process.env.KEIKO_LK_E2E_MOCK_GATEWAY_PORT);
const server = createServer((req, res) => {
  void handleRequest(req, res);
});
// KEIKO-0748: a bind failure (EADDRINUSE, EACCES) used to reach the top-level as an uncaught
// exception with no fixture context. Wire a one-shot 'error' listener before listen so a bind
// failure rejects the awaited promise with a message that names the port and the fixture.
await new Promise((resolve, reject) => {
  const onListenError = (listenError) => {
    reject(
      new Error(
        `local-knowledge-e2e-server: bind failed on 127.0.0.1:${String(port)} — ${listenError instanceof Error ? listenError.message : String(listenError)}`,
        { cause: listenError },
      ),
    );
  };
  server.once("error", onListenError);
  server.listen(port, "127.0.0.1", () => {
    server.off("error", onListenError);
    resolve();
  });
});

if (process.env.KEIKO_INITIAL_PROJECT_PATH !== undefined) {
  mkdirSync(process.env.KEIKO_INITIAL_PROJECT_PATH, { recursive: true });
}

const child = spawn(process.execPath, ["scripts/dev-runner.mjs"], {
  env: process.env,
  stdio: "inherit",
});

// KEIKO-0700: single-shot shutdown guard. The pre-fix code let both the signal handler and the
// child's 'exit' handler run their own close+exit sequences, so a signal received AFTER the
// child had already exited would call server.close() twice, double-count the exit code, and
// leak the idle keep-alive drain. Track the first path to run and short-circuit the second.
// closeAllConnections() before close() drops any idle keep-alive connection so an idle
// `curl --http1.1` client cannot delay process exit for the keep-alive timeout.
// The bounded grace before the fixture escalates its child to SIGKILL. Mirrors
// dev-runner.mjs's own shutdown pattern so this fixture cannot orphan the runner and its
// descendants — a fixture that exits first leaves child processes bound to their ports, the
// exact regression that scripts/dev-stop.mjs KEIKO-0734 hardened against.
const CHILD_SHUTDOWN_GRACE_MS = 5_000;
let shutdownStarted = false;
function waitForChildExit(timeoutMs) {
  return new Promise((resolveWait) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolveWait();
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeoutMs);
    timer.unref?.();
    child.once("exit", () => {
      clearTimeout(timer);
      resolveWait();
    });
  });
}
function shutdown(reason, exitCode) {
  if (shutdownStarted) return;
  shutdownStarted = true;
  const childDrained =
    reason === "signal"
      ? Promise.resolve(child.kill(exitCode.signal)).then(() =>
          waitForChildExit(CHILD_SHUTDOWN_GRACE_MS),
        )
      : Promise.resolve();
  server.closeAllConnections?.();
  server.close(() => {
    childDrained.finally(() => {
      if (reason === "child-exit" && exitCode.signal !== null) {
        process.kill(process.pid, exitCode.signal);
      }
      process.exit(exitCode.code);
    });
  });
}

process.on("SIGTERM", () => shutdown("signal", { signal: "SIGTERM", code: 0 }));
process.on("SIGINT", () => shutdown("signal", { signal: "SIGINT", code: 130 }));
child.on("exit", (code, signal) => shutdown("child-exit", { code: code ?? 1, signal }));
