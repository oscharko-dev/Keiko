import { resetServerLogFailureNotices } from "../../../tests/support/activity-log-test-support.js";
// `keiko support incident` (#3533): argument parsing, the canonical descriptor resolution from the
// pinned window, the public/private projections the CLI prints, and the report/dismiss actions,
// all through the production server module (no mocks of the store or the analyzer).

import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLogOperationSchema,
  attachActivityLogEventRegistration,
  type SupportIncidentPrivateProjection,
  type SupportIncidentPublicProjection,
  type SupportIncidentRecord,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import {
  closeFileServerLogSinks,
  createFileServerLogSink,
  recordRegisteredFailureIncident,
} from "@oscharko-dev/keiko-activity-log";
import type { CliIo } from "./runner.js";
import { ACTIVITY_LOG_READ_CHUNK_BYTES } from "@oscharko-dev/keiko-activity-log/reader";
import { loadActivityLog } from "./lazy-modules.js";
import { runSupportCli } from "./support.js";
import { analyzeLogText } from "@oscharko-dev/keiko-activity-log/reader";
import {
  MAX_SUPPORT_INCIDENT_WINDOW_BYTES,
  SupportIncidentWindowError,
  parseSupportIncidentArgs,
  resolveSupportIncidentEvidence,
} from "./support-incident.js";
import {
  fixtureLine,
  fixtureProcess,
  segmentIdentity,
  writeFixtureSegment,
} from "../../../tests/support/activity-log-segments.js";

const INCIDENT_ID = "0123456789abcdef0123456789abcdef";
// A registered failure whose class requires nothing but the failure line itself.
const FAILURE_OP = "cli.support.export.failed";

function makeIo(): { readonly io: CliIo; readonly out: () => string; readonly err: () => string } {
  let out = "";
  let err = "";
  return {
    io: {
      out: (text: string): void => {
        out += text;
      },
      err: (text: string): void => {
        err += text;
      },
    },
    out: () => out,
    err: () => err,
  };
}

async function run(
  args: readonly string[],
): Promise<{ readonly code: number; readonly out: string; readonly err: string }> {
  const capture = makeIo();
  const code = await runSupportCli(["incident", ...args], capture.io);
  return { code, out: capture.out(), err: capture.err() };
}

// Incident commands reach the Activity Log through `loadActivityLog()`, its isolated graph
// imported lazily. That first import is the slowest step of this suite and, under coverage or on a
// slow filesystem, can alone exceed the per-test budget of whichever test runs first. Pay it once
// here, bounded on the hook as in portable-macos-activation.test.ts, so a real hang still fails.
beforeAll(async () => {
  await loadActivityLog();
}, 60_000);
describe("parseSupportIncidentArgs", () => {
  it("parses every subcommand and its flags", () => {
    expect(parseSupportIncidentArgs(["list", "--json"])).toEqual({
      kind: "ok",
      value: { command: "list", incidentId: undefined, stateDir: undefined, json: true },
    });
    expect(parseSupportIncidentArgs(["show", INCIDENT_ID, "--state-dir", "/tmp/k"])).toEqual({
      kind: "ok",
      value: { command: "show", incidentId: INCIDENT_ID, stateDir: "/tmp/k", json: false },
    });
    expect(parseSupportIncidentArgs([])).toEqual({ kind: "help" });
    expect(parseSupportIncidentArgs(["report", "--help"])).toEqual({ kind: "help" });
  });

  it.each([
    [["publish"], "unknown subcommand"],
    [["show"], "requires an incident ID"],
    [["dismiss", "../../etc"], "requires an incident ID"],
    [["preview", INCIDENT_ID.toUpperCase()], "requires an incident ID"],
    [["list", "--state-dir"], "--state-dir is missing its value"],
  ])("rejects %j", (args, message) => {
    const parsed = parseSupportIncidentArgs(args);
    expect(parsed.kind).toBe("usage");
    expect(parsed.kind === "usage" ? parsed.message : "").toContain(message);
  });
});

