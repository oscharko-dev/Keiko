import { resetServerLogFailureNotices } from "../../../tests/support/activity-log-test-support.js";
// Registry-linked executable proof (#3532) for `server.diagnostic.failure`.
//
// Kept out of `diagnostics-log.test.ts` / `diagnostics-log.activity-log.test.ts` /
// `diagnostics-log.reason-vocabulary.test.ts` (several concurrent streams edit those files) as a
// dedicated co-located file. Drives the real production sink `defaultServerDiagnosticSink.record`
// with a temp `KEIKO_STATE_DIR`, then reads the persisted line back with `readPersistedActivityLog`
// — never a hand-built event or registration object (this task's rule 1).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  expectActivityLogProof,
  persistedActivityLogLines,
  readPersistedActivityLog,
} from "../../../tests/support/activity-log-proof.js";
import {
  DEFAULT_SERVER_DIAGNOSTIC_SUMMARY,
  defaultServerDiagnosticSink,
  type ServerDiagnosticRecord,
} from "./diagnostics-log.js";
import { closeFileServerLogSinks } from "./observability/index.js";

describe("server.diagnostic.failure activity log proof (#3532)", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "keiko-diagnostics-log-proof-"));
    vi.stubEnv("KEIKO_STATE_DIR", stateDir);
    // The default sink also writes one structured line to stderr; asserted elsewhere.
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    closeFileServerLogSinks();
    resetServerLogFailureNotices();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("persists one server.diagnostic.failure line through the default diagnostic sink", () => {
    const record: ServerDiagnosticRecord = {
      correlationId: "corr-diagnostic-proof-01",
      timestamp: "2026-09-18T00:00:00.000Z",
      operation: "chat.stream",
      source: "server.top-level-catch",
      errorClass: "GatewayError",
      message: DEFAULT_SERVER_DIAGNOSTIC_SUMMARY,
    };

    defaultServerDiagnosticSink.record(record);

    const [line] = persistedActivityLogLines(
      readPersistedActivityLog(stateDir),
      "server.diagnostic.failure",
    );
    const persisted = expectActivityLogProof(
      "server.diagnostic.failure.activity-log-line",
      line ?? "",
    );
    expect(persisted).toMatchObject({
      level: "error",
      category: "diagnostic",
      correlationId: "corr-diagnostic-proof-01",
      diagnosticOperation: "chat.stream",
      diagnosticErrorClass: "GatewayError",
      source: "server.top-level-catch",
      completeness: "complete",
      loss: "none",
    });
  });
});
