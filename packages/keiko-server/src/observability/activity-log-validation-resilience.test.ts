import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLogEvent,
  activityLogOperationSchema,
} from "@oscharko-dev/keiko-contracts/runtime/observability";

import {
  MAX_LOG_LINE_BYTES,
  closeFileServerLogSinks,
  createFileServerLogSink,
  resetServerLogFailureNotices,
  type ServerLogSink,
} from "./server-log.js";

function runBusinessOperation(sink: ServerLogSink, rejectedValue: string): string {
  const registration = activityLogOperationSchema("chat.request.dispatch");
  if (registration === undefined) throw new Error("test registration is missing");
  const event = activityLogEvent(
    registration,
    { correlationId: "validation-resilience-0001" },
    {
      endpointDigest: "a".repeat(64),
      modelId: rejectedValue,
      messageCount: 1,
      bodyBytes: 32,
      timeoutMs: 1_000,
      stream: false,
    },
  );
  sink.write(event);
  return "business-operation-completed";
}

describe("Activity Log validation resilience", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "keiko-log-validation-resilience-"));
    resetServerLogFailureNotices();
  });

  afterEach(() => {
    closeFileServerLogSinks();
    resetServerLogFailureNotices();
    rmSync(stateDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("drops an invalid event without changing its calling business operation", () => {
    const rejectedValue = "operator prompt must never appear";
    const stderrWrite = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    expect(runBusinessOperation(createFileServerLogSink(stateDir), rejectedValue)).toBe(
      "business-operation-completed",
    );

    const persisted = readFileSync(join(stateDir, "logs", "server.log"), "utf8");
    expect(persisted).not.toContain("chat.request.dispatch");
    expect(persisted).not.toContain(rejectedValue);
    expect(stderrWrite).toHaveBeenCalledTimes(1);

    const notice = String(stderrWrite.mock.calls[0]?.[0]);
    expect(Buffer.byteLength(notice, "utf8")).toBeLessThanOrEqual(MAX_LOG_LINE_BYTES);
    expect(notice).not.toContain(rejectedValue);
    expect(JSON.parse(notice)).toMatchObject({
      category: "diagnostic",
      op: "server-log.write-failed",
      errorKind: "validation-failed",
      rejectionKind: "invalid-field-vocabulary",
      writerCapability: "unavailable",
      compatibilityState: "incomplete",
      completeness: "unknown",
      loss: "event-dropped",
    });
    expect(JSON.parse(notice)).not.toHaveProperty("failedOp");
  });
});
