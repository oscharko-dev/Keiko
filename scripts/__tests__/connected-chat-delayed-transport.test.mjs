// Real loopback producers exercise the paired lab client's headers, body and cancellation.
// The native dispatcher's header deadline is scaled down without replacing global fetch, so
// this reproduces its independent deadline through callJson rather than mocking a failure.
import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_RESPONSE_BYTES } from "../../packages/keiko-model-gateway/dist/http.js";
import { APP_SESSION_COOKIE_NAME } from "../../packages/keiko-server/dist/coding-app-session/sessionCookie.js";
import {
  CODING_APP_SESSION_LAUNCHER_SECRET_ENV,
  CODING_APP_SESSION_LAUNCHER_SECRET_MIN_CHARS,
} from "../../packages/keiko-contracts/dist/coding-app-session.js";
import { openApiSession } from "../testing/coding-workbench-lab/lab-common.mjs";

const SERVERS = [];
const RESTORE_DISPATCHERS = [];
const ENV = {
  [CODING_APP_SESSION_LAUNCHER_SECRET_ENV]: "s".repeat(
    CODING_APP_SESSION_LAUNCHER_SECRET_MIN_CHARS,
  ),
};

afterEach(async () => {
  while (RESTORE_DISPATCHERS.length > 0) RESTORE_DISPATCHERS.pop()();
  vi.unstubAllGlobals();
  for (const server of SERVERS.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

function scheduleResponse(response, delay, body) {
  const timer = globalThis.setTimeout(() => response.end(body), delay);
  response.once("close", () => globalThis.clearTimeout(timer));
}

async function producer(answer) {
  const seen = [];
  let received;
  const receipt = new Promise((resolve) => {
    received = resolve;
  });
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      if (request.url.endsWith("/pair")) {
        response.writeHead(204, {
          "set-cookie": `${APP_SESSION_COOKIE_NAME}=fixture; HttpOnly`,
        });
        response.end();
        return;
      }
      const closed = new Promise((resolve) => response.once("close", resolve));
      const observation = {
        path: request.url,
        method: request.method,
        headers: request.headers,
        body,
        closed,
      };
      seen.push(observation);
      received(observation);
      answer(response);
    });
  });
  SERVERS.push(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const session = await openApiSession(`http://127.0.0.1:${server.address().port}`, ENV);
  return { session, seen, receipt };
}

async function shrinkNativeHeaderDeadline() {
  await globalThis.fetch("data:text/plain,warmup");
  // Node's native fetch reads this dispatcher; its function identity stays native so the
  // gateway's production DNS-pinned transport selection is exercised without a fetch fake.
  const key = Symbol.for("undici.globalDispatcher.1");
  const original = globalThis[key];
  expect(original?.dispatch).toBeTypeOf("function");
  globalThis[key] = {
    dispatch(options, handler) {
      return original.dispatch({ ...options, headersTimeout: 100 }, handler);
    },
  };
  RESTORE_DISPATCHERS.push(() => {
    globalThis[key] = original;
  });
}

describe("connected-chat explicit transport deadline", () => {
  it("preserves the shared client's injected global fetch convention", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new globalThis.Response(null, {
          status: 204,
          headers: { "set-cookie": `${APP_SESSION_COOKIE_NAME}=fixture; HttpOnly` },
        }),
      )
      .mockResolvedValueOnce(globalThis.Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetch);
    const session = await openApiSession("http://127.0.0.1:1983", ENV);
    const result = await session.request(
      "POST",
      "/api/injected",
      { fixture: true },
      {
        timeoutMs: 1000,
      },
    );
    expect(result).toMatchObject({ status: 200, json: { ok: true } });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1][1]).toMatchObject({
      method: "POST",
      body: '{"fixture":true}',
      redirect: "manual",
      headers: { cookie: `${APP_SESSION_COOKIE_NAME}=fixture`, "x-keiko-csrf": "1" },
    });
  });

  it("receives an actual delayed answer beyond native fetch's header deadline", async () => {
    const { session, seen } = await producer((response) => {
      response.setHeader("x-keiko-correlation-id", "actual-delayed-answer");
      scheduleResponse(response, 2500, '{"ok":true}');
    });
    await shrinkNativeHeaderDeadline();
    await expect(
      session.request(
        "POST",
        "/api/delayed",
        { question: "fixture" },
        {
          signal: globalThis.AbortSignal.timeout(5000),
        },
      ),
    ).rejects.toMatchObject({ cause: { code: "UND_ERR_HEADERS_TIMEOUT" } });
    expect(seen).toHaveLength(1);
    await seen[0].closed;
    const result = await session.request(
      "POST",
      "/api/delayed",
      { question: "fixture" },
      {
        signal: globalThis.AbortSignal.timeout(5000),
        timeoutMs: 5000,
      },
    );
    expect(result).toEqual({
      status: 200,
      json: { ok: true },
      correlationId: "actual-delayed-answer",
    });
    expect(seen).toHaveLength(2);
    expect(seen[1]).toMatchObject({
      method: "POST",
      path: "/api/delayed",
      body: '{"question":"fixture"}',
    });
    expect(seen[1].headers).toMatchObject({
      "x-keiko-csrf": "1",
      "content-type": "application/json",
      cookie: `${APP_SESSION_COOKIE_NAME}=fixture`,
    });
  });

  it("applies the explicit deadline through a response body and closes the connection", async () => {
    const { session, receipt } = await producer((response) => {
      response.write('{"ok":');
      scheduleResponse(response, 2500, "true}");
    });
    const outcome = session.request("GET", "/api/delayed-body", undefined, { timeoutMs: 100 });
    await expect(outcome).rejects.toThrow();
    await (
      await receipt
    ).closed;
  });

  it("forwards caller cancellation after headers and closes the connection", async () => {
    const { session, receipt } = await producer((response) => {
      response.write('{"ok":');
      scheduleResponse(response, 2500, "true}");
    });
    const controller = new globalThis.AbortController();
    const outcome = session.request("GET", "/api/cancelled-body", undefined, {
      timeoutMs: 5000,
      signal: controller.signal,
    });
    const delivered = await receipt;
    controller.abort();
    await expect(outcome).rejects.toThrow();
    await delivered.closed;
  });

  it("retains the existing gateway response byte bound", async () => {
    const { session, receipt } = await producer((response) => {
      response.end("x".repeat(MAX_RESPONSE_BYTES + 1));
    });
    await expect(
      session.request("GET", "/api/oversized", undefined, {
        timeoutMs: 5000,
      }),
    ).rejects.toThrow("gateway response exceeded the size limit");
    await (
      await receipt
    ).closed;
  });
});
