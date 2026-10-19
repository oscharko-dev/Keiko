import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { ServerLogEvent } from "@oscharko-dev/keiko-activity-log";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";
import { BROWSER_APPROVAL_ROUTES } from "./browserApprovalRoutes.js";
import {
  browserApprovalChallengeText,
  type BrowserApprovalChallengeResult,
  type BrowserApprovalRequestResult,
  type BrowserApprovalProofResult,
} from "@oscharko-dev/keiko-contracts/runtime/coding-app-session";
import {
  createFakeSessionPairingPort,
  extractSessionCookie,
  fakePairingRequestBody,
  postHeaders,
  startAppSessionTestServer,
  type AppSessionTestServer,
} from "./_support.js";

const ROOT = "/api/coding-workbench/app-session/browser";
const servers: AppSessionTestServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

async function fixture(): Promise<{
  readonly server: AppSessionTestServer;
  readonly owner: string;
}> {
  const server = await startAppSessionTestServer({
    sessionPairingPort: createFakeSessionPairingPort(),
  });
  servers.push(server);
  const response = await fetch(`${server.baseUrl}/api/coding-workbench/app-session/pair`, {
    method: "POST",
    headers: postHeaders(),
    body: JSON.stringify(fakePairingRequestBody()),
  });
  const owner = extractSessionCookie(response);
  if (owner === undefined) throw new Error("Missing fixture owner session");
  return { server, owner };
}

function post(
  server: AppSessionTestServer,
  action: string,
  body: unknown,
  cookie?: string,
): Promise<Response> {
  return fetch(`${server.baseUrl}${ROOT}/${action}`, {
    method: "POST",
    headers: { ...postHeaders(cookie), origin: server.baseUrl },
    body: JSON.stringify(body),
  });
}

function keyPair(): { readonly publicKey: KeyObject; readonly privateKey: KeyObject } {
  return generateKeyPairSync("ec", { namedCurve: "prime256v1" });
}

