import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";
import type {
  CodingWorkbenchBudget,
  CodingWorkbenchRuntimeAuthorityFacts,
  CodingWorkbenchRuntimeEvent,
  CodingWorkbenchRuntimeIntent,
  VerificationReport,
} from "@oscharko-dev/keiko-contracts";
import {
  validateCodingWorkbenchRuntimeAuthorityFacts,
  validateCodingWorkbenchRuntimeEvent,
} from "@oscharko-dev/keiko-contracts";

import { EditorAgentAuthorityRegistry } from "../editor/agentAuthorityRegistry.js";
import { createCodingRuntimeEditorMutationLeaseCoordinator } from "./codingRuntimeEditorMutationLeaseCoordinator.js";
import type { CodingRuntimeEditorMutationLeaseCoordinator } from "./codingRuntimeEditorMutationLeaseCoordinator.js";
import type { CodingToolFacade } from "./codingToolFacadePorts.js";
import type { CodingToolInvocationRegistry } from "./codingToolInvocationRegistry.js";
import type { CodingToolActionRequest, CodingToolResult } from "./codingToolIpc.js";
import { createCodingToolInvocationRegistry } from "./codingToolInvocationRegistry.js";
import {
  createProductionManagedWorktreeToolFacade,
  productionWorkspaceDigest,
} from "./productionManagedWorktreeTools.js";
import {
  CodingRuntimeAuthorityService,
  codingRuntimeBudgetDigest,
  codingRuntimeFactDigest,
  type CodingRuntimeMintResult,
  type CodingRuntimeTrustedContext,
} from "./runtimeAuthorityService.js";
import { projectRuntimeAuthorityValue } from "./runtimeAuthorityProjection.js";

const NOW = new Date().toISOString();

type EditRequest = Extract<CodingToolActionRequest, { readonly action: "edit" }>;
type SuccessfulMint = Extract<CodingRuntimeMintResult, { readonly ok: true }>;

interface AuthorityFixture {
  readonly authority: CodingRuntimeAuthorityService;
  readonly context: CodingRuntimeTrustedContext;
  readonly minted: SuccessfulMint;
  readonly invocations: CodingToolInvocationRegistry;
  readonly leases: CodingRuntimeEditorMutationLeaseCoordinator;
  readonly facts: CodingWorkbenchRuntimeAuthorityFacts;
}

interface ManagedFacadeOptions {
  readonly assertLiveWorkspace?: () => boolean;
  readonly transformLiveFacts?: (
    facts: CodingWorkbenchRuntimeAuthorityFacts,
  ) => CodingWorkbenchRuntimeAuthorityFacts;
}

interface ManagedFacade {
  readonly fixture: AuthorityFixture;
  readonly facade: CodingToolFacade;
  readonly capability: string;
}

