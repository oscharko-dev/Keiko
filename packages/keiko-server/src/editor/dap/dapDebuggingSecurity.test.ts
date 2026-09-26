// Cross-stack adversarial regression suite for governed debugging (Issue #2348).
//
// The assertions below deliberately exercise the public DAP hardening seams rather than merely
// checking that helpers do not throw. They cover the containment floor in ADR-0136 D1/D3/D7/D8:
// rejected execution inputs have typed failures, bounded state reports an explicit truncation, and
// both wall expiry and activation revocation reach process-scope termination.
import { chmodSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { DebugActivationInput } from "@oscharko-dev/keiko-contracts";
import { DEBUG_ACTIVATION_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts/runtime/debug-activation";
import {
  DEFAULT_DEBUG_PAYLOAD_LIMITS,
  buildDebugVariableTree,
  buildStackPage,
  parseDebugSessionStartRequest,
} from "@oscharko-dev/keiko-contracts/runtime/dap-debug";

import { buildRedactor, createInMemoryUiStore, type UiHandlerDeps } from "../../index.js";
import { createRunRegistry } from "../../runs.js";
import { createUiServer, UI_HOST } from "../../server.js";
import { createWorkspaceMutexRegistry } from "../../task-workspace/mutex.js";
import { createDebugCapabilityGate } from "./debugActivationPolicy.js";
import { DapAdapterPreflightError, preflightDapAdapter } from "./dapNodeAdapter.js";
import type { QualifiedDebugCapsuleHandle } from "./dapCapsuleSupervisor.js";
import { breakpointStoreWorkspaceFingerprint, createBreakpointStore } from "./breakpointStore.js";
import { createDebugBrowserSessionRegistry } from "./dapBrowserSession.js";
import { createDapEventBridge } from "./dapEventBridge.js";
import type { DapProcessManager } from "./dapProcessManager.js";
import { createDebugReferenceStore } from "./dapReferenceStore.js";
import type { DapDebugRouteService } from "./dapDebugRoutes.js";
import { createDebugActivationControlService } from "./debugActivationControl.js";
import type { DebugActivationEvidence } from "./debugActivationEvidence.js";
import {
  DEBUG_MAX_SESSIONS_PER_SERVER,
  DEBUG_WALL_TIMEOUT_MS,
  createDebugSessionRegistry,
  type DebugProvisionalReservationInput,
} from "./debugSessionRegistry.js";
import { assertDebugLaunchEnvironment, parseOpaqueDebugTarget } from "./debugLaunchPlan.js";
import { createNodeDebugAdapterSpec } from "./providers/nodeDebugAdapter.js";

const roots: string[] = [];
const SENTINEL = "DAP-SECRET-0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d";

function temporary(label: string): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), `keiko-dap-security-${label}-`)));
  roots.push(path);
  return path;
}

function executable(path: string): void {
  writeFileSync(path, "#!/bin/sh\nexit 0\n", "utf8");
  chmodSync(path, 0o755);
}

function expectPreflightFailure(operation: () => unknown): void {
  try {
    operation();
    throw new Error("expected DAP adapter preflight to fail");
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(DapAdapterPreflightError);
    expect(error).toMatchObject({ code: "EXECUTABLE_NOT_FOUND" });
  }
}

function reservation(
  sessionId: string,
  partition = "partition_a",
): DebugProvisionalReservationInput {
  return {
    sessionId,
    workspaceId: `workspace-${sessionId}`,
    workspacePartitionKey: partition,
    browserSessionBinding: `browser-${sessionId}`,
    targetKind: "file",
    activationRevision: 7,
    network: "none",
    filesystem: "executionRoot",
  };
}

function promotion(): {
  readonly planId: string;
  readonly planEpoch: number;
  readonly planExpiresAtMs: number;
  readonly provisioningDigest: string;
  readonly backend: "oci";
  readonly runtimeIdentityDigest: string;
} {
  return {
    planId: "plan_a",
    planEpoch: 1,
    planExpiresAtMs: Number.MAX_SAFE_INTEGER,
    provisioningDigest: "a".repeat(64),
    backend: "oci",
    runtimeIdentityDigest: "b".repeat(64),
  };
}

