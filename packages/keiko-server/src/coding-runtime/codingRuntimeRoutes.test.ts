/* eslint-disable @typescript-eslint/explicit-function-return-type -- Local test fixture callbacks are contextually typed. */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type {
  CodingWorkbenchRuntimeSnapshot,
  CodingWorkbenchRuntimeSseEvent,
} from "@oscharko-dev/keiko-contracts";
import type { UiHandlerDeps } from "../deps.js";
import {
  createFakeSessionPairingPort,
  fakePairingRequestBody,
} from "../coding-app-session/_support.js";
import { createCodingAppSessionChannel } from "../coding-app-session/sessionChannel.js";
import { APP_SESSION_COOKIE_NAME } from "../coding-app-session/sessionCookie.js";
import { createSessionRegistry } from "../coding-app-session/sessionRegistry.js";
import {
  API_ROUTES,
  STREAMING,
  matchRoute,
  type HandlerOutcome,
  type RouteContext,
  type RouteDefinition,
} from "../routes.js";
import {
  CODING_RUNTIME_ROUTE_GROUP,
  handleCodingRuntimeApproval,
  handleCodingRuntimeApprovalReview,
  handleCodingRuntimeEvents,
  handleCodingRuntimeFollowUp,
  handleCodingRuntimePause,
  handleCodingRuntimeQuestionAnswer,
  handleCodingRuntimeQuestionList,
  handleCodingRuntimeQuestionReject,
  handleCodingRuntimeRecoveryAcknowledgement,
  handleCodingRuntimeResearch,
  handleCodingRuntimeResearchRevoke,
  handleCodingRuntimeResume,
  handleCodingRuntimeRetry,
  handleCodingRuntimeStatus,
  handleCodingRuntimeStop,
  handleCodingRuntimeTakeover,
  handleCreateCodingRuntimeRun,
  handleCodingRuntimeReadiness,
  handleGetCodingRuntimeRun,
  openCodingRuntimeSse,
} from "./codingRuntimeRoutes.js";

const snapshot: CodingWorkbenchRuntimeSnapshot = {
  schemaVersion: "1",
  state: "ready",
  revision: 2,
  updatedAt: "2026-07-13T00:00:00.000Z",
  runId: "run-1",
  requestedMode: "governed-assist",
  runtimeSource: "keiko-sidecar",
  modelSource: "keiko-model-gateway",
};

function context(
  body = "{}",
  params: Record<string, string> = {},
  path = "/api/coding-workbench/runtime/runs",
  cookie?: string,
): RouteContext {
  const req = new PassThrough() as unknown as RouteContext["req"];
  req.headers = cookie === undefined ? {} : { cookie };
  queueMicrotask(() => (req as unknown as PassThrough).end(body));
  return {
    correlationId: undefined,
    req,
    res: new FakeResponse() as unknown as RouteContext["res"],
    params,
    url: new URL(`http://localhost${path}`),
  };
}

// #2478: the question routes enforce the app-session read authority, so the fixtures pair a real
// channel + registry once and present its cookie; unpaired contexts simply omit the cookie.
function pairedAppSession(): { channel: UiHandlerDeps["codingAppSessionChannel"]; cookie: string } {
  const channel = createCodingAppSessionChannel({
    registry: createSessionRegistry(),
    pairingPort: createFakeSessionPairingPort(),
  });
  const paired = channel.pair(fakePairingRequestBody());
  if (!paired.paired) throw new Error("test pairing failed");
  return { channel, cookie: `${APP_SESSION_COOKIE_NAME}=${paired.cookieToken}` };
}

class FakeResponse extends EventEmitter {
  public readonly chunks: string[] = [];
  public writableEnded = false;
  public destroyed = false;
  public writeHead(): this {
    return this;
  }
  public write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }
  public end(): this {
    this.writableEnded = true;
    return this;
  }
  public destroy(): this {
    this.destroyed = true;
    this.emit("close");
    return this;
  }
}

function runtime(
  overrides: Partial<Record<string, unknown>> = {},
  runtimeSnapshot: CodingWorkbenchRuntimeSnapshot = snapshot,
  researchGrant?: {
    readonly grantId: string;
    readonly domains: readonly string[];
    readonly expiresAt: string;
  },
): UiHandlerDeps {
  const calls: unknown[] = [];
  const orchestrator = {
    start: (body: unknown) => {
      calls.push(body);
      return Promise.resolve({ ok: true as const, snapshot: runtimeSnapshot });
    },
    retry: () => Promise.resolve({ ok: true as const, snapshot: runtimeSnapshot }),
    decideApproval: () => Promise.resolve({ ok: true as const, snapshot: runtimeSnapshot }),
    stop: () => Promise.resolve({ ok: true as const, snapshot: runtimeSnapshot }),
    takeover: () => Promise.resolve({ ok: true as const, snapshot: runtimeSnapshot }),
    acknowledgeRecovery: () => Promise.resolve({ ok: true as const, snapshot: runtimeSnapshot }),
    pause: () => Promise.resolve({ ok: true as const, snapshot: runtimeSnapshot }),
    resume: () => Promise.resolve({ ok: true as const, snapshot: runtimeSnapshot }),
    revokeResearch: () => Promise.resolve({ ok: true as const, snapshot: runtimeSnapshot }),
    submitFollowUp: (_runId: string, body: unknown) => {
      calls.push(body);
      return Promise.resolve({ ok: true as const, snapshot: runtimeSnapshot });
    },
    answerQuestion: (_runId: string, body: unknown) => {
      calls.push(body);
      return Promise.resolve({ ok: true as const, snapshot: runtimeSnapshot });
    },
    rejectQuestion: () => Promise.resolve({ ok: true as const, snapshot: runtimeSnapshot }),
    listQuestions: () =>
      Promise.resolve({
        ok: true as const,
        snapshot: runtimeSnapshot,
        questions: { schemaVersion: "1" as const, questions: [] },
      }),
    status: () => runtimeSnapshot,
    getSnapshot: (runId: string) => (runId === "run-1" ? runtimeSnapshot : undefined),
    pendingResearchAsk: (runId: string) =>
      runId === "run-1"
        ? {
            requestId: "research-approval-1",
            host: "nodejs.org",
            requestLine: "/docs/latest/api/stream.html backpressure",
            expiresAt: "2026-07-13T00:02:00.000Z",
          }
        : undefined,
    researchGrant: (runId: string) => (runId === "run-1" ? researchGrant : undefined),
    pendingApprovalReview: (runId: string) =>
      runId === "run-1"
        ? {
            requestId: "permission-7",
            paths: ["src/alpha.ts", "src/beta.ts"],
            pathsTruncated: false,
            fileCount: 2,
            addedLines: 12,
            deletedLines: 4,
          }
        : undefined,
  };
  const eventHub = {
    subscribe: (
      _runId: string,
      _cursor: string | undefined,
      subscriber: { write: (event: CodingWorkbenchRuntimeSseEvent) => boolean },
    ) => {
      subscriber.write({
        schemaVersion: "1",
        cursor: "run-1:0",
        sequence: 0,
        occurredAt: snapshot.updatedAt,
        kind: "status",
        runId: "run-1",
        state: "ready",
        revision: 2,
      });
      return { ok: true as const, detach: () => undefined };
    },
  };
  return {
    codingRuntimeOrchestrator: orchestrator,
    codingRuntimeEventHub: eventHub,
    __calls: calls,
    ...overrides,
  } as unknown as UiHandlerDeps;
}

