/* eslint-disable @typescript-eslint/explicit-function-return-type -- Local test fixture callbacks are contextually typed. */
// #2478 acceptance guard: NO unauthenticated content route remains on the coding-workbench
// surface. The test enumerates the full runId-keyed loopback route table (the coding-runtime group
// and the app-session group), invokes every handler WITHOUT a session cookie against a runtime
// whose pending question carries a canary text, and asserts the canary never leaves the server —
// while a paired caller (the positive control) does receive it, so the sweep cannot go vacuously
// green. New content-bearing routes added to either group (W1.6–W1.9) are swept automatically.

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { UiHandlerDeps } from "../deps.js";
import { API_ROUTES, type RouteContext, type RouteDefinition } from "../routes.js";
import { CODING_RUNTIME_ROUTE_GROUP } from "../coding-runtime/codingRuntimeRoutes.js";
import { createFakeSessionPairingPort, fakePairingRequestBody } from "./_support.js";
import { CODING_APP_SESSION_ROUTE_GROUP } from "./codingAppSessionRoutes.js";
import { createCodingAppSessionChannel } from "./sessionChannel.js";
import { APP_SESSION_COOKIE_NAME } from "./sessionCookie.js";
import { createSessionRegistry } from "./sessionRegistry.js";

const CANARY = "CANARY-QUESTION-TEXT-2478";

/** The content-bearing routes the session guard must cover (the grep-able enforcement list). */
const ENFORCED_CONTENT_ROUTE_PATTERNS = [
  "/api/coding-workbench/runtime/runs/:runId/questions",
  "/api/coding-workbench/runtime/runs/:runId/questions/answer",
  "/api/coding-workbench/runtime/runs/:runId/questions/reject",
] as const;

class SweepResponse extends EventEmitter {
  public readonly chunks: string[] = [];
  public writableEnded = false;
  public destroyed = false;
  public writeHead() {
    return this;
  }
  public write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }
  public end() {
    this.writableEnded = true;
    return this;
  }
  public destroy() {
    this.destroyed = true;
    this.emit("close");
    return this;
  }
}

function sweepContext(cookie?: string): { ctx: RouteContext; res: SweepResponse } {
  const req = new PassThrough() as unknown as RouteContext["req"];
  req.headers = cookie === undefined ? {} : { cookie };
  // A plain (non-TLS) socket shape so cookie-issuing handlers can evaluate `requestIsSecure`.
  Object.assign(req, { socket: {} });
  queueMicrotask(() => (req as unknown as PassThrough).end("{}"));
  const res = new SweepResponse();
  return {
    ctx: {
      req,
      res: res as unknown as RouteContext["res"],
      params: { runId: "run-1" },
      url: new URL("http://localhost/api/coding-workbench/runtime/status"),
    },
    res,
  };
}

const snapshot = {
  schemaVersion: "1",
  state: "running",
  revision: 2,
  updatedAt: "2026-07-18T00:00:00.000Z",
  runId: "run-1",
  requestedMode: "supervised-coding",
  runtimeSource: "keiko-sidecar",
  modelSource: "keiko-model-gateway",
};

const canaryQuestions = {
  questions: [
    {
      id: "que_canary",
      questions: [
        {
          question: CANARY,
          header: "Canary",
          options: [{ label: CANARY, description: CANARY }],
        },
      ],
    },
  ],
};

function canaryRuntimeDeps(channel: UiHandlerDeps["codingAppSessionChannel"]): UiHandlerDeps {
  const operation = () => Promise.resolve({ ok: true as const, snapshot });
  const orchestrator = {
    start: operation,
    retry: operation,
    decideApproval: operation,
    stop: operation,
    takeover: operation,
    acknowledgeRecovery: operation,
    pause: operation,
    resume: operation,
    submitFollowUp: operation,
    answerQuestion: operation,
    rejectQuestion: operation,
    listQuestions: () =>
      Promise.resolve({ ok: true as const, snapshot, questions: canaryQuestions }),
    status: () => snapshot,
    getSnapshot: (runId: string) => (runId === "run-1" ? snapshot : undefined),
  };
  const eventHub = {
    subscribe: () => ({ ok: false as const, reason: "sweep" }),
  };
  return {
    codingRuntimeOrchestrator: orchestrator,
    codingRuntimeEventHub: eventHub,
    codingAppSessionChannel: channel,
  } as unknown as UiHandlerDeps;
}

