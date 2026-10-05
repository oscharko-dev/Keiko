import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as activityLog from "@oscharko-dev/keiko-activity-log";
import type { ActivityLogReadinessSnapshot } from "@oscharko-dev/keiko-contracts/runtime/diagnostics";
import { API_ROUTES, STREAMING, type RouteContext } from "./routes.js";
import type { UiHandlerDeps } from "./deps.js";
import { buildRedactor, createRunRegistry } from "./index.js";
import { createInMemoryUiStore } from "./store/index.js";

vi.mock("@oscharko-dev/keiko-activity-log", async (importOriginal) => {
  const actual = await importOriginal<typeof activityLog>();
  return {
    ...actual,
    currentActivityLogReadiness: vi.fn(actual.currentActivityLogReadiness),
    listSupportIncidents: vi.fn(actual.listSupportIncidents),
    supportIncidentRetentionPolicy: vi.fn(actual.supportIncidentRetentionPolicy),
  };
});
const directories: string[] = [];
afterEach(() => {
  activityLog.closeFileServerLogSinks();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.mocked(activityLog.currentActivityLogReadiness).mockReset();
  vi.mocked(activityLog.listSupportIncidents).mockReset();
  vi.mocked(activityLog.supportIncidentRetentionPolicy).mockReset();
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

const READINESS: readonly ActivityLogReadinessSnapshot[] = [
  { readiness: "ready", reasons: [], writer: "production-file", lostEvents: 0 },
  {
    readiness: "degraded",
    reasons: ["storage-pressure"],
    writer: "production-file",
    lostEvents: 2,
  },
  { readiness: "unavailable", reasons: ["sink-unwritable"], writer: "unavailable", lostEvents: 7 },
];

describe("health preserves the Activity Log readiness projection", () => {
  it.each(READINESS)(
    "preserves $readiness without counting or opening incident records",
    async (snapshot) => {
      const { ctx, deps } = fixture();
      vi.mocked(activityLog.currentActivityLogReadiness).mockReturnValue(snapshot);
      const health = API_ROUTES.find((route) => route.pattern === "/api/health");
      const result = await health?.handler(ctx, deps);
      if (result === undefined || result === STREAMING)
        throw new TypeError("Expected health response");
      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({ status: "ok", diagnostics: snapshot });
      expect(result.body).toHaveProperty("diagnostics", snapshot);
      expect(activityLog.listSupportIncidents).not.toHaveBeenCalled();
      expect(activityLog.supportIncidentRetentionPolicy).not.toHaveBeenCalled();
    },
  );

  it("does not turn an unused incident-store probe into invented readiness or repeated diagnostics", async () => {
    const { ctx, deps: originalDeps } = fixture();
    const record = vi.fn();
    const deps = { ...originalDeps, diagnostics: { record } };
    vi.mocked(activityLog.currentActivityLogReadiness).mockReturnValue({
      readiness: "ready",
      reasons: [],
      writer: "production-file",
      lostEvents: 0,
    });
    vi.mocked(activityLog.listSupportIncidents).mockImplementation(() => {
      throw new Error("unreadable unused store");
    });
    const health = API_ROUTES.find((route) => route.pattern === "/api/health");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await health?.handler(ctx, deps);
      if (result === undefined || result === STREAMING)
        throw new TypeError("Expected health response");
      expect(result.body).toHaveProperty("diagnostics", {
        readiness: "ready",
        reasons: [],
        writer: "production-file",
        lostEvents: 0,
      });
    }
    expect(activityLog.listSupportIncidents).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });
});
