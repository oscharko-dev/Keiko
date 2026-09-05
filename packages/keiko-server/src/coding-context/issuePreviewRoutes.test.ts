import { EventEmitter } from "node:events";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFakeSessionPairingPort,
  fakePairingRequestBody,
} from "../coding-app-session/_support.js";
import { createCodingAppSessionChannel } from "../coding-app-session/sessionChannel.js";
import { APP_SESSION_COOKIE_NAME } from "../coding-app-session/sessionCookie.js";
import { createSessionRegistry } from "../coding-app-session/sessionRegistry.js";
import type { UiHandlerDeps } from "../deps.js";
import type { ServerDiagnosticRecord } from "../diagnostics-log.js";
import { createBufferedServerLogSink } from "../observability/index.js";
import type { RouteContext } from "../routes.js";
import { createInMemoryUiStore } from "../store/index.js";
import type { GitHubIssueResolver } from "./githubIssueResolution.js";
import { createCodingWorkbenchIssuePreviewHandler } from "./issuePreviewRoutes.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function fixture(
  rawBody?: string,
  registered = true,
): {
  readonly ctx: RouteContext;
  readonly deps: UiHandlerDeps;
  readonly activity: ReturnType<typeof createBufferedServerLogSink>;
  readonly diagnostics: ServerDiagnosticRecord[];
} {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-preview-route-")));
  const store = createInMemoryUiStore();
  cleanups.push(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  if (registered) store.createProject(root, "selected");
  const channel = createCodingAppSessionChannel({
    registry: createSessionRegistry(),
    pairingPort: createFakeSessionPairingPort(),
  });
  const pairing = channel.pair(fakePairingRequestBody());
  if (!pairing.paired) throw new Error("test pairing failed");
  const req = Readable.from([
    Buffer.from(rawBody ?? JSON.stringify({ repositoryPath: root, issueRef: "#42" })),
  ]) as RouteContext["req"];
  req.headers = { cookie: `${APP_SESSION_COOKIE_NAME}=${pairing.cookieToken}` };
  req.complete = true;
  const res = Object.assign(new EventEmitter(), {
    writableEnded: false,
    closed: false,
    destroyed: false,
  });
  const ctx: RouteContext = {
    req,
    res: res as unknown as RouteContext["res"],
    params: {},
    url: new URL("http://127.0.0.1/api/coding-workbench/issue/preview"),
    correlationId: "preview-cancel",
  };
  const activity = createBufferedServerLogSink();
  const diagnostics: ServerDiagnosticRecord[] = [];
  const deps = {
    store,
    codingAppSessionChannel: channel,
    activityLog: activity,
    diagnostics: {
      record: (record: ServerDiagnosticRecord): void => {
        diagnostics.push(record);
      },
    },
  } as unknown as UiHandlerDeps;
  return { ctx, deps, activity, diagnostics };
}

describe("issue preview request lifecycle", () => {
  it.each([
    ["malformed JSON", "{", 400],
    ["invalid wire fields", '{"rawAuthority":"untrusted"}', 400],
    ["route byte limit", " ".repeat(1_025), 413],
    ["transport byte limit", " ".repeat(65_537), 413],
  ] as const)("rejects %s before invoking a resolver", async (_label, rawBody, status) => {
    const f = fixture(rawBody);
    const resolver = vi.fn<GitHubIssueResolver>();
    const result = await createCodingWorkbenchIssuePreviewHandler(resolver)(f.ctx, f.deps);
    expect(result.status).toBe(status);
    expect(resolver).not.toHaveBeenCalled();
  });

  it("rejects an unregistered checkout without invoking a resolver", async () => {
    const f = fixture(undefined, false);
    const resolver = vi.fn<GitHubIssueResolver>();
    const result = await createCodingWorkbenchIssuePreviewHandler(resolver)(f.ctx, f.deps);
    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ error: { code: "UNKNOWN_REPOSITORY" } });
    expect(resolver).not.toHaveBeenCalled();
  });

  it("reports an upstream exception with correlated redacted diagnostics and disposes listeners", async () => {
    const f = fixture();
    const hostileMessage = "secret issue body at https://private.example/patient";
    const resolver: GitHubIssueResolver = () => Promise.reject(new Error(hostileMessage));
    const result = await createCodingWorkbenchIssuePreviewHandler(resolver)(f.ctx, f.deps);
    expect(result.status).toBe(502);
    expect(result.body).toMatchObject({
      error: { code: "CODING_WORKBENCH_ISSUE_PREVIEW_FAILED", correlationId: f.ctx.correlationId },
    });
    expect(f.diagnostics).toHaveLength(1);
    expect(f.diagnostics[0]).toMatchObject({
      correlationId: f.ctx.correlationId,
      operation: "coding-workbench.issue.preview",
    });
    expect(
      JSON.stringify({ result, diagnostics: f.diagnostics, events: f.activity.events }),
    ).not.toContain(hostileMessage);
    expect(f.ctx.req.listenerCount("aborted")).toBe(0);
    expect(f.ctx.res.listenerCount("close")).toBe(0);
  });

  it("cancels upstream reads when the response closes after the request body completed", async () => {
    const f = fixture();
    const resolver: GitHubIssueResolver = (_deps, input) => {
      f.ctx.res.emit("close");
      return Promise.resolve({
        ok: false,
        failure: input.signal?.aborted ? "cancelled" : "issue-unavailable",
      });
    };
    const result = await createCodingWorkbenchIssuePreviewHandler(resolver)(f.ctx, f.deps);
    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ failure: "cancelled" });
    expect(f.activity.events).toContainEqual(
      expect.objectContaining({
        op: "coding-workbench.issue.previewed",
        correlationId: "preview-cancel",
        extra: { outcome: "cancelled" },
      }),
    );
    expect(f.ctx.req.listenerCount("aborted")).toBe(0);
    expect(f.ctx.res.listenerCount("close")).toBe(0);
  });

  it("keeps internal resolver failure reasons out of the existing HTTP envelope", async () => {
    const f = fixture();
    const resolver: GitHubIssueResolver = () =>
      Promise.resolve({
        ok: false,
        failure: "issue-unavailable",
        failureReason: "read-failed",
      });
    const result = await createCodingWorkbenchIssuePreviewHandler(resolver)(f.ctx, f.deps);
    expect(result.body).toMatchObject({ failure: "issue-unavailable" });
    expect(result.body).not.toHaveProperty("failureReason");
    expect(JSON.stringify(result.body)).not.toContain("read-failed");
  });

  it("reports a transient gh read failure as a distinct, retry-worded status (B5-13)", async () => {
    const f = fixture();
    const resolver: GitHubIssueResolver = () =>
      Promise.resolve({
        ok: false,
        failure: "issue-unavailable",
        failureReason: "read-transient-failure",
      });
    const result = await createCodingWorkbenchIssuePreviewHandler(resolver)(f.ctx, f.deps);
    expect(result.status).toBe(503);
    expect(result.body).toMatchObject({
      failure: "issue-unavailable",
      error: { code: "CODING_WORKBENCH_ISSUE_READ_TRANSIENT_FAILURE" },
    });
  });

  it("disposes transport listeners after a completed resolver refusal", async () => {
    const f = fixture();
    const resolver: GitHubIssueResolver = () =>
      Promise.resolve({ ok: false, failure: "auth-required" });
    expect((await createCodingWorkbenchIssuePreviewHandler(resolver)(f.ctx, f.deps)).status).toBe(
      403,
    );
    expect(f.ctx.req.listenerCount("aborted")).toBe(0);
    expect(f.ctx.res.listenerCount("close")).toBe(0);
  });

  it("refuses unpaired requests before reading their body or resolving upstream", async () => {
    const f = fixture();
    f.ctx.req.headers = {};
    const resolver = vi.fn<GitHubIssueResolver>();
    const result = await createCodingWorkbenchIssuePreviewHandler(resolver)(f.ctx, f.deps);
    expect(result.status).toBe(403);
    expect(result.body).toMatchObject({ failure: "authority-denied" });
    expect(resolver).not.toHaveBeenCalled();
    expect(f.ctx.req.readableDidRead).toBe(false);
  });
});
