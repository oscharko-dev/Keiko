// `keiko support incident` (#3533): argument parsing, the canonical descriptor resolution from the
// pinned window, the public/private projections the CLI prints, and the report/dismiss actions,
// all through the production server module (no mocks of the store or the analyzer).

import { mkdtempSync, rmSync } from "node:fs";
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
  resetServerLogFailureNotices,
} from "@oscharko-dev/keiko-server/observability/server-log";
import type { CliIo } from "./runner.js";
import { loadServer } from "./lazy-modules.js";
import { runSupportCli } from "./support.js";
import {
  MAX_SUPPORT_INCIDENT_WINDOW_BYTES,
  SupportIncidentWindowError,
  parseSupportIncidentArgs,
  readSupportIncidentWindow,
} from "./support-incident.js";

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

// The support commands reach keiko-server through `loadServer()`, the whole server module graph
// imported lazily. That first import is the slowest step of this suite and, under coverage or on a
// slow filesystem, can alone exceed the per-test budget of whichever test runs first. Pay it once
// here, bounded on the hook as in portable-macos-activation.test.ts, so a real hang still fails.
beforeAll(async () => {
  await loadServer();
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
    const server = await import("@oscharko-dev/keiko-server");
    const recorded = server.recordRegisteredFailureIncident(stateDir, {
      op: FAILURE_OP,
      errorKind: "unavailable",
      correlationId: "failed-export-1",
    });
    expect(recorded?.status).toBe("created");
    const incidentId = recorded?.status === "created" ? recorded.record.incidentId : "";
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
      readSupportIncidentWindow([
        {
          segmentId: "20260918T120000000Z-4242-0a1b2c3d-000001",
          state: "sealed",
          sizeBytes: MAX_SUPPORT_INCIDENT_WINDOW_BYTES + 1,
          path: join(stateDir, "logs", "activity-20260918T120000000Z-4242-0a1b2c3d-000001.jsonl"),
        },
      ]),
    ).toThrow(SupportIncidentWindowError);
    expect(() =>
      readSupportIncidentWindow([
        {
          segmentId: "20260918T120000000Z-4242-0a1b2c3d-000001",
          state: "sealed",
          sizeBytes: 10,
          path: join(stateDir, "logs", "activity-20260918T120000000Z-4242-0a1b2c3d-000001.jsonl"),
        },
      ]),
    ).toThrow(SupportIncidentWindowError);
  });
});