function emptyDapByteSource(): AsyncIterable<Buffer> {
  return {
    [Symbol.asyncIterator]: (): AsyncIterator<Buffer> => ({
      next: (): Promise<IteratorResult<Buffer>> =>
        Promise.resolve({ done: true, value: undefined }),
    }),
  };
}

function liveCapsule(kill: (signal: NodeJS.Signals) => void): QualifiedDebugCapsuleHandle {
  let alive = true;
  return {
    planId: "plan_a",
    source: emptyDapByteSource(),
    sink: { write: () => undefined },
    processGroup: {
      kill: (signal): void => {
        kill(signal);
        alive = false;
      },
    },
    exited: (): boolean => !alive,
    inspectScope: () =>
      Promise.resolve({
        qualified: true,
        backend: "oci" as const,
        runtimeIdentityDigest: "b".repeat(64),
        descendants: alive ? 1 : 0,
      }),
    terminateContainment: (): Promise<void> => {
      alive = false;
      return Promise.resolve();
    },
    cleanup: (): Promise<void> => Promise.resolve(),
  };
}

function inertManager(): DapProcessManager {
  return {
    start: () => Promise.resolve(),
    request: <T>(): Promise<T> => Promise.reject(new Error("unexpected DAP request")),
    stop: () => Promise.resolve(),
    revoke: () => Promise.resolve(),
    failMalformed: () => Promise.resolve(),
    sweepExpired: () => Promise.resolve(),
    reconcile: () => Promise.resolve(),
    shutdown: () => Promise.resolve(),
    health: () => undefined,
    binding: () => undefined,
    boundSessionId: () => undefined,
    workspaceSessionId: () => undefined,
    pauseContext: () => undefined,
  };
}

function routeService(stateDir: string): DapDebugRouteService {
  return {
    manager: inertManager(),
    breakpoints: createBreakpointStore({ stateDir }),
    browserSessions: createDebugBrowserSessionRegistry({ now: () => 0 }),
    references: createDebugReferenceStore(),
    events: createDapEventBridge(),
    activation: () =>
      Promise.resolve({
        ok: true,
        schemaVersion: "1",
        adapterId: "node-typescript",
        revision: 7,
        state: "available",
        reasonCode: "AVAILABLE",
        policyResult: "allowed",
      }),
    renameInstrumentation: vi.fn().mockResolvedValue(undefined),
  };
}

async function listenOnFreePort(deps: Parameters<typeof createUiServer>[0]): Promise<Server> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, UI_HOST, resolve));
  const address = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => {
    probe.close(() => {
      resolve();
    });
  });
  const server = createUiServer({ ...deps, port: address.port });
  await new Promise<void>((resolve) => server.listen(address.port, UI_HOST, resolve));
  return server;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
}

function routeDeps(
  root: string,
  service: DapDebugRouteService,
): { readonly deps: UiHandlerDeps; readonly store: ReturnType<typeof createInMemoryUiStore> } {
  const store = createInMemoryUiStore();
  store.createProject(root, "security fixture");
  const deps = {
    config: undefined,
    configPresent: false,
    store,
    redactor: buildRedactor({}, undefined),
    evidenceStore: { put: () => "", list: () => [], get: () => undefined, delete: () => undefined },
    env: { KEIKO_EDITOR_DEBUG: "1" },
    registry: createRunRegistry(),
    modelPortFactory: () => undefined,
    dapDebug: service,
  } as unknown as UiHandlerDeps;
  return { deps, store };
}

