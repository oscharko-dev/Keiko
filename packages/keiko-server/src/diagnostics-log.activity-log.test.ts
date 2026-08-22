// What the operator diagnostic sink puts on the ACTIVITY LOG line, as opposed to what it prints
// to stderr. The record is a caller-supplied object, so the question this suite answers is not
// "does the redactor work" (log-redaction.test.ts owns that) but "which fields of the record are
// allowed to become log fields at all".

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_SERVER_DIAGNOSTIC_SUMMARY,
  defaultServerDiagnosticSink,
  serverDiagnosticFromError,
} from "./diagnostics-log.js";
import type { ServerDiagnosticRecord } from "./diagnostics-log.js";
import { closeFileServerLogSinks, SERVER_LOG_LEVEL_ENV } from "./observability/index.js";

function readActivityLine(stateDir: string): Record<string, unknown> {
  const raw = readFileSync(join(stateDir, "logs", "server.log"), "utf8").trim();
  return JSON.parse(raw) as Record<string, unknown>;
}

describe("diagnostic records on the activity log", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "keiko-diagnostics-log-"));
    vi.stubEnv("KEIKO_STATE_DIR", stateDir);
    // The sink also writes one structured line to stderr; that track is asserted elsewhere.
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    closeFileServerLogSinks();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("projects the record onto allowlisted fields instead of passing it whole", () => {
    // `notes` is the shape this defends against: a field the type does not declare today, added
    // by a future producer or by a merge of request data onto the record. It is short, ASCII and
    // space-free, so it survives every value guard the log has — the only thing that can stop it
    // is not offering it to the log in the first place.
    const record = {
      correlationId: "req-1f2e3d",
      timestamp: "2026-08-21T00:00:00.000Z",
      operation: "chat.stream",
      source: "server.top-level-catch",
      errorClass: "GatewayError",
      message: "Provider verification failed without exposing upstream response details.",
      code: "GATEWAY_ERROR",
      occurrenceCount: 2,
      partialUsage: { promptTokens: 10, completionTokens: 4 },
      parentCorrelationId: "job-parent-1f2e3d",
      httpStatus: 503,
      retryAfterMs: 2_000,
      notes: "JaneDoe1985",
    } as ServerDiagnosticRecord & { readonly notes: string };

    defaultServerDiagnosticSink.record(record);
    const line = readActivityLine(stateDir);

    // The evidence an operator reads, flat on the line and keyed the way every other line is.
    // `diagnosticSummary` carries the SAME text as `record.message` — that is expected and safe:
    // `message` is an allowlisted, code-declared summary (never foreign error/provider/customer
    // text), just projected under a different key so it does not collide with `message` on
    // `log-redaction.ts`'s `DENIED_FIELD_NAMES`.
    expect(line).toMatchObject({
      category: "diagnostic",
      op: "chat.stream",
      correlationId: "req-1f2e3d",
      errorKind: "GatewayError",
      source: "server.top-level-catch",
      code: "GATEWAY_ERROR",
      occurrenceCount: 2,
      promptTokens: 10,
      completionTokens: 4,
      diagnosticSummary: "Provider verification failed without exposing upstream response details.",
      parentCorrelationId: "job-parent-1f2e3d",
      httpStatus: 503,
      retryAfterMs: 2_000,
    });

    // Nothing else. Not the undeclared field, not the whole record under a `record` key, and not
    // a key literally named `message` (the DENIED_FIELD_NAMES collision this design avoids), nor
    // the timestamp the envelope already carries as `ts`.
    expect(line.notes).toBeUndefined();
    expect(line.record).toBeUndefined();
    expect(line.message).toBeUndefined();
    expect(Object.keys(line)).not.toContain("message");
    expect(line.timestamp).toBeUndefined();
    expect(JSON.stringify(line)).not.toContain("JaneDoe1985");
  });

  // ADR-0173 D3/D11 (g2, g29): a thrown Error carries its stack and its allowlisted summary all
  // the way to the persisted line, through `serverDiagnosticFromError` → `defaultServerDiagnosticSink`
  // → the file sink's redaction pass — not merely through `describeError` in isolation.
  it("wires frames and diagnosticSummary from a thrown Error onto the activity log", () => {
    function levelThree(): never {
      throw new Error("boom");
    }
    function levelTwo(): void {
      levelThree();
    }
    function levelOne(): void {
      levelTwo();
    }

    let caught: unknown;
    try {
      levelOne();
    } catch (error) {
      caught = error;
    }

    const record = serverDiagnosticFromError({
      correlationId: "cid-frames",
      operation: "unit.frames",
      source: "unit",
      error: caught,
      summary: DEFAULT_SERVER_DIAGNOSTIC_SUMMARY,
      redact: (message) => message,
      now: () => 0,
    });
    defaultServerDiagnosticSink.record(record);
    const line = readActivityLine(stateDir);

    expect(line.diagnosticSummary).toBe(DEFAULT_SERVER_DIAGNOSTIC_SUMMARY);
    expect(Object.keys(line)).not.toContain("message");

    expect(line.frames).toBeInstanceOf(Array);
    const frames = line.frames as readonly string[];
    // `levelThree`, `levelTwo`, `levelOne` and the `try` block itself are four distinct call sites
    // in THIS file, so at least three frames survive the dist/src anchor.
    expect(frames.length).toBeGreaterThanOrEqual(3);
    for (const frame of frames) {
      expect(frame).toMatch(/^packages\/keiko-server\/src\//);
    }
  });

  it("omits an absent optional field rather than writing it as null", () => {
    defaultServerDiagnosticSink.record({
      correlationId: "req-000001",
      timestamp: "2026-08-21T00:00:00.000Z",
      operation: "evidence.retention",
      source: "server.diagnostic",
      errorClass: "EvidenceRetention",
      message: "Evidence retention deleted manifests.",
      occurrenceCount: 3,
    });
    const line = readActivityLine(stateDir);

    expect(line).toMatchObject({ op: "evidence.retention", occurrenceCount: 3 });
    expect(Object.keys(line)).not.toContain("code");
    expect(Object.keys(line)).not.toContain("gatewayRequestId");
    expect(Object.keys(line)).not.toContain("promptTokens");
    expect(Object.keys(line)).not.toContain("parentCorrelationId");
    expect(Object.keys(line)).not.toContain("httpStatus");
    expect(Object.keys(line)).not.toContain("retryAfterMs");
  });

  // `parentCorrelationId` is shape-guarded, not merely redacted, the same way `server-log.ts`'s
  // `applyEnvelopeFields` guards its own `parentCorrelationId` envelope field: a value that does
  // not fit `isValidCorrelationId`'s shape (`^[A-Za-z0-9._-]{8,128}$`) is dropped outright rather
  // than written under a marker, even though it is short enough and plain enough to sail through
  // every generic value guard `log-redaction.ts` applies to an ordinary string field.
  it("drops a malformed parentCorrelationId instead of writing it through the generic value guards", () => {
    defaultServerDiagnosticSink.record({
      correlationId: "req-shape-guard",
      timestamp: "2026-08-21T00:00:00.000Z",
      operation: "chat.stream",
      source: "server.top-level-catch",
      errorClass: "GatewayError",
      message: DEFAULT_SERVER_DIAGNOSTIC_SUMMARY,
      parentCorrelationId: "not a real id",
    });
    const line = readActivityLine(stateDir);

    expect(Object.keys(line)).not.toContain("parentCorrelationId");
    expect(JSON.stringify(line)).not.toContain("not a real id");
  });

  // Raising the threshold is what an operator does to isolate a failure. An unstamped line
  // defaults to `info`, which is exactly the level `warn` filters out — so the setting meant to
  // surface failures would have deleted every one of them from the file while stderr kept them.
  it("stamps the record as an error so a raised threshold cannot filter it out", () => {
    vi.stubEnv(SERVER_LOG_LEVEL_ENV, "warn");

    defaultServerDiagnosticSink.record({
      correlationId: "req-abc123",
      timestamp: "2026-08-21T00:00:00.000Z",
      operation: "knowledge.index",
      source: "server.diagnostic",
      errorClass: "IndexingError",
      message: "Indexing failed.",
    });

    expect(readActivityLine(stateDir)).toMatchObject({
      level: "error",
      category: "diagnostic",
      op: "knowledge.index",
    });
  });
});
