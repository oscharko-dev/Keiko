// Unit tests for handleStartQiRun source validation.
//
// Covers the single-file absolute-path guard (Epic #709/#791) and the capsule source parsing path
// (Epic #710, Issue #716): a valid capsule/capsule-set id parses cleanly and commits to the SSE
// stream; a missing/empty/whitespace/non-string id returns 400 QI_BAD_REQUEST, while a missing label
// (outer shape failure) returns 400 QI_BAD_SOURCE. The SSE execution contracts live in
// runExecution.test.ts.

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
    const error = (result.body as { error: { code: string; message: string } }).error;
    expect(error.code).toBe("QI_BAD_REQUEST");
    expect(error.message).toMatch(/capsuleId/);
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

  // A JSON body can carry a non-string capsuleId (number / array / null); the `typeof !== "string"`
  // guard must reject it. Without these the guard could be mutated to `!== "number"` undetected.
  it("returns 400 QI_BAD_REQUEST when capsuleId is a non-string number", async () => {
    const result = asResult(
      await handleStartQiRun(
        ctx(
          makeReq({ sources: [{ kind: "capsule", label: "My Capsule", capsuleId: 123 }] }),
          new MockResponse(),
        ),
        deps(),
      ),
    );
    expect(result.status).toBe(400);
    expect((result.body as { error: { code: string } }).error.code).toBe("QI_BAD_REQUEST");
  });

  it("returns 400 QI_BAD_REQUEST when capsuleId is a non-string array", async () => {
    const result = asResult(
      await handleStartQiRun(
        ctx(
          makeReq({ sources: [{ kind: "capsule", label: "My Capsule", capsuleId: [] }] }),
          new MockResponse(),
        ),
        deps(),
      ),
    );
    expect(result.status).toBe(400);
    expect((result.body as { error: { code: string } }).error.code).toBe("QI_BAD_REQUEST");
  });

  it("returns 400 QI_BAD_SOURCE (not QI_BAD_REQUEST) when a capsule source has no label", async () => {
    // A missing label fails the outer shape guard (validateSource) before the capsule field check,
    // so it surfaces as QI_BAD_SOURCE — this pins the boundary between the two coded errors.
    const result = asResult(
      await handleStartQiRun(
        ctx(
          makeReq({ sources: [{ kind: "capsule", capsuleId: "cap-abc-123" }] }),
          new MockResponse(),
        ),
        deps(),
      ),
    );
    expect(result.status).toBe(400);
    expect((result.body as { error: { code: string } }).error.code).toBe("QI_BAD_SOURCE");
  });

  it("commits to the SSE stream when a valid capsuleId is provided", async () => {
    // Parsing succeeds, so the handler commits to the SSE path (STREAMING) before the run executes;
    // with no evidenceDir the run then fails and emits a streamed error event — never a 400.
    // Asserting STREAMING unconditionally is the mutation-meaningful check: a parser that wrongly
    // returned any RouteResult here would fail this test instead of passing a dead conditional.
    const res = new MockResponse();
    const outcome = await handleStartQiRun(
      ctx(
        makeReq({ sources: [{ kind: "capsule", label: "My Capsule", capsuleId: "cap-abc-123" }] }),
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

describe("handleStartQiRun — capsule-set source validation (Issue #716/#718)", () => {
  it("returns 400 QI_BAD_REQUEST when capsuleSetId is missing", async () => {
    const result = asResult(
      await handleStartQiRun(
        ctx(makeReq({ sources: [{ kind: "capsule-set", label: "My Set" }] }), new MockResponse()),
        deps(),
      ),
    );
    expect(result.status).toBe(400);
    const error = (result.body as { error: { code: string; message: string } }).error;
    expect(error.code).toBe("QI_BAD_REQUEST");
    expect(error.message).toMatch(/capsuleSetId/);
  });

  it("returns 400 QI_BAD_REQUEST when capsuleSetId is an empty string", async () => {
    const result = asResult(
      await handleStartQiRun(
        ctx(
          makeReq({ sources: [{ kind: "capsule-set", label: "My Set", capsuleSetId: "" }] }),
          new MockResponse(),
        ),
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

  it("returns 400 QI_BAD_REQUEST when capsuleSetId is a non-string number", async () => {
    const result = asResult(
      await handleStartQiRun(
        ctx(
          makeReq({ sources: [{ kind: "capsule-set", label: "My Set", capsuleSetId: 99 }] }),
          new MockResponse(),
        ),
        deps(),
      ),
    );
    expect(result.status).toBe(400);
    expect((result.body as { error: { code: string } }).error.code).toBe("QI_BAD_REQUEST");
  });

  it("commits to the SSE stream when a valid capsuleSetId is provided", async () => {
    const res = new MockResponse();
    const outcome = await handleStartQiRun(
      ctx(
        makeReq({
          sources: [{ kind: "capsule-set", label: "My Set", capsuleSetId: "set-abc-123" }],
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

  it("commits to the SSE stream when a valid snapshotRunId is provided", async () => {
    // Parsing succeeds, so the handler commits to the SSE path (STREAMING) before the run executes;
    // with no evidenceDir the run then fails and emits a streamed error event — never a 400. Asserting
    // STREAMING unconditionally is mutation-meaningful: a parser that wrongly returned a RouteResult
    // here would fail this test instead of passing a dead conditional.
    const res = new MockResponse();
    const outcome = await handleStartQiRun(
      ctx(
        makeReq({
          sources: [{ kind: "figma-snapshot", label: "My snapshot", snapshotRunId: "snap-abc-1" }],
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

// ─── SSE 'accepted' frame — multi-source wire shape (Issue #730) ─────────────────────────────────
//
// Existing tests all use `evidenceDir: undefined`, so `executeQiRun` throws QI_NO_EVIDENCE_DIR
// BEFORE ingestion and the 'accepted' frame is never emitted. These tests supply a real temp dir
// so ingestion runs and the 'accepted' frame IS emitted (it is written synchronously inside
// `onAccepted`, before any model call, so it is present regardless of whether generation later
// fails). The SSE chunks are `data: {...}\n\n` lines; we parse them into JSON frames and locate
// the one with `type === "accepted"`.

function parseSseFrames(chunks: readonly string[]): readonly Record<string, unknown>[] {
  const raw = chunks.join("");
  return raw
    .split("\n\n")
    .map((block) => block.trim())
    .filter((block) => block.startsWith("data:"))
    .map((block) => JSON.parse(block.slice("data:".length).trim()) as Record<string, unknown>);
}

describe("handleStartQiRun — SSE accepted frame wire shape (Issue #730)", () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function depsWithEvidenceDir(evidenceDir: string): UiHandlerDeps {
    return {
      config: undefined,
      configPresent: false,
      evidenceStore: emptyStore(),
      env: {},
      redactor: buildRedactor({}),
      registry: createRunRegistry(),
      modelPortFactory: () => undefined,
      store: createInMemoryUiStore(),
      evidenceDir,
    };
  }

  // B1 — 17 sources (cap is 16): accepted frame must carry droppedSourceCount === 1.
  // Pins the `droppedSourceCount > 0` conditional emit in runRoutes.ts:315.
  // A mutation removing the condition or emitting a falsy value causes `droppedSourceCount` to
  // be absent (or 0) where this asserts it is exactly 1.
  it("accepted frame carries droppedSourceCount === 1 when 17 requirements sources are submitted (cap = 16)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qi-route-b1-"));
    tmpDirs.push(dir);
    const res = new MockResponse();

    const sources = Array.from({ length: 17 }, (_, i) => ({
      kind: "requirements" as const,
      label: `Src${String(i)}`,
      text: `The system shall satisfy requirement number ${String(i)} for the audit trail.`,
    }));

    const outcome = await handleStartQiRun(
      ctx(makeReq({ sources }), res),
      depsWithEvidenceDir(dir),
    );

    expect(outcome).toBe(STREAMING);
    const frames = parseSseFrames(res.chunks);
    const accepted = frames.find((f) => f.type === "accepted");
    expect(accepted).toBeDefined();
    expect(accepted?.droppedSourceCount).toBe(1);
  });

  // B2 — 2 valid sources: accepted frame must NOT contain `droppedSourceCount` at all.
  // Pins the `> 0` guard: when none are dropped the key must be absent (not present as 0).
  // A mutation that always spreads `{ droppedSourceCount: 0 }` would fail this test.
  it("accepted frame has no droppedSourceCount key when only 2 sources are submitted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qi-route-b2-"));
    tmpDirs.push(dir);
    const res = new MockResponse();

    const sources = [
      { kind: "requirements" as const, label: "Alpha", text: "The system shall log every login." },
      {
        kind: "requirements" as const,
        label: "Beta",
        text: "The system shall enforce the daily transfer limit.",
      },
    ];

    const outcome = await handleStartQiRun(
      ctx(makeReq({ sources }), res),
      depsWithEvidenceDir(dir),
    );

    expect(outcome).toBe(STREAMING);
    const frames = parseSseFrames(res.chunks);
    const accepted = frames.find((f) => f.type === "accepted");
    expect(accepted).toBeDefined();
    // Key must be absent — not present as 0 — because zero drops must not widen the wire.
    expect("droppedSourceCount" in (accepted ?? {})).toBe(false);
  });

  // B3 — 1 valid + 1 whitespace-only source: accepted frame must carry `skippedSources` with
  // exactly one entry, and that entry's keys must be exactly ["code","kind","label"] (sorted).
  // This pins the wire-shape projection in runRoutes.ts:325-329: the internal QiSkippedSource
  // also has a `message` field, which the route MUST strip before emitting it on the SSE surface
  // (the `accepted` frame bypasses the redactor). A mutation that leaks `message` into the frame
  // would add an extra key and fail the `Object.keys(...).sort()` assertion.
  it("accepted frame skippedSources entries have exactly {code,kind,label} keys — no message field leaked", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qi-route-b3-"));
    tmpDirs.push(dir);
    const res = new MockResponse();

    const sources = [
      {
        kind: "requirements" as const,
        label: "GoodSource",
        text: "The system shall validate every input field before persisting data.",
      },
      // Whitespace-only text → ingests to nothing → skipped with QI_SOURCE_EMPTY.
      { kind: "requirements" as const, label: "BlankSource", text: "   \n\t  " },
    ];

    const outcome = await handleStartQiRun(
      ctx(makeReq({ sources }), res),
      depsWithEvidenceDir(dir),
    );

    expect(outcome).toBe(STREAMING);
    const frames = parseSseFrames(res.chunks);
    const accepted = frames.find((f) => f.type === "accepted");
    expect(accepted).toBeDefined();

    const skipped = accepted?.skippedSources as readonly Record<string, unknown>[];
    expect(Array.isArray(skipped)).toBe(true);
    expect(skipped).toHaveLength(1);

    const entry = skipped[0];
    expect(entry).toBeDefined();
    // Exact key-set: {code, kind, label} — message must NOT appear on the wire.
    expect(Object.keys(entry ?? {}).sort()).toEqual(["code", "kind", "label"]);
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