describe("production managed-worktree tool facade", () => {
  it("denies a distinct edit that would exceed the cumulative runtime patch budget", async () => {
    const root = managedRoot("keiko-runtime-patch-budget-");
    const first = editRequestFor("edit-budget-1", "value = 1;\n", "value = 2;\n");
    const second = editRequestFor("edit-budget-2", "value = 2;\n", "value = 3;\n");
    const maxPatchBytes = patchBytes(first) + patchBytes(second) - 1;
    const { facade, capability } = managedFacade(root, { maxPatchBytes });

    await expect(execute(facade, capability, first)).resolves.toMatchObject({
      status: "completed",
    });
    await expect(execute(facade, capability, second)).resolves.toMatchObject({
      status: "denied",
    });
    expect(readFileSync(join(root, "src", "value.ts"), "utf8")).toBe("value = 2;\n");
  });

  it("denies a distinct edit that would exceed the cumulative runtime tool-call budget", async () => {
    const root = managedRoot("keiko-runtime-tool-budget-");
    const { facade, capability } = managedFacade(root, { maxToolCalls: 1 });
    const first = editRequestFor("edit-call-1", "value = 1;\n", "value = 2;\n");
    const second = editRequestFor("edit-call-2", "value = 2;\n", "value = 3;\n");

    await expect(execute(facade, capability, first)).resolves.toMatchObject({
      status: "completed",
    });
    await expect(execute(facade, capability, second)).resolves.toMatchObject({
      status: "denied",
    });
    expect(readFileSync(join(root, "src", "value.ts"), "utf8")).toBe("value = 2;\n");
  });

  it("accounts for exact UTF-8 patch bytes rather than UTF-16 code units", async () => {
    const before = 'value = "😀";\n';
    const after = 'value = "😺";\n';
    const request = editRequestFor("edit-utf8", before, after);
    const exactBytes = patchBytes(request);
    expect(exactBytes).toBeGreaterThan(request.changeset.patch.length);

    const exactRoot = managedRootWith("keiko-runtime-utf8-exact-", before);
    const exact = managedFacade(exactRoot, { maxPatchBytes: exactBytes });
    await expect(execute(exact.facade, exact.capability, request)).resolves.toMatchObject({
      status: "completed",
    });
    expect(readFileSync(join(exactRoot, "src", "value.ts"), "utf8")).toBe(after);

    const tooSmallRoot = managedRootWith("keiko-runtime-utf8-denied-", before);
    const tooSmall = managedFacade(tooSmallRoot, { maxPatchBytes: exactBytes - 1 });
    await expect(execute(tooSmall.facade, tooSmall.capability, request)).resolves.toMatchObject({
      status: "denied",
    });
    expect(readFileSync(join(tooSmallRoot, "src", "value.ts"), "utf8")).toBe(before);
  });

  it("rejects a replayed direct edit without applying a second mutation", async () => {
    const root = managedRoot("keiko-runtime-replayed-edit-");
    const request = editRequestFor("edit-replayed", "value = 1;\n", "value = 2;\n");
    const { facade, capability } = managedFacade(root);

    await expect(execute(facade, capability, request)).resolves.toMatchObject({
      status: "completed",
    });
    await expect(execute(facade, capability, request)).resolves.toMatchObject({ status: "denied" });
    expect(readFileSync(join(root, "src", "value.ts"), "utf8")).toBe("value = 2;\n");
  });

  it.each(["patch bytes", "tool calls"] as const)(
    "does not oversubscribe %s for simultaneous distinct direct edits",
    async (budgetKind): Promise<void> => {
      const root = managedRoot("keiko-runtime-concurrent-edits-");
      const first = editRequestFor("edit-concurrent-1", "value = 1;\n", "value = 2;\n");
      const second = editRequestFor("edit-concurrent-2", "value = 1;\n", "value = 3;\n");
      const budget =
        budgetKind === "patch bytes"
          ? { maxPatchBytes: patchBytes(first), maxToolCalls: 2 }
          : { maxPatchBytes: patchBytes(first) + patchBytes(second), maxToolCalls: 1 };
      const { facade, capability } = managedFacade(root, budget);

      const results = await Promise.all([
        execute(facade, capability, first),
        execute(facade, capability, second),
      ]);

      expect(results.filter((result) => result.status === "completed")).toHaveLength(1);
      expect(results.filter((result) => result.status === "denied")).toHaveLength(1);
      expect(readFileSync(join(root, "src", "value.ts"), "utf8")).toMatch(/^value = [23];\n$/u);
    },
  );

  it("fails closed without mutation when the managed workspace becomes unavailable", async () => {
    const root = managedRoot("keiko-runtime-workspace-drift-");
    const { facade, capability } = managedFacade(root, {}, { assertLiveWorkspace: () => false });

    await expect(execute(facade, capability, editRequest())).resolves.toMatchObject({
      status: "failed",
    });
    expect(readFileSync(join(root, "src", "value.ts"), "utf8")).toBe("value = 1;\n");
  });

  it("fails closed without mutation when the managed workspace head drifts", async () => {
    const root = managedRoot("keiko-runtime-head-drift-");
    const { facade, capability } = managedFacade(
      root,
      {},
      {
        transformLiveFacts: (facts): CodingWorkbenchRuntimeAuthorityFacts => ({
          ...facts,
          binding: { ...facts.binding, branchHeadDigest: digest("drifted-head") },
        }),
      },
    );

    await expect(execute(facade, capability, editRequest())).resolves.toMatchObject({
      status: "denied",
    });
    expect(readFileSync(join(root, "src", "value.ts"), "utf8")).toBe("value = 1;\n");
  });

  it("performs a contained edit, routes verification, and rejects forged or drifted authority", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-runtime-tools-")));
    mkdirSync(join(root, "src"));
    const target = join(root, "src", "value.ts");
    writeFileSync(target, "export const value = 1;\n");
    const fixture = authorityFixture(root);
    const factsValidation = validateCodingWorkbenchRuntimeAuthorityFacts(fixture.facts);
    if (!factsValidation.ok) throw new Error(factsValidation.errors.join(","));
    expect(fixture.authority.state()).toMatchObject({ state: "running", runId: "run-2258" });
    let live = true;
    const runtimeEvents: CodingWorkbenchRuntimeEvent[] = [];
    const runToReport = vi.fn(() => Promise.resolve(passedReport(root)));
    const validated = fixture.authority.revalidateCapabilityForMutation({
      capability: fixture.minted.toolFacadeCapability,
      adapterKind: "model-gateway-sidecar",
      liveFacts: fixture.facts,
      workspaceRoot: root,
      deploymentCeiling: fixture.context.deploymentCeiling,
      nowIso: new Date().toISOString(),
    });
    if (!validated.ok) throw new Error(validated.reason);
    const facadeInput = {
      authority: fixture.authority,
      authorityRef: fixture.minted.authorityRef,
      workspaceRoot: root,
      authorityExpiresAt: fixture.context.expiresAt,
      deploymentCeiling: fixture.context.deploymentCeiling,
      liveFacts: () => fixture.facts,
      assertLiveWorkspace: () => live,
      invocationRegistry: fixture.invocations,
      leases: fixture.leases,
      verificationRunner: { runToReport },
      onRuntimeEvent: (event: CodingWorkbenchRuntimeEvent): void => {
        runtimeEvents.push(event);
      },
    } as const;
    const rawIdentityFacade = createProductionManagedWorktreeToolFacade({
      ...facadeInput,
      workspaceId: fixture.context.workspaceId,
    });
    await expect(
      execute(rawIdentityFacade, fixture.minted.toolFacadeCapability, readRequest("raw-read")),
    ).resolves.toMatchObject({ status: "failed" });
    const facade = createProductionManagedWorktreeToolFacade({
      ...facadeInput,
      workspaceId: fixture.facts.binding.workspaceId,
    });

    await expect(
      execute(facade, fixture.minted.toolFacadeCapability, readRequest()),
    ).resolves.toMatchObject({
      status: "completed",
      read: { text: "export const value = 1;\n" },
    });
    await expect(
      execute(facade, fixture.minted.toolFacadeCapability, editRequest()),
    ).resolves.toMatchObject({
      status: "completed",
    });
    expect(readFileSync(target, "utf8")).toBe("export const value = 2;\n");
    await expect(
      execute(facade, fixture.minted.toolFacadeCapability, verificationRequest()),
    ).resolves.toMatchObject({ status: "completed" });
    expect(runToReport).toHaveBeenCalledWith(
      { projectId: root, kinds: ["typecheck"], requestId: "verify-1" },
      expect.any(AbortSignal),
    );
    expect(runtimeEvents).toHaveLength(1);
    expect(runtimeEvents[0]).toMatchObject({
      runId: "run-2258",
      kind: "verification-summarized",
      verificationKind: "verification-command",
      verificationStatus: "passed",
      passedCount: 0,
      failedCount: 0,
      skippedCount: 0,
    });
    expect(validateCodingWorkbenchRuntimeEvent(runtimeEvents[0]).ok).toBe(true);
    expect(JSON.stringify(runtimeEvents[0])).not.toContain(root);
    await expect(
      execute(facade, fixture.minted.toolFacadeCapability, verificationRequest()),
    ).resolves.toMatchObject({ status: "denied" });
    expect(runtimeEvents).toHaveLength(1);

    await expect(
      execute(facade, "forged-capability-value-2258", readRequest("read-2")),
    ).resolves.toMatchObject({
      status: "denied",
    });
    live = false;
    await expect(
      execute(facade, fixture.minted.toolFacadeCapability, verificationRequest("verify-2")),
    ).resolves.toMatchObject({ status: "failed" });
  });

  it("rejects parent traversal, undeclared targets, and symlink patch targets", async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "keiko-runtime-escape-")));
    const root = join(base, "workspace");
    mkdirSync(join(root, "src"), { recursive: true });
    const outside = join(base, "outside.ts");
    writeFileSync(outside, "outside\n");
    symlinkSync(outside, join(root, "src", "link.ts"));
    const fixture = authorityFixture(root);
    const facade = createProductionManagedWorktreeToolFacade({
      authority: fixture.authority,
      authorityRef: fixture.minted.authorityRef,
      workspaceId: fixture.facts.binding.workspaceId,
      workspaceRoot: root,
      authorityExpiresAt: fixture.context.expiresAt,
      deploymentCeiling: fixture.context.deploymentCeiling,
      liveFacts: () => fixture.facts,
      assertLiveWorkspace: () => true,
      invocationRegistry: fixture.invocations,
      leases: fixture.leases,
      verificationRunner: { runToReport: () => Promise.resolve(passedReport(root)) },
      onRuntimeEvent: (): void => undefined,
    });

    for (const request of [traversalEdit(), undeclaredEdit(), symlinkEdit()]) {
      await expect(
        execute(facade, fixture.minted.toolFacadeCapability, request),
      ).resolves.not.toMatchObject({ status: "completed" });
    }
    expect(readFileSync(outside, "utf8")).toBe("outside\n");
  });

  it.each(["failed", "denied", "cancelled"] as const)(
    "emits a truthful content-free summary for a %s verification result",
    async (status) => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-runtime-result-")));
      const fixture = authorityFixture(root);
      const events: CodingWorkbenchRuntimeEvent[] = [];
      const facade = createProductionManagedWorktreeToolFacade({
        authority: fixture.authority,
        authorityRef: fixture.minted.authorityRef,
        workspaceId: fixture.facts.binding.workspaceId,
        workspaceRoot: root,
        authorityExpiresAt: fixture.context.expiresAt,
        deploymentCeiling: fixture.context.deploymentCeiling,
        liveFacts: () => fixture.facts,
        assertLiveWorkspace: () => true,
        invocationRegistry: fixture.invocations,
        leases: fixture.leases,
        verificationRunner: { runToReport: () => Promise.resolve(reportWithStatus(root, status)) },
        onRuntimeEvent: (event): void => {
          events.push(event);
        },
      });

      await expect(
        execute(facade, fixture.minted.toolFacadeCapability, verificationRequest()),
      ).resolves.toMatchObject({ status: "failed" });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        kind: "verification-summarized",
        verificationStatus: "failed",
        passedCount: 0,
        failedCount: 1,
        skippedCount: 0,
      });
      expect(validateCodingWorkbenchRuntimeEvent(events[0]).ok).toBe(true);
    },
  );

  it("publishes the result before workspace drift can settle the tool as failed", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-runtime-race-")));
    const fixture = authorityFixture(root);
    const order: string[] = [];
    let live = true;
    const facade = createProductionManagedWorktreeToolFacade({
      authority: fixture.authority,
      authorityRef: fixture.minted.authorityRef,
      workspaceId: fixture.facts.binding.workspaceId,
      workspaceRoot: root,
      authorityExpiresAt: fixture.context.expiresAt,
      deploymentCeiling: fixture.context.deploymentCeiling,
      liveFacts: () => fixture.facts,
      assertLiveWorkspace: () => live,
      invocationRegistry: fixture.invocations,
      leases: fixture.leases,
      verificationRunner: { runToReport: () => Promise.resolve(passedReport(root)) },
      onRuntimeEvent: (): void => {
        order.push("verification-summarized");
        live = false;
      },
    });

    const result = await execute(
      facade,
      fixture.minted.toolFacadeCapability,
      verificationRequest(),
    );
    order.push(`tool-${result.status}`);

    expect(order).toEqual(["verification-summarized", "tool-failed"]);
  });

  it("fails closed when verification event publication throws", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-runtime-publish-")));
    const fixture = authorityFixture(root);
    const facade = createProductionManagedWorktreeToolFacade({
      authority: fixture.authority,
      authorityRef: fixture.minted.authorityRef,
      workspaceId: fixture.facts.binding.workspaceId,
      workspaceRoot: root,
      authorityExpiresAt: fixture.context.expiresAt,
      deploymentCeiling: fixture.context.deploymentCeiling,
      liveFacts: () => fixture.facts,
      assertLiveWorkspace: () => true,
      invocationRegistry: fixture.invocations,
      leases: fixture.leases,
      verificationRunner: { runToReport: () => Promise.resolve(passedReport(root)) },
      onRuntimeEvent: (): never => {
        throw new Error("publication-failed");
      },
    });

    await expect(
      execute(facade, fixture.minted.toolFacadeCapability, verificationRequest()),
    ).resolves.toMatchObject({ status: "failed" });
  });
});

