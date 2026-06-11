import type { Clock } from "@oscharko-dev/keiko-model-gateway";
import type {
  OrchestrationAuthorityBoundary,
  OrchestrationChildPlan,
  OrchestrationChildRole,
  OrchestrationExecutionMode,
  OrchestrationPlan,
  OrchestrationState,
  OrchestrationStateTransition,
  HarnessLimits,
  TaskInput,
} from "./types.js";
import { createSession, type AgentConfig, type AgentSession, type HarnessDeps } from "./session.js";
import { defaultIdSource } from "./fingerprint.js";
import { resolveTaskPlan } from "./tasks/policy.js";

export interface RolePolicy {
  readonly role: OrchestrationChildRole;
  readonly allowsParallel: boolean;
  readonly escalatesOnFailure: boolean;
  readonly maxRetryAttempts: number;
  readonly defaultAuthority: OrchestrationAuthorityBoundary;
}

export const DEFAULT_ROLE_POLICIES: Readonly<Record<OrchestrationChildRole, RolePolicy>> = {
  planner: {
    role: "planner",
    allowsParallel: false,
    escalatesOnFailure: true,
    maxRetryAttempts: 1,
    defaultAuthority: {
      allowedTaskTypes: ["explain-plan"],
      canReadWorkspace: true,
      canWriteWorkspace: false,
      canSpawnChildren: false,
      canCancelSiblings: false,
      canApproveSettlement: false,
      maxConcurrentChildren: 1,
      maxRetryAttempts: 1,
    },
  },
  implementer: {
    role: "implementer",
    allowsParallel: true,
    escalatesOnFailure: true,
    maxRetryAttempts: 2,
    defaultAuthority: {
      allowedTaskTypes: ["generate-unit-tests", "investigate-bug"],
      canReadWorkspace: true,
      canWriteWorkspace: true,
      canSpawnChildren: false,
      canCancelSiblings: false,
      canApproveSettlement: false,
      maxConcurrentChildren: 2,
      maxRetryAttempts: 2,
    },
  },
  reviewer: {
    role: "reviewer",
    allowsParallel: true,
    escalatesOnFailure: false,
    maxRetryAttempts: 1,
    defaultAuthority: {
      allowedTaskTypes: ["explain-plan", "verify"],
      canReadWorkspace: true,
      canWriteWorkspace: false,
      canSpawnChildren: false,
      canCancelSiblings: false,
      canApproveSettlement: false,
      maxConcurrentChildren: 2,
      maxRetryAttempts: 1,
    },
  },
  validator: {
    role: "validator",
    allowsParallel: true,
    escalatesOnFailure: true,
    maxRetryAttempts: 1,
    defaultAuthority: {
      allowedTaskTypes: ["verify", "explain-plan"],
      canReadWorkspace: true,
      canWriteWorkspace: false,
      canSpawnChildren: false,
      canCancelSiblings: false,
      canApproveSettlement: false,
      maxConcurrentChildren: 2,
      maxRetryAttempts: 1,
    },
  },
  merger: {
    role: "merger",
    allowsParallel: false,
    escalatesOnFailure: true,
    maxRetryAttempts: 1,
    defaultAuthority: {
      allowedTaskTypes: ["investigate-bug"],
      canReadWorkspace: true,
      canWriteWorkspace: true,
      canSpawnChildren: false,
      canCancelSiblings: false,
      canApproveSettlement: true,
      maxConcurrentChildren: 1,
      maxRetryAttempts: 1,
    },
  },
} as const;

export interface OrchestrationLimits {
  readonly maxConcurrentChildren: number;
  readonly maxChildren: number;
  readonly maxFailedChildren: number;
  readonly maxModelCalls: number;
  readonly maxToolCalls: number;
  readonly maxCommandExecutions: number;
  readonly maxWallTimeMs: number;
}

