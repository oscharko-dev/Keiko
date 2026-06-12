// Unit tests for handleStartQiRun source validation.
//
// Covers the single-file absolute-path guard (Epic #709/#791) and the capsule source parsing path
// (Epic #710, Issue #716): a valid capsuleId parses cleanly; a missing/empty/whitespace capsuleId
// returns 400. The SSE execution contracts live in runExecution.test.ts.

import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import type { EvidenceStore } from "@oscharko-dev/keiko-evidence";
import type { QualityIntelligence as QI } from "@oscharko-dev/keiko-contracts";
import type { Redactor, UiHandlerDeps } from "../../deps.js";
import { buildRedactor, createInMemoryUiStore, createRunRegistry, STREAMING } from "../../index.js";
import type { RouteContext, RouteResult } from "../../routes.js";
import { handleStartQiRun, toStreamEvent } from "../runRoutes.js";

// ─── Fixture helpers ───────────────────────────────────────────────────────────

function emptyStore(): EvidenceStore {
  return { put: () => "", list: () => [], get: () => undefined, delete: () => undefined };
}

function deps(): UiHandlerDeps {
  return {
    config: undefined,
    configPresent: false,
    evidenceStore: emptyStore(),
    env: {},
    redactor: buildRedactor({}),
    registry: createRunRegistry(),
    modelPortFactory: () => undefined,
    store: createInMemoryUiStore(),
    evidenceDir: undefined,
  };
}

function makeReq(body: Record<string, unknown>): IncomingMessage {
  return Readable.from([Buffer.from(JSON.stringify(body), "utf8")]) as unknown as IncomingMessage;
}

class MockResponse extends EventEmitter {
  public statusCode: number | undefined;
  public headers: Record<string, string> | undefined;
  public chunks: string[] = [];
  public ended = false;

  writeHead(statusCode: number, headers: Record<string, string>): this {
    this.statusCode = statusCode;
    this.headers = headers;
    return this;
  }

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }

  end(): this {
    this.ended = true;
    return this;
  }
}

function ctx(req: IncomingMessage, res: MockResponse): RouteContext {
  return {
    req,
    res: res as unknown as ServerResponse,
    params: {},
    url: new URL("http://127.0.0.1/api/quality-intelligence/runs"),
  };
}

function asResult(outcome: RouteResult | typeof STREAMING): RouteResult {
  if (outcome === STREAMING) throw new Error("expected RouteResult, got STREAMING");
  return outcome;
}

describe("handleStartQiRun — single-file absolute-path validation", () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("returns 400 QI_BAD_SOURCE before streaming for a relative file source path", async () => {
    const res = new MockResponse();
    const result = asResult(
      await handleStartQiRun(
        ctx(
          makeReq({
            sources: [{ kind: "file", label: "Relative", path: "docs/spec.md" }],
          }),
          res,
        ),
        deps(),
      ),
    );

    expect(result.status).toBe(400);
    expect((result.body as { error: { code: string; message: string } }).error).toMatchObject({
      code: "QI_BAD_SOURCE",
    });
    expect((result.body as { error: { code: string; message: string } }).error.message).toMatch(
      /absolute local paths/i,
    );
    expect(res.statusCode).toBeUndefined();
    expect(res.chunks).toHaveLength(0);
  });

  it("keeps an absolute file source on the SSE path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qi-start-route-"));
    tmpDirs.push(dir);
    const path = join(dir, "spec.md");
    writeFileSync(path, "# Spec\nThe system shall generate cases.\n", "utf8");
    const res = new MockResponse();

    const outcome = await handleStartQiRun(
      ctx(
        makeReq({
          sources: [{ kind: "file", label: "Absolute", path }],
        }),
        res,
      ),
      deps(),
    );

    expect(outcome).toBe(STREAMING);
    expect(res.statusCode).toBe(200);
    expect(res.headers?.["Content-Type"]).toContain("text/event-stream");
    expect(res.ended).toBe(true);
    expect(res.chunks.join("")).toContain('"type":"error"');
  });
});

