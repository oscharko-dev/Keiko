import type { ProductionManagedWorktreeToolInput } from "./productionManagedWorktreeTools.js";
/* eslint-disable @typescript-eslint/explicit-function-return-type -- Local resolver fixtures are contextually typed. */
import * as processLog from "../process-log-sink.js";
import { createBufferedServerLogSink } from "../../../../tests/support/buffered-server-log.js";
import { formatActivityLogProofLine } from "../../../../tests/support/activity-log-proof.js";
import {
  openCodeGatewayCatalogProjection,
  type OpenCodeToolProfile,
} from "./opencodeToolSchemas.js";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { validateSkillDiscoveryResultV1 } from "@oscharko-dev/keiko-contracts/runtime/coding-skill-discovery";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { validateCodingWorkbenchRuntimeEvent } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-validation";
import type { CodingWorkbenchRuntimeEvent } from "@oscharko-dev/keiko-contracts";
import type { ServerDiagnosticRecord } from "../diagnostics-log.js";
import {
  createProductionAcceptedInitializationAuthority,
  operatorDecisionRequester,
  runManifestAdmission,
} from "./productionCodingRuntimeResolver.js";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";

import { EditorAgentAuthorityRegistry } from "../editor/agentAuthorityRegistry.js";
import { createMaterializedPatchRegistry } from "./materializedPatchRegistry.js";
import {
  createProductionCodingRuntimeHost,
  type ProductionCodingRuntimeHost,
} from "./productionCodingRuntimeHost.js";
import { RESEARCH_GRANT_DEFAULT_MAX_TTL_MS } from "./researchGrantRegistry.js";
import type { CodingRuntimeEditorMutationLeaseBroker } from "./codingRuntimeEditorMutationLeaseCoordinator.js";
import type { CiRepairExecutionBudget } from "./codingRuntimeCiRepairController.js";
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

// #3873: a fixture without delivery storage composes the unavailable CI-repair budget, which refuses
// every prompt charge. The one test that drives a run's model calls through the composed prompt
// ledger replaces it with a budget that admits them; every other test composes the original.
const ciRepairBudgetOverride = vi.hoisted(() => ({
  current: undefined as CiRepairExecutionBudget | undefined,
}));

vi.mock("./productionCiRepairRuntime.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./productionCiRepairRuntime.js")>();
  return {
    ...original,
    createProductionCiRepairBudget: (
      ...args: Parameters<typeof original.createProductionCiRepairBudget>
    ): ReturnType<typeof original.createProductionCiRepairBudget> => {
      ciRepairNotifierCapture.current = args[3];
      return ciRepairBudgetOverride.current ?? original.createProductionCiRepairBudget(...args);
    },
  };
});

// F5 (#3873): the edit outcome observer the resolver hands each run's managed tool facade, captured
// at the one production composition site so a test can play the facade's part.
const editOutcomeCapture = vi.hoisted(() => ({
  observers: [] as ((outcome: { readonly kind: "refused"; readonly reasonCode: string }) => void)[],
  revisions: [] as (() => number | undefined)[],
  blocked: [] as NonNullable<ProductionManagedWorktreeToolInput["verificationBlocked"]>[],
  admitted: [] as NonNullable<ProductionManagedWorktreeToolInput["verificationAdmitted"]>[],
}));

// PR #3876 review: the registry of rendered diffs the resolver hands each run's managed tool facade,
// captured at the same composition site.
const materializedPatchesCapture = vi.hoisted(() => ({ registries: [] as unknown[] }));

vi.mock("./productionManagedWorktreeTools.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./productionManagedWorktreeTools.js")>();
  return {
    ...original,
    createProductionManagedWorktreeToolFacade: (
      ...args: Parameters<typeof original.createProductionManagedWorktreeToolFacade>
    ): ReturnType<typeof original.createProductionManagedWorktreeToolFacade> => {
      const observe = args[0].observeEditOutcome;
      if (observe !== undefined) editOutcomeCapture.observers.push(observe);
      if (args[0].verificationRevision !== undefined)
        editOutcomeCapture.revisions.push(args[0].verificationRevision);
      if (args[0].verificationBlocked !== undefined)
        editOutcomeCapture.blocked.push(args[0].verificationBlocked);
      if (args[0].verificationAdmitted !== undefined)
        editOutcomeCapture.admitted.push(args[0].verificationAdmitted);
      materializedPatchesCapture.registries.push(args[0].materializedPatches);
      return original.createProductionManagedWorktreeToolFacade(...args);
    },
  };
});