export const DEFAULT_ORCHESTRATION_LIMITS: OrchestrationLimits = {
  maxConcurrentChildren: 2,
  maxChildren: 10,
  maxFailedChildren: 1,
  maxModelCalls: 40,
  maxToolCalls: 60,
  maxCommandExecutions: 20,
  maxWallTimeMs: 300_000,
} as const;

export interface OrchestrationChildRequest {
  readonly plan: OrchestrationChildPlan;
  readonly task: TaskInput;
  readonly resourceClaims?: readonly ResourceClaim[] | undefined;
  readonly config?: Partial<AgentConfig> | undefined;
}

export type ResourceKind = "file" | "patch" | "tool";
export type ResourceAccessMode = "read" | "write" | "exclusive";
export type ResourceConflictPolicy = "serialize" | "block" | "escalate";

export interface ResourceClaim {
  readonly kind: ResourceKind;
  readonly resourceId: string;
  readonly access: ResourceAccessMode;
  readonly policy: ResourceConflictPolicy;
}

export interface ResourceConflict {
  readonly childId: string;
  readonly conflictingChildId: string;
  readonly claim: ResourceClaim;
  readonly outcome: ResourceConflictPolicy;
  readonly reason: string;
}

export interface OrchestrationChildResult {
  readonly childId: string;
  readonly state: "completed" | "cancelled" | "failed" | "blocked";
  readonly attempts: number;
  readonly run: Awaited<AgentSession["result"]> | undefined;
  readonly reason: string;
  readonly conflicts?: readonly ResourceConflict[] | undefined;
}

export interface OrchestrationSessionResult {
  readonly runId: string;
  readonly state: OrchestrationState;
  readonly transitions: readonly OrchestrationStateTransition[];
  readonly children: Readonly<Record<string, OrchestrationChildResult>>;
}

export interface OrchestrationSession {
  readonly runId: string;
  readonly result: Promise<OrchestrationSessionResult>;
  readonly cancel: (reason?: string) => void;
}

export interface OrchestrationSchedulerHooks {
  readonly beforeDispatch?:
    | ((child: OrchestrationChildRequest, activeChildren: readonly string[]) => void | Promise<void>)
    | undefined;
  readonly afterCompletion?:
    | ((child: OrchestrationChildRequest, result: OrchestrationChildResult) => void | Promise<void>)
    | undefined;
}

export interface OrchestrationDeps extends HarnessDeps {
  readonly clock?: Clock | undefined;
  readonly hooks?: OrchestrationSchedulerHooks | undefined;
}

export interface OrchestrationConfig extends AgentConfig {
  readonly childLimits?: Partial<HarnessLimits> | undefined;
  readonly limits?: Partial<OrchestrationLimits> | undefined;
}

interface ActiveChild {
  readonly child: OrchestrationChildRequest;
  readonly session: AgentSession;
}

interface DispatchDecision {
  readonly action: "dispatch" | "defer" | "block";
  readonly conflicts: readonly ResourceConflict[];
}

function resolveOrchestrationLimits(
  config: OrchestrationConfig,
): OrchestrationLimits {
  return { ...DEFAULT_ORCHESTRATION_LIMITS, ...config.limits };
}

function toConfig(parent: OrchestrationConfig, child: OrchestrationChildRequest): AgentConfig {
  return {
    model: child.config?.model ?? parent.model,
    workingDirectory: child.config?.workingDirectory ?? parent.workingDirectory,
    dryRun: child.config?.dryRun ?? parent.dryRun,
    limits: child.config?.limits ?? parent.childLimits ?? undefined,
  };
}

function resolveRolePolicy(child: OrchestrationChildRequest): RolePolicy {
  return DEFAULT_ROLE_POLICIES[child.plan.role];
}

