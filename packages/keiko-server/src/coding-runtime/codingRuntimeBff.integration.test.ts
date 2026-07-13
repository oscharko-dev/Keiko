/* eslint-disable @typescript-eslint/explicit-function-return-type -- Integration fixtures are contextually typed. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildCspHeader } from "../csp.js";
import type { UiHandlerDeps } from "../deps.js";
import { createUiServer, UI_HOST } from "../server.js";
import { runMigrations } from "../store/schema.js";
import { createCodingRuntimeControlPlane } from "./codingRuntimeControlPlane.js";
import { createCodingRuntimeEvidenceAggregator } from "./codingRuntimeEvidenceAggregator.js";
import { createCodingRuntimeSnapshotStore } from "./codingRuntimeSnapshotStore.js";
import {
  createProductionCodingRuntimeHost,
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
  return (server.address() as AddressInfo).port;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve) =>
    server.close(() => {
      resolve();
    }),
  );
}

async function startServer(staticRoot: string, handlerDeps: UiHandlerDeps): Promise<number> {
  const probe = createUiServer({ staticRoot, csp: buildCspHeader([]), port: 0, handlerDeps });
  const port = await listen(probe);
  await close(probe);
  const server = createUiServer({ staticRoot, csp: buildCspHeader([]), port, handlerDeps });
  await new Promise<void>((resolve) => server.listen(port, UI_HOST, resolve));
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
    const completions = new Map<string, (outcome: "cancelled" | "failed" | "succeeded") => void>();
    const runtime: QualifiedProductionCodingRuntime = {
      createManager: (onRuntimeEvent) => ({
        start: (request) => {
          order.push(`ready:${request.runId}`);
          return { ok: true, runId: request.runId, status: "ready" };
        },
        issueApproval: () => ({ ok: false, failureCode: "runtime-stopped", retryable: false }),
        stop: (runId) => {
          order.push(`reaped:${runId}`);
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
          return launch(input.runId);
        },
      },
      approvalAuthority: {
        issue: () => ({ ok: false, failureCode: "runtime-stopped", retryable: false }),
      },
      taskDispatcher: {
        dispatch: (runId, taskIntent) => {
          order.push(`dispatch:${runId}:${taskIntent}`);
          const completion = new Promise<"cancelled" | "failed" | "succeeded">((resolve) => {
            completions.set(runId, resolve);
          });
          return Promise.resolve({ ok: true, completion });
        },
        abort: (runId) => {
          order.push(`aborted:${runId}`);
          completions.get(runId)?.("cancelled");
          return Promise.resolve(true);
        },
      },
      recovery: { reconcile: () => Promise.resolve({ status: "unreaped" }) },
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
    await control.startupRecovery;
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
    expect(order.slice(-2)).toEqual([
      `aborted:${startedBody.runId}`,
      `reaped:${startedBody.runId}`,
    ]);
    expect(control.quiescence.isQuiescent()).toBe(true);
    const duplicateStop = await stop(port, startedBody.runId);
    expect(duplicateStop.status).toBe(200);
    await expect(duplicateStop.json()).resolves.toMatchObject({ state: "idle" });
    expect(order.filter((entry) => entry === `reaped:${startedBody.runId}`)).toHaveLength(1);

    const completed = await post(port, {
      requestId: "request-2",
      taskIntent: "private task",
      requestedMode: "governed-assist",
    });
    const completedBody = (await completed.json()) as { runId: string; state: string };
    expect(completedBody.state).toBe("running");
    completions.get(completedBody.runId)?.("succeeded");
    await vi.waitFor(() => {
      expect(control.orchestrator.getSnapshot(completedBody.runId)?.state).toBe("succeeded");
    });
    expect(order.at(-1)).toBe(`reaped:${completedBody.runId}`);
    expect(control.quiescence.isQuiescent()).toBe(true);

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

function launch(runId: string) {
  return {
    taskRef: `task-${runId}`,
    recoveryHandle: "d".repeat(32),
    treeBindingId: `tree-${runId}`,
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
