// Activity Log proofs for #3531: manifest maintenance, streaming queries and their failure path,
// asserted on lines the real CLI path persisted through the production file sink.
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { closeFileServerLogSinks } from "@oscharko-dev/keiko-activity-log";
import {
  expectActivityLogProof,
  persistedActivityLogLines,
  readPersistedActivityLog,
} from "../../../tests/support/activity-log-proof.js";
import { loadActivityLog } from "./lazy-modules.js";
import type { CliIo } from "./runner.js";
import { runSupportCli } from "./support.js";
import { DEFAULT_SUPPORT_QUERY_LIMITS } from "@oscharko-dev/keiko-activity-log/reader";
import { runSupportQueryCli } from "./support-query-cli.js";
import {
  fixtureLine,
  fixtureProcess,
  segmentIdentity,
  writeFixtureSegment,
} from "../../../tests/support/activity-log-segments.js";

const REAL_TMPDIR = realpathSync(tmpdir());
const roots: string[] = [];
const T0 = Date.UTC(2026, 8, 18, 8, 0, 0);
const ROOT_ID = "corr-proof-root-0001";
const CHILD_ID = "corr-proof-child-001";

afterEach(() => {
  closeFileServerLogSinks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function stateWithHistory(): string {
  const stateDir = mkdtempSync(join(REAL_TMPDIR, "keiko-query-proof-"));
  roots.push(stateDir);
  const a = fixtureProcess(6101, "fedcba01");
  writeFixtureSegment(stateDir, segmentIdentity(a, T0, 1), [
    fixtureLine(a, T0, { op: "client.diagnostic", correlationId: ROOT_ID }),
    fixtureLine(a, T0 + 5, {
      op: "client.diagnostic",
      correlationId: CHILD_ID,
      parentCorrelationId: ROOT_ID,
    }),
  ]);
  return stateDir;
}

function makeIo(): { readonly io: CliIo; readonly out: () => string; readonly err: () => string } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { out: (text): void => void out.push(text), err: (text): void => void err.push(text) },
    out: (): string => out.join(""),
    err: (): string => err.join(""),
  };
}

function lineOf(stateDir: string, op: string): string {
  const lines = persistedActivityLogLines(readPersistedActivityLog(stateDir), op);
  expect(lines).toHaveLength(1);
  return lines[0] ?? "";
}

// The support query commands reach the Activity Log through `loadActivityLog()`, its isolated graph
// imported lazily. That first import is the slowest step of this suite and, under coverage or on a
// slow filesystem, can alone exceed the per-test budget of whichever test runs first. Pay it once
// here, bounded on the hook as in portable-macos-activation.test.ts, so a real hang still fails.
beforeAll(async () => {
  await loadActivityLog();
}, 60_000);
describe("support query activity log proofs (#3531)", () => {
  it("persists support.manifest.rebuilt and support.query.completed for one correlated query", async () => {
    const stateDir = stateWithHistory();
    const { io, out } = makeIo();

    const code = await runSupportCli(
      ["query", "--state-dir", stateDir, "--correlation-id", ROOT_ID, "--json"],
      io,
      {},
    );

    expect(code).toBe(0);
    const result = JSON.parse(out()) as {
      readonly metrics: { readonly resultEventCount: number; readonly selectedBytes: number };
      readonly diagnosticSufficiency: { readonly status: string };
    };
    const manifest = expectActivityLogProof(
      "support.manifest.rebuilt.manifest-evidence",
      lineOf(stateDir, "support.manifest.rebuilt"),
    );
    const completed = expectActivityLogProof(
      "support.query.completed.query-evidence",
      lineOf(stateDir, "support.query.completed"),
    );
    expect(manifest).toMatchObject({
      surface: "query",
      persisted: true,
      segmentCount: 1,
      builtCount: 1,
      completeness: "complete",
    });
    expect(completed).toMatchObject({
      surface: "query",
      queryClass: "correlation",
      closureCorrelationCount: 2,
      resultEventCount: result.metrics.resultEventCount,
      selectedBytes: result.metrics.selectedBytes,
      truncation: "none",
      sufficiency: result.diagnosticSufficiency.status,
    });
    expect(completed.correlationId).toBe(manifest.correlationId);
    for (const record of [manifest, completed]) {
      const text = JSON.stringify(record);
      for (const forbidden of [ROOT_ID, CHILD_ID, stateDir, "fedcba01"]) {
        expect(text).not.toContain(forbidden);
      }
    }
  });

  // Regression (review 4050607039): a closure that fully resolves and streams every correlation
  // but whose event bodies exceed --max-bytes must not persist an inconsistent pair — a nonzero
  // closureCorrelationCount next to a hardcoded candidateEventCount: 0, indistinguishable from real
  // evidence loss once written to the Activity Log.
  it("persists a consistent closure/candidate pair when a resolved closure exceeds --max-bytes", async () => {
    const stateDir = stateWithHistory();
    const { io, out } = makeIo();

    const code = await runSupportCli(
      [
        "query",
        "--state-dir",
        stateDir,
        "--correlation-id",
        ROOT_ID,
        "--max-bytes",
        "50",
        "--json",
      ],
      io,
      {},
    );

    expect(code).toBe(0);
    const result = JSON.parse(out()) as {
      readonly events: readonly unknown[];
      readonly truncation: { readonly state: string };
    };
    expect(result.events).toEqual([]);
    expect(result.truncation.state).toBe("budget-exceeded");
    const completed = expectActivityLogProof(
      "support.query.completed.query-evidence",
      lineOf(stateDir, "support.query.completed"),
    );
    expect(completed).toMatchObject({
      surface: "query",
      queryClass: "correlation",
      truncation: "budget-exceeded",
      sufficiency: "insufficient",
      closureCorrelationCount: 2,
    });
    // The regression: candidateEventCount must reflect the closure that was actually streamed
    // (both correlations), never the hardcoded 0 a fully-resolved-but-over-budget closure produced.
    expect(completed.candidateEventCount).toBeGreaterThan(0);
    for (const forbidden of [ROOT_ID, CHILD_ID, stateDir, "fedcba01"]) {
      expect(JSON.stringify(completed)).not.toContain(forbidden);
    }
  });

  it("persists support.query.failed with a closed error kind when the incident lookup fails", async () => {
    const stateDir = stateWithHistory();
    const { io, err } = makeIo();
    const activityLog = await loadActivityLog();
    const failingActivityLog = {
      ...activityLog,
      readSupportIncident: (): never => {
        throw new Error("incident store unavailable");
      },
    };

    const code = await runSupportQueryCli(
      {
        stateDir,
        json: true,
        selector: { incidentId: "0123456789abcdef0123456789abcdef", filter: {} },
        limits: DEFAULT_SUPPORT_QUERY_LIMITS,
      },
      io,
      {},
      { run: { loadActivityLog: () => Promise.resolve(failingActivityLog) } },
    );

    expect(code).toBe(1);
    expect(err()).toContain("incident lookup failed");
    const failed = expectActivityLogProof(
      "support.query.failed.failure-evidence",
      lineOf(stateDir, "support.query.failed"),
    );
    expect(failed).toMatchObject({
      level: "error",
      errorKind: "read-failed",
      surface: "query",
      failureStage: "incident-lookup",
      completeness: "unknown",
    });
    expect(JSON.stringify(failed)).not.toContain("incident store unavailable");
  });
});
