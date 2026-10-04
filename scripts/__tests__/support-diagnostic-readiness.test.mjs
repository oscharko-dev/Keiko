import { mkdtempSync, rmSync } from "node:fs";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  closeFileServerLogSinks,
  listSupportIncidents,
  recordUserReportedIncident,
  supportIncidentRetentionPolicy,
} from "@oscharko-dev/keiko-activity-log";
import { ACTIVITY_LOG_STORE_POLICY_FILE_NAME } from "@oscharko-dev/keiko-contracts/runtime/observability";
import {
  resolveActivityLogStorageConfig,
  writeActivityLogPolicyRecord,
} from "../../packages/keiko-activity-log/src/activity-log-store.js";
import { buildUiHandlerDeps } from "../../packages/keiko-server/src/deps.js";
import { API_ROUTES, STREAMING } from "../../packages/keiko-server/src/routes.js";
import { fetchHealth } from "../../packages/keiko-ui/src/lib/api.js";

const directories = [];
const dependencies = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const deps of dependencies.splice(0)) await deps.dispose?.();
  closeFileServerLogSinks();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

it("keeps the actual health projection in the UI when retained stock exceeds a new admission capacity", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "keiko-readiness-stock-"));
  directories.push(stateDir);
  for (let index = 0; index < 16; index += 1)
    expect(
      recordUserReportedIncident(stateDir, { correlationId: `stock-${String(index)}` }).status,
    ).toBe("created");
  closeFileServerLogSinks();
  const logs = join(stateDir, "logs");
  // A stopped-store policy migration changes future admission, not already retained records.
  rmSync(join(logs, ACTIVITY_LOG_STORE_POLICY_FILE_NAME));
  const { retentionBytes, retentionDays, pinQuotaBytes } = resolveActivityLogStorageConfig({
    KEIKO_LOG_RETENTION_BYTES: "65536",
  });
  writeActivityLogPolicyRecord(logs, logs, {
    schemaVersion: 1,
    retentionBytes,
    retentionDays,
    pinQuotaBytes,
  });
  const retainedCount = listSupportIncidents(stateDir, { readOnly: true }).length;
  const capacity = supportIncidentRetentionPolicy(stateDir).capacity;
  expect(retainedCount).toBeGreaterThan(capacity);
  const deps = buildUiHandlerDeps({
    configPath: join(stateDir, "missing-config.json"),
    evidenceDir: join(stateDir, "evidence"),
    uiDbPath: join(stateDir, "ui.db"),
    env: { KEIKO_STATE_DIR: stateDir, KEIKO_UI_DATA_DIR: stateDir },
  });
  dependencies.push(deps);
  const req = new IncomingMessage(new Socket());
  const route = API_ROUTES.find((candidate) => candidate.pattern === "/api/health");
  expect(route).toBeDefined();
  const result = await route.handler(
    {
      req,
      res: new ServerResponse(req),
      params: {},
      correlationId: "stock-health-request",
      url: new globalThis.URL("http://localhost/api/health"),
    },
    deps,
  );
  expect(result).not.toBe(STREAMING);
  expect(result.body.diagnostics).toMatchObject({
    retainedDiagnosticCount: retainedCount,
    diagnosticCapacity: capacity,
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new globalThis.Response(JSON.stringify(result.body))),
  );
  const health = await fetchHealth();
  expect(health.diagnostics).toEqual(result.body.diagnostics);
  expect(JSON.stringify(health)).not.toContain(stateDir);
});
