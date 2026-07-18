import { describe, expect, it } from "vitest";

import type { CodingAppSessionChannelSnapshot } from "./channelContract.js";
import {
  APP_SESSION_PATHS,
  createFakeSessionPairingPort,
  createStaticContentSource,
  extractSessionCookie,
  fakePairingRequestBody,
  postHeaders,
  startAppSessionTestServer,
  type AppSessionTestServer,
} from "./_support.js";

const CANARY = { kind: "transcript-probe", body: "milestone-1-bounded-canary" } as const;

function startServer(): Promise<AppSessionTestServer> {
  return startAppSessionTestServer({
    sessionPairingPort: createFakeSessionPairingPort(),
    contentSource: createStaticContentSource(CANARY),
  });
}

async function snapshotContent(
  server: AppSessionTestServer,
  cookie?: string,
): Promise<CodingAppSessionChannelSnapshot["content"]> {
  const response = await fetch(`${server.baseUrl}${APP_SESSION_PATHS.channel}`, {
    headers: cookie === undefined ? {} : { cookie },
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as CodingAppSessionChannelSnapshot).content;
}

async function pairSession(server: AppSessionTestServer): Promise<string> {
  const response = await fetch(`${server.baseUrl}${APP_SESSION_PATHS.pair}`, {
    method: "POST",
    headers: postHeaders(),
    body: JSON.stringify(fakePairingRequestBody()),
  });
  expect(response.status).toBe(200);
  const cookie = extractSessionCookie(response);
  if (cookie === undefined) throw new Error("pairing did not issue a cookie");
  return cookie;
}

async function readStreamContent(
  server: AppSessionTestServer,
  cookie?: string,
): Promise<CodingAppSessionChannelSnapshot["content"]> {
  const response = await fetch(`${server.baseUrl}${APP_SESSION_PATHS.stream}`, {
    headers: cookie === undefined ? {} : { cookie },
  });
  const body = response.body;
  if (body === null) throw new Error("stream had no body");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (!buffer.includes("\n\n")) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel();
  }
  const dataLine = buffer.split("\n").find((line) => line.startsWith("data:")) ?? "data:{}";
  return (JSON.parse(dataLine.slice("data:".length).trim()) as CodingAppSessionChannelSnapshot)
    .content;
}

describe("authenticated app-session channel journey (ADR-0141, #2477)", () => {
  it("an unpaired loopback client with correct Origin/CSRF/runId reads no content", async () => {
    const server = await startServer();
    try {
      expect(await snapshotContent(server)).toBeNull();
      expect(await readStreamContent(server)).toBeNull();
    } finally {
      await server.close();
    }
  });

  it("a paired session reads the bounded payload over snapshot and stream", async () => {
    const server = await startServer();
    try {
      const cookie = await pairSession(server);
      expect(await snapshotContent(server, cookie)).toEqual(CANARY);
      expect(await readStreamContent(server, cookie)).toEqual(CANARY);
    } finally {
      await server.close();
    }
  });

  it("rotation cuts the prior cookie and moves access to the new one", async () => {
    const server = await startServer();
    try {
      const cookie = await pairSession(server);
      const response = await fetch(`${server.baseUrl}${APP_SESSION_PATHS.rotate}`, {
        method: "POST",
        headers: postHeaders(cookie),
      });
      const rotated = extractSessionCookie(response);
      if (rotated === undefined) throw new Error("rotation did not re-issue a cookie");
      expect(await snapshotContent(server, cookie)).toBeNull();
      expect(await snapshotContent(server, rotated)).toEqual(CANARY);
    } finally {
      await server.close();
    }
  });

  it("sign-out revokes the session", async () => {
    const server = await startServer();
    try {
      const cookie = await pairSession(server);
      await fetch(`${server.baseUrl}${APP_SESSION_PATHS.signOut}`, {
        method: "POST",
        headers: postHeaders(cookie),
      });
      expect(await snapshotContent(server, cookie)).toBeNull();
    } finally {
      await server.close();
    }
  });

  it("a session does not survive a server restart (restart expiry)", async () => {
    const first = await startServer();
    let cookie: string;
    try {
      cookie = await pairSession(first);
      expect(await snapshotContent(first, cookie)).toEqual(CANARY);
    } finally {
      await first.close();
    }
    const restarted = await startServer();
    try {
      expect(await snapshotContent(restarted, cookie)).toBeNull();
    } finally {
      await restarted.close();
    }
  });
});
