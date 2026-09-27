import { resetServerLogger } from "../../../../tests/support/activity-log-test-support.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createFileServerLogSink,
  createServerLogger,
  setServerLogger,
  type ServerLogEvent,
} from "../observability/index.js";
import { createGatewayManualFetcher } from "./manual-crawl-fetcher.js";
import { readPersistedActivityLog } from "../../../../tests/support/activity-log-proof.js";
import { ACTIVITY_LOG_STORAGE_OPERATIONS } from "@oscharko-dev/keiko-activity-log";

const CORRELATION_ID = "8d5f2d77-e1c2-4d5d-aec8-2ac77a248dbe";
const stateDirs: string[] = [];

afterEach(() => {
  resetServerLogger();
  for (const stateDir of stateDirs.splice(0)) {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

function persistedEvents(stateDir: string): readonly ServerLogEvent[] {
  return readPersistedActivityLog(stateDir)
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as ServerLogEvent)
    .filter((event) => !ACTIVITY_LOG_STORAGE_OPERATIONS.has(event.op));
}

describe("manual crawl gateway policy activity logging", () => {
  it("persists a correlated undelegated-proxy refusal without dispatching the transport", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "keiko-manual-policy-log-"));
    stateDirs.push(stateDir);
    setServerLogger(createServerLogger({ sink: createFileServerLogSink(stateDir), level: "info" }));
    const fetcher = createGatewayManualFetcher({
      correlationId: CORRELATION_ID,
      egress: () => ({ httpsProxy: "http://proxy.example:8080" }),
    });

    const result = await fetcher.fetchManualPage(
      { kind: "http", url: "https://manual.example/docs" },
      { maxBytes: 1_024 },
    );

    expect(result).toEqual({ ok: false, reason: "fetch-failed" });
    expect(persistedEvents(stateDir)).toContainEqual(
      expect.objectContaining({
        op: "http.gateway.fetch.failed",
        correlationId: CORRELATION_ID,
        errorKind: "permission-denied",
        policyReason: "undelegated-proxied-hostname",
      }),
    );
  });
});