function pairedChannel(): { channel: UiHandlerDeps["codingAppSessionChannel"]; cookie: string } {
  const channel = createCodingAppSessionChannel({
    registry: createSessionRegistry(),
    pairingPort: createFakeSessionPairingPort(),
  });
  const paired = channel.pair(fakePairingRequestBody());
  if (!paired.paired) throw new Error("sweep pairing failed");
  return { channel, cookie: `${APP_SESSION_COOKIE_NAME}=${paired.cookieToken}` };
}

async function invoke(
  definition: RouteDefinition,
  deps: UiHandlerDeps,
  cookie?: string,
): Promise<string> {
  const { ctx, res } = sweepContext(cookie);
  const outcome = await Promise.resolve(definition.handler(ctx, deps));
  const body = typeof outcome === "object" && "body" in outcome ? JSON.stringify(outcome.body) : "";
  return `${body}\n${res.chunks.join("")}`;
}

describe("content route enforcement sweep (#2478)", () => {
  const sweptGroups: readonly RouteDefinition[] = [
    ...CODING_RUNTIME_ROUTE_GROUP,
    ...CODING_APP_SESSION_ROUTE_GROUP,
  ];

  it("mounts every enforced content-bearing route in the API route table exactly once", () => {
    for (const pattern of ENFORCED_CONTENT_ROUTE_PATTERNS) {
      const mounted = API_ROUTES.filter((route) => route.pattern === pattern);
      const grouped = sweptGroups.find((route) => route.pattern === pattern);
      expect(mounted).toHaveLength(1);
      // The mounted handler IS the group's guarded handler — no unguarded duplicate mount.
      expect(mounted[0]?.handler).toBe(grouped?.handler);
    }
  });

  it("never releases question text to any cookie-less caller across the full route table", async () => {
    const { channel } = pairedChannel();
    for (const definition of sweptGroups) {
      const withChannel = await invoke(definition, canaryRuntimeDeps(channel));
      const withoutChannel = await invoke(definition, canaryRuntimeDeps(undefined));
      expect(withChannel, `${definition.method} ${definition.pattern}`).not.toContain(CANARY);
      expect(withoutChannel, `${definition.method} ${definition.pattern}`).not.toContain(CANARY);
    }
  });

  it("never releases question text to a forged or revoked cookie across the full route table", async () => {
    const { channel, cookie } = pairedChannel();
    channel?.signOut(cookie.slice(cookie.indexOf("=") + 1));
    const forged = `${APP_SESSION_COOKIE_NAME}=sess_000000000000000000000000.forged`;
    for (const definition of sweptGroups) {
      const revoked = await invoke(definition, canaryRuntimeDeps(channel), cookie);
      const spoofed = await invoke(definition, canaryRuntimeDeps(channel), forged);
      expect(revoked, `${definition.method} ${definition.pattern}`).not.toContain(CANARY);
      expect(spoofed, `${definition.method} ${definition.pattern}`).not.toContain(CANARY);
    }
  });

  it("positive control: a paired caller does receive the canary question text", async () => {
    const { channel, cookie } = pairedChannel();
    const listRoute = sweptGroups.find(
      (route) => route.pattern === ENFORCED_CONTENT_ROUTE_PATTERNS[0],
    );
    expect(listRoute).toBeDefined();
    if (listRoute === undefined) return;
    const served = await invoke(listRoute, canaryRuntimeDeps(channel), cookie);
    expect(served).toContain(CANARY);
    expect(served).toContain('"session":"active"');
  });
});
