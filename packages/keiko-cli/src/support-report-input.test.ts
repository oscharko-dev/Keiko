import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MAX_SUPPORT_REPORT_BYTES,
  SUPPORT_REPORT_AVAILABILITY_REASONS,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { closeFileServerLogSinks } from "@oscharko-dev/keiko-activity-log";
import {
  createClientOnlySupportReport,
  createDesktopSupportReport,
} from "@oscharko-dev/keiko-activity-log/reader";
import { runSupportCli } from "./support.js";
import {
  expectActivityLogProof,
  persistedActivityLogLines,
  readPersistedActivityLog,
} from "../../../tests/support/activity-log-proof.js";

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "keiko-report-input-"));
});
afterEach(() => {
  closeFileServerLogSinks();
  rmSync(directory, { recursive: true, force: true });
});

async function analyzeInput(
  bytes: Uint8Array,
  args: readonly string[] = [],
): Promise<{ code: number; output: string; log: string }> {
  const path = join(directory, "human-selected-report");
  const stateDir = join(directory, "control-state");
  writeFileSync(path, bytes, { mode: 0o600 });
  const output: string[] = [];
  const errors: string[] = [];
  const code = await runSupportCli(
    ["analyze", path, ...args],
    {
      out: (text): void => {
        output.push(text);
      },
      err: (text): void => {
        errors.push(text);
      },
    },
    {},
    { cwd: directory, controlActivityStateDir: stateDir },
  );
  const log = readPersistedActivityLog(stateDir);
  expect(log).not.toContain(directory);
  if (code === 0) expect(errors).toEqual([]);
  return { code, output: output.join(""), log };
}

describe("support analyze input evidence", () => {
  it.each(["raw", "gzip"] as const)(
    "records actual %s transport and limited artifact scope",
    async (inputTransport) => {
      const report = createClientOnlySupportReport(undefined, "session-unavailable").reportJson;
      const bytes = inputTransport === "gzip" ? gzipSync(report) : Buffer.from(report);
      const result = await analyzeInput(bytes);
      expect(result.code).toBe(0);
      const lines = persistedActivityLogLines(result.log, "support.report.completed");
      expect(lines).toHaveLength(1);
      expect(
        expectActivityLogProof("support.report.completed.report-lifecycle", lines[0] ?? ""),
      ).toMatchObject({
        inputTransport,
        inputBytes: bytes.length,
        reportBytes: Buffer.byteLength(report),
        evidenceScope: "client-only",
        clientAvailabilityReason: "session-unavailable",
      });
    },
  );

  it("identifies full server evidence without an invented client availability reason", async () => {
    const report = createDesktopSupportReport(join(directory, "source-state")).reportJson;
    const bytes = Buffer.from(report);
    const result = await analyzeInput(bytes);
    expect(result.code).toBe(0);
    expect(result.output).not.toContain("Limited browser artifact");
    const lines = persistedActivityLogLines(result.log, "support.report.completed");
    expect(lines).toHaveLength(1);
    const event = expectActivityLogProof(
      "support.report.completed.report-lifecycle",
      lines[0] ?? "",
    );
    expect(event).toMatchObject({
      inputTransport: "raw",
      inputBytes: bytes.length,
      evidenceScope: "full",
    });
    expect(event).not.toHaveProperty("clientAvailabilityReason");
  });

  it("omits unknown transport and scope when the verified size exceeds the input budget", async () => {
    const bytes = Buffer.alloc(MAX_SUPPORT_REPORT_BYTES + 1);
    const result = await analyzeInput(bytes);
    expect(result.code).toBe(1);
    const lines = persistedActivityLogLines(result.log, "support.report.failed");
    expect(lines).toHaveLength(1);
    const event = expectActivityLogProof("support.report.failed.report-lifecycle", lines[0] ?? "");
    expect(event).toMatchObject({ inputBytes: bytes.length, reason: "report-budget-exceeded" });
    expect(event).not.toHaveProperty("inputTransport");
    expect(event).not.toHaveProperty("evidenceScope");
  });

  it("retains validated limited scope on a subsequent selection refusal", async () => {
    const report = createClientOnlySupportReport(undefined, "service-unavailable").reportJson;
    const bytes = gzipSync(report);
    const result = await analyzeInput(bytes, ["--correlation-id", "missing-timeline"]);
    expect(result.code).toBe(1);
    const lines = persistedActivityLogLines(result.log, "support.report.failed");
    expect(lines).toHaveLength(1);
    const event = expectActivityLogProof("support.report.failed.report-lifecycle", lines[0] ?? "");
    expect(event).toMatchObject({
      inputTransport: "gzip",
      inputBytes: bytes.length,
      reason: "selection-unavailable",
      evidenceScope: "client-only",
      clientAvailabilityReason: "service-unavailable",
    });
  });

  it.each(SUPPORT_REPORT_AVAILABILITY_REASONS)(
    "identifies a limited report in the default human view: %s",
    async (reason) => {
      const report = createClientOnlySupportReport(undefined, reason).reportJson;
      const result = await analyzeInput(Buffer.from(report));
      expect(result.code).toBe(0);
      expect(result.output).toContain(
        `Limited browser artifact: server evidence unavailable (${reason})`,
      );
      expect(result.output).toContain("Diagnostic sufficiency: insufficient");
    },
  );

  it.each(["gzip-corrupt", "gzip-budget", "gzip-utf8"] as const)(
    "preserves known input facts after %s failure",
    async (failure) => {
      const bytes =
        failure === "gzip-corrupt"
          ? Buffer.from([0x1f, 0x8b, 0x00])
          : gzipSync(
              failure === "gzip-budget"
                ? Buffer.alloc(MAX_SUPPORT_REPORT_BYTES + 1, 0x61)
                : Buffer.from([0xc0, 0xaf]),
            );
      const result = await analyzeInput(bytes);
      expect(result.code).toBe(1);
      const lines = persistedActivityLogLines(result.log, "support.report.failed");
      expect(lines).toHaveLength(1);
      expect(
        expectActivityLogProof("support.report.failed.report-lifecycle", lines[0] ?? ""),
      ).toMatchObject({
        inputTransport: "gzip",
        inputBytes: bytes.length,
        reason: failure === "gzip-budget" ? "report-budget-exceeded" : "corrupt-report",
      });
      expect(JSON.parse(lines[0] ?? "")).not.toHaveProperty("evidenceScope");
      expect(persistedActivityLogLines(result.log, "support.report.completed")).toEqual([]);
    },
  );
});
