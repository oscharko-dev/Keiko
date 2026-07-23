/* eslint-disable @typescript-eslint/explicit-function-return-type -- Integration fixtures are contextually typed. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";
import type { CodingWorkbenchRuntimeSnapshot } from "@oscharko-dev/keiko-contracts";

import {
  createFakeSessionPairingPort,
  fakePairingRequestBody,
} from "../coding-app-session/_support.js";
import { createCodingAppSessionChannel } from "../coding-app-session/sessionChannel.js";
import { APP_SESSION_COOKIE_NAME } from "../coding-app-session/sessionCookie.js";
import { createSessionRegistry } from "../coding-app-session/sessionRegistry.js";
import { buildCspHeader } from "../csp.js";
import type { UiHandlerDeps } from "../deps.js";
import { createUiServer, UI_HOST } from "../server.js";
import { runMigrations } from "../store/schema.js";
import { createCodingRuntimeControlPlane } from "./codingRuntimeControlPlane.js";
import { createCodingRuntimeEvidenceAggregator } from "./codingRuntimeEvidenceAggregator.js";
import { createCodingRuntimeSnapshotStore } from "./codingRuntimeSnapshotStore.js";
import {
  createProductionCodingRuntimeHost,
  type CodingRuntimeTaskOutcome,
  type QualifiedProductionCodingRuntime,
} from "./productionCodingRuntimeHost.js";

const servers: Server[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => {
            resolve();
          });
        }),
    ),
  );
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, UI_HOST, resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("server did not bind TCP");
  return address.port;
}

async function startServer(staticRoot: string, handlerDeps: UiHandlerDeps): Promise<number> {
  const serverDeps = { staticRoot, csp: buildCspHeader([]), port: 0, handlerDeps };
  const server = createUiServer(serverDeps);
  const port = await listen(server);
  // The real listener binds once and atomically. Before any request can be issued, align the
  // test-owned authority descriptor with Node's selected port so the production Host/Origin guard
  // still validates the exact bound endpoint rather than a probe or a synthetic authority.
  serverDeps.port = port;
  servers.push(server);
  return port;
}

function post(port: number, body: unknown): Promise<Response> {
  return fetch(`http://${UI_HOST}:${String(port)}/api/coding-workbench/runtime/runs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Keiko-CSRF": "1",
      Origin: `http://${UI_HOST}:${String(port)}`,
    },
    body: JSON.stringify(body),
  });
}

function stop(port: number, runId: string): Promise<Response> {
  return fetch(
    `http://${UI_HOST}:${String(port)}/api/coding-workbench/runtime/runs/${runId}/stop`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Keiko-CSRF": "1",
        Origin: `http://${UI_HOST}:${String(port)}`,
      },
      body: JSON.stringify({ requestId: runId }),
    },
  );
}

describe("production coding runtime BFF", () => {
  it("#2644: exposes a research grant only on the paired research route", async () => {
    const staticRoot = await mkdtemp(join(tmpdir(), "keiko-runtime-bff-research-"));
    roots.push(staticRoot);
    await writeFile(join(staticRoot, "index.html"), "<html></html>", "utf8");
    const channel = createCodingAppSessionChannel({
      registry: createSessionRegistry(),
      pairingPort: createFakeSessionPairingPort(),
    });
    const paired = channel.pair(fakePairingRequestBody());
    if (!paired.paired) throw new Error("expected paired app session");
    const cookie = `${APP_SESSION_COOKIE_NAME}=${paired.cookieToken}`;
    const host = "approved-route-canary.example";
    const snapshot: CodingWorkbenchRuntimeSnapshot = {
      schemaVersion: "1",
      state: "running",
      revision: 2,
      updatedAt: "2026-07-23T00:00:00.000Z",
      runId: "run-1",
      requestedMode: "supervised-coding",
      runtimeSource: "keiko-sidecar",
      modelSource: "keiko-model-gateway",
    };
    let grantVisible = false;
    const grant = {
      grantId: "grant-route-canary",
      domains: [host],
      expiresAt: "2099-07-23T00:05:00.000Z",
    };
    const orchestrator = {
      status: (): CodingWorkbenchRuntimeSnapshot => snapshot,
      getSnapshot: (runId: string): CodingWorkbenchRuntimeSnapshot | undefined =>
        runId === "run-1" ? snapshot : undefined,
      pendingResearchAsk: () => undefined,
      researchGrant: () => (grantVisible ? grant : undefined),
    };
    const port = await startServer(staticRoot, {
      codingRuntimeOrchestrator: orchestrator,
      codingRuntimeEventHub: { subscribe: () => ({ ok: false, reason: "not-needed" }) },
      codingAppSessionChannel: channel,
    } as unknown as UiHandlerDeps);
    const baseUrl = `http://${UI_HOST}:${String(port)}/api/coding-workbench/runtime`;

    const statusWithoutGrant = await fetch(`${baseUrl}/status`);
    grantVisible = true;
    const unpairedStatus = await fetch(`${baseUrl}/status`);
    const pairedStatus = await fetch(`${baseUrl}/status`, { headers: { cookie } });
    const unpairedResearch = await fetch(`${baseUrl}/runs/run-1/research`);
    const pairedResearch = await fetch(`${baseUrl}/runs/run-1/research`, {
      headers: { cookie },
    });
    const bodies = await Promise.all(
      [statusWithoutGrant, unpairedStatus, pairedStatus, unpairedResearch, pairedResearch].map(
        (response) => response.json(),
      ),
    );

    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[2]).toEqual(bodies[0]);
    expect(bodies[3]).toEqual({ session: "unpaired" });
    expect(bodies[4]).toEqual({
      session: "active",
      grant,
    });
  });

  it("keeps authority server-owned and dispatches transient intent through a qualified host", async () => {
    const staticRoot = await mkdtemp(join(tmpdir(), "keiko-runtime-bff-"));
    roots.push(staticRoot);
    await writeFile(join(staticRoot, "index.html"), "<html></html>", "utf8");
    const db = new DatabaseSync(":memory:");
    runMigrations(db);
    const snapshots = createCodingRuntimeSnapshotStore(db);
    const evidenceBodies = new Map<string, string>();
    const evidence = createCodingRuntimeEvidenceAggregator({
      put: (id, body) => (evidenceBodies.set(id, body), id),
      get: (id) => evidenceBodies.get(id),
      list: () => [],
      delete: (id) => void evidenceBodies.delete(id),
    });
    const order: string[] = [];
    const usedRequests = new Set<string>();
    let activeRoot = "/managed/workspace";
    const completions = new Map<string, (outcome: CodingRuntimeTaskOutcome) => void>();
    const runtime: QualifiedProductionCodingRuntime = {
      createManager: (onRuntimeEvent) => ({
        start: (request) => {
          order.push(`ready:${request.runId}`);
          return { ok: true, runId: request.runId, status: "ready" };
        },
        issueApproval: () => ({ ok: false, failureCode: "runtime-stopped", retryable: false }),
        pause: () => ({ ok: false, failureCode: "runtime-run-mismatch", retryable: false }),
        resume: () => ({ ok: false, failureCode: "runtime-run-mismatch", retryable: false }),
        stop: (runId) => {
          order.push(`reaped:${runId}`);
          completions.get(runId)?.("cancelled");
          onRuntimeEvent({
            schemaVersion: "1",
            eventId: `stopped-${runId}`,
            runId,
            occurredAt: "2026-01-01T00:00:00.000Z",
            kind: "runtime-stopped",
            runtimeSource: "codex-cli-adapter",
            modelSource: "chatgpt-codex-subscription-profile",
            effectiveMode: "governed-assist",
            health: "stopped",
          });
          return Promise.resolve({ ok: true, status: "stopped" });
        },
        takeover: () => Promise.resolve({ ok: true, status: "stopped" }),
        reconcile: () => Promise.resolve({ ok: true, status: "stopped" }),
        health: () => ({ status: "stopped" }),
      }),
      mintLaunch: {
        resolve: (input) => {
          if (usedRequests.has(input.requestId) || input.workspaceRoot !== "/managed/workspace")
            throw new Error("authority mint rejected");
          usedRequests.add(input.requestId);
          order.push(`mint:${input.requestId}`);
          return launch();
        },
      },
      approvalAuthority: {
        issue: () => ({ ok: false, failureCode: "runtime-stopped", retryable: false }),
      },
      taskDispatcher: {
        dispatch: (request) => {
          order.push(`dispatch:${request.runId}:${request.taskIntent}`);
          const completion = new Promise<CodingRuntimeTaskOutcome>((resolve) => {
            completions.set(request.runId, resolve);
          });
          return Promise.resolve({ ok: true, completion });
        },
        abort: (request) => {
          order.push(`aborted:${request.runId}`);
          completions.get(request.runId)?.("cancelled");
          return Promise.resolve(true);
        },
      },
      cancellationRegistry: { signalFor: () => undefined },
    };
    const host = createProductionCodingRuntimeHost({ resolve: () => runtime });
    if (host === undefined) throw new Error("expected qualified runtime host");
    const control = createCodingRuntimeControlPlane({
      snapshots,
      evidence,
      workspaceLifecycle: {
        getActive: () => ({
          instance: { workspaceId: "workspace-1" },
          binding: { activeRoot },
        }),
      } as never,
      serverPrincipal: () => "local-operator",
      runtimeHost: host,
    });
    const port = await startServer(staticRoot, {
      codingRuntimeOrchestrator: control.orchestrator,
      codingRuntimeEventHub: control.eventHub,
      codingRuntimeHostQualified: control.runtimeHostQualified,
    } as UiHandlerDeps);

    const forged = await post(port, {
      requestId: "request-forged",
      taskIntent: "private task",
      requestedMode: "governed-assist",
      workspaceRoot: "/attacker",
      env: { TOKEN: "attacker" },
    });
    expect(forged.status).toBe(400);
    expect(order).toEqual([]);

    const started = await post(port, {
      requestId: "request-1",
      taskIntent: "private task",
      requestedMode: "governed-assist",
    });
    const startedBody = (await started.json()) as { runId: string; state: string };
    expect(startedBody.state).toBe("running");
    expect(order).toEqual([
      "mint:request-1",
      `ready:${startedBody.runId}`,
      `dispatch:${startedBody.runId}:private task`,
    ]);
    expect(JSON.stringify(snapshots.listAll())).not.toContain("private task");
    expect([...evidenceBodies.values()].join("\n")).not.toContain("private task");

    const stopped = await stop(port, startedBody.runId);
    expect(stopped.status).toBe(200);
    await expect(stopped.json()).resolves.toMatchObject({
      runId: startedBody.runId,
      state: "cancelled",
    });
    expect(order.at(-1)).toBe(`reaped:${startedBody.runId}`);
    const duplicateStop = await stop(port, startedBody.runId);
    expect(duplicateStop.status).toBe(200);
    await expect(duplicateStop.json()).resolves.toMatchObject({ state: "idle" });
    expect(order.filter((entry) => entry === `reaped:${startedBody.runId}`)).toHaveLength(1);

    const second = await post(port, {
      requestId: "request-2",
      taskIntent: "private task",
      requestedMode: "governed-assist",
    });
    const secondBody = (await second.json()) as { runId: string; state: string };
    expect(secondBody.state).toBe("running");
    expect(order.at(-1)).toBe(`dispatch:${secondBody.runId}:private task`);
    const secondStopped = await stop(port, secondBody.runId);
    expect(secondStopped.status).toBe(200);
    await expect(secondStopped.json()).resolves.toMatchObject({
      runId: secondBody.runId,
      state: "cancelled",
    });
    expect(order.at(-1)).toBe(`reaped:${secondBody.runId}`);

    expect(
      (
        await post(port, {
          requestId: "request-1",
          taskIntent: "private task",
          requestedMode: "governed-assist",
        })
      ).status,
    ).toBe(403);
    activeRoot = "/managed/drifted";
    expect(
      (
        await post(port, {
          requestId: "request-3",
          taskIntent: "private task",
          requestedMode: "governed-assist",
        })
      ).status,
    ).toBe(403);
    db.close();
  });
});

function launch() {
  return {
    recoveryHandle: "d".repeat(32),
    treeBindingId: "tree-binding",
    taskRef: "task-ref",
    adapterKind: "codex-cli" as const,
    runtimeSource: "codex-cli-adapter" as const,
    modelSource: "chatgpt-codex-subscription-profile" as const,
    effectiveMode: "governed-assist" as const,
    executablePath: "/managed/runtime",
    managedRoot: "/managed",
    gatewayUrl: "http://127.0.0.1:4317",
    modelProfileId: "qualified-profile",
    args: [],
    inheritedEnvAllowlist: [],
    shutdownTimeoutMs: 1_000,
    startTimeoutMs: 1_000,
  };
}
