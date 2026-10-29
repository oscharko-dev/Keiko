import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodingWorkbenchMode } from "@oscharko-dev/keiko-contracts";
import type { QualifiedProductionCodingRuntime } from "../coding-runtime/productionCodingRuntimeHost.js";
import type {
  ProductionRuntimeBackendInput,
  QualifiedProductionRuntimeRun,
} from "../coding-runtime/productionCodingRuntimeResolver.js";

const captured = vi.hoisted(() => ({
  runtime: undefined as QualifiedProductionCodingRuntime | undefined,
}));

// Capture the very instance installed into the deps graph; all resolution and minting stay real.
vi.mock("../coding-runtime/productionCodingRuntimeResolver.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../coding-runtime/productionCodingRuntimeResolver.js")>();
  return {
    ...actual,
    createProductionCodingRuntimeResolver: (
      ...args: Parameters<typeof actual.createProductionCodingRuntimeResolver>
    ): ReturnType<typeof actual.createProductionCodingRuntimeResolver> => {
      const resolver = actual.createProductionCodingRuntimeResolver(...args);
      return {
        resolve: (): QualifiedProductionCodingRuntime | undefined => {
          captured.runtime = resolver.resolve();
          return captured.runtime;
        },
      };
    },
  };
});

import { buildUiHandlerDeps, type UiHandlerDeps } from "../deps.js";
import { editorAgentAuthorityRegistry } from "../editor/agentAuthorityRegistry.js";
import { decideGovernedAtlassianAction } from "./actionPolicy.js";
import * as processLog from "../process-log-sink.js";
import { createBufferedServerLogSink } from "../../../../tests/support/buffered-server-log.js";

const roots: string[] = [];
const graphs: UiHandlerDeps[] = [];
afterEach(async () => {
  for (const deps of graphs.splice(0)) await deps.dispose?.();
  vi.restoreAllMocks();
  captured.runtime = undefined;
  editorAgentAuthorityRegistry.reset();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repository(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-coding-ceiling-")));
  roots.push(root);
  const git = (...args: string[]): void => {
    execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
      cwd: root,
      stdio: "ignore",
      env: {
        PATH: process.env.PATH,
        HOME: "/nonexistent",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
    });
  };
  git("init", "-q", "-b", "main");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--allow-empty",
    "-qm",
    "fixture",
  );
  return root;
}

function backendRun(runId: string): QualifiedProductionRuntimeRun {
  return {
    manager: {
      start: () => ({ ok: true, runId, status: "ready" }),
      issueApproval: () => ({ ok: false, failureCode: "runtime-stopped", retryable: false }),
      pause: () => ({ ok: false, failureCode: "runtime-run-mismatch", retryable: false }),
      resume: () => ({ ok: false, failureCode: "runtime-run-mismatch", retryable: false }),
      stop: () => Promise.resolve({ ok: true, status: "stopped" }),
      takeover: () => Promise.resolve({ ok: true, status: "stopped" }),
      reconcile: () => Promise.resolve({ ok: true, status: "stopped" }),
      health: () => ({ status: "stopped" }),
      pendingApprovalReview: () => undefined,
      result: () => undefined,
    },
    launch: {
      adapterKind: "codex-cli",
      runtimeSource: "codex-cli-adapter",
      modelSource: "chatgpt-codex-subscription-profile",
      executablePath: "/qualified/codex",
      managedRoot: "/qualified",
      gatewayUrl: "http://127.0.0.1:1983",
      modelProfileId: "codex-subscription",
      args: [],
      inheritedEnvAllowlist: [],
      shutdownTimeoutMs: 1000,
      startTimeoutMs: 1000,
    },
    turnPort: {
      submitTurn: () => Promise.resolve(true),
      abortTurn: () => Promise.resolve(true),
      waitForTerminal: () => Promise.resolve("succeeded"),
    },
  };
}

function expectConnectorPolicyResult(result: unknown, mode: CodingWorkbenchMode): void {
  expect(result).toMatchObject(
    mode === "autonomous-delivery"
      ? { status: "failed", reasonCode: "ci-repair-budget-blocked" }
      : { status: "denied", evidence: [] },
  );
}

