import type { EnvSource } from "@oscharko-dev/keiko-model-gateway";
import { bindSecurityLogCorrelation, type SecurityLogSink } from "@oscharko-dev/keiko-security";
import type {
  UpdatePortableActivationSummary,
  UpdatePortableStagingSummary,
} from "@oscharko-dev/keiko-contracts";
import type { UpdateRuntimeFacts } from "./update-install-mode.js";
import {
  preparePortableHandoffPlan,
  type PortableHandoffProcessIdentity,
} from "./update-portable-handoff-builder.js";
import {
  PortableHandoffCoordinatorError,
  type PortableHandoffCoordinatorPort,
} from "./update-portable-handoff.js";
import { discardPortableHandoffPreparation } from "./update-portable-handoff-plan.js";
import type { UpdateLocalStateManager } from "./update-local-state.js";
import {
  activationIdFor,
  PortableUpdateActivationError,
} from "./update-portable-activation-files.js";

export interface PortableUpdateActivateInput {
  readonly sessionId: string;
  readonly targetVersion: string;
  readonly stage: UpdatePortableStagingSummary;
  readonly runtimeFacts?: UpdateRuntimeFacts | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface PortableUpdateHandoffAcceptance {
  readonly activationId: string;
  readonly status: "handoff-pending";
  readonly coordinatorId: string;
  readonly acceptedAt: string;
}

export interface PortableUpdateActivator {
  readonly activate: (
    input: PortableUpdateActivateInput,
  ) => Promise<UpdatePortableActivationSummary | PortableUpdateHandoffAcceptance>;
}

export interface PortableUpdateActivatorOptions {
  readonly env: EnvSource;
  readonly localState?: UpdateLocalStateManager | undefined;
  readonly now?: (() => number) | undefined;
  readonly homedir?: (() => string) | undefined;
  readonly handoffCoordinator?: PortableHandoffCoordinatorPort | undefined;
  readonly currentVersion?: string | undefined;
  readonly currentProcess?: (() => PortableHandoffProcessIdentity) | undefined;
  readonly newLaunchId?: (() => string) | undefined;
  readonly restoreLaunchId?: (() => string) | undefined;
  readonly securityLogSink?: SecurityLogSink | undefined;
}

export { PortableUpdateActivationError } from "./update-portable-activation-files.js";

const activePortableStateDirs = new Set<string>();

interface PortableHandoffDependencies {
  readonly coordinator: PortableHandoffCoordinatorPort;
  readonly currentProcess: () => PortableHandoffProcessIdentity;
  readonly currentVersion: string;
  readonly localState: UpdateLocalStateManager;
}

function assertAbort(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new PortableUpdateActivationError("cancelled", "portable activation was cancelled");
  }
}

function portableStateDir(
  options: PortableUpdateActivatorOptions,
  request: PortableUpdateActivateInput,
): string {
  return request.runtimeFacts?.portableStateDir ?? options.env.KEIKO_STATE_DIR ?? ".keiko";
}

function discardUncommittedHandoff(
  options: PortableUpdateActivatorOptions,
  stateDir: string,
  activationId: string,
): void {
  const localState = options.localState;
  if (localState !== undefined) {
    const current = localState.readRuntimeState();
    if (current.activationWal?.activationId === activationId) {
      if (current.activationWal.coordinatorId !== undefined) return;
      localState.writeRuntimeState({
        ...current,
        activationWal: undefined,
        recovery: {
          status: "none",
          ...(current.activeSession?.sessionId === undefined
            ? {}
            : { sessionId: current.activeSession.sessionId }),
          updatedAt: new Date(options.now?.() ?? Date.now()).toISOString(),
        },
      });
    }
  }
  discardPortableHandoffPreparation(stateDir, activationId);
}

function portableHandoffDependencies(
  options: PortableUpdateActivatorOptions,
): PortableHandoffDependencies {
  const { handoffCoordinator: coordinator, currentVersion, currentProcess, localState } = options;
  if (
    coordinator === undefined ||
    currentVersion === undefined ||
    currentProcess === undefined ||
    localState === undefined
  ) {
    throw new PortableUpdateActivationError(
      "portable-preflight-ineligible",
      "portable handoff capability is unavailable",
    );
  }
  return { coordinator, currentVersion, currentProcess, localState };
}

function prepareHandoffPlan(
  options: PortableUpdateActivatorOptions,
  input: PortableUpdateActivateInput,
  stateDir: string,
  dependencies: PortableHandoffDependencies,
): Promise<unknown> {
  return preparePortableHandoffPlan(
    {
      env: options.env,
      stateDir,
      currentVersion: dependencies.currentVersion,
      currentProcess: dependencies.currentProcess,
      signal: input.signal,
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.newLaunchId === undefined ? {} : { newLaunchId: options.newLaunchId }),
      ...(options.restoreLaunchId === undefined
        ? {}
        : { restoreLaunchId: options.restoreLaunchId }),
      ...(options.homedir === undefined ? {} : { home: options.homedir }),
      securityLogSink: bindSecurityLogCorrelation(options.securityLogSink, input.sessionId),
    },
    input,
    dependencies.localState.readRuntimeState().revision + 1,
  );
}

async function beginPortableHandoff(
  options: PortableUpdateActivatorOptions,
  input: PortableUpdateActivateInput,
): Promise<PortableUpdateHandoffAcceptance> {
  const dependencies = portableHandoffDependencies(options);
  assertAbort(input.signal);
  const stateDir = portableStateDir(options, input);
  const activationId = activationIdFor(input);
  try {
    await prepareHandoffPlan(options, input, stateDir, dependencies);
    const accepted = await dependencies.coordinator.begin({
      sessionId: input.sessionId,
      activationId,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    return { activationId, status: "handoff-pending", ...accepted };
  } catch (error) {
    if (!(error instanceof PortableHandoffCoordinatorError) || !error.nativeAuthorityMayBeLive) {
      discardUncommittedHandoff(options, stateDir, activationId);
    }
    throw error;
  }
}

export function createPortableUpdateActivator(
  options: PortableUpdateActivatorOptions,
): PortableUpdateActivator {
  return {
    activate(input): Promise<UpdatePortableActivationSummary | PortableUpdateHandoffAcceptance> {
      const stateDir = portableStateDir(options, input);
      if (activePortableStateDirs.has(stateDir)) {
        return Promise.reject(
          new PortableUpdateActivationError(
            "portable-activation-failed",
            "portable activation recovery is pending",
          ),
        );
      }
      activePortableStateDirs.add(stateDir);
      return beginPortableHandoff(options, input).finally(() => {
        activePortableStateDirs.delete(stateDir);
      });
    },
  };
}
