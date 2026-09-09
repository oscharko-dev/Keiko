import type { VerifiedCommitResult } from "@oscharko-dev/keiko-contracts";
/* eslint-disable @typescript-eslint/explicit-function-return-type -- Local authority fixtures are contextually typed. */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  productionGitDeliveryModeGrants,
  productionRuntimeAuthorityFacts,
  productionWorkspaceMatches,
  type ProductionWorkspaceAuthorityInput,
  resolveProductionRuntimeContext,
  configuredRuntimePromptTokenBudget,
} from "./productionRuntimeWorkspaceAuthority.js";
import {
  CodingRuntimeLaunchResolutionError,
  type CodingRuntimeLaunchResolutionFailureReason,
} from "./launchFailure.js";
// Epic #3384 correction 5 / ADR-0138 D2: pins derive their expectation from the SAME producers the
// module under test calls (AGENTS.md §7 fixture rule) instead of hand-restating the per-mode matrix,
// so a future change to the matrix cannot silently diverge from what these pins accept.
import {
  codingRuntimeActionClassesForMode,
  codingRuntimeCommandPolicyForMode,
  codingRuntimeConnectorScopesForMode,
  codingRuntimeNetworkPolicyForMode,
} from "./runtimeAuthorityService.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function expectLaunchResolutionFailure(
  run: () => unknown,
  reason: CodingRuntimeLaunchResolutionFailureReason,
): void {
  try {
    run();
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(CodingRuntimeLaunchResolutionError);
    if (error instanceof CodingRuntimeLaunchResolutionError) expect(error.reason).toBe(reason);
    return;
  }
  throw new Error("expected launch resolution failure");
}