describe("production Coding run connector ceiling (#4083 AC7)", () => {
  it.each<{ configured: string | undefined; expected: CodingWorkbenchMode }>([
    { configured: undefined, expected: "autonomous-delivery" },
    { configured: "governed-assist", expected: "governed-assist" },
    { configured: "supervised-coding", expected: "supervised-coding" },
    { configured: "invalid", expected: "governed-assist" },
  ])(
    "mints and evaluates actual run authority under ceiling $configured",
    async ({ configured, expected }) => {
      const log = createBufferedServerLogSink();
      const original = processLog.processServerLogSink();
      vi.spyOn(processLog, "processServerLogSink").mockReturnValue({
        ...original,
        write: log.write,
      });
      const root = repository();
      const state = realpathSync(mkdtempSync(join(tmpdir(), "keiko-coding-ceiling-state-")));
      roots.push(state);
      const createRun = vi.fn((input: ProductionRuntimeBackendInput) =>
        backendRun(input.request.runId),
      );
      const deps = buildUiHandlerDeps({
        configPath: undefined,
        evidenceDir: join(state, "evidence"),
        uiDbPath: join(state, "ui.db"),
        env: configured === undefined ? {} : { KEIKO_CODING_DEPLOYMENT_CEILING: configured },
        initialProjectPath: root,
        codingRuntimeStartConfirmationConsumer: {
          consume: () => ({ approvalDigest: "a".repeat(64) }),
        },
        codingRuntimeProductionPorts: {
          backend: { createRun },
          secureWorkspaceTextRead: {
            readText: () => Promise.resolve({ ok: false, reason: "denied" }),
          },
          editorAgentClient: {
            action: () => Promise.reject(new Error("No Editor action is expected")),
          },
        },
      });
      graphs.push(deps);
      const active = deps.workspaceLifecycle?.selectLocal?.({
        root,
        branch: "main",
        requestedBy: "operator",
      });
      const runtime = captured.runtime;
      if (active === undefined || runtime === undefined)
        throw new Error("Expected composed Coding runtime and local workspace");
      const request = {
        runId: "run-4083007",
        requestId: "request-4083007",
        taskIntent: "Inspect bounded connector authority",
        requestedMode: "autonomous-delivery" as const,
        runtimePreference: "codex-subscription" as const,
        workspaceId: active.instance.workspaceId,
        workspaceRoot: active.binding.activeRoot,
        serverPrincipal: "operator",
      };
      await runtime.mintLaunch.prepare?.(request);
      const launch = runtime.mintLaunch.resolve(request);
      const manager = runtime.createManager(() => undefined);
      await expect(
        manager.start({
          ...launch,
          runId: request.runId,
          workspaceRoot: root,
          requestedMode: request.requestedMode,
        }),
      ).resolves.toMatchObject({ ok: true });
      expect(createRun).toHaveBeenCalledOnce();
      const run = createRun.mock.calls[0]?.[0];
      if (run === undefined) throw new Error("Expected admitted Coding backend input");
      expect(run.context.deploymentCeiling).toBe(expected);
      expect(run.minted.effectiveMode).toBe(expected);
      expect(launch.effectiveMode).toBe(expected);
      const authority = { ...run.minted.authorityRef, workspaceRoot: root };
      const retained = editorAgentAuthorityRegistry.resolve(
        authority,
        root,
        expected,
        new Date().toISOString(),
      );
      expect(retained).toMatchObject({
        ok: true,
        envelope: {
          requestedMode: "autonomous-delivery",
          deploymentCeiling: expected,
          effectiveMode: expected,
        },
      });
      const connector = await run.toolFacade.execute({
        capability: run.minted.toolFacadeCapability,
        body: JSON.stringify({
          action: "connector",
          actionId: "ceiling-connector",
          idempotencyKey: "ceiling-connector",
          scope: "source-control.read",
        }),
      });
      expectConnectorPolicyResult(connector, expected);
      const denials = log.events.filter(
        (event) => event.op === "coding-runtime.tool-authority.denied",
      );
      if (expected === "autonomous-delivery") expect(denials).toEqual([]);
      else
        expect(denials).toContainEqual(
          expect.objectContaining({
            correlationId: request.runId,
            errorKind: "authority-denied",
            extra: {
              action: "connector",
              effectiveMode: expected,
              completeness: "complete",
              loss: "none",
            },
          }),
        );
      // The Full access call passes policy, then the unconfigured CI-repair budget refuses it.
      // This fixture neither supplies an execution backend nor bypasses that independent budget.
      // Coding's current source-control grant cannot acquire Jira write authority at any ceiling.
      expect(decideGovernedAtlassianAction("create-issue", authority, deps).kind).toBe(
        "policy-denied",
      );
    },
  );
});
