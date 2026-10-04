import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  supportIncidentRetentionPolicy,
  listSupportIncidents,
  recordUserReportedIncident,
  closeFileServerLogSinks,
} from "@oscharko-dev/keiko-activity-log";
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
  });
});
