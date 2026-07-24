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
    expect(setCookie).toHaveLength(6);
    expect(String(setCookie)).toContain(APP_SESSION_COOKIE_NAME);
    expect(String(setCookie)).toContain("Path=/api/coding-workbench");
    expect(String(setCookie)).toContain("Path=/api/git");
    expect(String(setCookie)).toContain("Path=/api/files");
    expect(String(setCookie)).toContain("Path=/api/editor");
    expect(String(setCookie)).toContain("Path=/api/runtime");
    expect(String(setCookie)).toContain("HttpOnly");
  });

  it("sign-out clears the cookie and revokes the session", () => {
    const { channel, cookie } = pairedChannel();
    const setCookie = handleCodingAppSessionSignOut(ctx(cookie), deps(channel)).headers?.[
      "Set-Cookie"
    ];
    expect(setCookie).toHaveLength(6);
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
      { req: fakeReq(), res, params: {}, url: new URL("http://127.0.0.1/") },
      deps(),
    );
    expect(writes[0]).toContain('"content":null');
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