function deriveClaims(child: OrchestrationChildRequest): readonly ResourceClaim[] {
  const explicit = child.resourceClaims ?? [];
  const plan = resolveTaskPlan(child.task);
  if (plan.targetFile === "<unspecified>") {
    return explicit;
  }
  if (child.plan.authority.canWriteWorkspace || plan.allowsPatch) {
    return [
      {
        kind: "file",
        resourceId: plan.targetFile,
        access: "write",
        policy: "serialize",
      },
      {
        kind: "patch",
        resourceId: plan.targetFile,
        access: "write",
        policy: "serialize",
      },
      ...explicit,
    ];
  }
  return [
    {
      kind: "file",
      resourceId: plan.targetFile,
      access: "read",
      policy: "serialize",
    },
    ...explicit,
  ];
}

function transition(
  transitions: OrchestrationStateTransition[],
  state: OrchestrationState,
  to: OrchestrationState,
  reason: string,
): OrchestrationState {
  transitions.push({ from: state, to, reason });
  return to;
}

function countEvents(
  children: Readonly<Record<string, OrchestrationChildResult>>,
  type: string,
): number {
  let count = 0;
  for (const result of Object.values(children)) {
    const events = result.run?.events ?? [];
    count += events.filter((event) => event.type === type).length;
  }
  return count;
}

function aggregateExceeded(
  children: Readonly<Record<string, OrchestrationChildResult>>,
  limits: OrchestrationLimits,
): string | null {
  if (Object.keys(children).length > limits.maxChildren) {
    return "maxChildren exceeded";
  }
  const failedChildren = Object.values(children).filter((child) => child.state === "failed").length;
  if (failedChildren > limits.maxFailedChildren) {
    return "maxFailedChildren exceeded";
  }
  if (countEvents(children, "model:call:started") > limits.maxModelCalls) {
    return "aggregate maxModelCalls exceeded";
  }
  if (countEvents(children, "tool:call:started") > limits.maxToolCalls) {
    return "aggregate maxToolCalls exceeded";
  }
  if (countEvents(children, "command:executed") > limits.maxCommandExecutions) {
    return "aggregate maxCommandExecutions exceeded";
  }
  return null;
}

function readyChildren(
  plan: OrchestrationPlan,
  requests: ReadonlyMap<string, OrchestrationChildRequest>,
  results: Readonly<Record<string, OrchestrationChildResult>>,
  active: ReadonlyMap<string, ActiveChild>,
): OrchestrationChildRequest[] {
  return plan.children
    .filter((child) => {
      if (results[child.childId] !== undefined || active.has(child.childId)) {
        return false;
      }
      return child.dependsOn.every((dependency) => results[dependency]?.state === "completed");
    })
    .map((child) => requests.get(child.childId))
    .filter((child): child is OrchestrationChildRequest => child !== undefined);
}

function canDispatch(
  mode: OrchestrationExecutionMode,
  child: OrchestrationChildRequest,
  active: ReadonlyMap<string, ActiveChild>,
  limits: OrchestrationLimits,
): boolean {
  if (active.size >= limits.maxConcurrentChildren) {
    return false;
  }
  if (mode === "single" || mode === "sequential") {
    return active.size === 0;
  }
  const policy = resolveRolePolicy(child);
  if (!policy.allowsParallel) {
    return active.size === 0;
  }
  for (const current of active.values()) {
    if (!resolveRolePolicy(current.child).allowsParallel) {
      return false;
    }
  }
  return true;
}

function validateChild(child: OrchestrationChildRequest): string | null {
  const policy = resolveRolePolicy(child);
  if (!child.plan.authority.allowedTaskTypes.includes(child.task.taskType)) {
    return `task type ${child.task.taskType} exceeds child authority`;
  }
  if (!policy.defaultAuthority.allowedTaskTypes.includes(child.task.taskType)) {
    return `task type ${child.task.taskType} violates role policy for ${child.plan.role}`;
  }
  if (child.plan.authority.maxRetryAttempts > policy.maxRetryAttempts) {
    return `maxRetryAttempts exceeds role policy for ${child.plan.role}`;
  }
  return null;
}

function claimsConflict(a: ResourceClaim, b: ResourceClaim): boolean {
  if (a.kind !== b.kind || a.resourceId !== b.resourceId) {
    return false;
  }
  if (a.kind === "tool") {
    return a.access === "exclusive" || b.access === "exclusive";
  }
  return !(a.access === "read" && b.access === "read");
}

