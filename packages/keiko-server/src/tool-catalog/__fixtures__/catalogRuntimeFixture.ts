import { mkdirSync, mkdtempSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodingWorkbenchMode } from "@oscharko-dev/keiko-contracts";
import { createInitialToolCatalog, compileToolProjection } from "@oscharko-dev/keiko-tool-catalog";
import { EditorAgentAuthorityRegistry } from "../../editor/agentAuthorityRegistry.js";
import { CodingRuntimeAuthorityService } from "../../coding-runtime/runtimeAuthorityService.js";
import { createInMemoryRuntimeCapabilityStore } from "../../coding-runtime/runtimeCapabilityStore.js";
import {
  createCodingToolAuthorityPort,
  createCodingToolAuthorityPreview,
} from "../../coding-runtime/codingToolAuthorityPort.js";
import { createCodingToolApprovalBridge } from "../../coding-runtime/codingToolApprovalBridge.js";
import {
  productionRuntimeAuthorityFacts,
  resolveProductionRuntimeContext,
  type ProductionWorkspaceAuthorityInput,
} from "../../coding-runtime/productionRuntimeWorkspaceAuthority.js";
import type { WorkspaceLifecycleService } from "../../task-workspace/types.js";
import { catalogToolFixture } from "./catalogToolFixture.js";

export const RUNTIME_NOW = "2026-07-13T12:00:00.000Z";
function workspaceInput(mode: CodingWorkbenchMode): {
  input: ProductionWorkspaceAuthorityInput;
  root: string;
  dispose: () => void;
} {
  const managed = realpathSync(mkdtempSync(join(tmpdir(), "catalog-runtime-")));
  const root = join(managed, "repo", "workspace");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "fixture.ts"), "export const valid = true;\n");
  const active = {
    instance: {
      workspaceId: "workspace-private",
      repositoryId: "repository-private",
      repositoryRoot: root,
      managedWorktreePath: root,
      taskId: "task-private",
      taskBranch: "issue/3413-binding",
      baseBranch: "dev",
      lastVerifiedHead: "1".repeat(40),
      lifecycleState: "active",
      health: "healthy",
      driftMarkers: [],
    },
    binding: { activeRoot: root },
  };
  return {
    root,
    dispose: (): void => {
      rmSync(managed, { recursive: true, force: true });
    },
    input: {
      workspaceLifecycle: { getActive: () => active } as unknown as WorkspaceLifecycleService,
      managedTaskWorkspaceRoot: managed,
      deploymentCeiling: mode,
      readWorkspaceHead: () => "1".repeat(40),
      now: () => new Date(RUNTIME_NOW),
    },
  };
}
function mint(
  mode: CodingWorkbenchMode,
  workspace: ReturnType<typeof workspaceInput>,
): {
  authority: CodingRuntimeAuthorityService;
  registry: EditorAgentAuthorityRegistry;
  trusted: ReturnType<typeof resolveProductionRuntimeContext>;
  minted: Extract<ReturnType<CodingRuntimeAuthorityService["mintStart"]>, { ok: true }>;
} {
  const trusted = resolveProductionRuntimeContext(workspace.input, {
    runId: "run-1",
    requestId: "request-1",
    taskIntent: "Read the accepted workspace",
    requestedMode: mode,
    workspaceId: "workspace-private",
    workspaceRoot: workspace.root,
    serverPrincipal: "operator-private",
  });
  const registry = new EditorAgentAuthorityRegistry();
  const authority = new CodingRuntimeAuthorityService(
    registry,
    () => "run-1",
    () => "nonce-1",
    undefined,
    createInMemoryRuntimeCapabilityStore({ nowMs: () => Date.parse(RUNTIME_NOW) }),
  );
  const intent = {
    schemaVersion: "1" as const,
    requestId: "request-1",
    command: "start" as const,
    taskIntent: "Read the accepted workspace",
    requestedMode: mode,
    modelSource: "keiko-model-gateway" as const,
  };
  const confirmation = authority.confirmStart(
    intent,
    trusted.taskId,
    trusted.operatorId,
    RUNTIME_NOW,
  );
  const minted = authority.mintStart(intent, trusted, confirmation, RUNTIME_NOW);
  if (!minted.ok) { console.error("MINT_DEBUG", JSON.stringify(minted)); throw new TypeError("Expected genuine runtime authority mint"); }
  if (
    !authority.transition("run-1", "ready", RUNTIME_NOW) ||
    !authority.transition("run-1", "running", RUNTIME_NOW)
  )
    throw new TypeError("Expected running runtime authority");
  return { authority, registry, trusted, minted };
}
function runtimePorts(
  mode: CodingWorkbenchMode,
  workspace: ReturnType<typeof workspaceInput>,
  runtime: ReturnType<typeof mint>,
  approval: ReturnType<typeof createCodingToolApprovalBridge>,
): ReturnType<typeof catalogToolFixture>["input"]["authorityPort"] {
  const context = (): Parameters<typeof createCodingToolAuthorityPort>[1] extends () => infer T
    ? T
    : never => ({
    adapterKind: "model-gateway-sidecar",
    liveFacts: productionRuntimeAuthorityFacts(workspace.input, runtime.trusted),
    workspaceRoot: workspace.root,
    deploymentCeiling: mode,
    nowIso: RUNTIME_NOW,
    ...runtime.minted.authorityRef,
    authorityExpiresAt: runtime.trusted.expiresAt,
  });
  return {
    preview: createCodingToolAuthorityPreview(runtime.authority, context, {
      approvalProofVerifier: approval,
      requireProducerBinding: true,
    }),
    ...createCodingToolAuthorityPort(runtime.authority, context, {
      approvalProofVerifier: approval,
      requireProducerBinding: true,
    }),
  };
}
export function catalogRuntimeFixture(mode: CodingWorkbenchMode): ReturnType<
  typeof catalogToolFixture
> &
  ReturnType<typeof mint> & {
    root: string;
    dispose: () => void;
    approval: ReturnType<typeof createCodingToolApprovalBridge>;
  } {
  const fixture = catalogToolFixture();
  fixture.now.mockReturnValue(Date.parse(RUNTIME_NOW));
  const workspace = workspaceInput(mode);
  const runtime = mint(mode, workspace);
  const approval = createCodingToolApprovalBridge();
  const catalog = createInitialToolCatalog();
  const projection = compileToolProjection(catalog, { id: "legacy-native", version: 1 });
  return {
    ...fixture,
    ...runtime,
    root: workspace.root,
    dispose: workspace.dispose,
    approval,
    input: {
      ...fixture.input,
      projection,
      authorityPort: runtimePorts(mode, workspace, runtime, approval),
    },
    options: {
      ...fixture.options,
      catalog,
      context: () => ({
        ...fixture.context,
        workspaceRoot: workspace.root,
        workspaceIdentity: runtime.trusted.workspaceId,
        workspaceRevision: runtime.trusted.branchHeadDigest,
        authority: runtime.minted.toolFacadeCapability,
        authorityExpiresAt: runtime.trusted.expiresAt,
        deadlineAt: runtime.trusted.expiresAt,
      }),
    },
  };
}
