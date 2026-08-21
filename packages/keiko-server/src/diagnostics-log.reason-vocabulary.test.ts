// `unsupportedReasons` is documented as a CLOSED vocabulary (see the field's doc comment in
// diagnostics-log.ts): the declared gateway modes Keiko recognises, plus two fixed fallback
// markers. `boundedUnsupportedReason` in keiko-contracts already narrows a gateway's declared mode
// onto that vocabulary at the PRODUCER (gateway-setup.ts). This suite is the second, independent
// proof: that the activity-log PROJECTION closes the same vocabulary again, structurally, so a
// future producer of this field — or a bug in an existing one — cannot put unbounded third-party
// text onto the line just because the string happens to be short and space-free enough to slip
// past the generic value guards `log-redaction.test.ts` owns.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { UNSUPPORTED_REASON_VOCABULARY, defaultServerDiagnosticSink } from "./diagnostics-log.js";
import type { ServerDiagnosticRecord } from "./diagnostics-log.js";
import { closeFileServerLogSinks } from "./observability/index.js";

function readActivityLine(stateDir: string): Record<string, unknown> {
  const raw = readFileSync(join(stateDir, "logs", "server.log"), "utf8").trim();
  return JSON.parse(raw) as Record<string, unknown>;
}

const BASE_RECORD: ServerDiagnosticRecord = {
  correlationId: "req-2f9c1b",
  timestamp: "2026-08-21T00:00:00.000Z",
  operation: "POST /api/gateway/setup",
  source: "gateway-setup.discovery",
  errorClass: "GatewayDiscoveryUnusableModels",
  message:
    "Setup skipped models the gateway declared as unsupported modes or that failed the embedding probe.",
};

describe("unsupportedReasons vocabulary closure", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "keiko-diagnostics-reason-vocab-"));
    vi.stubEnv("KEIKO_STATE_DIR", stateDir);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    closeFileServerLogSinks();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("declares every recognised mode plus both fixed markers", () => {
    expect(UNSUPPORTED_REASON_VOCABULARY.has("chat")).toBe(true);
    expect(UNSUPPORTED_REASON_VOCABULARY.has("embedding")).toBe(true);
    expect(UNSUPPORTED_REASON_VOCABULARY.has("rerank")).toBe(true);
    expect(UNSUPPORTED_REASON_VOCABULARY.has("not-chat-capable")).toBe(true);
    expect(UNSUPPORTED_REASON_VOCABULARY.has("unrecognised-mode")).toBe(true);
  });

  it("keeps a recognised reason and collapses a foreign one to the fixed marker", () => {
    defaultServerDiagnosticSink.record({
      ...BASE_RECORD,
      unsupportedModelCount: 3,
      // "rerank" is a declared mode Keiko recognises and must survive; "vendor-private-mode" is
      // exactly the shape a bug or a future producer could hand this field — short, lowercase,
      // hyphenated, no spaces — which sails through every generic value guard untouched. Only the
      // vocabulary closure stops it.
      unsupportedReasons: ["rerank", "vendor-private-mode", "not-chat-capable"],
    });

    const line = readActivityLine(stateDir);
    expect(line.unsupportedReasons).toStrictEqual([
      "rerank",
      "unrecognised-mode",
      "not-chat-capable",
    ]);
    expect(JSON.stringify(line)).not.toContain("vendor-private-mode");
  });

  it("leaves an already-closed reason list untouched", () => {
    defaultServerDiagnosticSink.record({
      ...BASE_RECORD,
      unsupportedReasons: ["chat", "unrecognised-mode"],
    });

    expect(readActivityLine(stateDir).unsupportedReasons).toStrictEqual([
      "chat",
      "unrecognised-mode",
    ]);
  });
});
