import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { decodeCodingAppSessionPairingFragment } from "@oscharko-dev/keiko-contracts/runtime/coding-app-session-pairing";
import type { ServerLogEvent } from "@oscharko-dev/keiko-activity-log";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";
import { createLauncherBrowser } from "./launcherBrowser.js";
import { createLauncherSessionPairingPort } from "./launcherSessionPairingPort.js";
import { handleLauncherBrowserOpen } from "./launcherBrowserRoutes.js";
import {
  extractSessionCookie,
  postHeaders,
  startAppSessionTestServer,
  type AppSessionTestServer,
} from "./_support.js";

const servers: AppSessionTestServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

it("opens the native browser without authenticating the HTTP requester, then redeems only in the opened browser", async () => {
  const secret = "synthetic-native-handoff-secret-with-32-characters";
  let opened = "";
  const server = await startAppSessionTestServer({
    sessionPairingPort: createLauncherSessionPairingPort({ secret }),
    launcherBrowser: {
      open: (target, origin) =>
        createLauncherBrowser({
          secret,
          port: Number(new URL(origin).port),
          open: (browser, url): Promise<void> => {
            expect(browser).toBe("firefox");
            opened = url;
            return Promise.resolve();
          },
        }).open(target, origin),
    },
  });
  servers.push(server);
  const response = await fetch(`${server.baseUrl}/api/coding-workbench/app-session/open-browser`, {
    method: "POST",
    headers: { ...postHeaders(), origin: server.baseUrl, "user-agent": "Mozilla Firefox/159.0" },
    body: JSON.stringify({ origin: server.baseUrl }),
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.getSetCookie()).toEqual([]);
  expect(await response.json()).toEqual({ state: "opened" });
  expect(server.deps.codingAppSessionChannel?.sessionCount()).toBe(0);
  expect(
    await (await fetch(`${server.baseUrl}/api/coding-workbench/app-session/browser`)).json(),
  ).toEqual({ state: "unavailable" });
  const proof = decodeCodingAppSessionPairingFragment(new URL(opened).hash);
  const paired = await fetch(`${server.baseUrl}/api/coding-workbench/app-session/pair`, {
    method: "POST",
    headers: postHeaders(),
    body: JSON.stringify(proof),
  });
  const cookie = extractSessionCookie(paired);
  expect(cookie).toBeDefined();
  if (cookie === undefined) throw new TypeError("missing paired cookie");
  expect(
    await (
      await fetch(`${server.baseUrl}/api/coding-workbench/app-session/browser`, {
        headers: { cookie },
      })
    ).json(),
  ).toMatchObject({ state: "active" });
});

it.each(["opened", "busy", "unavailable", "failed"] as const)(
  "records only the closed %s outcome",
  async (outcome) => {
    const server = await startAppSessionTestServer();
    servers.push(server);
    const events: ServerLogEvent[] = [];
    const req = new IncomingMessage(new Socket());
    req.headers = { host: "localhost:1983", origin: "http://localhost:1983" };
    const pending = handleLauncherBrowserOpen(
      {
        req,
        res: new ServerResponse(req),
        url: new URL("http://localhost:1983/api/coding-workbench/app-session/open-browser"),
        params: {},
        correlationId: "browser-open-proof",
      },
      {
        ...server.deps,
        launcherBrowser: { open: () => Promise.resolve(outcome) },
        activityLog: {
          write: (event) => {
            events.push(event);
          },
        },
      },
    );
    req.emit("data", Buffer.from(JSON.stringify({ origin: "http://localhost:1983" })));
    req.emit("end");
    const result = await pending;
    expect(result.body).toEqual({ state: outcome });
    expect(result.headers?.["Set-Cookie"]).toBeUndefined();
    expectActivityLogProof(
      "coding-app-session.browser-open.outcome",
      formatActivityLogProofLine(events[0] ?? {}),
    );
    expect(events[0]?.extra).toMatchObject({ outcome });
  },
);

it.each([undefined, "http://localhost:1984", "http://evil.invalid:1983"])(
  "refuses missing or foreign origin %s without an opener call",
  async (origin) => {
    const open = vi.fn();
    const server = await startAppSessionTestServer({ launcherBrowser: { open } });
    servers.push(server);
    const response = await fetch(
      `${server.baseUrl}/api/coding-workbench/app-session/open-browser`,
      {
        method: "POST",
        headers: { ...postHeaders(), ...(origin === undefined ? {} : { origin }) },
        body: JSON.stringify({ origin: server.baseUrl }),
      },
    );
    expect(open).not.toHaveBeenCalled();
    expect(response.headers.getSetCookie()).toEqual([]);
  },
);

it("logs and contains a rejected native opener without returning its error or issuing a cookie", async () => {
  const server = await startAppSessionTestServer({
    launcherBrowser: { open: () => Promise.reject(new Error("PRIVATE_NATIVE_PROOF")) },
  });
  servers.push(server);
  const response = await fetch(`${server.baseUrl}/api/coding-workbench/app-session/open-browser`, {
    method: "POST",
    headers: { ...postHeaders(), origin: server.baseUrl },
    body: JSON.stringify({ origin: server.baseUrl }),
  });
  expect(await response.json()).toEqual({ state: "failed" });
  expect(response.headers.getSetCookie()).toEqual([]);
  expect(server.deps.codingAppSessionChannel?.sessionCount()).toBe(0);
});