function execute(
  facade: CodingToolFacade,
  capability: string,
  request: CodingToolActionRequest,
): Promise<CodingToolResult> {
  return facade.execute({ body: JSON.stringify(request), capability });
}

function readRequest(
  actionId = "read-1",
): Extract<CodingToolActionRequest, { readonly action: "read" }> {
  return {
    action: "read",
    actionId,
    idempotencyKey: `${actionId}-key`,
    relativePath: "src/value.ts",
  };
}

function editRequest(): EditRequest {
  const original = "export const value = 1;\n";
  return {
    action: "edit",
    actionId: "edit-1",
    idempotencyKey: "edit-1-key",
    changeset: {
      patch:
        "--- a/src/value.ts\n+++ b/src/value.ts\n@@ -1 +1 @@\n-export const value = 1;\n+export const value = 2;\n",
      files: [{ file: "src/value.ts", expectedContentHash: digest(original) }],
      selectedFiles: ["src/value.ts"],
    },
  };
}

function editRequestFor(actionId: string, before: string, after: string): EditRequest {
  return editBody(
    actionId,
    `--- a/src/value.ts\n+++ b/src/value.ts\n@@ -1 +1 @@\n-${before}+${after}`,
    "src/value.ts",
    digest(before),
  );
}

function patchBytes(request: EditRequest): number {
  return Buffer.byteLength(request.changeset.patch, "utf8");
}

