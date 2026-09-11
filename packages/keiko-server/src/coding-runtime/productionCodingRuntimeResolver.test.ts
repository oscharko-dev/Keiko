/* eslint-disable @typescript-eslint/explicit-function-return-type -- Local resolver fixtures are contextually typed. */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { validateSkillDiscoveryResultV1 } from "@oscharko-dev/keiko-contracts/runtime/coding-skill-discovery";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { validateCodingWorkbenchRuntimeEvent } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-validation";
import type { CodingWorkbenchRuntimeEvent } from "@oscharko-dev/keiko-contracts";
import type { ServerDiagnosticRecord } from "../diagnostics-log.js";
import {
  operatorDecisionRequester,
  runManifestAdmission,
} from "./productionCodingRuntimeResolver.js";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";

import { EditorAgentAuthorityRegistry } from "../editor/agentAuthorityRegistry.js";
import {
  createProductionCodingRuntimeHost,
  type ProductionCodingRuntimeHost,
} from "./productionCodingRuntimeHost.js";
import { RESEARCH_GRANT_DEFAULT_MAX_TTL_MS } from "./researchGrantRegistry.js";
import type { CodingRuntimeEditorMutationLeaseBroker } from "./codingRuntimeEditorMutationLeaseCoordinator.js";
import type {
  CodingRuntimeStartConfirmationClaim,
  CodingRuntimeStartConfirmationConsumer,
} from "./codingRuntimeStartConfirmation.js";
import {
  createProductionCodingRuntimeResolver,
  resolveProductionRuntimeStartConfirmationClaim,
  type ProductionCodingRuntimeResolverInput,
  type ProductionRuntimeBackendInput,
  type ProductionRuntimeBackendResolver,
} from "./productionCodingRuntimeResolver.js";

const ciRepairNotifierCapture = vi.hoisted(() => ({
  current: undefined as ((runId: string) => void) | undefined,
}));

