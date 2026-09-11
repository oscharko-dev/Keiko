import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import type { CodingAppSessionChannelSnapshot } from "./channelContract.js";
import type { UiHandlerDeps } from "../deps.js";
import type { RouteContext, RouteResult } from "../routes.js";
import {
  createFakeSessionPairingPort,
  createStaticContentSource,
  fakePairingRequestBody,
} from "./_support.js";
import {
  handleCodingAppSessionChannelSnapshot,
  handleCodingAppSessionChannelStream,
  handleCodingAppSessionPair,
  handleCodingAppSessionRotate,
  handleCodingAppSessionSignOut,
  readPairingBody,
} from "./codingAppSessionRoutes.js";
import { createCodingAppSessionChannel, type CodingAppSessionChannel } from "./sessionChannel.js";
import { APP_SESSION_COOKIE_NAME } from "./sessionCookie.js";
import { createSessionRegistry } from "./sessionRegistry.js";
import { createBufferedServerLogSink, type ServerLogEvent } from "../observability/server-log.js";

const CANARY = { kind: "probe", body: "handler-canary" } as const;

function fakeReq(cookie?: string): IncomingMessage {
  return {
    headers: cookie === undefined ? {} : { cookie },
    socket: {},
    once: vi.fn(),
  } as unknown as IncomingMessage;
}

function ctx(cookie?: string): RouteContext {
  return {
    correlationId: undefined,
    req: fakeReq(cookie),
    res: {} as ServerResponse,
    params: {},
    url: new URL("http://127.0.0.1/"),
  };
}

function deps(channel?: CodingAppSessionChannel): UiHandlerDeps {
  return { codingAppSessionChannel: channel } as unknown as UiHandlerDeps;
}

function pairedChannel(): { channel: CodingAppSessionChannel; cookie: string } {
  const channel = createCodingAppSessionChannel({
    registry: createSessionRegistry(),
    pairingPort: createFakeSessionPairingPort(),
    contentSource: createStaticContentSource(CANARY),
  });
  const result = channel.pair(fakePairingRequestBody());
  if (!result.paired) throw new Error("pair failed");
  return { channel, cookie: `${APP_SESSION_COOKIE_NAME}=${result.cookieToken}` };
}

function snapshotOf(result: RouteResult): CodingAppSessionChannelSnapshot {
  return result.body as CodingAppSessionChannelSnapshot;
}

describe("app-session route handlers (fail-closed defensive branches)", () => {
  it("snapshot without a composed channel is content-free", () => {
    expect(snapshotOf(handleCodingAppSessionChannelSnapshot(ctx(), deps())).content).toBeNull();
  });

  it("snapshot with a paired cookie returns the bounded payload", () => {
    const { channel, cookie } = pairedChannel();
    const result = handleCodingAppSessionChannelSnapshot(ctx(cookie), deps(channel));
    expect(snapshotOf(result).content).toEqual(CANARY);
  });

  it("snapshot with an unknown cookie is content-free", () => {
    const { channel } = pairedChannel();
    const result = handleCodingAppSessionChannelSnapshot(
      ctx(`${APP_SESSION_COOKIE_NAME}=sess_000000000000000000000000.forged`),
      deps(channel),
    );
    expect(snapshotOf(result).content).toBeNull();
  });

  it("pair without a composed channel acknowledges without issuing a cookie", async () => {
    const result = await handleCodingAppSessionPair(ctx(), deps());
    expect(result.headers).toBeUndefined();
  });

  it("rotate without a composed channel acknowledges without a cookie", () => {
    expect(handleCodingAppSessionRotate(ctx(), deps()).headers).toBeUndefined();
  });

  it("rotate with a paired cookie re-issues a cookie", () => {
    const { channel, cookie } = pairedChannel();
    const setCookie = handleCodingAppSessionRotate(ctx(cookie), deps(channel)).headers?.[
      "Set-Cookie"
    ];
    expect(setCookie).toHaveLength(11);
    expect(String(setCookie)).toContain("Path=/api/task-workspaces;");
    expect(String(setCookie)).toContain(APP_SESSION_COOKIE_NAME);
    expect(String(setCookie)).toContain("Path=/api/coding-workbench");
    expect(String(setCookie)).toContain("Path=/api/git");
    expect(String(setCookie)).toContain("Path=/api/files");
    expect(String(setCookie)).toContain("Path=/api/editor");
    expect(String(setCookie)).toContain("Path=/api/editor/local-history");
    expect(String(setCookie)).toContain("Path=/api/runtime");
    expect(String(setCookie)).toContain("Path=/api/runs");
    expect(String(setCookie)).toContain("Path=/api/workspaces");
    expect(String(setCookie)).toContain("HttpOnly");
  });

  it("sign-out clears the cookie and revokes the session", () => {
    const { channel, cookie } = pairedChannel();
    const setCookie = handleCodingAppSessionSignOut(ctx(cookie), deps(channel)).headers?.[
      "Set-Cookie"
    ];
    expect(setCookie).toHaveLength(11);
    expect(String(setCookie)).toContain("Path=/api/task-workspaces;");
    expect(String(setCookie)).toContain("Path=/api/editor/local-history");
    expect(String(setCookie)).toContain("Path=/api/runs");
    expect(String(setCookie)).toContain("Path=/api/workspaces");
    expect(String(setCookie)).toContain("Max-Age=0");
    expect(channel.sessionCount()).toBe(0);
  });

  it("stream without a composed channel writes a content-free frame", () => {
    const writes: string[] = [];
    const res = {
      writeHead: vi.fn(),
      write: vi.fn((chunk: string) => {
        writes.push(chunk);
        return true;
      }),
      once: vi.fn(),
      end: vi.fn(),
      writableEnded: false,
      destroyed: false,
    } as unknown as ServerResponse;
    handleCodingAppSessionChannelStream(
      {
        correlationId: undefined,
        req: fakeReq(),
        res,
        params: {},
        url: new URL("http://127.0.0.1/"),
      },
      deps(),
    );
    expect(writes[0]).toContain('"content":null');
  });
});