const roots: string[] = [];

afterEach(() => {
  ciRepairBudgetOverride.current = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("production coding runtime resolver", () => {
  it.each(["direct", "code-mode"] as const)(
    "binds actual facade lifecycle to the captured %s projection",
    async (selected) => {
      const log = createBufferedServerLogSink();
      const originalSink = processLog.processServerLogSink();
      vi.spyOn(processLog, "processServerLogSink").mockReturnValue({
        ...originalSink,
        write: log.write,
      });
      const fixture = workspaceFixture();
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(fixture.nowMs());
      const confirmations = confirmationFixture();
      const createRun = vi.fn((input: ProductionRuntimeBackendInput) =>
        backendRun(input.request.runId),
      );
      let profile: OpenCodeToolProfile = selected;
      const readProfile = vi.fn(() => profile);
      const backend = {
        createRun,
        get toolProfile(): OpenCodeToolProfile {
          return readProfile();
        },
      };
      const host = createProductionCodingRuntimeHost(
        resolverFor(fixture, createRun, confirmations.consumer, undefined, { backend }),
      );
      if (host === undefined) throw new Error("expected qualified composition");
      profile = selected === "direct" ? "code-mode" : "direct";
      const request = launchRequest(fixture.workspace);
      confirmations.issue(
        resolveProductionRuntimeStartConfirmationClaim(fixture.authority, request),
      );
      host.launchResolver.resolve(request);
      const composed = createRun.mock.calls[0]?.[0];
      if (composed === undefined) throw new Error("expected minted composition");
      await expect(
        composed.toolFacade.execute({
          capability: composed.minted.toolFacadeCapability,
          body: JSON.stringify({
            action: "discover",
            actionId: "profile-read",
            idempotencyKey: "profile-read",
            query: "source",
            maxResults: 1,
          }),
        }),
      ).resolves.toMatchObject({ status: "denied" });
      const expected = openCodeGatewayCatalogProjection(selected).projection;
      const bindings = log.events.filter((event) => event.op.startsWith("tool-catalog.bind-"));
      expect(bindings.length).toBeGreaterThan(0);
      for (const event of bindings) {
        const line: unknown = JSON.parse(formatActivityLogProofLine(event));
        expect(line).toMatchObject({
          profileId: expected.profile.id,
          profileVersion: expected.profile.version,
          projectionDigest: expected.projectionDigest,
        });
      }
      expect(readProfile).toHaveBeenCalledOnce();
      await expect(
        composed.toolFacade.execute({
          capability: composed.minted.toolFacadeCapability,
          body: JSON.stringify({
            action: "discover",
            actionId: "profile-input",
            idempotencyKey: "profile-input",
            query: "source",
            maxResults: 1,
            toolProfile: profile,
          }),
        }),
      ).resolves.toMatchObject({ status: "invalid" });
      expect(JSON.stringify(bindings)).not.toContain("source");
      expect(JSON.stringify(bindings)).not.toContain(composed.minted.toolFacadeCapability);
    },
  );

  it("shares provider context usage between the backend and public host projection", () => {
    const fixture = workspaceFixture();
    const confirmations = confirmationFixture();
    const createRun = vi.fn((input: ProductionRuntimeBackendInput) => {
      input.contextUsage?.recordProviderSample(input.request.runId, {
        sampleId: "sample-1",
        capacityTokens: 128_000,
        reservedOutputTokens: 8_000,
        inputTokens: 42_000,
        updatedAt: "2026-09-15T06:30:00.000Z",
      });
      return backendRun(input.request.runId);
    });
    const host = createProductionCodingRuntimeHost(
      resolverFor(fixture, createRun, confirmations.consumer),
    );
    if (host === undefined) throw new Error("expected qualified host");
    const request = launchRequest(fixture.workspace);
    confirmations.issue(resolveProductionRuntimeStartConfirmationClaim(fixture.authority, request));

    host.launchResolver.resolve(request);

    expect(host.contextUsage?.read(request.runId)).toMatchObject({
      state: "available",
      usedInputTokens: 42_000,
      cumulativePromptTokens: 42_000,
    });
  });

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

  // ADR-0137 D1: the control plane's repository-instructions loader reads AGENTS.md through the
  // one secure read port the resolver was composed with — the port every run's governed
  // `keiko_workspace_read` answers through — never a second filesystem path.
  it("exposes the composed secure workspace read port to the control plane unchanged", () => {
    const fixture = workspaceFixture();
    const confirmations = confirmationFixture();
    const secureWorkspaceTextRead = {
      readText: () => Promise.resolve({ ok: false as const, reason: "denied" as const }),
    };
    const host = createProductionCodingRuntimeHost(
      resolverFor(
        fixture,
        vi.fn((input: ProductionRuntimeBackendInput) => backendRun(input.request.runId)),
        confirmations.consumer,
        undefined,
        { secureWorkspaceTextRead },
      ),
    );

    expect(host?.secureWorkspaceTextRead).toBe(secureWorkspaceTextRead);
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

  // F5 (#3873, live Gemma qualification): every edit a run's facade answered stayed inside that
  // facade, so eleven NO_ACTIVE_SESSION refusals reached nothing that could stop the run. The
  // facade the resolver composes per run reports each outcome, with the run's own id, through the
  // slot the control plane fills with the orchestrator's refusal bound.
  it("routes a run's edit outcomes through the latest attached observer with the run's id", () => {
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
    const readRevision = vi.fn(() => 5);
    const blocked = vi.fn();
    const completed = vi.fn();
    const admitted = vi.fn(() => completed);
    const latest = Object.assign(vi.fn(), {
      verificationRevision: readRevision,
      verificationBlocked: blocked,
      verificationAdmitted: admitted,
    });
    host.attachEditOutcomeObserver?.(first);
    editOutcomeCapture.observers.length = 0;
    editOutcomeCapture.revisions.length = 0;
    editOutcomeCapture.blocked.length = 0;
    editOutcomeCapture.admitted.length = 0;
    const request = launchRequest(fixture.workspace);
    confirmations.issue(resolveProductionRuntimeStartConfirmationClaim(fixture.authority, request));
    host.launchResolver.resolve(request);
    host.attachEditOutcomeObserver?.(latest);

    const outcome = { kind: "refused", reasonCode: "NO_ACTIVE_SESSION" } as const;
    expect(editOutcomeCapture.observers).toHaveLength(1);
    editOutcomeCapture.observers[0]?.(outcome);

    expect(first).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledExactlyOnceWith(request.runId, outcome);
    expect(editOutcomeCapture.revisions[0]?.()).toBe(5);
    expect(readRevision).toHaveBeenCalledExactlyOnceWith(request.runId);
    editOutcomeCapture.blocked[0]?.("NO_RUNNABLE_STEPS", "a".repeat(64));
    expect(blocked).toHaveBeenCalledExactlyOnceWith(
      request.runId,
      "NO_RUNNABLE_STEPS",
      "a".repeat(64),
    );
    expect(editOutcomeCapture.admitted[0]?.()).toBe(completed);
    expect(admitted).toHaveBeenCalledExactlyOnceWith(request.runId);
  });

  // PR #3876 review: a run's edit port registers the diff it renders in the one registry the editor
  // route reads. A facade composed without the composition's registry would register nothing, and
  // every edit beside a backslash-n would meet the engine's heuristic again, with no test red.
  it.each([
    ["hands the composition's registry to each run's tool facade", true],
    ["composes the facade without a registry when the composition has none", false],
  ] as const)("%s", (_name, supplied) => {
    const fixture = workspaceFixture();
    const confirmations = confirmationFixture();
    const createRun = vi.fn((input: ProductionRuntimeBackendInput) =>
      backendRun(input.request.runId),
    );
    const registry = createMaterializedPatchRegistry();
    const host = createProductionCodingRuntimeHost(
      resolverFor(
        fixture,
        createRun,
        confirmations.consumer,
        undefined,
        supplied ? { materializedPatches: registry } : {},
      ),
    );
    if (host === undefined) throw new Error("expected qualified host");
    materializedPatchesCapture.registries.length = 0;
    const request = launchRequest(fixture.workspace);
    confirmations.issue(resolveProductionRuntimeStartConfirmationClaim(fixture.authority, request));

    host.launchResolver.resolve(request);

    expect(materializedPatchesCapture.registries).toHaveLength(1);
    expect(materializedPatchesCapture.registries[0]).toBe(supplied ? registry : undefined);
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
      correlationId: "request-runtime-start-0001",
    } as const;
    confirmations.issue(resolveProductionRuntimeStartConfirmationClaim(fixture.authority, request));
    const launch = host.launchResolver.resolve(request);
    expect(launch.authorityEnvelopeDigest).toBe(
      createRun.mock.calls[0]?.[0].minted.authorityRef.envelopeDigest,
    );
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
    expect(revokeRunAdmissions).toHaveBeenCalledExactlyOnceWith(
      "run-1",
      "request-runtime-start-0001",
    );
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

  // F9 (#3873): the composed host answers whether a run's Authority Envelope ran out of time, on the
  // composition's own clock, so a run that reached its envelope's end (run
  // `run-272120967981827964065820685403290179367`) settles under that cause, not an internal error.
  it("answers a run's envelope end from its minted authority on the composition clock", () => {
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
    confirmations.issue(resolveProductionRuntimeStartConfirmationClaim(fixture.authority, request));
    host.launchResolver.resolve(request);
    const expiresAt = createRun.mock.calls[0]?.[0].context.expiresAt;
    if (expiresAt === undefined) throw new Error("expected a composed run");

    expect(host.envelopeDurationExhausted?.(request.runId)).toBe(false);
    fixture.advanceNow(Date.parse(expiresAt) - fixture.nowMs() - 1);
    expect(host.envelopeDurationExhausted?.(request.runId)).toBe(false);
    fixture.advanceNow(1);
    expect(host.envelopeDurationExhausted?.(request.runId)).toBe(true);
    expect(host.envelopeDurationExhausted?.("run-other")).toBe(false);
  });

  // #3873: the composed host counts a run's model calls where the sidecar gateway admits and settles
  // them — the model-gateway capability's prompt reservation — and its tool calls where the run's
  // facade answers them, and answers both through `runEffort` for the run's settled line.
  it("counts the run's admitted model calls and answered tool calls for its effort roll-up", async () => {
    const fixture = workspaceFixture();
    // The capability store and its authentication read the process clock; hold it on the fixture's
    // clock from before the host is composed, so both judge the run's capabilities at one instant.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(fixture.nowMs());
    ciRepairBudgetOverride.current = {
      admitTool: () => undefined,
      canChargePrompt: () => ({ accepted: true }),
      chargePrompt: () => ({ accepted: true }),
      observed: () => undefined,
    };
    const confirmations = confirmationFixture();
    const createRun = vi.fn((input: ProductionRuntimeBackendInput) =>
      backendRun(input.request.runId),
    );
    const host = createProductionCodingRuntimeHost(
      resolverFor(fixture, createRun, confirmations.consumer),
    );
    if (host === undefined) throw new Error("expected qualified host");
    const request = launchRequest(fixture.workspace);
    confirmations.issue(resolveProductionRuntimeStartConfirmationClaim(fixture.authority, request));
    host.launchResolver.resolve(request);
    const backend = createRun.mock.calls[0]?.[0];
    const ledger = host.runtimeCapabilityAuthenticator;
    if (backend === undefined || ledger === undefined || !hasPromptSettlement(ledger)) {
      throw new Error("expected a composed run and its prompt ledger");
    }
    const capability = backend.minted.modelGatewayCapability;

    // One model call the gateway admitted and, 4 s later, settled with the provider's own count. The
    // admitted reservation answers the call's identity and the settlement names it, as the gateway
    // does, so the call is timed from its own reservation.
    const reserved = ledger.reservePromptTokens?.(capability, 1_000);
    expect(reserved).toMatchObject({ ok: true, modelCallId: expect.any(Number) as unknown });
    fixture.advanceNow(4_000);
    vi.setSystemTime(fixture.nowMs());
    expect(
      ledger.settlePromptTokens(capability, 1_000, 1_240, modelCallIdOf(reserved)),
    ).toMatchObject({ ok: true });
    // A reservation the run's allowance refused is no model call: nothing was dispatched.
    expect(ledger.reservePromptTokens?.(capability, 10_000_000)).toMatchObject({ ok: false });
    // A malformed edit the run's facade refused is still a refused edit.
    await expect(
      backend.toolFacade.execute({
        body: JSON.stringify({
          action: "edit",
          actionId: "action-1",
          idempotencyKey: "idem-1",
          changeset: {},
        }),
        capability: backend.minted.toolFacadeCapability,
      }),
    ).resolves.toMatchObject({ status: "invalid" });

    expect(host.runEffort?.read(request.runId)).toEqual({
      modelTurnCount: 1,
      modelDurationMs: 4_000,
      promptTokensTotal: 1_240,
      toolInvocationCount: 1,
      workspaceReadCount: 0,
      editCount: 0,
      editRefusedCount: 1,
    });
    expect(host.runEffort?.read("run-other")).toBeUndefined();
  });
});

interface PromptSettlementPort {
  readonly settlePromptTokens: (
    capability: string,
    reservedPromptTokens: number,
    actualPromptTokens: number,
    modelCallId?: number,
  ) => unknown;
}

// The identity an admitted reservation answers beside its run, as the gateway reads it.
function modelCallIdOf(reservation: unknown): number | undefined {
  if (typeof reservation !== "object" || reservation === null) return undefined;
  const id = (reservation as { readonly modelCallId?: unknown }).modelCallId;
  return typeof id === "number" ? id : undefined;
}

// The settlement half of the gateway's prompt ledger is wired by the resolver but not declared on
// the shared host interface (see `runtimeCapabilityAuthenticatorFor`); the gateway reads it the same
// way.
function hasPromptSettlement<T extends object>(value: T): value is T & PromptSettlementPort {
  return "settlePromptTokens" in value && typeof value.settlePromptTokens === "function";
}

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
      "request-runtime-parent-0007",
    );
    composed.admitRunManifest?.();
    expect(admitRunManifest).toHaveBeenCalledExactlyOnceWith(
      "/managed/worktree",
      "run-7",
      "2026-09-10T20:00:00.000Z",
      "request-runtime-parent-0007",
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

describe("production pending-spawn lease binding", () => {
  it.each(["workspace-drift", "technical-resolver-fault"] as const)(
    "distinguishes expected refusal from %s after real pending-spawn admission",
    (kind) => {
      const fixture = workspaceFixture();
      const confirmations = confirmationFixture();
      const createRun = vi.fn((input: ProductionRuntimeBackendInput) =>
        backendRun(input.request.runId),
      );
      const failure = new Error("PRIVATE_RESOLVER_TECHNICAL_CAUSE");
      let fault = false;
      const host = createProductionCodingRuntimeHost(
        resolverFor(fixture, createRun, confirmations.consumer, undefined, {
          resolveWorkspaceRootAccess: (root) => {
            if (fault) throw failure;
            return {
              kind: "managed-task",
              canonicalRoot: root,
              repositoryRoot: root,
              fs: nodeWorkspaceFs,
            };
          },
        }),
      );
      if (host === undefined) throw new Error("expected qualified host");
      const request = launchRequest(fixture.workspace);
      confirmations.issue(
        resolveProductionRuntimeStartConfirmationClaim(fixture.authority, request),
      );
      const resolved = host.launchResolver.resolve(request);
      const backend = createRun.mock.calls[0]?.[0];
      if (backend?.canSpawnRuntime === undefined)
        throw new Error("expected actual pending spawn guard");
      const launch = {
        ...resolved,
        runId: request.runId,
        workspaceRoot: fixture.workspace,
        requestedMode: request.requestedMode,
      };
      expect(backend.canSpawnRuntime(launch)).toBe(true);
      if (kind === "workspace-drift") {
        fixture.setHead("2".repeat(40));
        expect(backend.canSpawnRuntime(launch)).toBe(false);
      } else {
        fault = true;
        expect(() => backend.canSpawnRuntime?.(launch)).toThrow(failure);
      }
    },
  );

  it.each(["revoked", "expired", "root-drift", "run", "tree", "envelope", "workspace"] as const)(
    "rechecks %s using the minted starting authority",
    async (kind) => {
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
      confirmations.issue(
        resolveProductionRuntimeStartConfirmationClaim(fixture.authority, request),
      );
      const resolved = host.launchResolver.resolve(request);
      const backend = createRun.mock.calls[0]?.[0];
      if (backend?.canSpawnRuntime === undefined)
        throw new Error("expected server-owned spawn guard");
      const launch = {
        ...resolved,
        runId: request.runId,
        workspaceRoot: fixture.workspace,
        requestedMode: request.requestedMode,
      };
      expect(backend.canSpawnRuntime(launch)).toBe(true);
      if (kind === "revoked") await backend.authorityLifecycle.revokeRuntime(request.runId);
      if (kind === "expired") fixture.advanceNow(121 * 60_000);
      const replacements = {
        run: { runId: "foreign-run" },
        tree: { treeBindingId: "0".repeat(64) },
        envelope: { authorityEnvelopeDigest: "0".repeat(64) },
        workspace: { workspaceRoot: `${fixture.workspace}-foreign` },
      };
      const changed = {
        ...launch,
        ...(kind in replacements ? replacements[kind as keyof typeof replacements] : {}),
      };
      if (kind === "root-drift") fixture.revokeWorkspaceAccess();
      expect(backend.canSpawnRuntime(changed)).toBe(false);
    },
  );
});

import {
  catalogRuntimeFixture,
  RUNTIME_NOW,
} from "../tool-catalog/__fixtures__/catalogRuntimeFixture.js";
import { CodingRuntimeAuthorityService } from "./runtimeAuthorityService.js";
import { createInMemoryRuntimeCapabilityStore } from "./runtimeCapabilityStore.js";
import { productionRuntimeAuthorityFacts } from "./productionRuntimeWorkspaceAuthority.js";

function acceptedInitializationProjectionFixture() {
  const base = catalogRuntimeFixture("autonomous-delivery");
  roots.push(dirname(dirname(base.root)));
  const authority = new CodingRuntimeAuthorityService(
    new EditorAgentAuthorityRegistry(),
    () => "run-1",
    () => "nonce-init",
    undefined,
    createInMemoryRuntimeCapabilityStore({ nowMs: () => Date.now() }),
  );
  const intent = {
    schemaVersion: "1" as const,
    requestId: "request-init",
    command: "start" as const,
    taskIntent: "Read initial project instructions",
    requestedMode: "autonomous-delivery" as const,
    modelSource: "keiko-model-gateway" as const,
  };
  const confirmation = authority.confirmStart(
    intent,
    base.trusted.taskId,
    base.trusted.operatorId,
    RUNTIME_NOW,
  );
  const minted = authority.mintStart(intent, base.trusted, confirmation, RUNTIME_NOW);
  if (!minted.ok) throw new TypeError("Expected actual initial mint");
  const active = {
    instance: {
      workspaceId: base.trusted.workspaceId,
      repositoryId: base.trusted.projectId,
      repositoryRoot: base.root,
      managedWorktreePath: base.root,
      taskId: base.trusted.taskId,
      taskBranch: base.trusted.branchRef,
      baseBranch: "dev",
      lastVerifiedHead: "1".repeat(40),
      lifecycleState: "active",
      health: "healthy",
      driftMarkers: [],
    },
    binding: { activeRoot: base.root },
  };
  const workspace = {
    workspaceLifecycle: { getActive: () => active } as never,
    managedTaskWorkspaceRoot: dirname(dirname(base.root)),
    deploymentCeiling: "autonomous-delivery" as const,
    readWorkspaceHead: () => "1".repeat(40),
    now: () => new Date(),
  };
  const controller = new AbortController();
  const input = {
    minted,
    authority,
    context: base.trusted,
    liveFacts: () => productionRuntimeAuthorityFacts(workspace, base.trusted),
    resolveWorkspaceRootAccess: () => ({
      kind: "managed-task" as const,
      canonicalRoot: base.root,
      repositoryRoot: base.root,
      fs: nodeWorkspaceFs,
    }),
    signal: controller.signal,
    now: () => new Date(),
  };
  return { input, controller, base, minted, authority };
}

describe("accepted initialization STARTING projection", () => {
  function fixture() {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(RUNTIME_NOW));
    return acceptedInitializationProjectionFixture();
  }
  it("captures the actual accepted binding and budget without delegation or authority renewal", () => {
    const f = fixture();
    const delegation = vi.spyOn(f.authority, "resolveCapabilityForDelegation");
    const projection = createProductionAcceptedInitializationAuthority(f.input);
    const guard = projection?.resolve();
    expect(guard?.check()).toBe(true);
    expect(guard?.binding).toMatchObject({
      ...f.minted.authorityRef,
      workspaceId: f.input.liveFacts().binding.workspaceId,
    });
    expect(guard?.executionBudget?.deadlineAtMs).toBeLessThanOrEqual(
      Date.parse(f.base.trusted.expiresAt),
    );
    expect(delegation).not.toHaveBeenCalled();
    expect(projection?.resolve()).toBeUndefined();
  });
  it.each(["run", "digest", "audience"] as const)(
    "refuses copied %s authority instead of granting an initialization guard",
    (change) => {
      const f = fixture();
      const minted = {
        ...f.minted,
        authorityRef: {
          ...f.minted.authorityRef,
          ...(change === "run" ? { runId: "foreign-run" } : {}),
          ...(change === "digest" ? { envelopeDigest: "f".repeat(64) } : {}),
        },
        ...(change === "audience" ? { toolFacadeCapability: f.minted.modelGatewayCapability } : {}),
      };
      expect(
        createProductionAcceptedInitializationAuthority({ ...f.input, minted }),
      ).toBeUndefined();
    },
  );
  it("captures immutable mint/context/callback fields once while revalidating actual live facts", () => {
    const f = fixture();
    const reference = vi.fn(() => f.minted.authorityRef);
    const projection = createProductionAcceptedInitializationAuthority({
      ...f.input,
      minted: {
        ...f.minted,
        get authorityRef() {
          return reference();
        },
      },
    });
    const guard = projection?.resolve();
    expect(reference).toHaveBeenCalledOnce();
    expect(guard?.check()).toBe(true);
    f.authority.transition("run-1", "ready", RUNTIME_NOW);
    expect(guard?.check()).toBe(false);
    expect(reference).toHaveBeenCalledOnce();
  });
  it("refuses changed envelope bytes on a later actual pending-spawn resolution", () => {
    const f = fixture();
    const revalidate = f.authority.revalidateCapabilityForPendingSpawn.bind(f.authority);
    let changed = false;
    vi.spyOn(f.authority, "revalidateCapabilityForPendingSpawn").mockImplementation((input) => {
      const actual = revalidate(input);
      if (!changed || !actual.ok) return actual;
      return {
        ...actual,
        envelope: {
          ...actual.envelope,
          authority: { ...actual.envelope.authority, expiresAt: "2026-09-10T12:30:00.000Z" },
        },
      };
    });
    const guard = createProductionAcceptedInitializationAuthority(f.input)?.resolve();
    expect(guard?.check()).toBe(true);
    changed = true;
    expect(guard?.check()).toBe(false);
  });
  it("refuses current-run duration exhaustion before expiry without widening operator phases", () => {
    const f = fixture();
    const guard = createProductionAcceptedInitializationAuthority(f.input)?.resolve();
    expect(guard?.check()).toBe(true);
    vi.setSystemTime(new Date(Date.parse(RUNTIME_NOW) + f.base.trusted.budget.maxRuntimeMs));
    expect(guard?.check()).toBe(false);
  });
});
