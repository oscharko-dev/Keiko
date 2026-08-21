// What the operator diagnostic sink puts on the ACTIVITY LOG line, as opposed to what it prints
// to stderr. The record is a caller-supplied object, so the question this suite answers is not
// "does the redactor work" (log-redaction.test.ts owns that) but "which fields of the record are
// allowed to become log fields at all".

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { defaultServerDiagnosticSink } from "./diagnostics-log.js";
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
      notes: "JaneDoe1985",
    } as ServerDiagnosticRecord & { readonly notes: string };

    defaultServerDiagnosticSink.record(record);
    const line = readActivityLine(stateDir);

    // The evidence an operator reads, flat on the line and keyed the way every other line is.
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
    });

    // Nothing else. Not the undeclared field, not the whole record under a `record` key, and not
    // the summary or the timestamp the envelope already carries as `ts`.
    expect(line.notes).toBeUndefined();
    expect(line.record).toBeUndefined();
    expect(line.message).toBeUndefined();
    expect(line.timestamp).toBeUndefined();
    expect(JSON.stringify(line)).not.toContain("JaneDoe1985");
    expect(JSON.stringify(line)).not.toContain("Provider verification");
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
