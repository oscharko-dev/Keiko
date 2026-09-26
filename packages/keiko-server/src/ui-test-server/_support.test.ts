import { mkdtempSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildCspHeader } from "../csp.js";
import {
  buildRedactor,
  createInMemoryUiStore,
  createRunRegistry,
  QueueEventSink,
  type UiHandlerDeps,
} from "../index.js";
import { UI_HOST } from "../server.js";
import { closeUiTestServer, startUiTestServer, type StartedUiTestServer } from "./_support.js";

const roots: string[] = [];
const servers: StartedUiTestServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(({ server }) => closeUiTestServer(server)));
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

async function start(handlerDeps?: UiHandlerDeps): Promise<StartedUiTestServer> {
  const staticRoot = mkdtempSync(join(tmpdir(), "keiko-ui-test-server-"));
  roots.push(staticRoot);
  const started = await startUiTestServer({
    staticRoot,
    csp: buildCspHeader([]),
    ...(handlerDeps === undefined ? {} : { handlerDeps }),
  });
  servers.push(started);
  return started;
}

function minimalHandlerDeps(): UiHandlerDeps {
  return {
    config: undefined,
    configPresent: false,
    evidenceStore: { put: () => "", list: () => [], get: () => undefined, delete: () => undefined },
    env: {},
    redactor: buildRedactor({}),
    registry: createRunRegistry(),
    modelPortFactory: () => undefined,
    store: createInMemoryUiStore(),
  };
}

describe("UI test server lifecycle", () => {
  it("binds once and validates the exact OS-selected loopback authority", async () => {
    const started = await start();
    const accepted = await fetch(`http://${UI_HOST}:${String(started.port)}/api/health`);
    const forged = await fetch(`http://${UI_HOST}:${String(started.port)}/api/health`, {
      headers: { Origin: `http://${UI_HOST}:1` },
    });

    expect(accepted.status).toBe(200);
    expect(forged.status).toBe(403);
  });

  it("uses a fresh authority after a server that handled keep-alive traffic closes", async () => {
    const first = await start();
    expect((await fetch(`http://${UI_HOST}:${String(first.port)}/api/health`)).status).toBe(200);
    await closeUiTestServer(first.server);
    servers.splice(servers.indexOf(first), 1);

    const second = await start();
    expect(second.port).not.toBe(first.port);
    expect((await fetch(`http://${UI_HOST}:${String(second.port)}/api/health`)).status).toBe(200);
  });

  // #2902 audit thread 7: `closeUiTestServer` only called `server.close()`, which — per Node's own
  // `http.Server#close` contract — waits for every already-accepted, still-open connection to end on
  // its own before the callback fires. An SSE response never blocks on that when it is inert (a raw
  // idle TCP connect, or a fully-drained/ended response) — Node only holds `close()` open while a
  // response is genuinely mid-stream (headers sent, `res.end()` never called). A test that reads an
  // SSE stream's `ready` frame and then tears down without cancelling the client read leaves exactly
  // that: a still-open response the server is waiting on. Force-close is proven by racing the close
  // promise against a short timer: before the fix the timer always wins because nothing ever ends
  // the still-open response.
  it("force-closes a still-streaming SSE connection instead of leaving teardown pending", async () => {
    const runId = randomUUID();
    const handlerDeps = minimalHandlerDeps();
    handlerDeps.registry.register({
      runId,
      fingerprint: "fp-support-teardown",
      modelId: "test-model",
      sink: new QueueEventSink(),
      cancel: () => undefined,
    });
    const started = await start(handlerDeps);
    servers.splice(servers.indexOf(started), 1); // closed manually below, not by afterEach

    const response = await fetch(
      `http://${UI_HOST}:${String(started.port)}/api/runs/${runId}/events`,
    );
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error("expected a readable SSE response body");
    await reader.read(); // consume the `ready` frame so the response is genuinely streaming

    const TIMED_OUT = Symbol("timed-out");
    const outcome = await Promise.race([
      closeUiTestServer(started.server).then(() => "closed" as const),
      new Promise((resolve) => {
        setTimeout(() => {
          resolve(TIMED_OUT);
        }, 500);
      }),
    ]);

    expect(outcome).toBe("closed");
    await reader.cancel().catch(() => undefined);
  });
});