async function attachRunningCapsule(
  now: () => number,
  sessionId = "session_a",
): Promise<{
  readonly registry: ReturnType<typeof createDebugSessionRegistry>;
  readonly kill: ReturnType<typeof vi.fn<(signal: NodeJS.Signals) => void>>;
}> {
  const registry = createDebugSessionRegistry({
    appendEvidence: () => Promise.resolve(),
    now,
    emitOutputLimit: () => undefined,
  });
  const kill = vi.fn<(signal: NodeJS.Signals) => void>();
  await registry.reserve({ ...reservation(sessionId), ...promotion() });
  const attempt = await registry.beginStartupAttempt(sessionId);
  await registry.attachCapsule(sessionId, attempt.attemptId, liveCapsule(kill), {
    backend: "oci",
    runtimeIdentityDigest: "b".repeat(64),
  });
  await registry.markRunning(sessionId, attempt.attemptId);
  return { registry, kill };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("governed DAP cross-stack adversarial containment (#2348)", () => {
  it("rejects a workspace-planted adapter with EXECUTABLE_NOT_FOUND and strips secrets before spawn", () => {
    const workspace = temporary("workspace");
    const trusted = temporary("trusted");
    const adapter = join(trusted, "trusted-dap");
    executable(adapter);
    symlinkSync(adapter, join(workspace, "trusted-dap"));
    const spec = createNodeDebugAdapterSpec(
      "trusted-dap",
      ["--server", "/run/keiko-debug/dap.sock"],
      [trusted],
      "a".repeat(64),
      ["LANG"],
    );

    expectPreflightFailure(() =>
      preflightDapAdapter(spec, {
        workspaceRoot: workspace,
        processEnv: { PATH: workspace, LANG: "C", TOKEN: SENTINEL },
        approvedPath: trusted,
        commandAllowed: () => true,
      }),
    );

    const result = preflightDapAdapter(spec, {
      workspaceRoot: workspace,
      processEnv: { PATH: trusted, LANG: "C", TOKEN: SENTINEL },
      approvedPath: trusted,
      commandAllowed: () => true,
    });
    expect(result.env).toStrictEqual({
      LANG: "C",
      HOME: "/run/keiko-debug/home",
      USERPROFILE: "/run/keiko-debug/home",
      PATH: "/opt/keiko-runtime",
      TMPDIR: "/run/keiko-debug/tmp",
      TEMP: "/run/keiko-debug/tmp",
      TMP: "/run/keiko-debug/tmp",
    });
    expect(JSON.stringify(result.env)).not.toContain(SENTINEL);
    result.home.cleanup();
    result.temp.cleanup();
  });

  it("rejects free-form target, path, and environment injection with INVALID_CAPSULE_PLAN", () => {
    const injectedTarget = { kind: "file", fileId: "src/app.ts", argv: ["; touch /tmp/pwned"] };
    expect(() => parseOpaqueDebugTarget(injectedTarget)).toThrow(
      expect.objectContaining({ code: "INVALID_CAPSULE_PLAN" }),
    );
    for (const fileId of ["../outside.ts", "/absolute.ts", "\\\\host\\share\\app.ts"]) {
      const parsed = parseDebugSessionStartRequest({
        schemaVersion: "1",
        workspaceId: "workspace_a",
        target: { kind: "file", fileId },
        activationRevision: 7,
      });
      expect(parsed).toMatchObject({ ok: false });
    }
    const metacharacterFileName = parseDebugSessionStartRequest({
      schemaVersion: "1",
      workspaceId: "workspace_a",
      target: { kind: "file", fileId: "src/app.ts; curl attacker.invalid" },
      activationRevision: 7,
    });
    // A semicolon is inert data in a file name: the closed plan never accepts a caller-provided argv.
    expect(metacharacterFileName).toMatchObject({
      ok: true,
      value: { target: { kind: "file", fileId: "src/app.ts; curl attacker.invalid" } },
    });
    const catalogInjection = parseDebugSessionStartRequest({
      schemaVersion: "1",
      workspaceId: "workspace_a",
      target: { kind: "catalog", targetId: "run; curl attacker.invalid" },
      activationRevision: 7,
    });
    expect(catalogInjection).toMatchObject({ ok: false });
    expect(() => {
      assertDebugLaunchEnvironment({
        environment: {
          HOME: "/run/keiko-debug/home",
          USERPROFILE: "/run/keiko-debug/home",
          PATH: "/opt/keiko-runtime",
          TMPDIR: "/run/keiko-debug/tmp",
          TEMP: "/run/keiko-debug/tmp",
          TMP: "/run/keiko-debug/tmp",
          TOKEN: SENTINEL,
        },
      } as unknown as Parameters<typeof assertDebugLaunchEnvironment>[0]);
    }).toThrow(expect.objectContaining({ code: "INVALID_CAPSULE_PLAN" }));
  });

  it("enforces the global concurrent-session bound before another session can reserve capacity", async () => {
    const registry = createDebugSessionRegistry({
      appendEvidence: () => Promise.resolve(),
      now: () => 0,
      emitOutputLimit: () => undefined,
    });
    for (let index = 0; index < DEBUG_MAX_SESSIONS_PER_SERVER; index += 1) {
      await registry.reserve({
        ...reservation(`session_${String(index)}`, `partition_${String(index)}`),
        ...promotion(),
        planId: `plan_${String(index)}`,
      });
    }

    await expect(
      registry.reserve({
        ...reservation("session_overflow", "partition_overflow"),
        ...promotion(),
      }),
    ).rejects.toMatchObject({ code: "CAPACITY" });
  });

  it("turns an overdue wall-time session into an awaited process-group termination", async () => {
    let now = 0;
    const current = await attachRunningCapsule(() => now);
    now = DEBUG_WALL_TIMEOUT_MS + 1;

    expect(current.registry.expiredSessions()).toStrictEqual([
      { sessionId: "session_a", reason: "wallTimeout" },
    ]);
    await current.registry.teardown("session_a", "wallTimeout");
    expect(current.kill).toHaveBeenCalledWith("SIGTERM");
    expect(current.kill).toHaveBeenCalledTimes(1);
    expect(current.registry.session("session_a")).toBeUndefined();
  });

  it("rejects cross-origin and non-API attempts to open the debug SSE route", async () => {
    const staticRoot = temporary("static");
    const stateDir = temporary("state");
    const workspaceRoot = temporary("workspace");
    const service = routeService(stateDir);
    const current = routeDeps(workspaceRoot, service);
    const server = await listenOnFreePort({
      staticRoot,
      csp: "default-src 'self'",
      port: 0,
      handlerDeps: current.deps,
    });
    try {
      const port = (server.address() as AddressInfo).port;
      const workspaceId = breakpointStoreWorkspaceFingerprint(workspaceRoot);
      const query = `?workspaceId=${encodeURIComponent(workspaceId)}`;
      const foreign = await fetch(
        `http://${UI_HOST}:${String(port)}/api/editor/debug/events${query}`,
        {
          headers: { Origin: "https://attacker.invalid" },
        },
      );
      const nonApi = await fetch(`http://${UI_HOST}:${String(port)}/editor/debug/events${query}`);

      expect(foreign.status).toBe(403);
      expect(await foreign.json()).toMatchObject({ error: { code: "FORBIDDEN_HOST" } });
      expect(nonApi.status).toBe(404);
      expect(await nonApi.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
    } finally {
      await closeServer(server);
      current.store.close();
    }
  });

  it("projects oversized variable and stack payloads with bounded, explicit truncation", () => {
    const oversizedVariableValue = SENTINEL.repeat(DEFAULT_DEBUG_PAYLOAD_LIMITS.maxValueBytes);
    const oversizedFrameName = SENTINEL.repeat(DEFAULT_DEBUG_PAYLOAD_LIMITS.maxNameBytes);
    const variables = buildDebugVariableTree(
      Array.from(
        { length: DEFAULT_DEBUG_PAYLOAD_LIMITS.maxVariablesPerExpansion + 1 },
        (_, index) => ({
          variableRef: `variable_${String(index)}`,
          name: `name_${String(index)}`,
          value: oversizedVariableValue,
          presentation: "data" as const,
          children: [],
        }),
      ),
    );
    const stack = buildStackPage(
      Array.from({ length: DEFAULT_DEBUG_PAYLOAD_LIMITS.maxRetainedFrames + 1 }, (_, index) => ({
        frameRef: `frame_${String(index)}`,
        name: oversizedFrameName,
        line: index + 1,
        column: 1,
      })),
      0,
    );

    expect(variables.truncated).toBe(true);
    expect(variables.nodes.at(-1)).toMatchObject({ kind: "truncated", truncated: true });
    expect(variables.nodes).toHaveLength(DEFAULT_DEBUG_PAYLOAD_LIMITS.maxVariablesPerExpansion);
    const firstVariable = variables.nodes[0];
    expect(firstVariable?.kind).toBe("variable");
    if (firstVariable?.kind === "variable") {
      expect(firstVariable.value.truncated).toBe(true);
      expect(firstVariable.value.value).toContain("[truncated]");
    }
    expect(JSON.stringify(variables)).not.toContain(oversizedVariableValue);
    expect(stack).toMatchObject({
      truncated: true,
      retainedCount: DEFAULT_DEBUG_PAYLOAD_LIMITS.maxRetainedFrames,
      omittedCount: 1,
    });
    expect(stack.frames).toHaveLength(DEFAULT_DEBUG_PAYLOAD_LIMITS.maxFramesPerPage);
    const firstFrame = stack.frames[0];
    expect(firstFrame?.name.truncated).toBe(true);
    expect(firstFrame?.name.value).toContain("[truncated]");
    expect(JSON.stringify(stack)).not.toContain(oversizedFrameName);
  });

  it("synchronously revokes a live process group when its activation ceiling narrows", async () => {
    const root = temporary("activation-workspace");
    const current = await attachRunningCapsule(() => 0);
    let deployment: "allowed" | "denied" = "allowed";
    const evidence: DebugActivationEvidence[] = [];
    const control = createDebugActivationControlService({
      mutex: createWorkspaceMutexRegistry(),
      productSupport: () => "supported",
      deploymentPolicy: () => deployment,
      provisioning: () => "provisioned",
      disposeActiveSession: () => current.registry.revoke("session_a"),
      projectEvidence: (_fingerprint, entry): void => {
        evidence.push(entry);
      },
    });
    const enabled = { realRoot: root, revision: 7, workspaceActivation: "enabled" as const };
    expect(control.resolve(enabled)).toMatchObject({ state: "available" });
    deployment = "denied";

    await expect(
      control.synchronize({ action: "settingsChange", changed: false, context: enabled }),
    ).resolves.toMatchObject({ state: "disabledByPolicy", reasonCode: "POLICY_DENIED" });
    expect(current.kill).toHaveBeenCalledWith("SIGTERM");
    expect(current.kill).toHaveBeenCalledTimes(1);
    expect(current.registry.session("session_a")).toBeUndefined();
    expect(evidence.at(-1)).toMatchObject({ action: "revoke", effectiveState: "disabledByPolicy" });
    expect(JSON.stringify(evidence)).not.toContain(SENTINEL);
    control.dispose();
  });

  it("keeps the activation contract closed while rejecting unknown policy-shaping fields", () => {
    const gate = createDebugCapabilityGate();
    const wellFormed: DebugActivationInput = {
      schemaVersion: DEBUG_ACTIVATION_SCHEMA_VERSION,
      adapterId: "node-typescript",
      revision: 7,
      productSupport: "supported",
      deploymentPolicy: "allowed",
      provisioning: "provisioned",
      workspaceActivation: "enabled",
    };
    expect(gate.resolve(wellFormed)).toMatchObject({ ok: true, state: "available" });

    const smuggled = { ...wellFormed, forcedPolicyResult: "allowed" };
    expect(gate.resolve(smuggled as unknown as DebugActivationInput)).toMatchObject({
      ok: false,
      state: "disabled",
      reasonCode: "INVALID_INPUT",
      policyResult: "denied",
    });
  });
});