describe("app-session lifecycle lines (F65)", () => {
  function logged(channel: CodingAppSessionChannel): {
    readonly deps: UiHandlerDeps;
    readonly events: readonly ServerLogEvent[];
  } {
    const activityLog = createBufferedServerLogSink();
    return {
      deps: { codingAppSessionChannel: channel, activityLog } as unknown as UiHandlerDeps,
      events: activityLog.events,
    };
  }

  function pairingRequest(body: unknown): RouteContext {
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
      headers: {},
      socket: {},
    });
    return { ...ctx(), correlationId: "pair-correlation", req: req as unknown as IncomingMessage };
  }

  it("logs a pairing that issued a session, correlated and body-free", async () => {
    const channel = createCodingAppSessionChannel({
      registry: createSessionRegistry(),
      pairingPort: createFakeSessionPairingPort(),
      contentSource: createStaticContentSource(CANARY),
    });
    const { deps: logDeps, events } = logged(channel);

    await handleCodingAppSessionPair(pairingRequest(fakePairingRequestBody()), logDeps);

    expect(events).toEqual([
      {
        level: "info",
        category: "http",
        op: "coding-app-session.paired",
        correlationId: "pair-correlation",
      },
    ]);
  });

  it("writes no line of its own for a denied pairing; denials stay aggregated (KEIKO-0838)", async () => {
    const { channel } = pairedChannel();
    const { deps: logDeps, events } = logged(channel);

    await handleCodingAppSessionPair(pairingRequest({ requestId: "forged" }), logDeps);

    expect(events).toEqual([]);
  });

  it("logs a rotation and a sign-out", () => {
    const { channel, cookie } = pairedChannel();
    const { deps: logDeps, events } = logged(channel);

    const issued = handleCodingAppSessionRotate(ctx(cookie), logDeps).headers?.["Set-Cookie"];
    // The rotation invalidated the paired cookie, so the sign-out presents the one it issued.
    handleCodingAppSessionSignOut(ctx(String(issued).split(";")[0] ?? ""), logDeps);

    expect(events.map((event) => event.op)).toEqual([
      "coding-app-session.rotated",
      "coding-app-session.signed-out",
    ]);
  });

  // PR #3452 review: the log never shows a sign-out that did not happen. An absent or unknown
  // cookie, a repeated sign-out from a stale tab and an unconfigured channel revoke nothing.
  it("logs a sign-out only when it revoked a session", () => {
    const { channel, cookie } = pairedChannel();
    const { deps: logDeps, events } = logged(channel);

    handleCodingAppSessionSignOut(ctx(), logDeps);
    handleCodingAppSessionSignOut(ctx(`${APP_SESSION_COOKIE_NAME}=sess_unknown.token`), logDeps);
    handleCodingAppSessionSignOut(ctx(cookie), logDeps);
    handleCodingAppSessionSignOut(ctx(cookie), logDeps);
    const unconfigured = createBufferedServerLogSink();
    handleCodingAppSessionSignOut(ctx(cookie), {
      activityLog: unconfigured,
    } as unknown as UiHandlerDeps);

    expect(events.map((event) => event.op)).toEqual(["coding-app-session.signed-out"]);
    expect(unconfigured.events).toEqual([]);
    expect(channel.sessionCount()).toBe(0);
  });
});

function streamOf(chunks: readonly Buffer[]): IncomingMessage {
  return Readable.from([...chunks]) as unknown as IncomingMessage;
}

describe("readPairingBody (fail-closed body reader)", () => {
  it("parses a bounded JSON object", async () => {
    expect(await readPairingBody(streamOf([Buffer.from(JSON.stringify({ a: 1 }))]))).toEqual({
      a: 1,
    });
  });

  it("resolves undefined for an empty body", async () => {
    expect(await readPairingBody(streamOf([]))).toBeUndefined();
  });

  it("resolves undefined for malformed JSON", async () => {
    expect(await readPairingBody(streamOf([Buffer.from("{not json")]))).toBeUndefined();
  });

  it("resolves undefined and drains a body that exceeds the cap", async () => {
    expect(await readPairingBody(streamOf([Buffer.alloc(9 * 1024, 0x61)]))).toBeUndefined();
  });

  it("resolves undefined when the request stream errors", async () => {
    const erroring = new Readable({
      read(): void {
        this.destroy(new Error("stream boom"));
      },
    }) as unknown as IncomingMessage;
    expect(await readPairingBody(erroring)).toBeUndefined();
  });
});
