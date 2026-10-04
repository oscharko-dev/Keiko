import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  supportIncidentRetentionPolicy,
  listSupportIncidents,
  recordUserReportedIncident,
  closeFileServerLogSinks,
  currentActivityLogReadiness,
} from "@oscharko-dev/keiko-activity-log";
import { ACTIVITY_LOG_STORE_POLICY_FILE_NAME } from "@oscharko-dev/keiko-contracts/runtime/observability";
import { createBufferedServerLogSink } from "../../../tests/support/buffered-server-log.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";
import { resetServerLogger } from "../../../tests/support/activity-log-test-support.js";
import { createServerLogger, setServerLogger } from "./observability/index.js";
import { supportDiagnosticCapacity } from "./support-diagnostic-capacity.js";
import { API_ROUTES, STREAMING, type RouteContext } from "./routes.js";
import type { UiHandlerDeps } from "./deps.js";
import { buildRedactor, createRunRegistry } from "./index.js";
import { createInMemoryUiStore } from "./store/index.js";
const directories: string[] = [];
afterEach(() => {
  resetServerLogger();
  closeFileServerLogSinks();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});
function fixture(): { ctx: RouteContext; deps: UiHandlerDeps; stateDir: string } {
  const stateDir = mkdtempSync(join(tmpdir(), "keiko-diagnostic-capacity-"));
  directories.push(stateDir);
  return {
    stateDir,
    ctx: {
      req: {} as RouteContext["req"],
      res: {} as RouteContext["res"],
      params: {},
      correlationId: "capacity-inspection-correlation",
      url: new URL("http://localhost/api/health"),
    },
    deps: {
      config: undefined,
      configPresent: false,
      evidenceStore: {
        put: () => "",
        list: () => [],
        get: () => undefined,
        delete: () => undefined,
      },
      env: { KEIKO_STATE_DIR: stateDir },
      redactor: buildRedactor({}),
      registry: createRunRegistry(),
      modelPortFactory: () => undefined,
      store: createInMemoryUiStore(),
    },
  };
}
describe("existing health diagnostic storage projection", () => {
  it.each(["corrupt", "unsafe-permissions"] as const)(
    "reports %s governing storage once per failure streak without inventing counts or event loss",
    (fault) => {
      const { ctx, deps: originalDeps, stateDir } = fixture();
      const record = vi.fn();
      const deps = { ...originalDeps, diagnostics: { record } };
      expect(recordUserReportedIncident(stateDir).status).toBe("created");
      closeFileServerLogSinks();
      const path = join(stateDir, "logs", ACTIVITY_LOG_STORE_POLICY_FILE_NAME);
      const original = readFileSync(path);
      const baseline = currentActivityLogReadiness();
      const breakPolicy = (): void => {
        if (fault === "corrupt") writeFileSync(path, "not a policy", { mode: 0o600 });
        else chmodSync(path, 0o644);
      };
      breakPolicy();
      const failed = supportDiagnosticCapacity(ctx, deps);
      expect(failed.readiness).toBe(
        baseline.readiness === "unavailable" ? "unavailable" : "degraded",
      );
      expect(failed.reasons).toEqual([...new Set([...baseline.reasons, "storage-check-failed"])]);
      expect(failed).not.toHaveProperty("retainedDiagnosticCount");
      expect(failed).not.toHaveProperty("diagnosticCapacity");
      expect({ ...baseline, ...failed }).toMatchObject({
        writer: baseline.writer,
        lostEvents: baseline.lostEvents,
      });
      supportDiagnosticCapacity(ctx, deps);
      expect(record).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(record.mock.calls)).not.toContain(stateDir);
      chmodSync(path, 0o600);
      writeFileSync(path, original);
      expect(supportDiagnosticCapacity(ctx, deps)).toHaveProperty("retainedDiagnosticCount", 1);
      breakPolicy();
      supportDiagnosticCapacity(ctx, deps);
      expect(record).toHaveBeenCalledTimes(2);
    },
  );
  it("reports retained candidates against the governing byte reservation capacity without calling them open defects or mutating their identity", async () => {
    const { ctx, deps, stateDir } = fixture();
    for (let slot = 0; slot < 33; slot += 1)
      expect(
        recordUserReportedIncident(stateDir, { correlationId: `retained-${String(slot)}` }).status,
      ).toBe("created");
    const ids = listSupportIncidents(stateDir).map((record) => record.incidentId);
    const health = API_ROUTES.find((route) => route.pattern === "/api/health");
    const result = await health?.handler(ctx, deps);
    if (result === undefined || result === STREAMING)
      throw new Error("Expected JSON health projection");
    expect(result.body).toMatchObject({
      diagnostics: {
        retainedDiagnosticCount: 33,
        diagnosticCapacity: supportIncidentRetentionPolicy(stateDir).capacity,
      },
    });
    expect(JSON.stringify(result.body)).not.toContain(stateDir);
    expect(JSON.stringify(result.body)).not.toContain("retained-");
    expect(listSupportIncidents(stateDir).map((record) => record.incidentId)).toEqual(ids);
  });
  it("logs only bounded candidate counts when the count changes", () => {
    const { ctx, deps, stateDir } = fixture();
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "debug" }));
    expect(supportDiagnosticCapacity(ctx, deps)).toMatchObject({
      retainedDiagnosticCount: 0,
      diagnosticCapacity: supportIncidentRetentionPolicy(stateDir).capacity,
    });
    supportDiagnosticCapacity(ctx, deps);
    const events = sink.events.filter((event) => event.op === "support.diagnostics.capacity");
    expect(events).toHaveLength(1);
    const event = events[0];
    if (event === undefined) throw new Error("Expected capacity evidence");
    expectActivityLogProof("support.diagnostics.capacity.line", formatActivityLogProofLine(event));
    expect(event.level).toBe("info");
    expect(event.errorKind).toBeUndefined();
    expect(recordUserReportedIncident(stateDir).status).toBe("created");
    supportDiagnosticCapacity({ correlationId: "later-health-observation" }, deps);
    const observations = sink.events.filter((entry) => entry.op === "support.diagnostics.capacity");
    expect(observations).toHaveLength(2);
    expect(observations[1]).toMatchObject({
      correlationId: "later-health-observation",
      extra: { retainedCandidateCount: 1 },
    });
  });
  it("keeps truthful storage counts when the production logger owns a sink failure", () => {
    const { ctx, deps: originalDeps, stateDir } = fixture();
    const record = vi.fn();
    const deps = { ...originalDeps, diagnostics: { record } };
    setServerLogger(
      createServerLogger({
        sink: {
          write: (): never => {
            throw new Error("synthetic logging failure");
          },
        },
      }),
    );
    const before = currentActivityLogReadiness().lostEvents;
    expect(supportDiagnosticCapacity(ctx, deps)).toMatchObject({
      retainedDiagnosticCount: 0,
      diagnosticCapacity: supportIncidentRetentionPolicy(stateDir).capacity,
    });
    expect(record).not.toHaveBeenCalled();
    expect(currentActivityLogReadiness().lostEvents).toBeGreaterThan(before);
  });
});