function strongestPolicy(
  left: ResourceConflictPolicy,
  right: ResourceConflictPolicy,
): ResourceConflictPolicy {
  const priority: Record<ResourceConflictPolicy, number> = {
    serialize: 0,
    block: 1,
    escalate: 2,
  };
  return priority[left] >= priority[right] ? left : right;
}

function evaluateClaims(
  child: OrchestrationChildRequest,
  active: ReadonlyMap<string, ActiveChild>,
): DispatchDecision {
  const childClaims = deriveClaims(child);
  const conflicts: ResourceConflict[] = [];
  for (const [activeChildId, current] of active.entries()) {
    for (const left of childClaims) {
      for (const right of deriveClaims(current.child)) {
        if (!claimsConflict(left, right)) {
          continue;
        }
        const outcome = strongestPolicy(left.policy, right.policy);
        conflicts.push({
          childId: child.plan.childId,
          conflictingChildId: activeChildId,
          claim: left,
          outcome,
          reason: `${left.kind} claim on ${left.resourceId} conflicts with active child ${activeChildId}`,
        });
      }
    }
  }
  if (conflicts.length === 0) {
    return { action: "dispatch", conflicts };
  }
  const outcome = conflicts.reduce<ResourceConflictPolicy>(
    (current, conflict) => strongestPolicy(current, conflict.outcome),
    "serialize",
  );
  if (outcome === "serialize") {
    return { action: "defer", conflicts };
  }
  return { action: "block", conflicts };
}

function chooseNextCompleted(
  active: ReadonlyMap<string, ActiveChild>,
): Promise<readonly [string, Awaited<AgentSession["result"]>]> {
  return Promise.race(
    [...active.entries()].map(async ([childId, child]) => [childId, await child.session.result] as const),
  );
}

async function waitForNextResolution(
  active: ReadonlyMap<string, ActiveChild>,
  controller: AbortController,
): Promise<readonly [string, Awaited<AgentSession["result"]>] | "aborted"> {
  return Promise.race([
    chooseNextCompleted(active),
    new Promise<"aborted">((resolve) => {
      controller.signal.addEventListener(
        "abort",
        () => {
          for (const child of active.values()) {
            child.session.cancel("parent cancelled");
          }
          resolve("aborted");
        },
        { once: true },
      );
    }),
  ]);
}