async function approveBrowser(server: AppSessionTestServer, owner: string): Promise<Response> {
  const pair = keyPair();
  const jwk = pair.publicKey.export({ format: "jwk" });
  const requested = await post(server, "request", {
    publicKey: { x: jwk.x, y: jwk.y },
    remember: true,
  });
  expect(requested.status).toBe(200);
  const pending = (await requested.json()) as BrowserApprovalRequestResult;
  if (pending.state !== "pending") throw new Error("Missing browser request");
  const approved = await post(
    server,
    "approve",
    {
      requestId: pending.request.requestId,
      comparisonCode: pending.request.comparisonCode,
      remember: true,
    },
    owner,
  );
  expect(await approved.json()).toEqual({ state: "accepted" });
  const challenged = await post(server, "challenge", {
    purpose: "complete",
    subjectId: pending.request.requestId,
  });
  const challenge = (await challenged.json()) as BrowserApprovalChallengeResult;
  if (challenge.state !== "challenge") throw new Error("Missing browser challenge");
  const signature = sign("sha256", Buffer.from(browserApprovalChallengeText(challenge.challenge)), {
    key: pair.privateKey,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
  return post(server, "prove", { challengeId: challenge.challenge.challengeId, signature });
}

describe("browser approval on the real mounted BFF", () => {
  it("records only registered body-free approval lifecycle evidence", async () => {
    const { server, owner } = await fixture();
    const route = BROWSER_APPROVAL_ROUTES.find((entry) => entry.method === "GET");
    if (route === undefined) throw new Error("Missing inspection route");
    const events: ServerLogEvent[] = [];
    const req = new IncomingMessage(new Socket());
    req.headers.cookie = owner;
    await route.handler(
      {
        req,
        res: new ServerResponse(req),
        correlationId: "browser-approval-log-control",
        params: {},
        url: new URL(`${server.baseUrl}${ROOT}`),
      },
      {
        ...server.deps,
        activityLog: {
          write: (event): void => {
            events.push(event);
          },
        },
      },
    );
    expect(events).toHaveLength(1);
    expectActivityLogProof(
      "coding-app-session.browser-approval.state.line",
      formatActivityLogProofLine(events[0] ?? {}),
    );
    expect(events[0]?.extra).toEqual({
      action: "inspect",
      outcome: "accepted",
      sessionCount: 1,
      completeness: "complete",
      loss: "none",
    });
    expect(JSON.stringify(events)).not.toContain(owner);
  });
  it("saves authenticated drafts after approval and refuses the same cookie after revocation", async () => {
    const { server, owner } = await fixture();
    const project = server.deps.store.createProject(process.cwd());
    const chat = server.deps.store.createChat(
      project.path,
      "Private fixture chat",
      "fixture-model",
    );
    const draftPath = `/api/chats/${chat.id}/draft`;
    expect((await fetch(`${server.baseUrl}${draftPath}`)).status).toBe(404);
    const response = await approveBrowser(server, owner);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const cookie = extractSessionCookie(response);
    expect(cookie).toBeTypeOf("string");
    if (cookie === undefined) throw new Error("Missing approved cookie");
    const body = (await response.json()) as BrowserApprovalProofResult;
    expect(JSON.stringify(body)).not.toContain(cookie.split("=").at(1));
    if (body.state !== "active" || body.approval === undefined) throw new Error("Missing approval");
    const saved = await fetch(`${server.baseUrl}${draftPath}`, {
      method: "PUT",
      headers: { ...postHeaders(cookie), origin: server.baseUrl },
      body: JSON.stringify({ text: "Synthetic private draft", expectedRevision: 0 }),
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ text: "Synthetic private draft", revision: 1 });
    expect((await fetch(`${server.baseUrl}${draftPath}`, { headers: { cookie } })).status).toBe(
      200,
    );
    const revoked = await post(server, "revoke", body.approval.approvalId, owner);
    expect(await revoked.json()).toEqual({ state: "accepted" });
    expect((await fetch(`${server.baseUrl}${draftPath}`, { headers: { cookie } })).status).toBe(
      404,
    );
  });

  it.each([undefined, "forged"])(
    "does not expose approval management to an unapproved browser: %s",
    async (cookie) => {
      const { server } = await fixture();
      const inspected = await fetch(`${server.baseUrl}${ROOT}`, {
        headers: cookie === undefined ? {} : { cookie },
      });
      expect(await inspected.json()).toEqual({ state: "unavailable" });
      const response = await post(
        server,
        "approve",
        {
          requestId: `brq_${"a".repeat(32)}`,
          comparisonCode: "12345678",
          remember: true,
        },
        cookie,
      );
      expect(await response.json()).toEqual({ state: "unavailable" });
      expect(extractSessionCookie(response)).toBeUndefined();
      expect(server.deps.codingAppSessionChannel?.sessionCount()).toBe(1);
    },
  );

  it.each([undefined, "http://localhost:1983", "http://attacker.invalid:1983", "null"])(
    "requires the exact transport origin for approval requests: %s",
    async (origin) => {
      const { server } = await fixture();
      const key = keyPair().publicKey.export({ format: "jwk" });
      const response = await fetch(`${server.baseUrl}${ROOT}/request`, {
        method: "POST",
        headers: { ...postHeaders(), ...(origin === undefined ? {} : { origin }) },
        body: JSON.stringify({ publicKey: { x: key.x, y: key.y }, remember: false }),
      });
      if (response.status !== 403) {
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ state: "unavailable" });
      }
      expect(server.deps.codingAppSessionChannel?.sessionCount()).toBe(1);
    },
  );

  it("keeps the existing CSRF and bounded JSON protections", async () => {
    const { server } = await fixture();
    const missingCsrf = await fetch(`${server.baseUrl}${ROOT}/request`, {
      method: "POST",
      headers: { origin: server.baseUrl, "content-type": "application/json" },
      body: "{}",
    });
    expect(missingCsrf.status).toBe(403);
    const oversized = await post(server, "request", { padding: "x".repeat(9 * 1_024) });
    expect(await oversized.json()).toEqual({ state: "unavailable" });
    expect(extractSessionCookie(oversized)).toBeUndefined();
    expect(server.deps.codingAppSessionChannel?.sessionCount()).toBe(1);
  });
});