describe("production runtime workspace authority", () => {
  it("binds an explicit deployment prompt budget only into newly resolved authority", () => {
    const fixture = liveFixture();
    const prior = resolveProductionRuntimeContext(fixture.input, fixture.request);
    const next = resolveProductionRuntimeContext(
      { ...fixture.input, promptTokenBudget: 2_000_000 },
      { ...fixture.request, runId: "run-next" },
    );
    expect(prior.budget.maxPromptTokens).toBe(200_000);
    expect(next.budget.maxPromptTokens).toBe(2_000_000);
    expect(next.budget.maxToolCalls).toBe(prior.budget.maxToolCalls);
    expect(next.budget.maxRuntimeMs).toBe(prior.budget.maxRuntimeMs);
    expect(next.budget.maxPatchBytes).toBe(prior.budget.maxPatchBytes);
  });

  it("validates the deployment prompt budget without an invalid-value fallback", () => {
    expect(configuredRuntimePromptTokenBudget(undefined)).toBe(200_000);
    expect(configuredRuntimePromptTokenBudget("2000000")).toBe(2_000_000);
    for (const invalid of ["", "0", "-1", "1.5", "NaN", "Infinity", "2000001", "1e6"]) {
      expect(() => configuredRuntimePromptTokenBudget(invalid)).toThrow(RangeError);
    }
  });
  it("binds only the healthy active managed worktree and fails on live HEAD drift", () => {
    const managed = realpathSync(mkdtempSync(join(tmpdir(), "keiko-runtime-managed-")));
    roots.push(managed);
    const workspace = join(managed, "repo", "workspace");
    mkdirSync(workspace, { recursive: true });
    let head = "1".repeat(40);
    let verifiedHead = head;
    let commitResult: VerifiedCommitResult | undefined;
    const lifecycle = {
      getActive: () => ({
        instance: {
          workspaceId: "workspace-private",
          repositoryId: "repository-private",
          repositoryRoot: workspace,
          managedWorktreePath: workspace,
          taskId: "task-private",
          taskBranch: "issue/2376-runtime",
          baseBranch: "dev",
          lastVerifiedHead: verifiedHead,
          lifecycleState: "active",
          health: "healthy",
          driftMarkers: [],
        },
        binding: { activeRoot: workspace },
      }),
    };
    const input = {
      workspaceLifecycle: lifecycle as never,
      managedTaskWorkspaceRoot: managed,
      deploymentCeiling: "supervised-coding" as const,
      readWorkspaceHead: () => head,
      verifiedCommitResult: (): VerifiedCommitResult | undefined => commitResult,
      now: () => new Date("2026-07-13T12:00:00.000Z"),
    };
    const context = resolveProductionRuntimeContext(input, {
      runId: "run-1",
      requestId: "request-1",
      taskIntent: "private task",
      requestedMode: "supervised-coding",
      workspaceId: "workspace-private",
      workspaceRoot: workspace,
      serverPrincipal: "operator-private",
    });

    expect(context.workspaceRoot).toBe(workspace);
    expect(context.deploymentCeiling).toBe("supervised-coding");
    expect(productionRuntimeAuthorityFacts(input, context).binding).not.toMatchObject({
      taskId: "task-private",
      workspaceId: "workspace-private",
    });
    expect(productionWorkspaceMatches(input, context)).toBe(true);
    const workspaceDigest = productionRuntimeAuthorityFacts(input, context).binding
      .workspaceRootDigest;
    head = "2".repeat(40);
    expect(productionWorkspaceMatches(input, context)).toBe(false);
    verifiedHead = head;
    // The existing manual restamp still cannot bless an external HEAD move for a runtime.
    expect(productionWorkspaceMatches(input, context)).toBe(false);
    const receipt: VerifiedCommitResult = {
      schemaVersion: "1",
      proposalId: "commit-1",
      runId: "run-1",
      envelopeDigest: "a".repeat(64),
      runtimeAuthorityDigest: "b".repeat(64),
      workspaceDigest,
      repositoryDigest: "c".repeat(64),
      baseSha: "1".repeat(40),
      parentSha: "1".repeat(40),
      headSha: head,
      stagedTreeDigest: "d".repeat(64),
      committedTreeDigest: "d".repeat(64),
      messageDigest: "e".repeat(64),
      verificationEvidenceId: "verification-1",
      status: "succeeded",
      reason: "completed",
      recordedAt: "2026-07-13T12:00:00.000Z",
    };
    commitResult = { ...receipt, runId: "other-run" };
    expect(productionWorkspaceMatches(input, context)).toBe(false);
    commitResult = { ...receipt, workspaceDigest: "0".repeat(64) };
    expect(productionWorkspaceMatches(input, context)).toBe(false);
    commitResult = receipt;
    expect(productionWorkspaceMatches(input, context)).toBe(true);
    head = "3".repeat(40);
    expect(productionWorkspaceMatches(input, context)).toBe(false);
  });

  it("derives the runtime and model source from the validated runtime preference", () => {
    const managed = realpathSync(mkdtempSync(join(tmpdir(), "keiko-runtime-codex-")));
    roots.push(managed);
    const workspace = join(managed, "repo", "workspace");
    mkdirSync(workspace, { recursive: true });
    const instance = {
      workspaceId: "workspace-private",
      repositoryId: "repository-private",
      repositoryRoot: workspace,
      managedWorktreePath: workspace,
      taskId: "task-private",
      taskBranch: "issue/2376-runtime",
      baseBranch: "dev",
      lastVerifiedHead: "1".repeat(40),
      lifecycleState: "active",
      health: "healthy",
      driftMarkers: [],
    };
    const context = resolveProductionRuntimeContext(
      {
        workspaceLifecycle: {
          getActive: () => ({ instance, binding: { activeRoot: workspace } }),
        } as never,
        managedTaskWorkspaceRoot: managed,
        deploymentCeiling: "supervised-coding",
        readWorkspaceHead: () => "1".repeat(40),
      },
      {
        runId: "run-codex",
        requestId: "request-codex",
        taskIntent: "private task",
        requestedMode: "supervised-coding",
        runtimePreference: "codex-subscription",
        workspaceId: "workspace-private",
        workspaceRoot: workspace,
        serverPrincipal: "operator-private",
      },
    );

    expect(context).toMatchObject({
      runtimeSource: "codex-cli-adapter",
      modelProfile: {
        source: "chatgpt-codex-subscription-profile",
      },
    });

    const managedContext = resolveProductionRuntimeContext(
      {
        workspaceLifecycle: {
          getActive: () => ({ instance, binding: { activeRoot: workspace } }),
        } as never,
        managedTaskWorkspaceRoot: managed,
        deploymentCeiling: "supervised-coding",
        readWorkspaceHead: () => "1".repeat(40),
        resolveManagedModelProfile: (modelId, reasoningEffort) => ({
          profileId: modelId ?? "default-model",
          ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
        }),
      },
      {
        runId: "run-managed",
        requestId: "request-managed",
        taskIntent: "private task",
        requestedMode: "supervised-coding",
        runtimePreference: "managed-gateway",
        modelId: "qwen-coder",
        reasoningEffort: "high",
        workspaceId: "workspace-private",
        workspaceRoot: workspace,
        serverPrincipal: "operator-private",
      },
    );

    expect(managedContext.modelProfile).toMatchObject({
      profileId: "qwen-coder",
      source: "keiko-model-gateway",
      reasoningEffort: "high",
    });
  });

  it("classifies unsupported subscription effort and unknown managed models separately", () => {
    const managed = realpathSync(mkdtempSync(join(tmpdir(), "keiko-runtime-selection-")));
    roots.push(managed);
    const workspace = join(managed, "repo", "workspace");
    mkdirSync(workspace, { recursive: true });
    const instance = {
      workspaceId: "workspace-private",
      repositoryId: "repository-private",
      repositoryRoot: workspace,
      managedWorktreePath: workspace,
      taskId: "task-private",
      taskBranch: "issue/runtime",
      baseBranch: "dev",
      lastVerifiedHead: "1".repeat(40),
      lifecycleState: "active",
      health: "healthy",
      driftMarkers: [],
    };
    const input: ProductionWorkspaceAuthorityInput = {
      workspaceLifecycle: {
        getActive: () => ({ instance, binding: { activeRoot: workspace } }),
      } as never,
      managedTaskWorkspaceRoot: managed,
      deploymentCeiling: "supervised-coding",
      readWorkspaceHead: () => "1".repeat(40),
    };
    const request = {
      runId: "run-selection",
      requestId: "request-selection",
      taskIntent: "private task",
      requestedMode: "supervised-coding" as const,
      workspaceId: "workspace-private",
      workspaceRoot: workspace,
      serverPrincipal: "operator-private",
    };

    expectLaunchResolutionFailure(
      () =>
        resolveProductionRuntimeContext(input, {
          ...request,
          runtimePreference: "codex-subscription",
          reasoningEffort: "high",
        }),
      "codex-reasoning-effort-unsupported",
    );
    expectLaunchResolutionFailure(
      () =>
        resolveProductionRuntimeContext(input, {
          ...request,
          runtimePreference: "managed-gateway",
          modelId: "unknown-model",
        }),
      "managed-model-unqualified",
    );
  });

  it("denies non-canonical and mismatched request, binding, and instance roots", () => {
    const managed = realpathSync(mkdtempSync(join(tmpdir(), "keiko-runtime-roots-")));
    roots.push(managed);
    const workspace = join(managed, "repo", "workspace");
    const other = join(managed, "repo", "other");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(other, { recursive: true });
    const alias = join(managed, "workspace-alias");
    symlinkSync(workspace, alias);
    let activeRoot = workspace;
    let managedWorktreePath = workspace;
    const instance = {
      workspaceId: "workspace-private",
      repositoryId: "repository-private",
      repositoryRoot: workspace,
      get managedWorktreePath() {
        return managedWorktreePath;
      },
      taskId: "task-private",
      taskBranch: "issue/2376-runtime",
      baseBranch: "dev",
      lastVerifiedHead: "1".repeat(40),
      lifecycleState: "active",
      health: "healthy",
      driftMarkers: [],
    };
    const input = {
      workspaceLifecycle: {
        getActive: () => ({ instance, binding: { activeRoot } }),
      } as never,
      managedTaskWorkspaceRoot: managed,
      deploymentCeiling: "supervised-coding" as const,
      readWorkspaceHead: () => "1".repeat(40),
    };
    const request = {
      runId: "run-1",
      requestId: "request-1",
      taskIntent: "private task",
      requestedMode: "supervised-coding" as const,
      workspaceId: "workspace-private",
      workspaceRoot: workspace,
      serverPrincipal: "operator-private",
    };

    expect(() =>
      resolveProductionRuntimeContext(input, { ...request, workspaceRoot: alias }),
    ).toThrow("runtime-workspace-unqualified");
    activeRoot = other;
    expect(() => resolveProductionRuntimeContext(input, request)).toThrow(
      "runtime-workspace-unqualified",
    );
    activeRoot = workspace;
    const context = resolveProductionRuntimeContext(input, request);
    managedWorktreePath = other;
    expect(productionWorkspaceMatches(input, context)).toBe(false);
  });

  it.each([
    [
      "task identity",
      (fixture: ReturnType<typeof liveFixture>) => (fixture.instance.taskId = "task-2"),
    ],
    [
      "project identity",
      (fixture: ReturnType<typeof liveFixture>) => (fixture.instance.repositoryId = "repository-2"),
    ],
    [
      "project root digest",
      (fixture: ReturnType<typeof liveFixture>) =>
        (fixture.instance.repositoryRoot = fixture.other),
    ],
    [
      "base branch",
      (fixture: ReturnType<typeof liveFixture>) => (fixture.instance.baseBranch = "release"),
    ],
    [
      "task branch",
      (fixture: ReturnType<typeof liveFixture>) => (fixture.instance.taskBranch = "issue/other"),
    ],
    [
      "workspace identity",
      (fixture: ReturnType<typeof liveFixture>) => (fixture.instance.workspaceId = "workspace-2"),
    ],
    [
      "workspace root",
      (fixture: ReturnType<typeof liveFixture>) =>
        (fixture.instance.managedWorktreePath = fixture.other),
    ],
    [
      "active root",
      (fixture: ReturnType<typeof liveFixture>) => {
        fixture.setActiveRoot(fixture.other);
      },
    ],
    [
      "verified HEAD",
      (fixture: ReturnType<typeof liveFixture>) =>
        (fixture.instance.lastVerifiedHead = "2".repeat(40)),
    ],
    [
      "live HEAD",
      (fixture: ReturnType<typeof liveFixture>) => {
        fixture.setHead("2".repeat(40));
      },
    ],
  ])("denies live %s drift before retained authority use", (_field, mutate) => {
    const fixture = liveFixture();
    const context = resolveProductionRuntimeContext(fixture.input, fixture.request);

    mutate(fixture);

    expect(productionWorkspaceMatches(fixture.input, context)).toBe(false);
  });

  it("denies altered branch constraints even when live workspace fields still match", () => {
    const fixture = liveFixture();
    const context = resolveProductionRuntimeContext(fixture.input, fixture.request);

    expect(
      productionWorkspaceMatches(fixture.input, {
        ...context,
        branch: { ...context.branch, allowedPrefixes: ["untrusted/"] },
      }),
    ).toBe(false);
  });

  // ADR-0138 D2 / epic #3384 correction 5: the "delivery" resource scope is `approval-required`,
  // never `denied`, in every mode — so `delivery-substrate` and the `source-control.*` connector
  // scopes must be minted in every mode too; approval (not scope absence) is what still blocks an
  // unapproved delivery effect below `autonomous-delivery`. Withholding the scope until
  // `autonomous-delivery` (the pre-fix shape) made `gitOperationRequirements.ts`'s
  // `LOCAL_WRITE_REQUIREMENT` unsatisfiable for `supervised-coding`, which ADR-0138 D2 marks
  // `workspace-contained`/`allowed` — a Supervised workspace run could never stage a file. The same
  // D2 correction applies to `workspace-contained` commands themselves: `governed-assist`'s effect is
  // `approval-required`, never a hard `deny`, so `command-execution` is minted (gated on approval)
  // in EVERY mode, not withheld below `supervised-coding`. Expectations below are derived from the
  // production producers rather than hand-listed, so this pin cannot drift from the matrix it guards.
  it.each(["governed-assist", "supervised-coding", "autonomous-delivery"] as const)(
    "derives the production authority envelope for %s",
    (mode) => {
      const fixture = liveFixture();
      const context = resolveProductionRuntimeContext(
        { ...fixture.input, deploymentCeiling: mode },
        { ...fixture.request, requestedMode: mode },
      );

      expect(context.actionClasses).toEqual(codingRuntimeActionClassesForMode(mode, undefined));
      expect(context.commandPolicy).toEqual(codingRuntimeCommandPolicyForMode(mode));
      expect(context.networkPolicy).toEqual(codingRuntimeNetworkPolicyForMode(mode, undefined));
      // The delivery/source-control connector scope is granted in every mode now (never denied by
      // the matrix); only the network policy stays mode-gated to autonomous-delivery — that
      // dimension is #3387's territory (push/pull-request/fetch have no mint route below Full
      // access yet).
      expect(context.connectorScopes).toEqual(["source-control.read", "source-control.write"]);
      // Explicit floor assertion (not only implied by toEqual above): Ask for approval's command
      // policy is approval-required — "governed" with per-command approval required — and never the
      // hard "deny" the pre-ADR-0138-D2 matrix used to mint.
      if (mode === "governed-assist") {
        expect(context.commandPolicy).toMatchObject({
          mode: "governed",
          requirePerCommandApproval: true,
        });
        expect(context.commandPolicy.mode).not.toBe("deny");
        expect(context.actionClasses).toContain("command-execution");
      }
    },
  );

  // #3384 / #3386: every capability in the envelope is derived from the EFFECTIVE mode — the
  // fail-closed minimum of requested mode and deployment ceiling (ADR-0124 D2) — not from the
  // requested mode. Deriving from the request let a run ask for `autonomous-delivery` under a lower
  // ceiling and receive a clamped `effectiveMode` while still carrying `network-egress` and a
  // connector-scoped network policy, which the runtime tool port and the Git-delivery route
  // admission both accept. That is authority widening by request. `delivery-substrate` and the
  // source-control connector scopes are no longer part of what clamping withholds (ADR-0138 D2:
  // delivery is approval-required, not mode-gated, below Full access), so only the network
  // dimension is asserted as clamped here.
  it.each(["supervised-coding", "governed-assist"] as const)(
    "clamps every derived capability to the deployment ceiling %s when a higher mode is requested",
    (ceiling) => {
      const fixture = liveFixture();
      const context = resolveProductionRuntimeContext(
        { ...fixture.input, deploymentCeiling: ceiling },
        { ...fixture.request, requestedMode: "autonomous-delivery" },
      );

      expect(context.deploymentCeiling).toBe(ceiling);
      // Clamping derives every capability from the CEILING mode via the same producers the resolver
      // calls — never from the requested (higher) mode.
      expect(context.actionClasses).toEqual(codingRuntimeActionClassesForMode(ceiling, undefined));
      expect(context.actionClasses).not.toContain("network-egress");
      expect(context.connectorScopes).toEqual(["source-control.read", "source-control.write"]);
      expect(context.networkPolicy).toEqual(codingRuntimeNetworkPolicyForMode(ceiling, undefined));
      expect(context.commandPolicy).toEqual(codingRuntimeCommandPolicyForMode(ceiling));
      // ADR-0138 D2: even at the lowest clamped ceiling (governed-assist), the command policy is
      // approval-required ("governed"), never a hard "deny" — workspace-contained commands are
      // gated by per-command approval, not withheld outright.
      expect(context.commandPolicy.mode).toBe("governed");
      expect(context.commandPolicy.requirePerCommandApproval).toBe(true);
    },
  );

  // ADR-0138's fail-closed rule: an unknown, missing or malformed mode value resolves to
  // `governed-assist`, the lowest posture. Asserted here on the production resolver, because a
  // malformed value reaching it must yield the same envelope a real governed-assist run gets — not
  // an accidental grant, or an accidental withholding, from a comparison that silently fell through.
  // Governed-assist's floor now carries the delivery/source-control scope AND `command-execution`
  // (both approval-required, never denied) alongside the deny-all network policy. Expectations are
  // derived from the production producers at the resolved lowest posture, never hand-listed.
  it.each([
    ["malformed requested mode", "AUTONOMOUS-DELIVERY", "autonomous-delivery"],
    ["empty requested mode", "", "autonomous-delivery"],
    ["malformed ceiling", "autonomous-delivery", "full-access"],
    ["empty ceiling", "autonomous-delivery", ""],
    ["both malformed", "not-a-mode", "not-a-mode"],
  ] as const)("fails closed to the lowest posture for a %s", (_label, requestedMode, ceiling) => {
    const fixture = liveFixture();
    const context = resolveProductionRuntimeContext(
      { ...fixture.input, deploymentCeiling: ceiling as never },
      { ...fixture.request, requestedMode: requestedMode as never },
    );

    expect(context.actionClasses).toEqual(
      codingRuntimeActionClassesForMode("governed-assist", undefined),
    );
    expect(context.actionClasses).toContain("command-execution");
    expect(context.actionClasses).toContain("delivery-substrate");
    expect(context.actionClasses).toContain("connector-access");
    expect(context.actionClasses).not.toContain("network-egress");
    expect(context.connectorScopes).toEqual(["source-control.read", "source-control.write"]);
    expect(context.networkPolicy).toEqual(
      codingRuntimeNetworkPolicyForMode("governed-assist", undefined),
    );
    expect(context.commandPolicy).toEqual(codingRuntimeCommandPolicyForMode("governed-assist"));
    // The lowest posture's command policy is approval-required ("governed"), never a hard "deny".
    expect(context.commandPolicy.mode).toBe("governed");
    expect(context.commandPolicy.requirePerCommandApproval).toBe(true);
  });

  // Epic #3384 correction 5, item 1: the concrete regression this record fixes. Before this change,
  // `gitOperationRequirements.ts`'s `LOCAL_WRITE_REQUIREMENT` (stage/unstage/branch-create/
  // branch-switch) demanded `source-control.write`, which was minted only for `autonomous-delivery`
  // — so a `supervised-coding` run, which ADR-0138 D2 marks `workspace-contained`/`allowed`, could
  // never satisfy `hasRequiredScopes` in `gitDelivery/runBoundAuthority.ts` and staging failed closed
  // with `permission-scope-missing` regardless of mode or approval. The envelope now carries the
  // scope every LOCAL_WRITE_REQUIREMENT operation demands in every mode; the mode/approval decision
  // (allowed for supervised-coding, approval-required for governed-assist) is the only remaining
  // gate, exactly as ADR-0138 D2 requires.
  it.each(["governed-assist", "supervised-coding", "autonomous-delivery"] as const)(
    "grants the LOCAL_WRITE_REQUIREMENT scope (workspace-write + source-control.write) for %s",
    (mode) => {
      const fixture = liveFixture();
      const context = resolveProductionRuntimeContext(
        { ...fixture.input, deploymentCeiling: mode },
        { ...fixture.request, requestedMode: mode },
      );

      expect(context.actionClasses).toContain("workspace-write");
      expect(context.connectorScopes).toContain("source-control.write");
    },
  );
});