vi.mock("./productionCiRepairRuntime.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./productionCiRepairRuntime.js")>();
  return {
    ...original,
    createProductionCiRepairBudget: (
      ...args: Parameters<typeof original.createProductionCiRepairBudget>
    ): ReturnType<typeof original.createProductionCiRepairBudget> => {
      ciRepairNotifierCapture.current = args[3];
      return original.createProductionCiRepairBudget(...args);
    },
  };
});

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("production coding runtime resolver", () => {
  it("carries the admitted issue through the production context and start confirmation", () => {
    const fixture = workspaceFixture();
    const confirmations = confirmationFixture();
    const createRun = vi.fn((input: ProductionRuntimeBackendInput) =>
      backendRun(input.request.runId),
    );
    const host = createProductionCodingRuntimeHost(
      resolverFor(fixture, createRun, confirmations.consumer),
    );
    if (host === undefined) throw new Error("expected qualified host");
    const issueBinding = {
      schemaVersion: "1" as const,
      repositoryId: "repository-private",
      remoteDigest: "a".repeat(64),
      issueNumber: 42,
      issueIdDigest: "b".repeat(64),
      defaultBaseRef: "dev",
      contentRevisionDigest: "c".repeat(64),
      bindingDigest: "d".repeat(64),
    };
    const request = { ...launchRequest(fixture.workspace), issueBinding };
    const approved = resolveProductionRuntimeStartConfirmationClaim(fixture.authority, request);
    const generic = resolveProductionRuntimeStartConfirmationClaim(
      fixture.authority,
      launchRequest(fixture.workspace),
    );
    expect(approved.bindingDigest).not.toBe(generic.bindingDigest);
    confirmations.issue(approved);
    host.launchResolver.resolve(request);
    expect(createRun.mock.calls[0]?.[0].context.issueBinding).toEqual(issueBinding);
  });

  // #3417: one server-approved skill catalog, composed once. Every run's tools are built from it,
  // and the operator's projection reads that same catalog, with the readiness it can tell itself.
  it("answers the operator's approved skills from the one catalog every run shares", () => {
    const fixture = workspaceFixture();
    const confirmations = confirmationFixture();
    const host = createProductionCodingRuntimeHost(
      resolverFor(
        fixture,
        vi.fn((input: ProductionRuntimeBackendInput) => backendRun(input.request.runId)),
        confirmations.consumer,
      ),
    );
    if (host === undefined) throw new Error("expected qualified host");
    // Before any run exists: a catalog composed per run could answer nothing here.
    const composed = host.approvedSkills?.();

    expect(composed === undefined ? undefined : validateSkillDiscoveryResultV1(composed).ok).toBe(
      true,
    );
    expect(composed?.skills.map((skill) => skill.skillId)).toEqual([
      "skl_repo-structure-summary@1",
    ]);
    expect(composed?.skills[0]?.readiness).toEqual({ state: "ready" });

    const request = launchRequest(fixture.workspace);
    confirmations.issue(resolveProductionRuntimeStartConfirmationClaim(fixture.authority, request));
    host.launchResolver.resolve(request);

    // The run composes its tools from that same catalog, so the operator's digest does not move.
    expect(host.approvedSkills?.().catalogDigest).toBe(composed?.catalogDigest);
  });

  it("starts an approved research grant lifetime at operator approval time", async () => {
    const fixture = workspaceFixture();
    const confirmations = confirmationFixture();
    const createRun = vi.fn((input: ProductionRuntimeBackendInput) => ({
      ...backendRun(input.request.runId),
      manager: {
        ...runtimeManager(input.request.runId),
        issueApproval: () => ({
          ok: true as const,
          approval: {} as never,
          approvalDigest: "b".repeat(64),
          expiresAtMs: fixture.nowMs() + 20_000,
        }),
      },
    }));
    let gatewayConfigured = true;
    const host = createProductionCodingRuntimeHost(
      resolverFor(fixture, createRun, confirmations.consumer, undefined, {
        gatewayEgress: () => (gatewayConfigured ? { noProxy: [] } : undefined),
      }),
    );
    if (host === undefined) throw new Error("expected qualified host");
    const request = launchRequest(fixture.workspace);
    confirmations.issue(resolveProductionRuntimeStartConfirmationClaim(fixture.authority, request));
    const launch = host.launchResolver.resolve(request);
    const manager = host.createManager(vi.fn());
    await manager.start({
      ...launch,
      runId: request.runId,
      workspaceRoot: fixture.workspace,
      requestedMode: request.requestedMode,
    });
    expect(researchUnavailable(host, request.runId)).toBe(false);
    const researchRequestId = host.pendingResearchApprovals?.request({
      runId: request.runId,
      url: new URL("https://example.com/reference"),
      taskId: "task-1",
      workspaceId: "workspace-1",
      nowMs: fixture.nowMs(),
    });
    if (researchRequestId === undefined) throw new Error("expected pending research approval");
    fixture.advanceNow(100_000);
    const approvalNowMs = fixture.nowMs();

    const issued = host.approvalAuthority.issue({
      runId: request.runId,
      requestId: researchRequestId,
      actionKind: "research",
      approvedByUserId: "operator-1",
      ttlMs: 20_000,
    });

    expect(issued.ok).toBe(true);
    expect(host.researchGrants?.activeGrants(request.runId, approvalNowMs)).toEqual([
      expect.objectContaining({ expiresAtMs: approvalNowMs + RESEARCH_GRANT_DEFAULT_MAX_TTL_MS }),
    ]);
    // Availability is evaluated when the gateway builds each offer. A live grant never widens a
    // missing transport binding, and restoring the binding is visible without recreating the run.
    gatewayConfigured = false;
    expect(researchUnavailable(host, request.runId)).toBe(true);
    gatewayConfigured = true;
    expect(researchUnavailable(host, request.runId)).toBe(false);
  });

  it("keeps child-agent unavailable when its per-run provider model cannot be resolved", () => {
    const fixture = workspaceFixture();
    const confirmations = confirmationFixture();
    const createRun = vi.fn((input: ProductionRuntimeBackendInput) =>
      backendRun(input.request.runId),
    );
    const childModelPortFactory = vi.fn(() => undefined);
    const host = createProductionCodingRuntimeHost(
      resolverFor(fixture, createRun, confirmations.consumer, undefined, {
        childModelId: () => "coding-safe-model",
        childModelPortFactory,
      }),
    );
    if (host === undefined) throw new Error("expected qualified host");
    const request = launchRequest(fixture.workspace);
    confirmations.issue(resolveProductionRuntimeStartConfirmationClaim(fixture.authority, request));
    host.launchResolver.resolve(request);

    expect(childUnavailable(host, request.runId)).toBe(true);
    expect(childUnavailable(host, request.runId)).toBe(true);
    expect(childModelPortFactory).toHaveBeenCalledOnce();
    expect(childModelPortFactory).toHaveBeenCalledWith("coding-safe-model");
  });

  // #3399 (epic #3384 correction 4): threaded through the exact same chain
  // `gitDeliveryAuthority` already uses. Before this change the resolver's composed runtime
  // carried no `gitDeliveryDescriptionAuthority` field at all, so it never reached the host.
  it("exposes a live, callable description-authority port from the real production chain", () => {
    const fixture = workspaceFixture();
    const confirmations = confirmationFixture();
    const createRun = vi.fn((input: ProductionRuntimeBackendInput) =>
      backendRun(input.request.runId),
    );
    const host = createProductionCodingRuntimeHost(
      resolverFor(fixture, createRun, confirmations.consumer),
    );
    if (host === undefined) throw new Error("expected qualified host");
    expect(host.gitDeliveryDescriptionAuthority).toBeDefined();
    // Fail-closed default: nothing was minted, so a re-check for any scope finds no record.
    expect(
      host.gitDeliveryDescriptionAuthority?.current(
        {
          remoteDigest: "a".repeat(64),
          pr: { ownerAndRepo: "owner/repo", prNumber: 1 },
          snapshotDigest: "b".repeat(64),
        },
        new Date().toISOString(),
      ),
    ).toBeUndefined();
  });

  // #3401 (epic #3384 closeout, description-composition-closeout): the MINT capability, closing
  // the gap the comment above's own predecessor left open. Before this change the resolver's
  // composed runtime carried no `mintDescriptionAuthority` field at all, so
  // `createProductionWorkbenchDescriptionDispatcher` deterministically denied every scope
  // (`model-egress-denied`) in production regardless of what `gitDeliveryDescriptionAuthority`
  // would have found, because nothing ever minted a record for it to find.
  it("mints a live description authority from the accepted mode through the real production chain", () => {
    const fixture = workspaceFixture();
    const confirmations = confirmationFixture();
    const createRun = vi.fn((input: ProductionRuntimeBackendInput) =>
      backendRun(input.request.runId),
    );
    const host = createProductionCodingRuntimeHost(
      resolverFor(fixture, createRun, confirmations.consumer),
    );
    if (host === undefined) throw new Error("expected qualified host");
    expect(host.mintDescriptionAuthority).toBeDefined();
    const scope = {
      remoteDigest: "a".repeat(64),
      pr: { ownerAndRepo: "owner/repo", prNumber: 1 },
      snapshotDigest: "b".repeat(64),
    };
    const nowIso = new Date(fixture.nowMs()).toISOString();
    host.mintDescriptionAuthority?.({
      scope,
      requestedMode: "governed-assist",
      nowIso,
      correlationId: "description-test",
    });
    expect(host.gitDeliveryDescriptionAuthority?.current(scope, nowIso)).toMatchObject({
      scope,
      // The accepted action mode reaches the owning mint and stays narrower than the fixture's
      // supervised deployment ceiling. The ceiling is never used as a requested-mode default.
      effectiveMode: "governed-assist",
    });

    const unknownModeScope = { ...scope, snapshotDigest: "c".repeat(64) };
    host.mintDescriptionAuthority?.({
      scope: unknownModeScope,
      requestedMode: undefined,
      nowIso,
    } as never);
    expect(host.gitDeliveryDescriptionAuthority?.current(unknownModeScope, nowIso)).toBeUndefined();
  });

  it("routes the resolver's CI-repair settlement callback through the latest attached notifier", () => {
    const fixture = workspaceFixture();
    const confirmations = confirmationFixture();
    const createRun = vi.fn((input: ProductionRuntimeBackendInput) =>
      backendRun(input.request.runId),
    );
    const host = createProductionCodingRuntimeHost(
      resolverFor(fixture, createRun, confirmations.consumer),
    );
    if (host === undefined) throw new Error("expected qualified host");
    const first = vi.fn();
    const latest = vi.fn();
    host.attachVerifiedHeadNotifier?.(first);
    const request = launchRequest(fixture.workspace);
    confirmations.issue(resolveProductionRuntimeStartConfirmationClaim(fixture.authority, request));
    host.launchResolver.resolve(request);
    host.attachVerifiedHeadNotifier?.(latest);

    ciRepairNotifierCapture.current?.("run-1");

    expect(first).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledExactlyOnceWith("run-1");
  });

  it("is unavailable without a trusted confirmation consumer and causes no backend side effects", () => {
    const fixture = workspaceFixture();
    const createRun = vi.fn();
    const resolver = resolverFor(fixture, createRun);

    expect(createProductionCodingRuntimeHost(resolver)).toBeUndefined();
    expect(createRun).not.toHaveBeenCalled();
  });

  it("attaches the run lease to production composition and detaches it on stop", async () => {
    const fixture = workspaceFixture();
    const confirmations = confirmationFixture();
    const detach = vi.fn();
    const attach = vi.fn(() => detach);
    const createRun = vi.fn((input: ProductionRuntimeBackendInput) =>
      backendRun(input.request.runId),
    );
    const host = createProductionCodingRuntimeHost(
      resolverFor(fixture, createRun, confirmations.consumer, { attach }),
    );
    if (host === undefined) throw new Error("expected qualified host");
    const manager = host.createManager(vi.fn());
    const request = launchRequest(fixture.workspace);
    confirmations.issue(resolveProductionRuntimeStartConfirmationClaim(fixture.authority, request));

    const launch = host.launchResolver.resolve(request);
    expect(attach).toHaveBeenCalledOnce();
    await manager.start({
      ...launch,
      runId: request.runId,
      workspaceRoot: fixture.workspace,
      requestedMode: request.requestedMode,
    });
    await manager.stop(request.runId);

    expect(detach).toHaveBeenCalledOnce();
  });

  it("binds a qualified backend to server authority and supports two run-bound turns", async () => {
    const fixture = workspaceFixture();
    const confirmations = confirmationFixture();
    const turns: string[] = [];
    // ADR-0147 D3, autonomous-delivery amendment: the run's manifest admissions end with the run.
    const revokeRunAdmissions = vi.fn((): number => 1);
    const createRun = vi.fn((input: ProductionRuntimeBackendInput) => ({
      manager: runtimeManager(input.request.runId),
      launch: {
        adapterKind: "opencode-compatible" as const,
        runtimeSource: "keiko-sidecar" as const,
        modelSource: "keiko-model-gateway" as const,
        executablePath: "/qualified/opencode",
        managedRoot: "/qualified",
        gatewayUrl: "http://127.0.0.1:1983/api/coding-sidecar/gateway",
        modelProfileId: "coding-safe-openai-compatible",
        args: [],
        inheritedEnvAllowlist: [],
        shutdownTimeoutMs: 1_000,
        startTimeoutMs: 1_000,
      },
      turnPort: {
        submitTurn: (_runId: string, text: string) => {
          turns.push(text);
          return Promise.resolve(true);
        },
        abortTurn: () => Promise.resolve(true),
        waitForTerminal: () => Promise.resolve("succeeded" as const),
      },
    }));
    const resolver = resolverFor(fixture, createRun, confirmations.consumer, undefined, {
      workspaceScriptTrust: { admitRunManifest: vi.fn(), revokeRunAdmissions },
    });
    const host = createProductionCodingRuntimeHost(resolver);
    if (host === undefined) throw new Error("expected qualified host");
    const manager = host.createManager(vi.fn());
    const request = {
      runId: "run-1",
      requestId: "request-1",
      taskIntent: "initial private task",
      requestedMode: "supervised-coding",
      runtimePreference: "managed-gateway",
      workspaceId: "workspace-private",
      workspaceRoot: fixture.workspace,
      serverPrincipal: "operator-private",
    } as const;
    confirmations.issue(resolveProductionRuntimeStartConfirmationClaim(fixture.authority, request));
    const launch = host.launchResolver.resolve(request);
    await expect(
      manager.start({
        ...launch,
        runId: "run-1",
        workspaceRoot: fixture.workspace,
        requestedMode: "supervised-coding",
      }),
    ).resolves.toMatchObject({ ok: true, runId: "run-1" });

    const first = await host.taskDispatcher.dispatch({
      runId: "run-1",
      requestId: "turn-1",
      expectedRevision: 1,
      taskIntent: "initial private task",
    });
    if (first.ok) await first.completion;
    const followUp = await host.taskDispatcher.dispatch({
      runId: "run-1",
      requestId: "turn-2",
      expectedRevision: 2,
      taskIntent: "follow-up private task",
    });
    if (followUp.ok) await followUp.completion;

    expect(turns).toEqual(["initial private task", "follow-up private task"]);
    expect(createRun).toHaveBeenCalledOnce();
    const backendInput = createRun.mock.calls[0]?.[0];
    expect(backendInput?.resolveWorkspaceRootAccess()).toMatchObject({
      kind: "managed-task",
      canonicalRoot: fixture.workspace,
    });
    fixture.revokeWorkspaceAccess();
    expect(backendInput?.resolveWorkspaceRootAccess()).toBeUndefined();
    expect(JSON.stringify(createRun.mock.calls[0]?.[0].minted)).not.toContain("private task");
    expect(createRun.mock.calls[0]?.[0].authorityLifecycle.revokeRuntime("run-1")).toBe(true);
    // Revoking the run drops its manifest admissions with it (ADR-0147 D3, autonomous-delivery).
    expect(revokeRunAdmissions).toHaveBeenCalledExactlyOnceWith("run-1");
    await expect(
      host.taskDispatcher.dispatch({
        runId: "run-1",
        requestId: "turn-revoked",
        expectedRevision: 3,
        taskIntent: "must not run",
      }),
    ).resolves.toEqual({ ok: false });
    expect(turns).toHaveLength(2);
  });

  it("revalidates workspace HEAD immediately before a retained adapter turn", async () => {
    const fixture = workspaceFixture();
    const confirmations = confirmationFixture();
    const submitTurn = vi.fn(() => Promise.resolve(true));
    const createRun = vi.fn((input: ProductionRuntimeBackendInput) => ({
      ...backendRun(input.request.runId),
      turnPort: {
        submitTurn,
        abortTurn: () => Promise.resolve(true),
        waitForTerminal: () => Promise.resolve("succeeded" as const),
      },
    }));
    const host = createProductionCodingRuntimeHost(
      resolverFor(fixture, createRun, confirmations.consumer),
    );
    if (host === undefined) throw new Error("expected qualified host");
    const manager = host.createManager(vi.fn());
    const request = launchRequest(fixture.workspace);
    confirmations.issue(resolveProductionRuntimeStartConfirmationClaim(fixture.authority, request));
    const launch = host.launchResolver.resolve(request);
    await manager.start({
      ...launch,
      runId: request.runId,
      workspaceRoot: fixture.workspace,
      requestedMode: request.requestedMode,
    });
    fixture.setHead("2".repeat(40));

    await expect(
      host.taskDispatcher.dispatch({
        runId: "run-1",
        requestId: "turn-drifted",
        expectedRevision: 1,
        taskIntent: "must not run",
      }),
    ).resolves.toEqual({ ok: false });
    expect(submitTurn).not.toHaveBeenCalled();
  });

  it.each([
    ["operator", { serverPrincipal: "operator-altered" }],
    ["intent", { taskIntent: "altered private task" }],
    ["mode", { requestedMode: "governed-assist" as const }],
    ["source", { runtimePreference: "codex-subscription" as const }],
  ])("denies an altered %s after confirmation", (_name, override) => {
    const fixture = workspaceFixture();
    const confirmations = confirmationFixture();
    const createRun = vi.fn();
    const host = createProductionCodingRuntimeHost(
      resolverFor(fixture, createRun, confirmations.consumer),
    );
    if (host === undefined) throw new Error("expected qualified host");
    const request = launchRequest(fixture.workspace);
    confirmations.issue(resolveProductionRuntimeStartConfirmationClaim(fixture.authority, request));

    expect(() => host.launchResolver.resolve({ ...request, ...override })).toThrow();
    expect(createRun).not.toHaveBeenCalled();
  });

  it("consumes a confirmation once and rejects replay and expiry", () => {
    const fixture = workspaceFixture();
    const confirmations = confirmationFixture();
    const createRun = vi.fn((input: ProductionRuntimeBackendInput) =>
      backendRun(input.request.runId),
    );
    const host = createProductionCodingRuntimeHost(
      resolverFor(fixture, createRun, confirmations.consumer),
    );
    if (host === undefined) throw new Error("expected qualified host");
    const request = launchRequest(fixture.workspace);
    const claim = resolveProductionRuntimeStartConfirmationClaim(fixture.authority, request);
    confirmations.issue(claim);
    host.launchResolver.resolve(request);
    expect(() => host.launchResolver.resolve({ ...request, runId: "run-replay" })).toThrow();

    const expiredFixture = workspaceFixture();
    const expired = confirmationFixture();
    const expiredCreateRun = vi.fn();
    const expiredHost = createProductionCodingRuntimeHost(
      resolverFor(expiredFixture, expiredCreateRun, expired.consumer),
    );
    if (expiredHost === undefined) throw new Error("expected qualified host");
    expired.issue(
      resolveProductionRuntimeStartConfirmationClaim(
        expiredFixture.authority,
        requestFor(expiredFixture.workspace),
      ),
      -1,
    );
    expect(() =>
      expiredHost.launchResolver.resolve(requestFor(expiredFixture.workspace)),
    ).toThrow();
    expect(expiredCreateRun).not.toHaveBeenCalled();
  });

  // KfQ 3954841973: a backend process (plus its HTTP/SSE client and tool bridge) was already
  // spawned by `createRun` below by the time the lease broker rejects attachment -- verifies the
  // already-built backend is disposed instead of leaked when that happens.
  it("disposes an already-spawned backend when lease attachment fails after creation", () => {
    const fixture = workspaceFixture();
    const confirmations = confirmationFixture();
    const dispose = vi.fn(() => Promise.resolve());
    const createRun = vi.fn((input: ProductionRuntimeBackendInput) => ({
      ...backendRun(input.request.runId),
      dispose,
    }));
    const runtimeMutationLeaseBroker = { attach: () => undefined };
    const host = createProductionCodingRuntimeHost(
      resolverFor(fixture, createRun, confirmations.consumer, runtimeMutationLeaseBroker),
    );
    if (host === undefined) throw new Error("expected qualified host");
    const request = launchRequest(fixture.workspace);
    confirmations.issue(resolveProductionRuntimeStartConfirmationClaim(fixture.authority, request));

    expect(() => host.launchResolver.resolve(request)).toThrow(
      "runtime-mutation-lease-broker-unavailable",
    );
    expect(createRun).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("disposes an already-spawned backend when launch validation rejects its shape", () => {
    const fixture = workspaceFixture();
    const confirmations = confirmationFixture();
    const dispose = vi.fn(() => Promise.resolve());
    const createRun = vi.fn((input: ProductionRuntimeBackendInput) => ({
      ...backendRun(input.request.runId),
      launch: { ...backendRun(input.request.runId).launch, executablePath: "" },
      dispose,
    }));
    const host = createProductionCodingRuntimeHost(
      resolverFor(fixture, createRun, confirmations.consumer),
    );
    if (host === undefined) throw new Error("expected qualified host");
    const request = launchRequest(fixture.workspace);
    confirmations.issue(resolveProductionRuntimeStartConfirmationClaim(fixture.authority, request));

    expect(() => host.launchResolver.resolve(request)).toThrow();
    expect(createRun).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
  });
});

function researchUnavailable(
  host: ProductionCodingRuntimeHost,
  runId: string,
): boolean | undefined {
  return host.runtimeCapabilityAuthenticator
    ?.unavailableOptionalTools?.(runId)
    ?.has("keiko_research_fetch");
}

function childUnavailable(host: ProductionCodingRuntimeHost, runId: string): boolean | undefined {
  return host.runtimeCapabilityAuthenticator
    ?.unavailableOptionalTools?.(runId)
    ?.has("keiko_child_agent");
}

function resolverFor(
  fixture: ReturnType<typeof workspaceFixture>,
  createRun: ProductionRuntimeBackendResolver["createRun"],
  confirmationConsumer?: CodingRuntimeStartConfirmationConsumer,
  runtimeMutationLeaseBroker?: Pick<CodingRuntimeEditorMutationLeaseBroker, "attach">,
  overrides: Partial<ProductionCodingRuntimeResolverInput> = {},
) {
  return createProductionCodingRuntimeResolver({
    workspaceAuthority: fixture.authority,
    authorityRegistry: new EditorAgentAuthorityRegistry(),
    backend: { createRun },
    secureWorkspaceTextRead: { readText: () => Promise.resolve({ ok: false, reason: "denied" }) },
    editorAgentClient: {
      action: () =>
        Promise.resolve({
          ok: false as const,
          error: { kind: "route" as const, code: "denied", message: "denied" },
        }),
    },
    verificationRunner: { runToReport: vi.fn() },
    resolveWorkspaceRootAccess: (requestedRoot) =>
      fixture.workspaceAccessAvailable()
        ? {
            kind: "managed-task",
            canonicalRoot: requestedRoot,
            fs: nodeWorkspaceFs,
            repositoryRoot: requestedRoot,
          }
        : undefined,
    ...(confirmationConsumer ? { confirmationConsumer } : {}),
    ...(runtimeMutationLeaseBroker ? { runtimeMutationLeaseBroker } : {}),
    ...overrides,
  });
}

function confirmationFixture() {
  let record:
    | {
        readonly requestId: string;
        readonly bindingDigest: string;
        readonly expiresAtMs: number;
      }
    | undefined;
  const consumer: CodingRuntimeStartConfirmationConsumer = {
    consume: (claim) => {
      if (record?.requestId !== claim.requestId) return undefined;
      if (claim.bindingDigest !== record.bindingDigest || claim.nowMs >= record.expiresAtMs) {
        return undefined;
      }
      record = undefined;
      return { approvalDigest: "a".repeat(64) };
    },
  };
  return {
    consumer,
    issue: (claim: CodingRuntimeStartConfirmationClaim, ttlMs = 60_000): void => {
      record = { ...claim, expiresAtMs: claim.nowMs + ttlMs };
    },
  };
}

function launchRequest(workspace: string) {
  return {
    runId: "run-1",
    requestId: "request-1",
    taskIntent: "initial private task",
    requestedMode: "supervised-coding" as const,
    runtimePreference: "managed-gateway" as const,
    workspaceId: "workspace-private",
    workspaceRoot: workspace,
    serverPrincipal: "operator-private",
  };
}

function requestFor(workspace: string) {
  return launchRequest(workspace);
}

function backendRun(runId: string) {
  return {
    manager: runtimeManager(runId),
    launch: {
      adapterKind: "opencode-compatible" as const,
      runtimeSource: "keiko-sidecar" as const,
      modelSource: "keiko-model-gateway" as const,
      executablePath: "/qualified/opencode",
      managedRoot: "/qualified",
      gatewayUrl: "http://127.0.0.1:1983/api/coding-sidecar/gateway",
      modelProfileId: "coding-safe-openai-compatible",
      args: [],
      inheritedEnvAllowlist: [],
      shutdownTimeoutMs: 1_000,
      startTimeoutMs: 1_000,
    },
    turnPort: {
      submitTurn: () => Promise.resolve(true),
      abortTurn: () => Promise.resolve(true),
      waitForTerminal: () => Promise.resolve("succeeded" as const),
    },
  };
}

function runtimeManager(runId: string) {
  return {
    start: () => ({ ok: true as const, runId, status: "ready" as const }),
    issueApproval: () => ({
      ok: false as const,
      failureCode: "runtime-stopped" as const,
      retryable: false as const,
    }),
    pause: () => ({
      ok: false as const,
      failureCode: "runtime-run-mismatch" as const,
      retryable: false as const,
    }),
    resume: () => ({
      ok: false as const,
      failureCode: "runtime-run-mismatch" as const,
      retryable: false as const,
    }),
    stop: () => Promise.resolve({ ok: true as const, status: "stopped" as const }),
    takeover: () => Promise.resolve({ ok: true as const, status: "stopped" as const }),
    reconcile: () => Promise.resolve({ ok: true as const, status: "stopped" as const }),
    health: () => ({ status: "stopped" as const }),
    pendingApprovalReview: () => undefined,
    result: () => undefined,
  };
}

function workspaceFixture() {
  const managed = realpathSync(mkdtempSync(join(tmpdir(), "keiko-runtime-resolver-")));
  roots.push(managed);
  const workspace = join(managed, "repo", "workspace");
  mkdirSync(workspace, { recursive: true });
  let head = "1".repeat(40);
  let workspaceAccessAvailable = true;
  let nowMs = Date.parse("2026-07-13T12:00:00.000Z");
  const instance = {
    workspaceId: "workspace-private",
    repositoryId: "repository-private",
    repositoryRoot: workspace,
    managedWorktreePath: workspace,
    taskId: "task-private",
    taskBranch: "issue/2376-runtime",
    baseBranch: "dev",
    lastVerifiedHead: head,
    lifecycleState: "active",
    health: "healthy",
    driftMarkers: [],
  };
  return {
    workspace,
    authority: {
      workspaceLifecycle: {
        getActive: () => ({ instance, binding: { activeRoot: workspace } }),
      } as never,
      managedTaskWorkspaceRoot: managed,
      deploymentCeiling: "supervised-coding" as const,
      readWorkspaceHead: () => head,
      now: () => new Date(nowMs),
    },
    nowMs: (): number => nowMs,
    advanceNow: (elapsedMs: number): void => {
      nowMs += elapsedMs;
    },
    setHead: (value: string): void => {
      head = value;
    },
    workspaceAccessAvailable: (): boolean => workspaceAccessAvailable,
    revokeWorkspaceAccess: (): void => {
      workspaceAccessAvailable = false;
    },
  };
}

// Run 11 (2026-09-10): the requester built `event-operator-decision-1`, the contract rejected the id
// as evidence text, and the first version validated and discarded in one expression — the tool waited
// its full window while the run never learned it was waiting. These pins drive the REAL requester
// through the real validator; the tool fixture that only stubbed `requestOperatorDecision` proved the
// wait and never this seam.
describe("operatorDecisionRequester", () => {
  const now = (): Date => new Date("2026-09-10T17:17:05.000Z");
  const runId = "run-162123733010859537403366256760456230003";

  // ADR-0147 D3, autonomous-delivery amendment: the admission the tool facade calls after a completed
  // effect is bound to THIS run's worktree, run id and authority expiry, and is absent when the
  // composition has no trust service — every mode then keeps asking exactly as before.
  it("binds the run-manifest admission to the run's worktree, id and authority expiry", () => {
    const admitRunManifest = vi.fn();
    const composed = runManifestAdmission(
      { workspaceScriptTrust: { admitRunManifest, revokeRunAdmissions: vi.fn() } },
      { workspaceRoot: "/managed/worktree", expiresAt: "2026-09-10T20:00:00.000Z" },
      { authorityRef: { runId: "run-7", envelopeDigest: "d".repeat(64) } },
    );
    composed.admitRunManifest?.();
    expect(admitRunManifest).toHaveBeenCalledExactlyOnceWith(
      "/managed/worktree",
      "run-7",
      "2026-09-10T20:00:00.000Z",
    );
    expect(
      runManifestAdmission(
        {},
        { workspaceRoot: "/managed/worktree", expiresAt: "2026-09-10T20:00:00.000Z" },
        { authorityRef: { runId: "run-7", envelopeDigest: "d".repeat(64) } },
      ),
    ).toEqual({});
  });

  it("emits contract-valid open and settled events for the run", () => {
    const emitted: CodingWorkbenchRuntimeEvent[] = [];
    const request = operatorDecisionRequester(now, undefined, runId, (event) => {
      emitted.push(event);
    });
    request("workspace-script-trust");
    request("workspace-script-trust", "limit-reached");

    expect(emitted.map((event) => validateCodingWorkbenchRuntimeEvent(event).ok)).toEqual([
      true,
      true,
    ]);
    expect(emitted[0]).toMatchObject({
      kind: "operator-decision",
      runId,
      operatorDecision: "workspace-script-trust",
    });
    expect(emitted[0]?.auxiliaryOutcome).toBeUndefined();
    expect(emitted[1]).toMatchObject({ auxiliaryOutcome: "limit-reached" });
  });

  // The run id is the one caller-supplied field the contract can refuse; every shape it refuses
  // must reach the log as the diagnostic and never as a dropped event, and every shape it accepts
  // must reach the run. Table-driven over the boundaries of the evidence-label rule (a label is at
  // most 96 characters of `[A-Za-z0-9.:/_-]`): empty, spaces, a control character, the longest
  // accepted run id, and the first one beyond it (CodeRabbit review, 2026-09-10).
  it.each([
    ["an empty run id", "", false],
    ["a run id with spaces (run 11's shape)", "run id with spaces", false],
    ["a run id carrying a control character", `run-1${String.fromCharCode(7)}`, false],
    ["the longest accepted run id", `run-${"9".repeat(92)}`, true],
    ["the first run id beyond the label bound", `run-${"9".repeat(93)}`, false],
  ])("routes %s through the real validator", (_label, runId, accepted) => {
    const emitted: CodingWorkbenchRuntimeEvent[] = [];
    const records: ServerDiagnosticRecord[] = [];
    const request = operatorDecisionRequester(
      now,
      { record: (record): void => void records.push(record) },
      runId,
      (event) => {
        emitted.push(event);
      },
    );
    request("workspace-script-trust");

    if (accepted) {
      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toMatchObject({ runId, kind: "operator-decision" });
      expect(records).toEqual([]);
      return;
    }
    expect(emitted).toEqual([]);
    expect(records).toEqual([
      expect.objectContaining({
        operation: "coding-runtime.operator-decision",
        errorClass: "OperatorDecisionEventRejected",
        message: "coding-runtime-operator-decision-event-rejected",
      }),
    ]);
  });
});