describe("keiko support incident", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "keiko-cli-incident-"));
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
  });

  afterEach(() => {
    closeFileServerLogSinks();
    resetServerLogFailureNotices();
    vi.restoreAllMocks();
    rmSync(stateDir, { recursive: true, force: true });
  });

  async function reportIncident(): Promise<string> {
    const reported = await run(["report", "--state-dir", stateDir, "--json"]);
    expect(reported.code).toBe(0);
    const parsed = JSON.parse(reported.out) as { status: string; incidentId: string };
    expect(parsed.status).toBe("created");
    return parsed.incidentId;
  }

  it("records a user report that resolves insufficient with a closed instrumentation-gap reason", async () => {
    const incidentId = await reportIncident();
    const shown = await run(["show", incidentId, "--state-dir", stateDir, "--json"]);
    expect(shown.code).toBe(0);
    const view = JSON.parse(shown.out) as SupportIncidentPrivateProjection;
    expect(view).toMatchObject({
      incidentId,
      trigger: "user-report",
      surface: "unattributed",
      sufficiencyStatus: "insufficient",
      sufficiencyReasons: ["no-registered-failure"],
      coverage: { requiredClassCount: 0, presentClassCount: 0 },
      pin: { status: "pinned" },
    });
    expect(view.segments.length).toBeGreaterThan(0);
    expect(view.lineCount).toBeGreaterThan(0);
  });

  it("previews only the strict public projection", async () => {
    const incidentId = await reportIncident();
    const preview = await run(["preview", incidentId, "--state-dir", stateDir, "--json"]);
    const shown = await run(["show", incidentId, "--state-dir", stateDir, "--json"]);
    const publicView = JSON.parse(preview.out) as SupportIncidentPublicProjection;
    const privateView = JSON.parse(shown.out) as SupportIncidentPrivateProjection;
    for (const [key, value] of Object.entries(publicView)) {
      expect(privateView).toHaveProperty(key, value);
    }
    expect(Object.keys(publicView).length).toBeLessThan(Object.keys(privateView).length);
    for (const privateKey of ["correlation", "segments", "window", "pin", "sufficiencyReasons"]) {
      expect(publicView).not.toHaveProperty(privateKey);
    }
    const human = await run(["preview", incidentId, "--state-dir", stateDir]);
    expect(human.out).toContain("Nothing has been sent");
    expect(human.out).not.toContain(stateDir);
  });

  it("resolves a registered failure's window to complete when its class evidence is whole", async () => {
    const registration = activityLogOperationSchema(FAILURE_OP);
    if (registration === undefined) throw new Error("fixture operation is not registered");
    createFileServerLogSink(stateDir).write(
      attachActivityLogEventRegistration(
        {
          level: "error",
          category: "diagnostic",
          op: FAILURE_OP,
          correlationId: "failed-export-1",
          errorKind: "unavailable",
          extra: {
            reason: "activity-log-unavailable",
            targetSha256: "a".repeat(64),
            failureKind: "SupportActivityLogUnavailableError",
            completeness: "complete",
            loss: "none",
          },
        },
        registration,
      ),
    );
    const recorded = recordRegisteredFailureIncident(stateDir, {
      op: FAILURE_OP,
      errorKind: "unavailable",
      correlationId: "failed-export-1",
    });
    expect(recorded?.status).toBe("created");
    const incidentId = recorded?.status === "created" ? recorded.incidentId : "";
    const shown = await run(["show", incidentId, "--state-dir", stateDir, "--json"]);
    expect(JSON.parse(shown.out)).toMatchObject({
      trigger: "registered-failure",
      op: FAILURE_OP,
      surface: "runtime-packages",
      errorKind: "unavailable",
      sufficiencyStatus: "complete",
      sufficiencyReasons: [],
      coverage: { requiredClassCount: 1, presentClassCount: 1, completeClassCount: 1 },
      correlation: { rootCorrelationId: "failed-export-1", childCorrelationIds: [] },
      integrity: "supported",
      completeness: "complete",
      loss: "none",
    });
  });

  it("lists, and dismisses only on an explicit request", async () => {
    const incidentId = await reportIncident();
    const listed = await run(["list", "--state-dir", stateDir, "--json"]);
    const { incidents } = JSON.parse(listed.out) as { incidents: SupportIncidentRecord[] };
    expect(incidents.map((incident) => incident.incidentId)).toEqual([incidentId]);
    const human = await run(["list", "--state-dir", stateDir]);
    expect(human.out).toContain(incidentId);
    expect(human.out).toContain("user-report");
    expect((await run(["dismiss", incidentId, "--state-dir", stateDir])).code).toBe(0);
    expect((await run(["dismiss", incidentId, "--state-dir", stateDir])).code).toBe(1);
    expect((await run(["list", "--state-dir", stateDir])).out).toBe(
      "No open incident candidates.\n",
    );
  });

  it("reports an unknown incident without resolving anything", async () => {
    const shown = await run(["show", INCIDENT_ID, "--state-dir", stateDir]);
    expect(shown.code).toBe(1);
    expect(shown.err).toContain(`no open incident ${INCIDENT_ID}`);
  });

  it("analyzes the window whole or not at all", () => {
    expect(() =>
      resolveSupportIncidentEvidence(
        [
          {
            segmentId: "20260918T120000000Z-4242-0a1b2c3d-000001",
            state: "sealed",
            sizeBytes: MAX_SUPPORT_INCIDENT_WINDOW_BYTES + 1,
            path: join(stateDir, "logs", "activity-20260918T120000000Z-4242-0a1b2c3d-000001.jsonl"),
          },
        ],
        stateDir,
      ),
    ).toThrow(SupportIncidentWindowError);
    expect(() =>
      resolveSupportIncidentEvidence(
        [
          {
            segmentId: "20260918T120000000Z-4242-0a1b2c3d-000001",
            state: "sealed",
            sizeBytes: 10,
            path: join(stateDir, "logs", "activity-20260918T120000000Z-4242-0a1b2c3d-000001.jsonl"),
          },
        ],
        stateDir,
      ),
    ).toThrow(SupportIncidentWindowError);
  });

  // Audit (#3531): `readSupportIncidentWindow` used to join every covered segment's lines into one
  // in-memory string (up to MAX_SUPPORT_INCIDENT_WINDOW_BYTES) before handing it to the analyzer.
  // `resolveSupportIncidentEvidence` must stream instead: never a whole-file read, only bounded
  // chunks, and the exact same analysis result a whole-text read would have produced.
  it("streams a multi-segment window in bounded chunks and never reads a segment whole", () => {
    const process = fixtureProcess(7101, "deadbeef");
    const t0 = Date.UTC(2026, 8, 18, 9, 0, 0);
    const bulkLines = (atMs: number, count: number): string[] =>
      Array.from({ length: count }, (_unused, index) =>
        fixtureLine(process, atMs + index, {
          op: "client.diagnostic",
          correlationId: `corr-bulk-${String(index).padStart(6, "0")}`,
        }),
      );
    const first = writeFixtureSegment(
      stateDir,
      segmentIdentity(process, t0, 1),
      bulkLines(t0, 300),
    );
    const second = writeFixtureSegment(
      stateDir,
      segmentIdentity(process, t0 + 400_000, 2),
      bulkLines(t0 + 400_000, 300),
    );
    const segments = [
      { segmentId: "s1", state: "sealed" as const, sizeBytes: statSync(first).size, path: first },
      { segmentId: "s2", state: "sealed" as const, sizeBytes: statSync(second).size, path: second },
    ];
    const totalBytes = segments.reduce((sum, segment) => sum + segment.sizeBytes, 0);
    // The fixture must genuinely exceed several read chunks, or a bug that reads the whole segment
    // in one call could still pass by accident.
    expect(totalBytes).toBeGreaterThan(ACTIVITY_LOG_READ_CHUNK_BYTES * 2);

    // `readActivityLogFileLines`'s own observability seam (never used in production) reports every
    // raw chunk it reads, in order, before yielding the lines inside it — the same seam
    // `support-segment-scan.ts`'s `ActivityLogScanner` uses to size its manifest digests. Recording
    // every chunk's size here proves the window is genuinely pulled through many bounded reads,
    // never accumulated into one buffer sized to the window.
    const chunkSizes: number[] = [];
    const analysis = resolveSupportIncidentEvidence(segments, stateDir, (chunk) => {
      chunkSizes.push(chunk.length);
    });

    // Several chunks, each within the bound — never one read sized to the whole window (or even to
    // one whole segment, both of which exceed one chunk by construction, asserted above).
    expect(chunkSizes.length).toBeGreaterThan(2);
    for (const size of chunkSizes) {
      expect(size).toBeLessThanOrEqual(ACTIVITY_LOG_READ_CHUNK_BYTES);
    }
    expect(chunkSizes.reduce((sum, size) => sum + size, 0)).toBe(totalBytes);
    // The whole-file primitive (`readKeptFiles`/`readVerifiedLogText`'s own `readFileSync`) is
    // structurally unreachable from this path: `support-incident.ts` no longer imports it at all.
    expect(readFileSync(join(import.meta.dirname, "support-incident.ts"), "utf8")).not.toContain(
      "support-export.js",
    );
    expect(analysis.evidence.supportedLineCount).toBe(600);

    // Same verdict the whole-text (pre-migration) reconstruction would have produced for this
    // well-formed window: the migration changes memory shape only, never a result.
    const wholeText = readFileSync(first, "utf8") + readFileSync(second, "utf8");
    expect(analysis).toEqual(analyzeLogText(wholeText));
  });

  // The pre-migration reconstruction (`readKeptFiles` rejoining every kept line with its own
  // trailing "\n") always reported the LAST line of the window as terminated, even when the
  // covered active segment's own tail was torn — the rejoin masked it. `resolveSupportIncidentEvidence`
  // preserves that exact verdict (forces `terminated: true` on every line it yields) rather than
  // silently starting to report a torn tail as `truncated`, which would be a result change this
  // audit is not chartered to make.
  it("matches the pre-migration reconstruction's masking of a torn active-segment tail", () => {
    const process = fixtureProcess(7202, "deadbee2");
    const t0 = Date.UTC(2026, 8, 18, 9, 30, 0);
    const sealedPath = writeFixtureSegment(stateDir, segmentIdentity(process, t0, 1), [
      fixtureLine(process, t0, { op: "client.diagnostic", correlationId: "corr-torn-000001" }),
    ]);
    const activePath = writeFixtureSegment(
      stateDir,
      segmentIdentity(process, t0 + 1000, 2),
      [fixtureLine(process, t0 + 1000, { op: "client.diagnostic", correlationId: "corr-torn-2" })],
      { state: "active", tail: '{"ts":"2026-09-18T09:30:02.000Z","op":"client.d' },
    );
    const segments = [
      {
        segmentId: "s1",
        state: "sealed" as const,
        sizeBytes: statSync(sealedPath).size,
        path: sealedPath,
      },
      {
        segmentId: "s2",
        state: "active" as const,
        sizeBytes: statSync(activePath).size,
        path: activePath,
      },
    ];

    const analysis = resolveSupportIncidentEvidence(segments, stateDir);

    // The old reconstruction's own join: every kept line (including a torn tail) rejoined with its
    // own trailing "\n" before analysis, exactly as `readSupportIncidentWindow` used to build its
    // `windowText`.
    const rejoinedLines = [
      ...readFileSync(sealedPath, "utf8").split("\n").filter(Boolean),
      ...readFileSync(activePath, "utf8").split("\n").filter(Boolean),
    ];
    const rejoinedText = rejoinedLines.map((line) => `${line}\n`).join("");
    expect(analysis).toEqual(analyzeLogText(rejoinedText));
    // The torn fragment is invalid JSON either way, but WHICH rejected evidence class it gets is
    // exactly the quirk being preserved: `invalidJsonEvidence` reads a forced-terminated line as
    // `corrupt` (a complete-but-malformed record), never as `truncated` (an incomplete one) — the
    // one distinction a real bounded reader would have reported correctly.
    expect(analysis.evidence.corruptLineCount).toBe(1);
    expect(analysis.evidence.truncatedLineCount).toBe(0);
  });
});