function verificationRequest(
  actionId = "verify-1",
): Extract<CodingToolActionRequest, { readonly action: "verification" }> {
  return {
    action: "verification",
    actionId,
    idempotencyKey: `${actionId}-key`,
    verifierId: "typecheck",
  };
}

function traversalEdit(): EditRequest {
  return editBody(
    "escape-1",
    "--- a/../outside.ts\n+++ b/../outside.ts\n@@ -1 +1 @@\n-outside\n+owned\n",
    "../outside.ts",
    digest("outside\n"),
  );
}

function undeclaredEdit(): EditRequest {
  return {
    ...editBody(
      "escape-2",
      "--- a/src/value.ts\n+++ b/src/value.ts\n@@ -1 +1 @@\n-old\n+owned\n",
      "src/other.ts",
      digest("old\n"),
    ),
  };
}

function symlinkEdit(): EditRequest {
  return editBody(
    "escape-3",
    "--- a/src/link.ts\n+++ b/src/link.ts\n@@ -1 +1 @@\n-outside\n+owned\n",
    "src/link.ts",
    digest("outside\n"),
  );
}

function editBody(
  actionId: string,
  patch: string,
  file: string,
  expectedContentHash: string,
): EditRequest {
  return {
    action: "edit",
    actionId,
    idempotencyKey: `${actionId}-key`,
    changeset: { patch, files: [{ file, expectedContentHash }], selectedFiles: [file] },
  };
}

