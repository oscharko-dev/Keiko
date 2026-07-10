import { describe, expect, it } from "vitest";
import {
  EDITOR_AGENT_SCHEMA_VERSION,
  type EditorAgentAction,
  type EditorAgentSessionSnapshot,
} from "@oscharko-dev/keiko-contracts";
import {
  createFetchEditorAgentHttpTransport,
  EditorAgentHttpClient,
  type EditorAgentHttpTransport,
  type EditorAgentHttpTransportRequest,
  type EditorAgentTimeoutScheduler,
} from "./editor-agent-client.js";

const encoder = new TextEncoder();
const HASH = "a".repeat(64);
const ACTION: EditorAgentAction = {
  schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
  actionId: "action-1",
  idempotencyKey: "idempotency-1",
  sessionId: "session-1",
  type: "openFile",
};

function transportWith(
  body: string,
  overrides: Partial<{
    readonly status: number;
    readonly redirected: boolean;
    readonly url: string;
  }> = {},
): EditorAgentHttpTransport {
  return {
    request: (request) =>
      Promise.resolve({
        status: overrides.status ?? 200,
        body: encoder.encode(body),
        url: overrides.url ?? request.url,
        redirected: overrides.redirected ?? false,
      }),
  };
}

function client(transport: EditorAgentHttpTransport): EditorAgentHttpClient {
  return new EditorAgentHttpClient({ baseUrl: "http://127.0.0.1:1983", transport });
}

function sessionSnapshot(): EditorAgentSessionSnapshot {
  return {
    schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
    sessionId: "session-1",
    windowId: "window-1",
    workspaceRoot: "/repo",
    activePaneId: "pane-1",
    panes: [{ paneId: "pane-1", activeFile: "src/a.ts", openFiles: ["src/a.ts"] }],
    dirtyFiles: [],
    activeFile: "src/a.ts",
    cursor: null,
    selection: null,
    diagnosticsSummary: null,
    textMode: "activeFile",
    text: "const value = 1;\n",
    activeFileContentHash: HASH,
    updatedAt: 1,
  };
}

function fetchReturning(
  response: Response,
  observe?: (init: RequestInit | undefined) => void,
): typeof fetch {
  return (_input, init): Promise<Response> => {
    observe?.(init);
    return Promise.resolve(response.clone());
  };
}

function streamingResponse(chunks: readonly string[]): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller): void {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
  );
}