// Epic #3384 correction 5, item 2: `productionGitDeliveryModeGrants` is the smallest pure per-mode
// projection this module exports so `gitDelivery/runBoundAuthority.test-support.ts`'s fixture can
// derive the production shape instead of restating it (AGENTS.md §7). Pinned directly here so the
// exported contract itself — not only the resolver that consumes it internally — has coverage.
describe("productionGitDeliveryModeGrants", () => {
  it.each(["governed-assist", "supervised-coding", "autonomous-delivery"] as const)(
    "grants the delivery/source-control scope for %s",
    (mode) => {
      const grants = productionGitDeliveryModeGrants(mode);
      // productionGitDeliveryModeGrants mints with researchEgressEnabled held at its production
      // default (`false`) -- see the module's own doc comment -- so the fixture matches that here
      // rather than restating which action classes each mode grants.
      expect(grants.actionClasses).toEqual(codingRuntimeActionClassesForMode(mode, false));
      expect(grants.connectorScopes).toEqual(codingRuntimeConnectorScopesForMode(mode));
      expect(grants.connectorScopes).toEqual(["source-control.read", "source-control.write"]);
      // ADR-0138 D2: governed-assist mints command-execution too (approval-required, never denied).
      if (mode === "governed-assist") {
        expect(grants.actionClasses).toContain("command-execution");
      }
    },
  );
});

function liveFixture() {
  const managed = realpathSync(mkdtempSync(join(tmpdir(), "keiko-runtime-live-fields-")));
  roots.push(managed);
  const workspace = join(managed, "repo", "workspace");
  const other = join(managed, "repo", "other");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(other, { recursive: true });
  let activeRoot = workspace;
  let head = "1".repeat(40);
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
  const input = {
    workspaceLifecycle: {
      getActive: () => ({ instance, binding: { activeRoot } }),
    } as never,
    managedTaskWorkspaceRoot: managed,
    deploymentCeiling: "supervised-coding" as const,
    readWorkspaceHead: () => head,
  };
  return {
    input,
    instance,
    other,
    request: {
      runId: "run-live",
      requestId: "request-live",
      taskIntent: "private task",
      requestedMode: "supervised-coding" as const,
      workspaceId: "workspace-private",
      workspaceRoot: workspace,
      serverPrincipal: "operator-private",
    },
    setActiveRoot: (value: string): void => {
      activeRoot = value;
    },
    setHead: (value: string): void => {
      head = value;
    },
  };
}