function managedRoot(prefix: string): string {
  return managedRootWith(prefix, "value = 1;\n");
}

function managedRootWith(prefix: string, contents: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "value.ts"), contents);
  return root;
}

function managedFacade(
  root: string,
  budget: Partial<CodingWorkbenchBudget> = {},
  options: ManagedFacadeOptions = {},
): ManagedFacade {
  const fixture = authorityFixture(root, budget);
  const liveFacts = (): CodingWorkbenchRuntimeAuthorityFacts =>
    options.transformLiveFacts?.(fixture.facts) ?? fixture.facts;
  const facade = createProductionManagedWorktreeToolFacade({
    authority: fixture.authority,
    authorityRef: fixture.minted.authorityRef,
    workspaceId: fixture.facts.binding.workspaceId,
    workspaceRoot: root,
    authorityExpiresAt: fixture.context.expiresAt,
    deploymentCeiling: fixture.context.deploymentCeiling,
    liveFacts,
    assertLiveWorkspace: options.assertLiveWorkspace ?? ((): boolean => true),
    invocationRegistry: fixture.invocations,
    leases: fixture.leases,
    verificationRunner: { runToReport: () => Promise.resolve(passedReport(root)) },
    onRuntimeEvent: (): void => undefined,
  });
  return { fixture, facade, capability: fixture.minted.toolFacadeCapability };
}

function authorityFixture(
  root: string,
  budget: Partial<CodingWorkbenchBudget> = {},
): AuthorityFixture {
  const authority = new CodingRuntimeAuthorityService(new EditorAgentAuthorityRegistry());
  const context = trustedContext(root, budget);
  const intent: Extract<CodingWorkbenchRuntimeIntent, { readonly command: "start" }> = {
    schemaVersion: "1",
    requestId: "request-2258",
    command: "start",
    taskIntent: "Edit and verify",
    requestedMode: "autonomous-delivery",
    modelSource: "keiko-model-gateway",
  };
  const confirmation = authority.confirmStart(intent, context.taskId, context.operatorId, NOW);
  const minted = authority.mintStartForRun("run-2258", intent, context, confirmation, NOW);
  if (!minted.ok) throw new Error("expected authority mint");
  authority.transition(minted.authorityRef.runId, "ready", NOW);
  authority.transition(minted.authorityRef.runId, "running", NOW);
  const invocations = createCodingToolInvocationRegistry();
  const leases = createCodingRuntimeEditorMutationLeaseCoordinator({
    invocationRegistry: invocations,
    cancelPendingByAuthorityRun: () => 0,
  });
  return { authority, context, minted, invocations, leases, facts: authorityFacts(context) };
}

