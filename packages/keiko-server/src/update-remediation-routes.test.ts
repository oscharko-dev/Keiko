import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  UpdateRemediationActionRequest,
  UpdateRemediationStatusReport,
  UpdateRemediationStatusRequest,
} from "@oscharko-dev/keiko-contracts";
import { buildCspHeader } from "./csp.js";
import { buildRedactor, createInMemoryUiStore, type UiHandlerDeps } from "./index.js";
import { createRunRegistry } from "./runs.js";
import { createUiServer, UI_HOST } from "./server.js";
import type { UpdateRemediationManager } from "./update-remediation.js";

function report(): UpdateRemediationStatusReport {
  return {
    schemaVersion: 1,
    checkedAt: "2026-06-30T12:00:00.000Z",
    targetVersion: "0.2.12",
    overallStatus: "pending",
    updateCanComplete: false,
    actions: [
      {
        actionId: "local-knowledge-reindex:local-knowledge",
        kind: "local-knowledge-reindex",
        store: "local-knowledge",
        remediation: "local-knowledge-reindex-required",
        status: "pending",
        required: true,
        canRun: true,
        canDefer: true,
        userApprovalRequired: true,
        featureIds: ["local-knowledge"],
        scopeCounts: { stores: 1, artifacts: 1, retainedEntries: 0, capsules: 1 },
        message: "Refresh Local Knowledge vectors.",
      },
    ],
    affectedFeatures: [
      {
        featureId: "local-knowledge",
        label: "Local Knowledge",
        state: "unavailable",
        reason: "Refresh Local Knowledge vectors.",
        actionIds: ["local-knowledge-reindex:local-knowledge"],
      },
    ],
    warnings: [],
  };
}

class FakeUpdateRemediationManager implements UpdateRemediationManager {
  public readonly statuses: UpdateRemediationStatusRequest[] = [];
  public readonly actions: UpdateRemediationActionRequest[] = [];

  public readonly getStatus = (
    request: UpdateRemediationStatusRequest = {},
  ): UpdateRemediationStatusReport => {
    this.statuses.push(request);
    return report();
  };

  public readonly runAction = (
    request: UpdateRemediationActionRequest,
  ): Promise<UpdateRemediationStatusReport> => {
    this.actions.push(request);
    return Promise.resolve({ ...report(), overallStatus: "completed", updateCanComplete: true });
  };

  public readonly completeRestart = (): UpdateRemediationStatusReport => report();

  public readonly updateCanComplete = (): boolean => false;
}

let server: Server;
let staticRoot: string;
let port: number;
let updateRemediation: FakeUpdateRemediationManager;

async function listen(srv: Server): Promise<number> {
  await new Promise<void>((resolve) => srv.listen(0, UI_HOST, resolve));
  return (srv.address() as AddressInfo).port;
}

async function closeServer(srv: Server = server): Promise<void> {
  await new Promise<void>((resolve) => {
    srv.close(() => {
      resolve();
    });
  });
}

function baseDeps(): UiHandlerDeps {
  return {
    config: undefined,
    configPresent: false,
    evidenceStore: {
      put: (): string => "",
      list: (): readonly string[] => [],
      get: (): string | undefined => undefined,
      delete: (): void => undefined,
    },
    env: {},
    redactor: buildRedactor({}),
    registry: createRunRegistry(),
    modelPortFactory: (): undefined => undefined,
    store: createInMemoryUiStore(),
    updateRemediation,
  };
}

async function buildServer(handlerDeps: UiHandlerDeps): Promise<{ server: Server; port: number }> {
  const probe = createUiServer({ staticRoot, csp: buildCspHeader([]), port: 0, handlerDeps });
  const chosenPort = await listen(probe);
  await closeServer(probe);
  const next = createUiServer({
    staticRoot,
    csp: buildCspHeader([]),
    port: chosenPort,
    handlerDeps,
  });
  await new Promise<void>((resolve) => next.listen(chosenPort, UI_HOST, resolve));
  return { server: next, port: chosenPort };
}

function baseUrl(): string {
  return `http://${UI_HOST}:${String(port)}`;
}

function csrfHeaders(): Record<string, string> {
  return { "Content-Type": "application/json", "X-Keiko-CSRF": "1" };
}

beforeEach(async () => {
  staticRoot = await mkdtemp(join(tmpdir(), "keiko-update-remediation-routes-"));
  updateRemediation = new FakeUpdateRemediationManager();
  const built = await buildServer(baseDeps());
  server = built.server;
  port = built.port;
});

afterEach(async () => {
  await closeServer();
  await rm(staticRoot, { recursive: true, force: true });
});

describe("update remediation routes", () => {
  it("returns persisted remediation status", async () => {
    const res = await fetch(`${baseUrl()}/api/update/remediation`);
    const body = (await res.json()) as UpdateRemediationStatusReport;

    expect(res.status).toBe(200);
    expect(body.actions[0]?.actionId).toBe("local-knowledge-reindex:local-knowledge");
  });

  it("requires CSRF for remediation status preparation", async () => {
    const res = await fetch(`${baseUrl()}/api/update/remediation/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetVersion: "0.2.12" }),
    });

    expect(res.status).toBe(403);
  });

  it("requires CSRF for remediation action execution", async () => {
    const res = await fetch(`${baseUrl()}/api/update/remediation/actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actionId: "local-knowledge-reindex:local-knowledge" }),
    });

    expect(res.status).toBe(403);
  });

  it("prepares status with release impact and runs actions", async () => {
    const prepared = await fetch(`${baseUrl()}/api/update/remediation/status`, {
      method: "POST",
      headers: csrfHeaders(),
      body: JSON.stringify({
        targetVersion: "0.2.12",
        impact: {
          stateImpact: [
            {
              store: "local knowledge",
              description: "Reindex required.",
              remediation: "local-knowledge-reindex-required",
              userActionRequired: true,
            },
          ],
        },
      }),
    });
    const action = await fetch(`${baseUrl()}/api/update/remediation/actions`, {
      method: "POST",
      headers: csrfHeaders(),
      body: JSON.stringify({
        actionId: "local-knowledge-reindex:local-knowledge",
        targetVersion: "0.2.12",
      }),
    });

    expect(prepared.status).toBe(200);
    expect(action.status).toBe(200);
    expect(updateRemediation.statuses[0]).toMatchObject({ targetVersion: "0.2.12", persist: true });
    expect(updateRemediation.actions[0]).toMatchObject({
      actionId: "local-knowledge-reindex:local-knowledge",
    });
  });
});
