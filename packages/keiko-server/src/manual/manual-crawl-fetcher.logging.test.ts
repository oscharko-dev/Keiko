import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createFileServerLogSink,
  createServerLogger,
  resetServerLogger,
  setServerLogger,
  type ServerLogEvent,
} from "../observability/index.js";
import { createGatewayManualFetcher } from "./manual-crawl-fetcher.js";

const CORRELATION_ID = "8d5f2d77-e1c2-4d5d-aec8-2ac77a248dbe";
const stateDirs: string[] = [];

afterEach(() => {
  resetServerLogger();
  for (const stateDir of stateDirs.splice(0)) {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

function persistedEvents(stateDir: string): readonly ServerLogEvent[] {
  return readFileSync(join(stateDir, "logs", "server.log"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as ServerLogEvent);
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
        errorKind: "PROXY_BLOCKED_BY_POLICY",
        policyReason: "undelegated-proxied-hostname",
      }),
    );
  });
});
