import { describe, expect, it } from "vitest";
import { EDITOR_AGENT_SCHEMA_VERSION, type EditorAgentAction } from "@oscharko-dev/keiko-contracts";
import {
  EditorAgentHttpClient,
  type EditorAgentHttpTransport,
  type EditorAgentHttpTransportRequest,
  type EditorAgentTimeoutScheduler,
} from "./editor-agent-client.js";

const encoder = new TextEncoder();
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

describe("EditorAgentHttpClient", () => {
  it.each([
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