describe("coding runtime routes", () => {
  it("mounts the inline follow-up, question, and pause/resume operations behind the runtime group", () => {
    const patterns = API_ROUTES.map(({ pattern }) => pattern);
    // #2386: these operations ARE now mounted — behind the same loopback+CSRF+serverPrincipal
    // boundary that already guards the runtime group (POST + JSON + CSRF enforced in server.ts).
    expect(patterns.some((pattern) => pattern.endsWith("/questions"))).toBe(true);
    expect(patterns.some((pattern) => pattern.endsWith("/questions/answer"))).toBe(true);
    expect(patterns.some((pattern) => pattern.endsWith("/questions/reject"))).toBe(true);
    expect(patterns.some((pattern) => pattern.endsWith("/follow-up"))).toBe(true);
    expect(patterns.some((pattern) => pattern.endsWith("/pause"))).toBe(true);
    expect(patterns.some((pattern) => pattern.endsWith("/resume"))).toBe(true);
    // #2387: the research revoke mutation shares the same guarded runtime group.
    expect(patterns.some((pattern) => pattern.endsWith("/research/revoke"))).toBe(true);
  });

  it("declares the productive singleton lifecycle routes and leaves deprecated authority routes unmounted", () => {
    expect(CODING_RUNTIME_ROUTE_GROUP.map(({ method, pattern }) => `${method} ${pattern}`)).toEqual(
      [
        "POST /api/coding-workbench/runtime/runs",
        "GET /api/coding-workbench/runtime/readiness",
        "GET /api/coding-workbench/runtime/status",
        "GET /api/coding-workbench/runtime/runs/:runId/events",
        "GET /api/coding-workbench/runtime/runs/:runId/research",
        "GET /api/coding-workbench/runtime/runs/:runId/approval-review",
        "POST /api/coding-workbench/runtime/runs/:runId/approvals",
        "POST /api/coding-workbench/runtime/runs/:runId/stop",
        "POST /api/coding-workbench/runtime/runs/:runId/takeover",
        "POST /api/coding-workbench/runtime/runs/:runId/retry",
        "POST /api/coding-workbench/runtime/runs/:runId/recovery-ack",
        "POST /api/coding-workbench/runtime/runs/:runId/pause",
        "POST /api/coding-workbench/runtime/runs/:runId/resume",
        "POST /api/coding-workbench/runtime/runs/:runId/follow-up",
        "POST /api/coding-workbench/runtime/runs/:runId/research/revoke",
        "POST /api/coding-workbench/runtime/runs/:runId/questions",
        "POST /api/coding-workbench/runtime/runs/:runId/questions/answer",
        "POST /api/coding-workbench/runtime/runs/:runId/questions/reject",
        "GET /api/coding-workbench/runtime/runs/:runId",
      ],
    );
    expect(API_ROUTES.some(({ pattern }) => pattern.includes("autonomous-delivery"))).toBe(false);
    expect(matchRoute("DELETE", "/api/coding-workbench/runtime/runs/run-1")).toBe(
      "method-not-allowed",
    );
    expect(matchRoute("GET", "/api/coding-workbench/runtime/nope")).toBeUndefined();
  });

  it("routes pause, resume, follow-up, and question mutations to the live run only", async () => {
    const session = pairedAppSession();
    const runPath = "/api/coding-workbench/runtime/runs";
    const handlers = [
      handleCodingRuntimePause,
      handleCodingRuntimeResume,
      handleCodingRuntimeResearchRevoke,
      handleCodingRuntimeFollowUp,
      handleCodingRuntimeQuestionAnswer,
      handleCodingRuntimeQuestionReject,
      handleCodingRuntimeQuestionList,
    ];
    for (const handler of handlers) {
      const deps = runtime({ codingAppSessionChannel: session.channel });
      await expect(
        handler(context("{}", { runId: "run-1" }, runPath, session.cookie), deps),
      ).resolves.toMatchObject({ status: 200 });
      await expect(
        handler(context("{}", { runId: "run-9" }, runPath, session.cookie), deps),
      ).resolves.toMatchObject({ status: 404 });
      await expect(
        handler(context("{}", {}, runPath, session.cookie), deps),
      ).resolves.toMatchObject({ status: 404 });
    }
  });

  it("caps a question answer body at 64KB and never echoes its untrusted text", async () => {
    const session = pairedAppSession();
    const runPath = "/api/coding-workbench/runtime/runs";
    const tooLarge = await handleCodingRuntimeQuestionAnswer(
      context(
        JSON.stringify({ padding: "x".repeat(64 * 1024 + 1) }),
        { runId: "run-1" },
        runPath,
        session.cookie,
      ),
      runtime({ codingAppSessionChannel: session.channel }),
    );
    expect(tooLarge).toMatchObject({ status: 413 });
    expect(JSON.stringify(tooLarge.body)).not.toContain("xxxx");

    const deps = runtime({ codingAppSessionChannel: session.channel });
    const answered = await handleCodingRuntimeQuestionAnswer(
      context(
        JSON.stringify({
          requestId: "req-1",
          expectedRevision: 2,
          questionId: "que_1",
          answers: [["untrusted-answer-text"]],
        }),
        { runId: "run-1" },
        runPath,
        session.cookie,
      ),
      deps,
    );
    expect(answered).toMatchObject({ status: 200, body: snapshot });
    // The route response projects only the content-free snapshot, never the answer text.
    expect(JSON.stringify(answered.body)).not.toContain("untrusted-answer-text");
  });

  // Epic #3384 defect B: every refused mutation used to return its 400/403 with nothing in the
  // activity log. Before this fix neither case below wrote a line; the mutation() funnel now emits
  // exactly one body-free warn line per refusal, naming which operation and which closed reason.
  it("#3384 defect B: logs a body-free refusal when a mutation body is malformed", async () => {
    const session = pairedAppSession();
    const records: unknown[] = [];
    const deps = runtime({
      codingAppSessionChannel: session.channel,
      activityLog: { write: (event: unknown) => void records.push(event) },
    });
    const refused = await handleCodingRuntimeQuestionAnswer(
      context("not-json", { runId: "run-1" }, "/api/coding-workbench/runtime/runs", session.cookie),
      deps,
    );
    expect(refused).toMatchObject({ status: 400 });
    expect(records).toEqual([
      expect.objectContaining({
        level: "warn",
        category: "process",
        op: "coding-runtime.operation.refused",
        extra: { operation: "answer", runId: "run-1", reason: "invalid-intent" },
      }),
    ]);
  });

  it("#3384 defect B: logs the closed failure code the runtime returned, e.g. replay-cap-exhausted", async () => {
    const session = pairedAppSession();
    const records: unknown[] = [];
    const deps = runtime({
      codingAppSessionChannel: session.channel,
      activityLog: { write: (event: unknown) => void records.push(event) },
    });
    (
      deps.codingRuntimeOrchestrator as unknown as {
        answerQuestion: (
          runId: string,
          body: unknown,
        ) => Promise<{ readonly ok: false; readonly failureCode: string }>;
      }
    ).answerQuestion = () =>
      Promise.resolve({ ok: false as const, failureCode: "replay-cap-exhausted" });
    const refused = await handleCodingRuntimeQuestionAnswer(
      context(
        JSON.stringify({
          requestId: "req-1",
          expectedRevision: 2,
          questionId: "que_1",
          answers: [["ok"]],
        }),
        { runId: "run-1" },
        "/api/coding-workbench/runtime/runs",
        session.cookie,
      ),
      deps,
    );
    expect(refused).toMatchObject({ status: 400 });
    expect(records).toEqual([
      expect.objectContaining({
        op: "coding-runtime.operation.refused",
        extra: { operation: "answer", runId: "run-1", reason: "replay-cap-exhausted" },
      }),
    ]);
  });

  it("#2478: serves the paired question list as the channel payload with the active session facet", async () => {
    const session = pairedAppSession();
    const listed = await handleCodingRuntimeQuestionList(
      context("{}", { runId: "run-1" }, "/api/coding-workbench/runtime/runs", session.cookie),
      runtime({ codingAppSessionChannel: session.channel }),
    );
    expect(listed).toEqual({ status: 200, body: { session: "active", questions: [] } });
  });

  it("#2478: an unpaired question list yields the one constant content-free projection before any run resolution", async () => {
    const session = pairedAppSession();
    const unpairedProjection = { status: 200, body: { session: "unpaired", questions: [] } };
    // Same constant shape for a live run, an unknown run, a missing runId, and even a server
    // composed without the runtime — the response never becomes an existence oracle (ADR-0141 D6).
    const cases: readonly [Record<string, string>, UiHandlerDeps][] = [
      [{ runId: "run-1" }, runtime({ codingAppSessionChannel: session.channel })],
      [{ runId: "run-9" }, runtime({ codingAppSessionChannel: session.channel })],
      [{}, runtime({ codingAppSessionChannel: session.channel })],
      [
        { runId: "run-1" },
        runtime({ codingAppSessionChannel: session.channel, codingRuntimeOrchestrator: undefined }),
      ],
      [{ runId: "run-1" }, runtime()],
    ];
    for (const [params, deps] of cases) {
      await expect(handleCodingRuntimeQuestionList(context("{}", params), deps)).resolves.toEqual(
        unpairedProjection,
      );
    }
  });

  it("#2387: the paired research route shows the operator the exact host and request line", () => {
    const session = pairedAppSession();
    const reviewed = handleCodingRuntimeResearch(
      context("", { runId: "run-1" }, "/api/coding-workbench/runtime/runs", session.cookie),
      runtime({ codingAppSessionChannel: session.channel }),
    );

    expect(reviewed).toEqual({
      status: 200,
      body: {
        session: "active",
        pending: {
          requestId: "research-approval-1",
          host: "nodejs.org",
          requestLine: "/docs/latest/api/stream.html backpressure",
          expiresAt: "2026-07-13T00:02:00.000Z",
        },
      },
    });
  });

  it("#2387: an unpaired research read yields the constant content-free projection, never the host", () => {
    const session = pairedAppSession();
    const unpairedProjection = { status: 200, body: { session: "unpaired" } };
    // Same constant shape for a live run, an unknown run, a missing runId, and a server composed
    // without the runtime, so the response is not an existence oracle (ADR-0141 D6).
    const cases: readonly [Record<string, string>, UiHandlerDeps][] = [
      [{ runId: "run-1" }, runtime({ codingAppSessionChannel: session.channel })],
      [{ runId: "run-9" }, runtime({ codingAppSessionChannel: session.channel })],
      [{}, runtime({ codingAppSessionChannel: session.channel })],
      [
        { runId: "run-1" },
        runtime({ codingAppSessionChannel: session.channel, codingRuntimeOrchestrator: undefined }),
      ],
      [{ runId: "run-1" }, runtime()],
    ];
    for (const [params, deps] of cases) {
      const result = handleCodingRuntimeResearch(context("", params), deps);
      expect(result).toEqual(unpairedProjection);
      expect(JSON.stringify(result.body)).not.toContain("nodejs.org");
    }
  });

  it("#2387: a paired read of an unknown run conceals existence instead of reporting no ask", () => {
    const session = pairedAppSession();

    const result = handleCodingRuntimeResearch(
      context("", { runId: "run-9" }, "/api/coding-workbench/runtime/runs", session.cookie),
      runtime({ codingAppSessionChannel: session.channel }),
    );

    expect(result.status).toBe(404);
    expect(JSON.stringify(result.body)).not.toContain("nodejs.org");
  });

  it("#2802: the paired approval-review route shows the operator the files the change would write", () => {
    const session = pairedAppSession();

    const reviewed = handleCodingRuntimeApprovalReview(
      context(
        "",
        { runId: "run-1" },
        "/api/coding-workbench/runtime/runs/run-1/approval-review",
        session.cookie,
      ),
      runtime({ codingAppSessionChannel: session.channel }),
    );

    expect(reviewed).toEqual({
      status: 200,
      body: {
        session: "active",
        pending: {
          requestId: "permission-7",
          paths: ["src/alpha.ts", "src/beta.ts"],
          pathsTruncated: false,
          fileCount: 2,
          addedLines: 12,
          deletedLines: 4,
        },
      },
    });
  });

  it("#2802: an unpaired approval-review read yields the constant projection, never a path", () => {
    const session = pairedAppSession();
    const unpairedProjection = { status: 200, body: { session: "unpaired" } };
    // Same constant shape for a live run, an unknown run, a missing runId, and a server composed
    // without the runtime, so the response is not an existence oracle (ADR-0141 D6).
    const cases: readonly [Record<string, string>, UiHandlerDeps][] = [
      [{ runId: "run-1" }, runtime({ codingAppSessionChannel: session.channel })],
      [{ runId: "run-9" }, runtime({ codingAppSessionChannel: session.channel })],
      [{}, runtime({ codingAppSessionChannel: session.channel })],
      [
        { runId: "run-1" },
        runtime({ codingAppSessionChannel: session.channel, codingRuntimeOrchestrator: undefined }),
      ],
      [{ runId: "run-1" }, runtime()],
    ];
    for (const [params, deps] of cases) {
      const result = handleCodingRuntimeApprovalReview(context("", params), deps);
      expect(result).toEqual(unpairedProjection);
      expect(JSON.stringify(result.body)).not.toContain("src/alpha.ts");
    }
  });

  it("#2802: a paired review of an unknown run conceals existence instead of reporting no review", () => {
    const session = pairedAppSession();

    const result = handleCodingRuntimeApprovalReview(
      context(
        "",
        { runId: "run-9" },
        "/api/coding-workbench/runtime/runs/run-9/approval-review",
        session.cookie,
      ),
      runtime({ codingAppSessionChannel: session.channel }),
    );

    expect(result.status).toBe(404);
    expect(JSON.stringify(result.body)).not.toContain("src/alpha.ts");
  });

  it("#2802: the content-free status and run projections never carry a reviewable path", () => {
    const session = pairedAppSession();
    const status = handleCodingRuntimeStatus(
      context("", {}, "/api/coding-workbench/runtime/status", session.cookie),
      runtime({ codingAppSessionChannel: session.channel }),
    );
    const run = handleGetCodingRuntimeRun(
      context("", { runId: "run-1" }, "/api/coding-workbench/runtime/runs/run-1", session.cookie),
      runtime({ codingAppSessionChannel: session.channel }),
    );

    for (const body of [status.body, run.body]) {
      expect(JSON.stringify(body)).not.toContain("src/alpha.ts");
      expect(JSON.stringify(body)).not.toContain("src/beta.ts");
    }
  });

  it("#2387: the content-free status projection never carries the pending research destination", () => {
    const status = handleCodingRuntimeStatus(context(""), runtime());

    expect(JSON.stringify(status.body)).not.toContain("nodejs.org");
    expect(JSON.stringify(status.body)).not.toContain("backpressure");
  });

  it("#2644: rejects caller-controlled status selectors instead of ignoring the request", () => {
    const status = handleCodingRuntimeStatus(
      context("", {}, "/api/coding-workbench/runtime/status?include=research"),
      runtime(),
    );

    expect(status).toMatchObject({
      status: 400,
      body: { error: { code: "CODING_RUNTIME_INVALID_INTENT" } },
    });
    expect(JSON.stringify(status.body)).not.toContain("research");
  });

  it("#2644: serves an approved research host only over the paired research channel", () => {
    const session = pairedAppSession();
    const approvedHost = "approved.example.org";
    const runningSnapshot: CodingWorkbenchRuntimeSnapshot = {
      ...snapshot,
      state: "running",
    };
    const grant = {
      grantId: "grant-1",
      domains: [approvedHost],
      expiresAt: "2026-07-13T00:03:00.000Z",
    };
    const withoutGrant = handleCodingRuntimeStatus(
      context(""),
      runtime({ codingAppSessionChannel: session.channel }, runningSnapshot),
    );
    const unpairedWithGrant = handleCodingRuntimeStatus(
      context(""),
      runtime({ codingAppSessionChannel: session.channel }, runningSnapshot, grant),
    );
    const pairedStatus = handleCodingRuntimeStatus(
      context("", {}, "/api/coding-workbench/runtime/status", session.cookie),
      runtime({ codingAppSessionChannel: session.channel }, runningSnapshot, grant),
    );
    const unpairedResearch = handleCodingRuntimeResearch(
      context("", { runId: "run-1" }),
      runtime({ codingAppSessionChannel: session.channel }, runningSnapshot, grant),
    );
    const pairedResearch = handleCodingRuntimeResearch(
      context(
        "",
        { runId: "run-1" },
        "/api/coding-workbench/runtime/runs/run-1/research",
        session.cookie,
      ),
      runtime({ codingAppSessionChannel: session.channel }, runningSnapshot, grant),
    );

    expect(unpairedWithGrant).toEqual(withoutGrant);
    expect(pairedStatus).toEqual(withoutGrant);
    expect(unpairedResearch).toEqual({ status: 200, body: { session: "unpaired" } });
    expect(pairedResearch).toEqual({
      status: 200,
      body: {
        session: "active",
        pending: {
          requestId: "research-approval-1",
          host: "nodejs.org",
          requestLine: "/docs/latest/api/stream.html backpressure",
          expiresAt: "2026-07-13T00:02:00.000Z",
        },
        grant,
      },
    });
  });

  it("#2478: unpaired question mutations receive the existence-concealing not-found result", async () => {
    const session = pairedAppSession();
    const deps = runtime({ codingAppSessionChannel: session.channel });
    for (const handler of [handleCodingRuntimeQuestionAnswer, handleCodingRuntimeQuestionReject]) {
      const denied = await handler(context("{}", { runId: "run-1" }), deps);
      const unknownRun = await handler(
        context("{}", { runId: "run-9" }, "/api/coding-workbench/runtime/runs", session.cookie),
        deps,
      );
      // Byte-identical to the unknown-run response: a probe cannot tell "not paired" apart.
      expect(denied).toEqual(unknownRun);
      expect(denied.status).toBe(404);
    }
  });

  it("#2478: a rotated-away or revoked cookie loses the question read authority", async () => {
    const session = pairedAppSession();
    const deps = runtime({ codingAppSessionChannel: session.channel });
    session.channel?.signOut(session.cookie.split("=")[1]);
    await expect(
      handleCodingRuntimeQuestionList(
        context("{}", { runId: "run-1" }, "/api/coding-workbench/runtime/runs", session.cookie),
        deps,
      ),
    ).resolves.toEqual({ status: 200, body: { session: "unpaired", questions: [] } });
  });

  it("projects only server-owned readiness facts and computes the effective mode fail-closed", () => {
    const result = handleCodingRuntimeReadiness(
      context("", {}, "/api/coding-workbench/runtime/readiness?requestedMode=autonomous-delivery"),
      runtime({
        // #2475: readiness reports the coding-runtime ceiling — the same knob the mint clamp
        // enforces — never the separate autonomous-delivery ceiling.
        codingRuntimeDeploymentCeiling: "supervised-coding",
        autonomousDeliveryDeploymentCeiling: "autonomous-delivery",
        codingRuntimeHostQualified: true,
        // No live run: the effective mode is the plain ceiling clamp.
        codingRuntimeOrchestrator: undefined,
      }),
    );

    expect(result).toEqual({
      status: 200,
      body: {
        schemaVersion: "1",
        requestedMode: "autonomous-delivery",
        deploymentCeiling: "supervised-coding",
        effectiveMode: "supervised-coding",
        runtimeAvailable: true,
        // ADR-0163 D9 fail-closed default: this deps fixture threads NO evidence class, and an
        // unthreaded path must degrade to the weak value, never silently to a verified claim.
        runtimeEvidenceClass: "functional-not-platform-qualified",
      },
    });
    const serialized = JSON.stringify(result.body);
    for (const forbidden of ["workspace", "authority", "endpoint", "credential", "path"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("names the precise unavailable reason exactly while the runtime host is unqualified", () => {
    const unavailable = handleCodingRuntimeReadiness(
      context("", {}, "/api/coding-workbench/runtime/readiness?requestedMode=supervised-coding"),
      runtime({
        codingRuntimeHostQualified: false,
        codingRuntimeUnavailableReason: "payload-tampered",
        codingRuntimeOrchestrator: undefined,
      }),
    );
    expect(unavailable).toMatchObject({
      status: 200,
      body: { runtimeAvailable: false, runtimeUnavailableReason: "payload-tampered" },
    });

    const fallback = handleCodingRuntimeReadiness(
      context("", {}, "/api/coding-workbench/runtime/readiness?requestedMode=supervised-coding"),
      runtime({ codingRuntimeHostQualified: false, codingRuntimeOrchestrator: undefined }),
    );
    expect(fallback).toMatchObject({
      status: 200,
      body: { runtimeAvailable: false, runtimeUnavailableReason: "runtime-unqualified" },
    });

    const available = handleCodingRuntimeReadiness(
      context("", {}, "/api/coding-workbench/runtime/readiness?requestedMode=supervised-coding"),
      runtime({ codingRuntimeHostQualified: true, codingRuntimeOrchestrator: undefined }),
    );
    expect(
      (available.body as { runtimeUnavailableReason?: string }).runtimeUnavailableReason,
    ).toBeUndefined();
  });

  // #2386 regression, strengthened by the 0.3.0 release audit: the server-confirmed effective mode
  // is anchored to the LIVE run. Requesting a wider mode while a supervised run is live must keep
  // confirming the run's own posture — the original invariant, unchanged.
  //
  // The audit found the NARROWING direction lies in exactly the same way. The envelope's
  // effectiveMode is fixed at mint (runtimeAuthorityService.mintConfirmedStartForRun) and nothing
  // re-mints it — `resume` only clears the manager's paused flag — so confirming `governed-assist`
  // for a paused run minted as `supervised-coding` told the operator the run holds LESS authority
  // than the tool facade actually enforces. Both directions are now pinned for every state in
  // which a run still holds a minted envelope.
  it("anchors the confirmed effective mode to the live run's minted envelope", () => {
    const liveStatus = (state: string): unknown => ({
      ...snapshot,
      state,
      requestedMode: "supervised-coding",
    });
    const readiness = (state: string, requestedMode: string): unknown => {
      const result = handleCodingRuntimeReadiness(
        context("", {}, `/api/coding-workbench/runtime/readiness?requestedMode=${requestedMode}`),
        runtime({
          codingRuntimeDeploymentCeiling: "autonomous-delivery",
          codingRuntimeHostQualified: true,
          codingRuntimeOrchestrator: { status: () => liveStatus(state) },
        }),
      );
      return (result.body as { effectiveMode?: string }).effectiveMode;
    };

    for (const state of [
      "starting",
      "ready",
      "running",
      "awaiting-approval",
      "paused",
      "stopping",
    ]) {
      // Widening past the live run is never confirmed — not even while paused.
      expect(readiness(state, "autonomous-delivery")).toBe("supervised-coding");
      // Neither is narrowing: the live envelope still grants supervised-coding.
      expect(readiness(state, "governed-assist")).toBe("supervised-coding");
    }
    // A run holding no envelope confirms what the next mint will actually clamp the request to.
    expect(readiness("recovery-required", "governed-assist")).toBe("governed-assist");
    expect(readiness("recovery-required", "autonomous-delivery")).toBe("autonomous-delivery");
  });

  it("keeps readiness independently available when the runtime is absent and rejects malformed modes", () => {
    const unavailable = handleCodingRuntimeReadiness(
      context("", {}, "/api/coding-workbench/runtime/readiness?requestedMode=governed-assist"),
      runtime({ codingRuntimeOrchestrator: undefined, codingRuntimeEventHub: undefined }),
    );
    expect(unavailable).toMatchObject({
      status: 200,
      body: {
        requestedMode: "governed-assist",
        deploymentCeiling: "governed-assist",
        effectiveMode: "governed-assist",
        runtimeAvailable: false,
      },
    });

    for (const path of [
      "/api/coding-workbench/runtime/readiness",
      "/api/coding-workbench/runtime/readiness?requestedMode=nope",
      "/api/coding-workbench/runtime/readiness?requestedMode=governed-assist&extra=forged",
      "/api/coding-workbench/runtime/readiness?requestedMode=governed-assist&requestedMode=supervised-coding",
    ]) {
      expect(handleCodingRuntimeReadiness(context("", {}, path), runtime())).toMatchObject({
        status: 400,
        body: { error: { code: "CODING_RUNTIME_INVALID_INTENT" } },
      });
    }
  });

  it("reports the runtime unavailable when lifecycle collaborators exist without a qualified host", () => {
    const result = handleCodingRuntimeReadiness(
      context("", {}, "/api/coding-workbench/runtime/readiness?requestedMode=governed-assist"),
      runtime(),
    );

    expect(result).toMatchObject({
      status: 200,
      body: { runtimeAvailable: false },
    });
  });

  it("parses a bounded JSON body and passes it only to the orchestrator", async () => {
    const session = pairedAppSession();
    const deps = runtime({ codingAppSessionChannel: session.channel });
    const result = await handleCreateCodingRuntimeRun(
      context(
        '{"requestId":"r","taskIntent":"private","requestedMode":"governed-assist"}',
        {},
        "/api/coding-workbench/runtime/runs",
        session.cookie,
      ),
      deps,
    );
    expect(result).toMatchObject({ status: 200, body: { runId: "run-1" } });
    expect((deps as unknown as { __calls: unknown[] }).__calls).toEqual([
      { requestId: "r", taskIntent: "private", requestedMode: "governed-assist" },
    ]);
    expect(JSON.stringify(result.body)).not.toContain("private");
  });

  it("fails closed when runtime dependencies are absent and returns 404 for a stale run", async () => {
    const session = pairedAppSession();
    await expect(
      handleCreateCodingRuntimeRun(
        context("{}", {}, "/api/coding-workbench/runtime/runs", session.cookie),
        { codingAppSessionChannel: session.channel } as UiHandlerDeps,
      ),
    ).resolves.toMatchObject({ status: 503 });
    const stopRoute = CODING_RUNTIME_ROUTE_GROUP.find(({ pattern }) => pattern.endsWith("/stop"));
    if (!stopRoute) throw new Error("missing stop route");
    const stale = await stopRoute.handler(
      context(
        '{"requestId":"gone"}',
        { runId: "gone" },
        "/api/coding-workbench/runtime/runs",
        session.cookie,
      ),
      runtime({ codingAppSessionChannel: session.channel }),
    );
    expect(stale).toMatchObject({ status: 404 });
  });

  it("replays SSE events and closes the heartbeat after a bounded cursor reset", () => {
    vi.useFakeTimers();
    try {
      const response = new FakeResponse();
      const req = new EventEmitter() as unknown as RouteContext["req"];
      const hub = {
        subscribe: (_runId: string, cursor: string | undefined) =>
          cursor === "bad"
            ? {
                ok: false as const,
                reason: "cursor-malformed" as const,
                snapshotNeeded: true as const,
              }
            : { ok: true as const, detach: () => undefined },
      };
      openCodingRuntimeSse(
        response as unknown as RouteContext["res"],
        req,
        hub as never,
        "run-1",
        "bad",
      );
      expect(response.chunks.join("")).toContain("event: reset");
      expect(response.chunks.join("")).toContain("cursor-malformed");
      expect(response.writableEnded).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("destroys a slow SSE connection when the transport applies backpressure", () => {
    const response = new FakeResponse();
    response.write = (): boolean => false;
    const req = new EventEmitter() as unknown as RouteContext["req"];
    const hub = {
      subscribe: (
        _runId: string,
        _cursor: string | undefined,
        subscriber: {
          write: (event: CodingWorkbenchRuntimeSseEvent) => boolean;
        },
      ) => {
        subscriber.write({
          schemaVersion: "1",
          cursor: "run-1:0",
          sequence: 0,
          occurredAt: snapshot.updatedAt,
          kind: "status",
          runId: "run-1",
          state: "ready",
          revision: 2,
        });
        return { ok: true as const, detach: () => undefined };
      },
    };
    openCodingRuntimeSse(
      response as unknown as RouteContext["res"],
      req,
      hub as never,
      "run-1",
      undefined,
    );
    expect(response.destroyed).toBe(true);
  });

  it("opens the event handler as streaming and includes replay data", () => {
    const ctx = context("", { runId: "run-1" });
    ctx.req.headers["last-event-id"] = "run-1:0";
    expect(handleCodingRuntimeEvents(ctx, runtime())).toBe(STREAMING);
    expect((ctx.res as unknown as FakeResponse).chunks.join("")).toContain('"cursor":"run-1:0"');
  });

  it("resumes a watchdog-recreated stream from its query cursor", () => {
    const subscribe = vi.fn(() => ({ ok: true as const, detach: () => undefined }));
    const ctx = context(
      "",
      { runId: "run-1" },
      "/api/coding-workbench/runtime/runs/run-1/events?cursor=run-1%3A42",
    );

    expect(handleCodingRuntimeEvents(ctx, runtime({ codingRuntimeEventHub: { subscribe } }))).toBe(
      STREAMING,
    );
    expect(subscribe).toHaveBeenCalledWith("run-1", "run-1:42", expect.any(Object));
  });

  it("treats an empty Last-Event-ID header as an absent cursor", () => {
    const subscribe = vi.fn(() => ({ ok: true as const, detach: () => undefined }));
    const ctx = context("", { runId: "run-1" });
    ctx.req.headers["last-event-id"] = "";

    expect(handleCodingRuntimeEvents(ctx, runtime({ codingRuntimeEventHub: { subscribe } }))).toBe(
      STREAMING,
    );
    expect(subscribe).toHaveBeenCalledWith("run-1", undefined, expect.any(Object));
  });

  it("does not fall back to a query cursor for repeated Last-Event-ID headers", () => {
    const subscribe = vi.fn(() => ({ ok: true as const, detach: () => undefined }));
    const ctx = context(
      "",
      { runId: "run-1" },
      "/api/coding-workbench/runtime/runs/run-1/events?cursor=run-1%3A42",
    );
    ctx.req.headers["last-event-id"] = ["run-1:1", "run-1:2"];

    expect(handleCodingRuntimeEvents(ctx, runtime({ codingRuntimeEventHub: { subscribe } }))).toBe(
      STREAMING,
    );
    expect(subscribe).toHaveBeenCalledWith("run-1", undefined, expect.any(Object));
  });

  it("keeps an idle runtime event stream alive and stops heartbeats on close", async () => {
    vi.useFakeTimers();
    try {
      const response = new FakeResponse();
      const req = new EventEmitter() as unknown as RouteContext["req"];
      const hub = {
        subscribe: () => ({ ok: true as const, detach: () => undefined }),
      };
      openCodingRuntimeSse(
        response as unknown as RouteContext["res"],
        req,
        hub as never,
        "run-1",
        undefined,
      );

      await vi.advanceTimersByTimeAsync(15_000);
      expect(response.chunks).toContain(": keep-alive\n\n");
      expect(response.chunks).toContain("event: heartbeat\ndata: {}\n\n");
      response.destroy();
      const heartbeatCount = response.chunks.length;
      await vi.advanceTimersByTimeAsync(15_000);
      expect(response.chunks).toHaveLength(heartbeatCount);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects an over-budget mutation body with 413 without buffering it", async () => {
    const session = pairedAppSession();
    const oversized = "x".repeat(64 * 1024 + 1);
    const result = await handleCreateCodingRuntimeRun(
      context(
        JSON.stringify({ padding: oversized }),
        {},
        "/api/coding-workbench/runtime/runs",
        session.cookie,
      ),
      runtime({ codingAppSessionChannel: session.channel }),
    );
    expect(result).toMatchObject({ status: 413 });
    expect(JSON.stringify(result.body)).toContain("PAYLOAD_TOO_LARGE");
    expect(JSON.stringify(result.body)).not.toContain("xxxx");
  });

  it("normalizes an empty mutation body to an empty object for the orchestrator", async () => {
    const session = pairedAppSession();
    const deps = runtime({ codingAppSessionChannel: session.channel });
    const result = await handleCreateCodingRuntimeRun(
      context("", {}, "/api/coding-workbench/runtime/runs", session.cookie),
      deps,
    );
    expect(result).toMatchObject({ status: 200 });
    expect((deps as unknown as { __calls: unknown[] }).__calls).toEqual([{}]);
  });

  it.each([
    ["malformed JSON", "not json"],
    ["a JSON array", "[1,2,3]"],
    ["a JSON scalar", "42"],
  ])("rejects %s mutation bodies as invalid intent", async (_label, body) => {
    const session = pairedAppSession();
    const result = await handleCreateCodingRuntimeRun(
      context(body, {}, "/api/coding-workbench/runtime/runs", session.cookie),
      runtime({ codingAppSessionChannel: session.channel }),
    );
    expect(result).toMatchObject({ status: 400 });
    expect(JSON.stringify(result.body)).toContain("CODING_RUNTIME_INVALID_INTENT");
  });

  it("propagates unexpected orchestrator failures to the server diagnostic boundary", async () => {
    const session = pairedAppSession();
    const deps = runtime({ codingAppSessionChannel: session.channel });
    const orchestrator = deps.codingRuntimeOrchestrator as unknown as {
      start: (body: unknown) => Promise<never>;
    };
    const failure = new Error("runtime-start-failure");
    orchestrator.start = () => Promise.reject(failure);

    await expect(
      handleCreateCodingRuntimeRun(
        context("{}", {}, "/api/coding-workbench/runtime/runs", session.cookie),
        deps,
      ),
    ).rejects.toBe(failure);
  });

  it("serves the singleton status and fails closed without the runtime", () => {
    expect(handleCodingRuntimeStatus(context(""), runtime())).toEqual({
      status: 200,
      body: snapshot,
    });
    expect(
      handleCodingRuntimeStatus(context(""), {
        codingRuntimeOrchestrator: undefined,
      } as unknown as UiHandlerDeps),
    ).toMatchObject({ status: 503 });
  });

  it("serves a run snapshot by id and 404s an unknown run", () => {
    expect(handleGetCodingRuntimeRun(context("", { runId: "run-1" }), runtime())).toEqual({
      status: 200,
      body: snapshot,
    });
    expect(handleGetCodingRuntimeRun(context("", { runId: "run-9" }), runtime())).toMatchObject({
      status: 404,
    });
  });

  it.each([
    ["approval", handleCodingRuntimeApproval],
    ["stop", handleCodingRuntimeStop],
    ["takeover", handleCodingRuntimeTakeover],
    ["retry", handleCodingRuntimeRetry],
    ["recovery acknowledgement", handleCodingRuntimeRecoveryAcknowledgement],
  ] as const)("routes the %s mutation to the live run only", async (_label, handler) => {
    const session = pairedAppSession();
    const runPath = "/api/coding-workbench/runtime/runs";
    const deps = runtime({ codingAppSessionChannel: session.channel });
    await expect(
      handler(context("{}", { runId: "run-1" }, runPath, session.cookie), deps),
    ).resolves.toMatchObject({ status: 200, body: snapshot });
    await expect(handler(context("{}", {}, runPath, session.cookie), deps)).resolves.toMatchObject({
      status: 404,
    });
    await expect(
      handler(context("{}", { runId: "run-9" }, runPath, session.cookie), deps),
    ).resolves.toMatchObject({ status: 404 });
  });

  it("detaches the SSE subscriber exactly once when the response closes", () => {
    const ctx = context("", { runId: "run-1" });
    let detached = 0;
    const hub = {
      subscribe: () => ({
        ok: true as const,
        detach: () => {
          detached += 1;
        },
      }),
    };
    openCodingRuntimeSse(ctx.res, ctx.req, hub as never, "run-1", undefined);
    const response = ctx.res as unknown as FakeResponse;
    response.destroy();
    response.destroy();
    expect(detached).toBe(1);
    // A destroyed transport is never end()ed again; the guard must not double-finalize it.
    expect(response.writableEnded).toBe(false);
  });
});

// Release-audit P0: every authority-granting coding-runtime mutation — start, approve, stop,
// takeover, retry, recovery-ack, pause, resume, follow-up, research revoke — was reachable by any
// same-user local process that could set the constant CSRF header. ADR-0141 D1 fixes loopback,
// Origin, CSRF and runId knowledge as routing facts that never grant a route; D2 makes the
// launcher-attested app session the authority. These routes bind to it and fail closed.
// The one POST in the group that is a READ, not a mutation: the question list keeps its documented
// ADR-0141 F1 content-free `{ session: "unpaired", questions: [] }` projection (HTTP 200) instead of
// a denial, so the sweep asserts that exact shape for it rather than exempting it.
const UNPAIRED_CONTENT_FREE_POST = "/api/coding-workbench/runtime/runs/:runId/questions";

const STATE_CHANGING_RUNTIME_ROUTES: readonly RouteDefinition[] = CODING_RUNTIME_ROUTE_GROUP.filter(
  ({ method, pattern }) => method === "POST" && pattern !== UNPAIRED_CONTENT_FREE_POST,
);

const RUNTIME_POST_ROUTES: readonly RouteDefinition[] = CODING_RUNTIME_ROUTE_GROUP.filter(
  ({ method }) => method === "POST",
);

interface SpyingRuntime {
  readonly deps: UiHandlerDeps;
  readonly invoked: readonly string[];
}

/** Deps whose orchestrator records every lifecycle call, so a denial can be proven to reach none. */
function spyingRuntime(channel: UiHandlerDeps["codingAppSessionChannel"]): SpyingRuntime {
  const invoked: string[] = [];
  const settle = (name: string) => () => {
    invoked.push(name);
    return Promise.resolve({ ok: true as const, snapshot });
  };
  const orchestrator = {
    start: settle("start"),
    retry: settle("retry"),
    decideApproval: settle("decideApproval"),
    stop: settle("stop"),
    takeover: settle("takeover"),
    acknowledgeRecovery: settle("acknowledgeRecovery"),
    pause: settle("pause"),
    resume: settle("resume"),
    revokeResearch: settle("revokeResearch"),
    submitFollowUp: settle("submitFollowUp"),
    answerQuestion: settle("answerQuestion"),
    rejectQuestion: settle("rejectQuestion"),
    listQuestions: () => {
      invoked.push("listQuestions");
      return Promise.resolve({
        ok: true as const,
        snapshot,
        questions: { schemaVersion: "1" as const, questions: [] },
      });
    },
    status: () => snapshot,
    getSnapshot: (runId: string) => (runId === "run-1" ? snapshot : undefined),
    pendingResearchAsk: () => undefined,
    researchGrant: () => undefined,
  };
  return {
    deps: {
      codingRuntimeOrchestrator: orchestrator,
      codingRuntimeEventHub: { subscribe: () => ({ ok: false as const, reason: "unused" }) },
      codingAppSessionChannel: channel,
    } as unknown as UiHandlerDeps,
    get invoked(): readonly string[] {
      return invoked;
    },
  };
}

function statusOf(outcome: HandlerOutcome): number {
  return outcome === STREAMING ? 200 : outcome.status;
}

async function invokeRoute(
  route: RouteDefinition,
  deps: UiHandlerDeps,
  cookie?: string,
): Promise<HandlerOutcome> {
  return Promise.resolve(
    route.handler(context("{}", { runId: "run-1" }, route.pattern, cookie), deps),
  );
}

describe("coding runtime mutation authority boundary (ADR-0141 D1/D2)", () => {
  it("denies every state-changing runtime route to a caller that presents no app session", async () => {
    const { channel } = pairedAppSession();
    // The sweep is over the mounted group, so a lifecycle route added later is covered by default.
    expect(STATE_CHANGING_RUNTIME_ROUTES.length).toBeGreaterThan(9);
    for (const route of STATE_CHANGING_RUNTIME_ROUTES) {
      const spy = spyingRuntime(channel);
      const outcome = await invokeRoute(route, spy.deps);
      expect(statusOf(outcome), route.pattern).not.toBe(200);
      expect(spy.invoked, route.pattern).toEqual([]);
    }
  });

  it("reaches no orchestrator operation at all from any unpaired POST in the runtime group", async () => {
    const { channel } = pairedAppSession();
    for (const route of RUNTIME_POST_ROUTES) {
      const spy = spyingRuntime(channel);
      const outcome = await invokeRoute(route, spy.deps);
      expect(spy.invoked, route.pattern).toEqual([]);
      if (route.pattern === UNPAIRED_CONTENT_FREE_POST) {
        expect(outcome, route.pattern).toEqual({
          status: 200,
          body: { session: "unpaired", questions: [] },
        });
      }
    }
  });

  it("denies a forged, revoked, or idle-expired session on every state-changing runtime route", async () => {
    const forged = `${APP_SESSION_COOKIE_NAME}=sess_000000000000000000000000.forged`;
    const revokedSession = pairedAppSession();
    revokedSession.channel?.signOut(
      revokedSession.cookie.slice(revokedSession.cookie.indexOf("=") + 1),
    );
    let clock = 0;
    const expiring = createCodingAppSessionChannel({
      registry: createSessionRegistry({ now: () => clock, idleTtlMs: 10, absoluteTtlMs: 1_000 }),
      pairingPort: createFakeSessionPairingPort(),
    });
    const expired = expiring.pair(fakePairingRequestBody());
    if (!expired.paired) throw new Error("test pairing failed");
    clock = 1_000;
    const hostile: readonly (readonly [
      string,
      UiHandlerDeps["codingAppSessionChannel"],
      string,
    ])[] = [
      ["forged", revokedSession.channel, forged],
      ["revoked", revokedSession.channel, revokedSession.cookie],
      ["idle-expired", expiring, `${APP_SESSION_COOKIE_NAME}=${expired.cookieToken}`],
      ["empty cookie value", revokedSession.channel, `${APP_SESSION_COOKIE_NAME}=`],
      ["another window's cookie prefix", revokedSession.channel, "unrelated=value"],
    ];
    for (const [label, channel, cookie] of hostile) {
      for (const route of STATE_CHANGING_RUNTIME_ROUTES) {
        const spy = spyingRuntime(channel);
        const outcome = await invokeRoute(route, spy.deps, cookie);
        expect(statusOf(outcome), `${label} ${route.pattern}`).not.toBe(200);
        expect(spy.invoked, `${label} ${route.pattern}`).toEqual([]);
      }
    }
  });

  it("fails closed on every state-changing runtime route when no app-session channel is composed", async () => {
    const { cookie } = pairedAppSession();
    for (const route of STATE_CHANGING_RUNTIME_ROUTES) {
      const spy = spyingRuntime(undefined);
      const outcome = await invokeRoute(route, spy.deps, cookie);
      expect(statusOf(outcome), route.pattern).not.toBe(200);
      expect(spy.invoked, route.pattern).toEqual([]);
    }
  });

  it("admits every state-changing runtime route for the launcher-attested paired caller", async () => {
    const { channel, cookie } = pairedAppSession();
    for (const route of STATE_CHANGING_RUNTIME_ROUTES) {
      const spy = spyingRuntime(channel);
      const outcome = await invokeRoute(route, spy.deps, cookie);
      expect(statusOf(outcome), route.pattern).toBe(200);
      expect(spy.invoked, route.pattern).toHaveLength(1);
    }
  });

  it("resolves authority before run existence, so an unpaired per-run denial is byte-identical to an unknown run", async () => {
    const { channel, cookie } = pairedAppSession();
    const perRun = STATE_CHANGING_RUNTIME_ROUTES.filter(({ pattern }) =>
      pattern.includes(":runId"),
    );
    for (const route of perRun) {
      const deps = spyingRuntime(channel).deps;
      const unpaired = await Promise.resolve(
        route.handler(context("{}", { runId: "run-1" }, route.pattern), deps),
      );
      const unknownRun = await Promise.resolve(
        route.handler(context("{}", { runId: "run-9" }, route.pattern, cookie), deps),
      );
      expect(unpaired, route.pattern).toEqual(unknownRun);
      expect(statusOf(unpaired), route.pattern).toBe(404);
    }
  });

  it("answers an unpaired run start with the honest authority-resolution failure, never a silent success", async () => {
    const { channel } = pairedAppSession();
    const spy = spyingRuntime(channel);
    const denied = await handleCreateCodingRuntimeRun(
      context('{"requestId":"r","taskIntent":"secret","requestedMode":"governed-assist"}'),
      spy.deps,
    );
    expect(denied).toMatchObject({
      status: 403,
      body: { error: { code: "CODING_RUNTIME_AUTHORITY_RESOLUTION_FAILED" } },
    });
    expect(spy.invoked).toEqual([]);
    expect(JSON.stringify(denied.body)).not.toContain("secret");
  });

  // The recorded attack, end to end: the unauthenticated status route publishes the pending
  // permission's requestId and the snapshot revision — the two values `approvalChallengeMatches`
  // binds on. Knowing them is now worthless, because the challenge is only spendable by a caller
  // that also holds the launcher-attested session, which no route publishes and no same-user local
  // process can mint (ADR-0141 D1: routing facts are never authority).
  it("refuses an approval minted from the challenge binding harvested off the unauthenticated status route", async () => {
    const { channel } = pairedAppSession();
    const awaitingApproval: CodingWorkbenchRuntimeSnapshot = {
      ...snapshot,
      state: "awaiting-approval",
      pendingPermission: {
        requestId: "permission-1",
        kind: "workspace-write",
        actionClass: "workspace-write",
        reasonCode: "approval-required",
        actionKind: "file-edit",
        expiresAt: "2099-07-13T00:05:00.000Z",
      },
    };
    const spy = spyingRuntime(channel);
    const deps = {
      ...spy.deps,
      codingRuntimeOrchestrator: {
        ...(spy.deps.codingRuntimeOrchestrator as object),
        status: () => awaitingApproval,
        getSnapshot: (runId: string) => (runId === "run-1" ? awaitingApproval : undefined),
      },
    } as unknown as UiHandlerDeps;

    const harvested = handleCodingRuntimeStatus(context(""), deps);
    const published = harvested.body as CodingWorkbenchRuntimeSnapshot;
    expect(published.pendingPermission?.requestId).toBe("permission-1");

    const replayed = await handleCodingRuntimeApproval(
      context(
        JSON.stringify({
          requestId: published.pendingPermission?.requestId,
          decision: "approved",
          expectedRevision: published.revision,
        }),
        { runId: published.runId ?? "" },
        "/api/coding-workbench/runtime/runs",
      ),
      deps,
    );

    expect(replayed).toMatchObject({ status: 404 });
    expect(spy.invoked).toEqual([]);
  });

  it("denies an unpaired caller before the body is read, so an oversized hostile body is never buffered", async () => {
    const { channel } = pairedAppSession();
    const spy = spyingRuntime(channel);
    const denied = await handleCodingRuntimeFollowUp(
      context(
        JSON.stringify({ taskIntent: "x".repeat(64 * 1024 + 1) }),
        { runId: "run-1" },
        "/api/coding-workbench/runtime/runs",
      ),
      spy.deps,
    );
    expect(denied).toMatchObject({ status: 404 });
    expect(spy.invoked).toEqual([]);
    expect(JSON.stringify(denied.body)).not.toContain("xxxx");
  });
});