describe("handleStartQiRun — seed validation", () => {
  it("returns 400 QI_BAD_REQUEST before streaming for a negative seed", async () => {
    const res = new MockResponse();
    const result = asResult(
      await handleStartQiRun(
        ctx(
          makeReq({
            sources: [{ kind: "requirements", label: "Reqs", text: "REQ-1" }],
            seed: -1,
          }),
          res,
        ),
        deps(),
      ),
    );

    expect(result.status).toBe(400);
    expect((result.body as { error: { code: string; message: string } }).error).toMatchObject({
      code: "QI_BAD_REQUEST",
    });
    expect((result.body as { error: { code: string; message: string } }).error.message).toMatch(
      /seed/i,
    );
    expect(res.statusCode).toBeUndefined();
    expect(res.chunks).toHaveLength(0);
  });

  it("keeps a valid seed on the SSE path", async () => {
    const res = new MockResponse();
    const outcome = await handleStartQiRun(
      ctx(
        makeReq({
          sources: [{ kind: "requirements", label: "Reqs", text: "REQ-1" }],
          seed: 7,
        }),
        res,
      ),
      deps(),
    );

    expect(outcome).toBe(STREAMING);
    expect(res.statusCode).toBe(200);
    expect(res.headers?.["Content-Type"]).toContain("text/event-stream");
  });
});

// ─── Capsule source parsing (Issue #716) ────────────────────────────────────────

describe("handleStartQiRun — capsule source validation (Issue #716)", () => {
  it("returns 400 QI_BAD_REQUEST when capsuleId is missing", async () => {
    const result = asResult(
      await handleStartQiRun(
        ctx(makeReq({ sources: [{ kind: "capsule", label: "My Capsule" }] }), new MockResponse()),
        deps(),
      ),
    );
    expect(result.status).toBe(400);
    expect((result.body as { error: { code: string } }).error.code).toBe("QI_BAD_REQUEST");
  });

  it("returns 400 QI_BAD_REQUEST when capsuleId is an empty string", async () => {
    const result = asResult(
      await handleStartQiRun(
        ctx(
          makeReq({ sources: [{ kind: "capsule", label: "My Capsule", capsuleId: "" }] }),
          new MockResponse(),
        ),
        deps(),
      ),
    );
    expect(result.status).toBe(400);
    expect((result.body as { error: { code: string } }).error.code).toBe("QI_BAD_REQUEST");
  });

  it("returns 400 QI_BAD_REQUEST when capsuleId is whitespace-only", async () => {
    const result = asResult(
      await handleStartQiRun(
        ctx(
          makeReq({ sources: [{ kind: "capsule", label: "My Capsule", capsuleId: "   " }] }),
          new MockResponse(),
        ),
        deps(),
      ),
    );
    expect(result.status).toBe(400);
    expect((result.body as { error: { code: string } }).error.code).toBe("QI_BAD_REQUEST");
  });

  it("starts the SSE stream (not a 400) when a valid capsuleId is provided", async () => {
    // With no evidenceDir the run will fail with QI_NO_EVIDENCE_DIR, but the key assertion is that
    // parsing succeeds (no 400) — the stream has started (STREAMING) or a non-400 result is returned.
    const outcome = await handleStartQiRun(
      ctx(
        makeReq({ sources: [{ kind: "capsule", label: "My Capsule", capsuleId: "cap-abc-123" }] }),
        new MockResponse(),
      ),
      deps(),
    );
    if (outcome !== STREAMING) {
      expect(outcome.status).not.toBe(400);
    }
  });
});