async function runOrchestration(
  orchestration: OrchestrationPlan,
  children: readonly OrchestrationChildRequest[],
  config: OrchestrationConfig,
  deps: OrchestrationDeps,
  controller: AbortController,
  runId: string,
): Promise<OrchestrationSessionResult> {
  const requests = new Map(children.map((child) => [child.plan.childId, child] as const));
  const results: Record<string, OrchestrationChildResult> = {};
  const active = new Map<string, ActiveChild>();
  const transitions: OrchestrationStateTransition[] = [];
  const limits = resolveOrchestrationLimits(config);
  const clock = deps.clock;
  const startedAt = clock?.now() ?? Date.now();
  let state: OrchestrationState = transition(transitions, "planning", "ready", "orchestration plan accepted");

  while (true) {
    if ((clock?.now() ?? Date.now()) - startedAt > limits.maxWallTimeMs) {
      state = transition(transitions, state, "failed", "orchestration maxWallTimeMs exceeded");
      for (const child of active.values()) {
        child.session.cancel("parent wall-time exceeded");
      }
      break;
    }
    if (controller.signal.aborted) {
      state = transition(transitions, state, "cancelling", "parent cancellation requested");
      for (const child of active.values()) {
        child.session.cancel("parent cancelled");
      }
      if (active.size === 0) {
        state = transition(transitions, state, "cancelled", "all children cancelled");
        break;
      }
    }

    const ready = readyChildren(orchestration, requests, results, active);
    let dispatchedAny = false;
    for (const child of ready) {
      if (!canDispatch(orchestration.executionMode, child, active, limits)) {
        continue;
      }
      const validation = validateChild(child);
      if (validation !== null) {
        results[child.plan.childId] = {
          childId: child.plan.childId,
          state: "failed",
          attempts: 0,
          run: undefined,
          reason: validation,
        };
        state = transition(transitions, state, "failed", validation);
        break;
      }
      const dispatchDecision = evaluateClaims(child, active);
      if (dispatchDecision.action === "defer") {
        continue;
      }
      if (dispatchDecision.action === "block") {
        results[child.plan.childId] = {
          childId: child.plan.childId,
          state: "blocked",
          attempts: 0,
          run: undefined,
          reason: dispatchDecision.conflicts.map((conflict) => conflict.reason).join("; "),
          conflicts: dispatchDecision.conflicts,
        };
        state = transition(transitions, state, "conflicted", `resource conflict on ${child.plan.childId}`);
        continue;
      }
      await deps.hooks?.beforeDispatch?.(child, [...active.keys()]);
      state = transition(transitions, state, "dispatching", `dispatch ${child.plan.childId}`);
      const session = createSession(child.task, toConfig(config, child), deps);
      active.set(child.plan.childId, { child, session });
      state = transition(transitions, state, "running", `child ${child.plan.childId} running`);
      dispatchedAny = true;
    }

    const aggregateError = aggregateExceeded(results, limits);
    if (aggregateError !== null) {
      state = transition(transitions, state, "failed", aggregateError);
      for (const child of active.values()) {
        child.session.cancel(aggregateError);
      }
      if (active.size === 0) {
        break;
      }
    }

    if (Object.keys(results).length === orchestration.children.length && active.size === 0) {
      if (Object.values(results).some((result) => result.state === "blocked")) {
        state = transition(transitions, state, "blocked", "resource conflicts left one or more children blocked");
        break;
      }
      if (state === "cancelling") {
        state = transition(transitions, state, "cancelled", "all children settled after cancellation");
      } else if (state !== "failed") {
        state = transition(transitions, state, "completed", "all children settled");
      }
      break;
    }

    if (active.size === 0 && !dispatchedAny) {
      const unresolved = orchestration.children
        .filter((child) => results[child.childId] === undefined)
        .map((child) => child.childId);
      state = transition(
        transitions,
        state,
        "blocked",
        `no dispatchable children remain: ${unresolved.join(", ")}`,
      );
      break;
    }

    if (active.size === 0) {
      continue;
    }

    const next = await waitForNextResolution(active, controller);
    if (next === "aborted") {
      continue;
    }
    const [childId, run] = next;
    const current = active.get(childId);
    active.delete(childId);
    const policy = current === undefined ? undefined : resolveRolePolicy(current.child);
    const childState: OrchestrationChildResult["state"] =
      run.outcome === "completed"
        ? "completed"
        : run.outcome === "cancelled"
          ? "cancelled"
          : "failed";
    results[childId] = {
      childId,
      state: childState,
      attempts: 1,
      run,
      reason: `child settled with ${run.outcome}`,
    };
    await deps.hooks?.afterCompletion?.(current?.child ?? requests.get(childId)!, results[childId]!);

    if (childState === "failed" && policy?.escalatesOnFailure === true) {
      state = transition(transitions, state, "failed", `child ${childId} failed`);
      for (const child of active.values()) {
        child.session.cancel(`sibling ${childId} failed`);
      }
    }
  }

  return { runId, state, transitions, children: results };
}

export function createOrchestrationSession(
  orchestration: OrchestrationPlan,
  children: readonly OrchestrationChildRequest[],
  config: OrchestrationConfig,
  deps: OrchestrationDeps,
): OrchestrationSession {
  const runId = (deps.idSource ?? defaultIdSource).newRunId();
  const controller = new AbortController();
  return {
    runId,
    result: runOrchestration(orchestration, children, config, deps, controller, runId),
    cancel: (reason?: string): void => {
      controller.abort(reason);
    },
  };
}
