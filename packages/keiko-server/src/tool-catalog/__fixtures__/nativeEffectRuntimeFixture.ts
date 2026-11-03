import { dirname } from "node:path";

import type { CodingWorkbenchMode } from "@oscharko-dev/keiko-contracts";

import { EditorAgentAuthorityRegistry } from "../../editor/agentAuthorityRegistry.js";
import { catalogRuntimeFixture, RUNTIME_NOW } from "./catalogRuntimeFixture.js";
import { createRuntimeCodingToolFacade } from "../../coding-runtime/codingToolAuthorityPort.js";
import type { CodingToolGovernedPorts } from "../../coding-runtime/codingToolGovernedDelegate.js";
import {
  productionRuntimeAuthorityFacts,
  type ProductionWorkspaceAuthorityInput,
} from "../../coding-runtime/productionRuntimeWorkspaceAuthority.js";
import { CodingRuntimeAuthorityService } from "../../coding-runtime/runtimeAuthorityService.js";
import { createInMemoryRuntimeCapabilityStore } from "../../coding-runtime/runtimeCapabilityStore.js";

/** The run every fixture authority is minted for. */
export const NATIVE_EFFECT_FIXTURE_RUN_ID = "run-1";
const RUN_ID = NATIVE_EFFECT_FIXTURE_RUN_ID;

export type NativeEffectFixtureContext = ReturnType<
  Parameters<typeof createRuntimeCodingToolFacade>[1]
>;

// The real owner, not a mock: a genuine authority service, authority registry and capability mint
// (the shape of the auditor's repro on PR #4064), with a tool-call budget of `maxToolCalls` and,
// when given, a patch budget of `maxPatchBytes`. Shared by the native-effect unit suite and the
// real-binary suites, so both answer a native ask through the same owner.
export function realNativeRuntime(
  maxToolCalls: number,
  mode: CodingWorkbenchMode = "autonomous-delivery",
  maxPatchBytes?: number,
): {
  readonly authority: CodingRuntimeAuthorityService;
  readonly capability: string;
  readonly dispose: () => void;
  readonly context: (nowIso?: string) => NativeEffectFixtureContext;
  readonly facade: ReturnType<typeof createRuntimeCodingToolFacade>;
  readonly expiresAt: string;
} {
  const base = catalogRuntimeFixture(mode);
  const budget = {
    ...base.trusted.budget,
    maxToolCalls,
    ...(maxPatchBytes === undefined ? {} : { maxPatchBytes }),
  };
  const trusted = { ...base.trusted, budget };
  const authority = new CodingRuntimeAuthorityService(
    new EditorAgentAuthorityRegistry(),
    () => RUN_ID,
    () => "nonce-1",
    undefined,
    createInMemoryRuntimeCapabilityStore({ nowMs: () => Date.parse(RUNTIME_NOW) }),
  );
  const minted = mintRunningAuthority(authority, trusted, mode);
  const workspace = workspaceFor(base.root, trusted, mode);
  const context = (nowIso = RUNTIME_NOW): NativeEffectFixtureContext =>
    nativeContext(workspace, base.root, trusted, minted.authorityRef.envelopeDigest, nowIso, mode);
  return {
    authority,
    capability: minted.toolFacadeCapability,
    dispose: base.dispose,
    context,
    facade: createRuntimeCodingToolFacade(authority, context, governedPorts()),
    expiresAt: trusted.expiresAt,
  };
}

type FixtureTrusted = ReturnType<typeof catalogRuntimeFixture>["trusted"];

function mintRunningAuthority(
  authority: CodingRuntimeAuthorityService,
  trusted: FixtureTrusted,
  mode: CodingWorkbenchMode,
): {
  readonly toolFacadeCapability: string;
  readonly authorityRef: { readonly envelopeDigest: string };
} {
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
  if (!minted.ok) throw new TypeError("Expected genuine runtime authority mint");
  if (
    !authority.transition(RUN_ID, "ready", RUNTIME_NOW) ||
    !authority.transition(RUN_ID, "running", RUNTIME_NOW)
  )
    throw new TypeError("Expected running runtime authority");
  return minted;
}

/** Governed ports that fail every call: a native ask never reaches one. */
export function governedPorts(): CodingToolGovernedPorts {
  const failed = (): Promise<{ readonly status: "failed" }> =>
    Promise.resolve({ status: "failed" });
  return {
    repositoryRead: { execute: failed },
    repositoryDiscover: { execute: failed },
    repositorySearch: { execute: failed },
    editorChangeset: { execute: failed },
    commandRunner: { execute: failed },
    verificationRunner: { execute: failed },
    gitAuthority: { execute: failed },
    deliveryAuthority: { execute: failed },
    connectorAuthority: { execute: failed },
    egressAuthority: { execute: failed },
  };
}

function workspaceFor(
  root: string,
  trusted: ReturnType<typeof catalogRuntimeFixture>["trusted"],
  mode: CodingWorkbenchMode,
): ProductionWorkspaceAuthorityInput {
  const instance = {
    workspaceId: trusted.workspaceId,
    repositoryId: trusted.projectId,
    repositoryRoot: root,
    managedWorktreePath: root,
    taskId: trusted.taskId,
    taskBranch: trusted.branchRef,
    baseBranch: trusted.branch.baseRef,
    lastVerifiedHead: "1".repeat(40),
    lifecycleState: "active" as const,
    health: "healthy" as const,
    driftMarkers: [],
  };
  return {
    workspaceLifecycle: {
      getActive: () => ({ instance, binding: { activeRoot: root } }),
    } as unknown as ProductionWorkspaceAuthorityInput["workspaceLifecycle"],
    managedTaskWorkspaceRoot: dirname(dirname(root)),
    deploymentCeiling: mode,
    readWorkspaceHead: () => "1".repeat(40),
    now: () => new Date(RUNTIME_NOW),
  };
}

function nativeContext(
  workspace: ProductionWorkspaceAuthorityInput,
  root: string,
  trusted: ReturnType<typeof catalogRuntimeFixture>["trusted"],
  envelopeDigest: string,
  nowIso: string,
  mode: CodingWorkbenchMode,
): NativeEffectFixtureContext {
  return {
    adapterKind: "model-gateway-sidecar",
    liveFacts: productionRuntimeAuthorityFacts(workspace, trusted),
    workspaceRoot: root,
    deploymentCeiling: mode,
    nowIso,
    runId: RUN_ID,
    envelopeDigest,
    authorityExpiresAt: trusted.expiresAt,
  };
}