describe("handleStartQiRun — capsule-set source validation (Issue #716/#718)", () => {
  it("returns 400 QI_BAD_REQUEST when capsuleSetId is missing", async () => {
    const result = asResult(
      await handleStartQiRun(
        ctx(makeReq({ sources: [{ kind: "capsule-set", label: "My Set" }] }), new MockResponse()),
        deps(),
      ),
    );
    expect(result.status).toBe(400);
    expect((result.body as { error: { code: string } }).error.code).toBe("QI_BAD_REQUEST");
  });

  it("returns 400 QI_BAD_REQUEST when capsuleSetId is whitespace-only", async () => {
    const result = asResult(
      await handleStartQiRun(
        ctx(
          makeReq({ sources: [{ kind: "capsule-set", label: "My Set", capsuleSetId: "   " }] }),
          new MockResponse(),
        ),
        deps(),
      ),
    );
    expect(result.status).toBe(400);
    expect((result.body as { error: { code: string } }).error.code).toBe("QI_BAD_REQUEST");
  });

  it("starts the SSE stream (not a 400) when a valid capsuleSetId is provided", async () => {
    const outcome = await handleStartQiRun(
      ctx(
        makeReq({
          sources: [{ kind: "capsule-set", label: "My Set", capsuleSetId: "set-abc-123" }],
        }),
        new MockResponse(),
      ),
      deps(),
    );
    if (outcome !== STREAMING) {
      expect(outcome.status).not.toBe(400);
    }
  });
});

describe("handleStartQiRun — figma-snapshot source validation (Issue #754)", () => {
  it("returns 400 QI_BAD_REQUEST when snapshotRunId is missing", async () => {
    const result = asResult(
      await handleStartQiRun(
        ctx(
          makeReq({ sources: [{ kind: "figma-snapshot", label: "My snapshot" }] }),
          new MockResponse(),
        ),
        deps(),
      ),
    );
    expect(result.status).toBe(400);
    expect((result.body as { error: { code: string } }).error.code).toBe("QI_BAD_REQUEST");
  });

  it("returns 400 QI_BAD_REQUEST when snapshotRunId is whitespace-only", async () => {
    const result = asResult(
      await handleStartQiRun(
        ctx(
          makeReq({
            sources: [{ kind: "figma-snapshot", label: "My snapshot", snapshotRunId: "   " }],
          }),
          new MockResponse(),
        ),
        deps(),
      ),
    );
    expect(result.status).toBe(400);
    expect((result.body as { error: { code: string } }).error.code).toBe("QI_BAD_REQUEST");
  });

  it("starts the SSE stream (not a 400) when a valid snapshotRunId is provided", async () => {
    const outcome = await handleStartQiRun(
      ctx(
        makeReq({
          sources: [{ kind: "figma-snapshot", label: "My snapshot", snapshotRunId: "snap-abc-1" }],
        }),
        new MockResponse(),
      ),
      deps(),
    );
    if (outcome !== STREAMING) {
      expect(outcome.status).not.toBe(400);
    }
  });
});

describe("toStreamEvent — reasonSummary redaction backstop (#279 AC3)", () => {
  // The workflow already produces a fail-closed, secret-free reasonSummary, but the SSE writer is
  // the one QI surface with no other redaction. This proves the redactor is actually applied to the
  // free-text field before it is streamed — removing the applyRedactor call fails this test.
  it("passes the reasonSummary field through the live-payload redactor", () => {
    const marker = "https://leak.example/v1 token sk-LEAKLEAKLEAK";
    const redactor: Redactor = (value: unknown): unknown =>
      typeof value === "string"
        ? value.replaceAll("sk-LEAKLEAKLEAK", "[redacted]").replaceAll("leak.example", "[redacted]")
        : value;
    const event = {
      sequence: 1,
      payload: { kind: "run:failed", reasonSummary: marker },
    } as unknown as QI.QualityIntelligenceRunEvent;

    const message = toStreamEvent(event, redactor) as { kind: string; reasonSummary?: string };

    expect(message.kind).toBe("run:failed");
    expect(message.reasonSummary).toBeDefined();
    expect(message.reasonSummary).not.toContain("sk-LEAKLEAKLEAK");
    expect(message.reasonSummary).not.toContain("leak.example");
  });

  it("leaves a non-secret reasonSummary unchanged (redactor is a no-op on safe codes)", () => {
    const event = {
      sequence: 2,
      payload: { kind: "run:failed", reasonSummary: "qi-run-error" },
    } as unknown as QI.QualityIntelligenceRunEvent;

    const message = toStreamEvent(event, buildRedactor({})) as { reasonSummary?: string };

    expect(message.reasonSummary).toBe("qi-run-error");
  });
});
