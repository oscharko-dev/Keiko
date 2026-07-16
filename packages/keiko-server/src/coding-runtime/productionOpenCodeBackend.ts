import { randomBytes } from "node:crypto";
import { join } from "node:path";

import type { UpdatePortableTarget } from "@oscharko-dev/keiko-contracts";
import type { LongLivedRuntimeQualification } from "@oscharko-dev/keiko-sandbox";

import type { OpenCodeGatewayReadinessRegistry } from "../coding-sidecar-gateway.js";
import type { PortableSidecarRuntimeVerification } from "../update-portable-sidecar-verification.js";
import type { CodingRuntimeEvidenceAggregator } from "./codingRuntimeEvidenceAggregator.js";
import { createNativeRuntimeProcessBackend } from "./nativeRuntimeProcessBackend.js";
import {
  createOpenCodeRuntimeComposition,
  type OpenCodeRuntimeCompositionInput,
} from "./opencodeRuntimeComposition.js";
import { createOpenCodeRuntimeQuestionPort } from "./productionCodingRuntimeQuestionPort.js";
import { createOpenCodeRuntimeTurnPort } from "./productionCodingRuntimePorts.js";
import type {
  ProductionRuntimeBackendInput,
  ProductionRuntimeBackendResolver,
  QualifiedProductionRuntimeRun,
} from "./productionCodingRuntimeResolver.js";
import type { QualifiedPortableOpenCodeRuntime } from "./productionPortableCodingRuntime.js";
import {
  createRuntimeProcessSupervisor,
  type RuntimeProcessSupervisor,
} from "./runtimeProcessSupervisor.js";

/**
 * Functional-evidence stand-in for a platform-qualified portable OpenCode runtime. It is reachable
 * only through the explicit `createSupervisor` harness seam and never through production discovery.
 */
export interface FunctionalPortableOpenCodeRuntime {
  readonly evidenceClass: "functional-not-platform-qualified";
  readonly installRoot: string;
  readonly target: UpdatePortableTarget;
  readonly sidecar: PortableSidecarRuntimeVerification;
  readonly qualification: LongLivedRuntimeQualification;
  readonly nativeHelperPath: string;
}

export type ResolvedPortableOpenCodeRuntime =
  | QualifiedPortableOpenCodeRuntime
  | FunctionalPortableOpenCodeRuntime;

export interface ProductionOpenCodeBackendInput {
  readonly portable: ResolvedPortableOpenCodeRuntime;
  readonly runtimeStateRoot: string;
  readonly gatewayUrl: string;
  readonly runtimeEvidence: Pick<CodingRuntimeEvidenceAggregator, "observe">;
  readonly gatewayReadiness: Pick<
    OpenCodeGatewayReadinessRegistry,
    "waitForObservedRequest" | "clear"
  >;
  readonly fetch?: typeof globalThis.fetch | undefined;
  /** Explicit functional-test seam. Production composition never supplies this. */
  readonly createSupervisor?:
    | ((input: {
        readonly workspaceRoot: string;
        readonly portable: ResolvedPortableOpenCodeRuntime;
      }) => RuntimeProcessSupervisor)
    | undefined;
}

/**
 * Concrete OpenCode process backend for the production coding-runtime resolver. It turns one
 * minted run into a supervised managed OpenCode composition: verified portable artifact, owned
 * process tree, loopback HTTP/SSE client, governed tool bridge, and gateway-bound model routing.
 */
export function createProductionOpenCodeBackend(
  input: ProductionOpenCodeBackendInput,
): ProductionRuntimeBackendResolver {
  return {
    createRun: (run): QualifiedProductionRuntimeRun => createOpenCodeRun(input, run),
  };
}

function createOpenCodeRun(
  input: ProductionOpenCodeBackendInput,
  run: ProductionRuntimeBackendInput,
): QualifiedProductionRuntimeRun {
  assertOpenCodeRun(run);
  const composition = createOpenCodeRuntimeComposition({
    portable: {
      verification: input.portable.sidecar,
      resourceRoot: input.portable.installRoot,
      target: input.portable.target,
    },
    stateBaseRoot: join(input.runtimeStateRoot, "coding-runtime", "opencode"),
    capabilities: {
      modelGatewayCapability: run.minted.modelGatewayCapability,
      toolFacadeCapability: run.minted.toolFacadeCapability,
    },
    toolFacade: run.toolFacade,
    governedEventSink: idempotentEventSink(
      run.minted.authorityRef.runId,
      run.minted.authorityRef.envelopeDigest,
      input.runtimeEvidence,
    ),
    gatewayReadiness: input.gatewayReadiness,
    fetch: input.fetch ?? globalThis.fetch,
    supervisor: runtimeSupervisor(input, run.context.workspaceRoot),
    onRuntimeEvent: run.onRuntimeEvent,
    authorityLifecycle: run.authorityLifecycle,
  });
  return {
    manager: composition.manager,
    launch: {
      recoveryHandle: randomBytes(16).toString("hex"),
      adapterKind: "opencode-compatible",
      runtimeSource: "keiko-sidecar",
      modelSource: "keiko-model-gateway",
      executablePath: join(input.portable.installRoot, input.portable.sidecar.executablePath),
      managedRoot: join(input.portable.installRoot, input.portable.sidecar.payloadRootPath),
      gatewayUrl: input.gatewayUrl,
      modelProfileId: run.context.modelProfile.profileId,
      args: [],
      inheritedEnvAllowlist: [],
      shutdownTimeoutMs: 5_000,
      startTimeoutMs: 30_000,
      confinement: input.portable.qualification,
    },
    turnPort: createOpenCodeRuntimeTurnPort(composition.runPort),
    questionPort: createOpenCodeRuntimeQuestionPort(composition.runPort),
  };
}

/** OpenCode never serves Codex subscription profiles; reject before any process work begins. */
function assertOpenCodeRun(run: ProductionRuntimeBackendInput): void {
  if (
    run.context.runtimeSource !== "keiko-sidecar" ||
    run.context.modelProfile.source !== "keiko-model-gateway"
  ) {
    throw new Error("opencode-backend-profile-mismatch");
  }
}

function runtimeSupervisor(
  input: ProductionOpenCodeBackendInput,
  workspaceRoot: string,
): RuntimeProcessSupervisor {
  if (input.createSupervisor) {
    return input.createSupervisor({ workspaceRoot, portable: input.portable });
  }
  return createRuntimeProcessSupervisor({
    backend: createNativeRuntimeProcessBackend({
      helperPath: input.portable.nativeHelperPath,
      runtimeRoots: [join(input.portable.installRoot, input.portable.sidecar.payloadRootPath)],
      workspaceRoot,
    }),
    qualifications: [input.portable.qualification],
  });
}

function idempotentEventSink(
  runId: string,
  authorityDigest: string,
  evidence: Pick<CodingRuntimeEvidenceAggregator, "observe">,
): OpenCodeRuntimeCompositionInput["governedEventSink"] {
  const identities = new Set<string>();
  return {
    execute: (identity, event): Promise<"duplicate" | "applied"> => {
      const duplicate = identities.has(identity);
      identities.add(identity);
      if (!duplicate) {
        evidence.observe(runId, {
          kind: event.kind === "tool" ? "tool-call" : "model-request",
          state: "running",
          authorityDigest,
        });
      }
      return Promise.resolve(duplicate ? "duplicate" : "applied");
    },
  };
}