function trustedContext(
  root: string,
  budget: Partial<CodingWorkbenchBudget> = {},
): CodingRuntimeTrustedContext {
  return {
    operatorId: "operator-2258",
    taskId: "task-2258",
    projectId: "project-2258",
    projectDigest: digest("project-2258"),
    workspaceId: "workspace-2258",
    workspaceRoot: root,
    branchRef: "issue/2258",
    branchHeadDigest: digest("head-2258"),
    branch: {
      baseRef: "dev",
      headRef: "issue/2258",
      allowDetachedHead: false,
      allowedPrefixes: ["issue/"],
    },
    deploymentCeiling: "autonomous-delivery",
    runtimeSource: "keiko-sidecar",
    actionClasses: ["workspace-read", "workspace-write", "verification"],
    connectorScopes: [],
    modelProfile: {
      profileId: "profile-2258",
      source: "keiko-model-gateway",
      supportsStreaming: true,
      supportsToolCalling: true,
    },
    commandPolicy: {
      mode: "deny",
      allow: [],
      deny: [],
      maxCommandTimeoutMs: 1,
      requirePerCommandApproval: true,
    },
    networkPolicy: { mode: "deny-all", allowLoopback: false, connectorScopes: [] },
    gates: ["human-approval"],
    budget: {
      maxRuntimeMs: 60_000,
      maxToolCalls: 20,
      maxPromptTokens: 10_000,
      maxPatchBytes: 65_536,
      ...budget,
    },
    expiresAt: "2099-07-13T10:30:00.000Z",
  };
}

function authorityFacts(
  context: CodingRuntimeTrustedContext,
): CodingWorkbenchRuntimeAuthorityFacts {
  const branchHead = projectRuntimeAuthorityValue("branch", context.branch.headRef);
  const branch = {
    ...context.branch,
    baseRef: projectRuntimeAuthorityValue("branch", context.branch.baseRef),
    headRef: branchHead,
    allowedPrefixes: [branchHead],
  };
  const modelProfile = {
    ...context.modelProfile,
    profileId: projectRuntimeAuthorityValue("profile", context.modelProfile.profileId),
  };
  return {
    binding: {
      taskId: projectRuntimeAuthorityValue("task", context.taskId),
      projectId: projectRuntimeAuthorityValue("project", context.projectId),
      projectDigest: context.projectDigest,
      workspaceId: projectRuntimeAuthorityValue("workspace", context.workspaceId),
      workspaceRootDigest: productionWorkspaceDigest(context.workspaceRoot),
      branchRef: projectRuntimeAuthorityValue("branch", context.branchRef),
      branchHeadDigest: context.branchHeadDigest,
    },
    actionClasses: context.actionClasses,
    connectorScopes: context.connectorScopes,
    runtimeSource: context.runtimeSource,
    modelSource: context.modelProfile.source,
    budgetDigest: codingRuntimeBudgetDigest(context.budget),
    commandPolicyDigest: codingRuntimeFactDigest(context.commandPolicy),
    networkPolicyDigest: codingRuntimeFactDigest(context.networkPolicy),
    gatesDigest: codingRuntimeFactDigest(context.gates),
    branchConstraintsDigest: codingRuntimeFactDigest(branch),
    modelProfileDigest: codingRuntimeFactDigest(modelProfile),
  };
}

function passedReport(root: string): VerificationReport {
  return {
    workspaceRoot: root,
    results: [],
    overallStatus: "passed",
    startedAtMs: 1,
    durationMs: 1,
    counts: {
      passed: 0,
      failed: 0,
      skipped: 0,
      denied: 0,
      "timed-out": 0,
      cancelled: 0,
      "resource-exceeded": 0,
    },
  };
}

function reportWithStatus(
  root: string,
  status: "failed" | "denied" | "cancelled",
): VerificationReport {
  const report = passedReport(root);
  return {
    ...report,
    overallStatus: status,
    counts: { ...report.counts, [status]: 1 },
  };
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