describe("EditorAgentHttpClient", () => {
  it.each([
    "not-a-url",
    "https://127.0.0.1:1983",
    "http://0.0.0.0:1983",
    "http://example.com:1983",
    "http://localhost.example.com:1983",
    "http://user:secret@localhost:1983",
    "http://localhost:1983/prefix",
    "http://localhost:1983/?token=secret",
  ])("rejects hostile or ambient-authority base URL %s", (baseUrl) => {
    expect(() => new EditorAgentHttpClient({ baseUrl, transport: transportWith("{}") })).toThrow(
      "loopback HTTP origin",
    );
  });

  it.each(["http://127.0.0.1:1983", "http://localhost:1983/", "http://[::1]:1983"])(
    "accepts loopback HTTP origin %s",
    (baseUrl) => {
      expect(
        () => new EditorAgentHttpClient({ baseUrl, transport: transportWith("{}") }),
      ).not.toThrow();
    },
  );

  it.each([
    { timeoutMs: 0, maxResponseBytes: 1 },
    { timeoutMs: 1, maxResponseBytes: 0 },
    { timeoutMs: 1.5, maxResponseBytes: 1 },
  ])("rejects invalid HTTP bounds %#", ({ timeoutMs, maxResponseBytes }) => {
    expect(
      () =>
        new EditorAgentHttpClient({
          baseUrl: "http://localhost:1983",
          transport: transportWith("{}"),
          timeoutMs,
          maxResponseBytes,
        }),
    ).toThrow("HTTP bounds must be positive");
  });

  it("adds the BFF mutation guard only to POST requests", async () => {
    const seen: (RequestInit | undefined)[] = [];
    const transport = createFetchEditorAgentHttpTransport(
      fetchReturning(new Response('{"snapshot":null}'), (init) => seen.push(init)),
    );
    const controller = new AbortController();
    await transport.request({
      method: "GET",
      url: "http://127.0.0.1:1983/api/editor/agent/sessions",
      signal: controller.signal,
      maxResponseBytes: 64,
    });
    await transport.request({
      method: "POST",
      url: "http://127.0.0.1:1983/api/editor/agent/snapshot",
      body: "{}",
      signal: controller.signal,
      maxResponseBytes: 64,
    });
    const getHeaders = new Headers(seen[0]?.headers);
    const postHeaders = new Headers(seen[1]?.headers);
    expect(getHeaders.get("X-Keiko-CSRF")).toBeNull();
    expect(getHeaders.get("content-type")).toBeNull();
    expect(postHeaders.get("X-Keiko-CSRF")).toBe("1");
    expect(postHeaders.get("content-type")).toBe("application/json");
    expect(seen[1]).toMatchObject({ method: "POST", body: "{}", redirect: "manual" });
  });

  it("reads a streamed response within the configured cap", async () => {
    const transport = createFetchEditorAgentHttpTransport(
      fetchReturning(streamingResponse(['{"sessions":', "[]}"])),
    );
    const result = await client(transport).listSessions(new AbortController().signal);
    expect(result).toEqual({ ok: true, value: { sessions: [] } });
  });

  it("reports an oversized streamed fetch response without leaking its body", async () => {
    const transport = createFetchEditorAgentHttpTransport(
      fetchReturning(streamingResponse(["SECRET", "_VALUE"])),
    );
    const result = await new EditorAgentHttpClient({
      baseUrl: "http://localhost:1983",
      transport,
      maxResponseBytes: 6,
    }).listSessions(new AbortController().signal);
    expect(result).toMatchObject({ ok: false, error: { code: "RESPONSE_TOO_LARGE" } });
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });

  it("accepts an empty fetch response body at the transport boundary", async () => {
    const transport = createFetchEditorAgentHttpTransport(fetchReturning(new Response(null)));
    const response = await transport.request({
      method: "GET",
      url: "http://localhost:1983/api/editor/agent/sessions",
      signal: new AbortController().signal,
      maxResponseBytes: 1,
    });
    expect(response.body).toEqual(new Uint8Array());
  });

  it("forbids redirect responses without following them", async () => {
    const result = await client(
      transportWith("", {
        status: 302,
        redirected: false,
      }),
    ).listSessions(new AbortController().signal);
    expect(result).toMatchObject({ ok: false, error: { code: "REDIRECT_BLOCKED" } });
  });

  it("forbids a transport-reported redirected final URL", async () => {
    const result = await client(
      transportWith("{}", {
        redirected: true,
        url: "http://localhost:1983/api/editor/agent/sessions",
      }),
    ).listSessions(new AbortController().signal);
    expect(result).toMatchObject({ ok: false, error: { code: "REDIRECT_BLOCKED" } });
  });

  it("forbids a response URL that differs from the fixed request URL", async () => {
    const result = await client(
      transportWith("{}", {
        url: "http://localhost:1983/api/editor/agent/sessions?redirected=1",
      }),
    ).listSessions(new AbortController().signal);
    expect(result).toMatchObject({ ok: false, error: { code: "REDIRECT_BLOCKED" } });
  });

  it("settles an uncooperative transport at the injected timeout without sleeping", async () => {
    const scheduler: EditorAgentTimeoutScheduler = {
      set: (callback) => {
        callback();
        return "timeout";
      },
      clear: () => undefined,
    };
    const transport: EditorAgentHttpTransport = {
      request: () => new Promise(() => undefined),
    };
    const result = await new EditorAgentHttpClient({
      baseUrl: "http://localhost:1983",
      transport,
      scheduler,
    }).listSessions(new AbortController().signal);
    expect(result).toMatchObject({ ok: false, error: { code: "TIMED_OUT" } });
  });

  it("cancels an uncooperative transport when the caller is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const transport: EditorAgentHttpTransport = {
      request: () => new Promise(() => undefined),
    };
    const result = await client(transport).listSessions(controller.signal);
    expect(result).toMatchObject({ ok: false, error: { kind: "cancelled", code: "CANCELLED" } });
  });

  it("maps a transport rejection caused by caller cancellation to cancelled", async () => {
    const controller = new AbortController();
    const transport: EditorAgentHttpTransport = {
      request: () => {
        controller.abort();
        return Promise.reject(new Error("abort detail"));
      },
    };
    const result = await client(transport).listSessions(controller.signal);
    expect(result).toMatchObject({ ok: false, error: { kind: "cancelled", code: "CANCELLED" } });
  });

  it("maps transport exceptions to a redacted stable failure", async () => {
    const transport: EditorAgentHttpTransport = {
      request: () => Promise.reject(new Error("SECRET transport detail")),
    };
    const result = await client(transport).listSessions(new AbortController().signal);
    expect(result).toEqual({
      ok: false,
      error: {
        kind: "transport",
        code: "TRANSPORT_FAILURE",
        message: "The editor agent route was unavailable.",
      },
    });
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });

  it("rejects oversized bodies even when an injected transport ignores the cap", async () => {
    const result = await new EditorAgentHttpClient({
      baseUrl: "http://localhost:1983",
      transport: transportWith(JSON.stringify({ sessions: [], padding: "x".repeat(200) })),
      maxResponseBytes: 64,
    }).listSessions(new AbortController().signal);
    expect(result).toMatchObject({ ok: false, error: { code: "RESPONSE_TOO_LARGE" } });
  });

  it("returns a bounded redacted malformed-response error", async () => {
    const result = await client(transportWith("not-json SECRET_VALUE")).listSessions(
      new AbortController().signal,
    );
    expect(result).toEqual({
      ok: false,
      error: {
        kind: "malformed-response",
        code: "MALFORMED_RESPONSE",
        message: "The editor agent route returned an invalid response.",
      },
    });
    expect(JSON.stringify(result)).not.toContain("SECRET_VALUE");
  });

  it("sends only the fixed sessions route and propagates the response cap", async () => {
    let seen: EditorAgentHttpTransportRequest | undefined;
    const transport: EditorAgentHttpTransport = {
      request: (request) => {
        seen = request;
        return Promise.resolve({
          status: 200,
          body: encoder.encode('{"sessions":[]}'),
          url: request.url,
          redirected: false,
        });
      },
    };
    const result = await client(transport).listSessions(new AbortController().signal);
    expect(result).toEqual({ ok: true, value: { sessions: [] } });
    expect(seen).toMatchObject({
      method: "GET",
      url: "http://127.0.0.1:1983/api/editor/agent/sessions",
    });
    expect(seen?.body).toBeUndefined();
    expect(seen?.maxResponseBytes).toBeGreaterThan(0);
  });

  it("redacts route error bodies while retaining the stable route code", async () => {
    const result = await client(
      transportWith(
        JSON.stringify({ error: { code: "INVALID_REQUEST", message: "SECRET route detail" } }),
        { status: 400 },
      ),
    ).snapshot(
      { schemaVersion: EDITOR_AGENT_SCHEMA_VERSION, textMode: "none" },
      new AbortController().signal,
    );
    expect(result).toMatchObject({
      ok: false,
      error: { kind: "route", code: "INVALID_REQUEST", status: 400 },
    });
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });

  it.each([
    "null",
    "{}",
    '{"error":{}}',
    '{"error":{"code":""}}',
    `{"error":{"code":"${"x".repeat(129)}"}}`,
  ])("rejects malformed route errors without reflecting their body %#", async (body) => {
    const result = await client(transportWith(body, { status: 400 })).snapshot(
      { schemaVersion: EDITOR_AGENT_SCHEMA_VERSION, textMode: "none" },
      new AbortController().signal,
    );
    expect(result).toMatchObject({ ok: false, error: { code: "MALFORMED_RESPONSE" } });
  });

  it.each(["null", "{}", '{"sessions":{}}', '{"sessions":[{}]}'])(
    "rejects malformed session collections %#",
    async (body) => {
      const result = await client(transportWith(body)).listSessions(new AbortController().signal);
      expect(result).toMatchObject({ ok: false, error: { code: "MALFORMED_RESPONSE" } });
    },
  );

  it("accepts an explicitly empty active-session snapshot", async () => {
    const result = await client(transportWith('{"snapshot":null}')).snapshot(
      { schemaVersion: EDITOR_AGENT_SCHEMA_VERSION, textMode: "none" },
      new AbortController().signal,
    );
    expect(result).toEqual({ ok: true, value: { snapshot: null } });
  });

  it("accepts a valid bounded active-session snapshot", async () => {
    const snapshot = sessionSnapshot();
    const result = await client(transportWith(JSON.stringify({ snapshot }))).snapshot(
      { schemaVersion: EDITOR_AGENT_SCHEMA_VERSION, textMode: "activeFile" },
      new AbortController().signal,
    );
    expect(result).toEqual({ ok: true, value: { snapshot } });
  });

  it.each(["null", "{}", '{"snapshot":{}}'])(
    "rejects malformed session snapshots %#",
    async (body) => {
      const result = await client(transportWith(body)).snapshot(
        { schemaVersion: EDITOR_AGENT_SCHEMA_VERSION, textMode: "none" },
        new AbortController().signal,
      );
      expect(result).toMatchObject({ ok: false, error: { code: "MALFORMED_RESPONSE" } });
    },
  );

  it("accepts a terminal action result without optional diagnostic fields", async () => {
    const result = await client(
      transportWith(
        JSON.stringify({
          result: {
            schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
            actionId: ACTION.actionId,
            sessionId: ACTION.sessionId,
            status: "succeeded",
          },
        }),
      ),
    ).action(ACTION, new AbortController().signal);
    expect(result).toEqual({
      ok: true,
      value: {
        result: {
          schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
          actionId: ACTION.actionId,
          sessionId: ACTION.sessionId,
          status: "succeeded",
        },
      },
    });
  });

  it("accepts a terminal file result without optional diagnostic fields", async () => {
    const result = await client(
      transportWith(
        JSON.stringify({
          result: {
            schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
            actionId: ACTION.actionId,
            sessionId: ACTION.sessionId,
            status: "succeeded",
            files: [{ file: "src/a.ts", status: "succeeded" }],
          },
        }),
      ),
    ).action(ACTION, new AbortController().signal);
    expect(result).toMatchObject({
      ok: true,
      value: { result: { files: [{ file: "src/a.ts", status: "succeeded" }] } },
    });
  });

  it.each([
    "null",
    '{"result":"SECRET"}',
    '{"result":{"message":42,"conflict":42,"failure":42,"files":42}}',
    '{"result":{"files":[null]}}',
    '{"result":{"conflict":{"code":42,"message":42,"file":"src/a.ts"}}}',
    '{"result":{"files":[{"message":42,"conflict":{}}]}}',
  ])("rejects malformed action results after redaction %#", async (body) => {
    const result = await client(transportWith(body)).action(ACTION, new AbortController().signal);
    expect(result).toMatchObject({ ok: false, error: { code: "MALFORMED_RESPONSE" } });
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });

  it("bounds and redacts every conflict message returned by the route", async () => {
    const routeMessage = `SECRET_VALUE ${"x".repeat(4_096)}`;
    const result = await client(
      transportWith(
        JSON.stringify({
          result: {
            schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
            actionId: ACTION.actionId,
            sessionId: ACTION.sessionId,
            status: "conflict",
            message: routeMessage,
            conflict: { code: "DIRTY", message: routeMessage },
            files: [
              {
                file: "src/a.ts",
                status: "conflict",
                message: routeMessage,
                conflict: { code: "DIRTY", message: routeMessage, file: "src/a.ts" },
              },
            ],
          },
        }),
        { status: 409 },
      ),
    ).action(ACTION, new AbortController().signal);
    expect(result).toMatchObject({
      ok: true,
      value: {
        result: {
          message: "Editor agent route detail redacted.",
          conflict: { code: "DIRTY", message: "Editor agent route detail redacted." },
          files: [
            {
              message: "Editor agent route detail redacted.",
              conflict: { code: "DIRTY", message: "Editor agent route detail redacted." },
            },
          ],
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain("SECRET_VALUE");
    expect(JSON.stringify(result).length).toBeLessThan(1_024);
  });

  it("bounds and redacts lifecycle failure messages returned by the route", async () => {
    const result = await client(
      transportWith(
        JSON.stringify({
          result: {
            schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
            actionId: ACTION.actionId,
            sessionId: ACTION.sessionId,
            status: "failed",
            failure: { code: "QUEUE_FULL", message: `SECRET_VALUE ${"x".repeat(4_096)}` },
          },
        }),
        { status: 429 },
      ),
    ).action(ACTION, new AbortController().signal);
    expect(result).toMatchObject({
      ok: true,
      value: {
        result: {
          status: "failed",
          failure: { code: "QUEUE_FULL", message: "Editor agent route detail redacted." },
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain("SECRET_VALUE");
    expect(JSON.stringify(result).length).toBeLessThan(512);
  });
});
