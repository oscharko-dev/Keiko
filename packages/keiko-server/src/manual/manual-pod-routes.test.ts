// Route trust-boundary proof for the manual-pod create/refresh/status BFF surface (Issue #2063).
// The handlers validate the request against the contract validators before any job starts and thread
// the correlation id into every fail-closed error body. No crawl or model call is exercised here.

import { describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import type { RouteContext } from "../routes.js";
import type { UiHandlerDeps } from "../deps.js";
import {
  handleCreateHtmlManualPod,
  handleGetHtmlManualPodJob,
  handleRefreshHtmlManualPod,
  type ManualPodRouteService,
} from "./manual-pod-routes.js";
import { initialJob, manualPodJobRegistry } from "./manual-pod-service.js";

function jsonRequest(body: Record<string, unknown> | undefined): IncomingMessage {
  const bytes = body === undefined ? [] : [Buffer.from(JSON.stringify(body), "utf8")];
  const req = Readable.from(bytes) as IncomingMessage;
  req.method = "POST";
  req.headers = { "content-type": "application/json", "x-keiko-csrf": "1" };
  return req;
}

function ctxFor(params: Record<string, string>, body?: Record<string, unknown>): RouteContext {
  return {
    req: jsonRequest(body),
    res: {} as never,
    params,
    url: new URL("http://127.0.0.1/api/local-knowledge/manual-pods/refresh"),
    correlationId: "corr-xyz",
  };
}

const FAKE_DEPS = {} as UiHandlerDeps;

describe("handleGetHtmlManualPodJob", () => {
  it("returns 400 when the jobId path param is missing", () => {
    const result = handleGetHtmlManualPodJob(ctxFor({}));
    expect(result.status).toBe(400);
  });

  it("returns 404 (with a correlation id) for an unknown job", () => {
    const result = handleGetHtmlManualPodJob(ctxFor({ jobId: "does-not-exist" }));
    expect(result.status).toBe(404);
    expect(JSON.stringify(result.body)).toContain("corr-xyz");
  });

  it("returns 200 and the job for a registered job", () => {
    manualPodJobRegistry.register(
      initialJob("route-test-job", "refresh", "cap-1", "src-1"),
      new AbortController(),
    );
    const result = handleGetHtmlManualPodJob(ctxFor({ jobId: "route-test-job" }));
    expect(result.status).toBe(200);
    expect((result.body as { jobId: string }).jobId).toBe("route-test-job");
  });
});

describe("handleRefreshHtmlManualPod", () => {
  it("rejects an invalid refresh body with a 400 before starting a job", async () => {
    const result = await handleRefreshHtmlManualPod(ctxFor({}, { capsuleId: "../etc" }), FAKE_DEPS);
    expect(result.status).toBe(400);
    expect(JSON.stringify(result.body)).toContain("corr-xyz");
  });
});

describe("handleCreateHtmlManualPod", () => {
  it("rejects an unsafe origin with a 400 before starting a job", async () => {
    const result = await handleCreateHtmlManualPod(
      ctxFor({}, { displayName: "x", origin: "ftp://evil/x" }),
      FAKE_DEPS,
    );
    expect(result.status).toBe(400);
  });

  it("rejects a request body that is not a JSON object with a 400", async () => {
    const req = Readable.from([Buffer.from("[]", "utf8")]) as IncomingMessage;
    req.method = "POST";
    req.headers = { "content-type": "application/json" };
    const ctx: RouteContext = {
      req,
      res: {} as never,
      params: {},
      url: new URL("http://127.0.0.1/api/local-knowledge/manual-pods/create"),
      correlationId: "corr-json",
    };
    const result = await handleCreateHtmlManualPod(ctx, FAKE_DEPS);
    expect(result.status).toBe(400);
  });
});

describe("manual-pod route success + service-error mapping (injected service)", () => {
  it("returns 202 and the job when the refresh service starts a job", async () => {
    const job = initialJob("route-ok", "refresh", "cap", "src");
    const service: ManualPodRouteService = {
      startRefresh: vi.fn().mockReturnValue({ ok: true, job }),
      startCreate: vi.fn(),
    };
    const result = await handleRefreshHtmlManualPod(
      ctxFor({}, { capsuleId: "cap", sourceId: "src" }),
      FAKE_DEPS,
      service,
    );
    expect(result.status).toBe(202);
    expect((result.body as { jobId: string }).jobId).toBe("route-ok");
  });

  it("maps a no-embedding-model service result to a 409 with a correlation id", async () => {
    const service: ManualPodRouteService = {
      startRefresh: vi.fn().mockReturnValue({ ok: false, reason: "no-embedding-model" }),
      startCreate: vi.fn(),
    };
    const result = await handleRefreshHtmlManualPod(
      ctxFor({}, { capsuleId: "cap", sourceId: "src" }),
      FAKE_DEPS,
      service,
    );
    expect(result.status).toBe(409);
    expect(JSON.stringify(result.body)).toContain("corr-xyz");
  });

  // LK-003: refresh must fail closed with a 409 (not silently start a second job) when the
  // service reports a job already running for this capsule.
  it("maps a job-already-running service result to a 409 with a correlation id", async () => {
    const service: ManualPodRouteService = {
      startRefresh: vi.fn().mockReturnValue({ ok: false, reason: "job-already-running" }),
      startCreate: vi.fn(),
    };
    const result = await handleRefreshHtmlManualPod(
      ctxFor({}, { capsuleId: "cap", sourceId: "src" }),
      FAKE_DEPS,
      service,
    );
    expect(result.status).toBe(409);
    expect(JSON.stringify(result.body)).toContain("corr-xyz");
    expect(JSON.stringify(result.body)).toContain("MANUAL_POD_JOB_ALREADY_RUNNING");
  });

  it("returns 202 for a create job and maps invalid-source to 400", async () => {
    const job = initialJob("route-create", "create", "cap", "src");
    const okService: ManualPodRouteService = {
      startRefresh: vi.fn(),
      startCreate: vi.fn().mockResolvedValue({ ok: true, job }),
    };
    const ok = await handleCreateHtmlManualPod(
      ctxFor({}, { displayName: "Ops", origin: "https://manual.example.com" }),
      FAKE_DEPS,
      okService,
    );
    expect(ok.status).toBe(202);

    const badService: ManualPodRouteService = {
      startRefresh: vi.fn(),
      startCreate: vi.fn().mockResolvedValue({ ok: false, reason: "invalid-source" }),
    };
    const bad = await handleCreateHtmlManualPod(
      ctxFor({}, { displayName: "Ops", origin: "https://manual.example.com" }),
      FAKE_DEPS,
      badService,
    );
    expect(bad.status).toBe(400);
  });
});
