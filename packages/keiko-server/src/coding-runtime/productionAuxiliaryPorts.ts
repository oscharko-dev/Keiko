import { createHash } from "node:crypto";

import type {
  AuxiliaryCapabilityOutcomeV1,
  AuxiliaryCapabilityRequestV1,
  AuxiliaryCapabilityTarget,
  AuxiliaryResearchScopeV1,
  CodeTaskChildRunId,
  CodeTaskGrantId,
  CodeTaskIdempotencyKey,
  CodeTaskRunId,
  CodeTaskSha256Digest,
  CodeTaskTaskId,
  CodeTaskWorkspaceId,
  CodingWorkbenchRuntimeEvent,
} from "@oscharko-dev/keiko-contracts";
import { CODE_TASK_AUXILIARY_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts/runtime/code-task-auxiliary";
import type { ModelPort } from "@oscharko-dev/keiko-harness";

import type { CodingToolMutationGuard } from "./codingToolFacadePorts.js";
import type { CodingToolActionOf, GovernedCodingToolPort } from "./codingToolGovernedDelegate.js";
import type { ExplicitSkillInvocationTracker } from "./explicitSkillInvocation.js";
import { createProductionReadOnlyChildRunner } from "./productionReadOnlyChildRunner.js";
import {
  createReadOnlyChildOrchestrator,
  type ReadOnlyChildStopReason,
} from "./readOnlyChildOrchestrator.js";
import type { ResearchGrantRegistry, ResolvedResearchGrant } from "./researchGrantRegistry.js";
import type { CodingRuntimeAuthorityService } from "./runtimeAuthorityService.js";
import type { SecureWorkspaceTextReadPort } from "./secureWorkspaceTextRead.js";
import type { SkillCatalog } from "./skillCatalog.js";
import type { WorkspaceRootAccess } from "../task-workspace/workspace-root-access.js";
import {
  createSkillInvocationPort,
  type SkillReevaluationDecision,
} from "./skillInvocationPort.js";

export interface ProductionAuxiliaryPortInput {
  readonly authority: Pick<CodingRuntimeAuthorityService, "state">;
  readonly reservePromptTokens: (promptTokens: number) => boolean;
  readonly taskId: string;
  readonly runId: string;
  readonly workspaceId: () => string;
  readonly workspaceRoot: string;
  readonly resolveWorkspaceRootAccess: () => WorkspaceRootAccess | undefined;
  readonly modelId: string;
  readonly authorityExpiresAt: string;
  readonly catalog: SkillCatalog;
  readonly explicitSkills: ExplicitSkillInvocationTracker;
  readonly modelPortFactory: (modelId: string) => ModelPort | undefined;
  readonly secureWorkspaceTextRead: SecureWorkspaceTextReadPort;
  readonly researchGrantRegistry?: ResearchGrantRegistry | undefined;
  readonly emit: (event: CodingWorkbenchRuntimeEvent) => void;
}

export interface ProductionAuxiliaryPorts {
  readonly skillAuthority: GovernedCodingToolPort<"skill">;
  /** Absent when no coding-safe provider model is configured; the delegate then fails closed. */
  readonly childAgentAuthority?: GovernedCodingToolPort<"child-agent"> | undefined;
}

export function createProductionAuxiliaryPorts(
  input: ProductionAuxiliaryPortInput,
): ProductionAuxiliaryPorts {
  const authorizedInput = {
    ...input,
    secureWorkspaceTextRead: workspaceAuthorityCheckedRead(input),
  };
  const runner = createProductionReadOnlyChildRunner({
    modelPortFactory: input.modelPortFactory,
    secureWorkspaceTextRead: authorizedInput.secureWorkspaceTextRead,
    reservePromptTokens: input.reservePromptTokens,
  });
  return {
    skillAuthority: skillPort(authorizedInput),
    // A child agent needs a resolvable PROVIDER model id. When the deployment has no coding-safe
    // model configured, the port is not mounted at all and the governed delegate answers "failed"
    // — a child must never be launched against a placeholder or a launch-profile identifier the
    // gateway cannot resolve.
    ...(input.modelId === "" ? {} : { childAgentAuthority: childPort(authorizedInput, runner) }),
  };
}

function workspaceAuthorityCheckedRead(
  input: ProductionAuxiliaryPortInput,
): SecureWorkspaceTextReadPort {
  return {
    readText: async (request): ReturnType<SecureWorkspaceTextReadPort["readText"]> => {
      if (!hasExactWorkspaceAccess(input)) return { ok: false, reason: "denied" };
      const result = await input.secureWorkspaceTextRead.readText(request);
      return hasExactWorkspaceAccess(input) ? result : { ok: false, reason: "denied" };
    },
  };
}

function hasExactWorkspaceAccess(input: ProductionAuxiliaryPortInput): boolean {
  try {
    const access = input.resolveWorkspaceRootAccess();
    return access?.kind === "managed-task" && access.canonicalRoot === input.workspaceRoot;
  } catch {
    return false;
  }
}

function skillPort(input: ProductionAuxiliaryPortInput): GovernedCodingToolPort<"skill"> {
  return {
    execute: async (request, signal, guard): Promise<AuxiliaryPortResult> => {
      const invocation = input.explicitSkills.consume(request.skillId) ? "explicit" : "implicit";
      const decision = await executeApprovedSkill(input, request, invocation, signal, guard);
      const port = createSkillInvocationPort({
        catalog: input.catalog,
        reevaluator: { reevaluate: () => decision },
        emitEvent: input.emit,
        now: () => new Date(),
      });
      const outcome = port.invoke(skillRequest(input, request, invocation));
      return { status: "completed", auxiliary: outcome };
    },
  };
}

async function executeApprovedSkill(
  input: ProductionAuxiliaryPortInput,
  request: CodingToolActionOf<"skill">,
  invocation: "explicit" | "implicit",
  signal: AbortSignal | undefined,
  guard: CodingToolMutationGuard,
): Promise<SkillReevaluationDecision> {
  const entry = input.catalog.get(request.skillId);
  if (entry === undefined) return { decision: "denied", reasonCode: "skill-not-approved" };
  if (invocation === "implicit" && !entry.implicitAllowed) {
    return { decision: "denied", reasonCode: "implicit-not-permitted" };
  }
  if (entry.category !== "repository-analysis") {
    return { decision: "unavailable", reasonCode: "skill-handler-unavailable" };
  }
  if (
    guard.chargeDelegatedRead?.(
      `${request.actionId}:skill-read`,
      `${request.idempotencyKey}:skill-read`,
    ) !== true
  ) {
    return { decision: "denied", reasonCode: "authority-budget-exceeded" };
  }
  const read = await input.secureWorkspaceTextRead.readText({
    relativePath: "package.json",
    ...(signal === undefined ? {} : { signal }),
  });
  if (!read.ok) return { decision: "unavailable", reasonCode: "skill-source-unavailable" };
  return { decision: "allowed", resultDigest: packageScriptDigest(read.text) };
}

function packageScriptDigest(text: string): CodeTaskSha256Digest {
  let names: readonly string[] = [];
  try {
    const parsed: unknown = JSON.parse(text);
    // Codepoint order, explicitly. The digest must be identical on every host, so the comparator
    // must not depend on the environment: `localeCompare()` without a fixed locale sorts by the
    // HOST locale and would hash the same package.json differently on a differently-configured
    // machine — the very nondeterminism this digest exists to rule out.
    if (isRecord(parsed) && isRecord(parsed.scripts)) {
      names = Object.keys(parsed.scripts).sort(byCodepoint);
    }
  } catch {
    names = [];
  }
  return createHash("sha256")
    .update(JSON.stringify(names), "utf8")
    .digest("hex") as CodeTaskSha256Digest;
}

function byCodepoint(left: string, right: string): number {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface AuxiliaryPortResult {
  readonly status: "completed";
  readonly auxiliary: AuxiliaryCapabilityOutcomeV1;
}

function skillRequest(
  input: ProductionAuxiliaryPortInput,
  request: CodingToolActionOf<"skill">,
  invocation: "explicit" | "implicit",
): AuxiliaryCapabilityRequestV1 {
  return {
    ...target(input, request.idempotencyKey),
    schemaVersion: CODE_TASK_AUXILIARY_SCHEMA_VERSION,
    capability: "skill",
    skillId: request.skillId,
    invocation,
  } as AuxiliaryCapabilityRequestV1;
}

function childPort(
  input: ProductionAuxiliaryPortInput,
  runner: ReturnType<typeof createProductionReadOnlyChildRunner>,
): GovernedCodingToolPort<"child-agent"> {
  let eventSequence = 0;
  return {
    execute: async (request, signal, guard): Promise<AuxiliaryPortResult> => {
      const parentAuthority = guard.resolveParentAuthority?.();
      if (parentAuthority === undefined) {
        return { status: "completed", auxiliary: stoppedChild("authority-revoked") };
      }
      const childRunId = childId(request.actionId);
      const research = activeResearchScope(input);
      let chargeSequence = 0;
      const orchestrator = createReadOnlyChildOrchestrator({
        runner,
        charger: {
          chargeParentToolCall: (): boolean => {
            chargeSequence += 1;
            return chargeChildCall(guard, childRunId, chargeSequence);
          },
        },
        cancellation: { stopReason: () => stopReason(guard, signal) },
        emit: input.emit,
        clock: { now: () => Date.now() },
        newEventId: (): string => {
          eventSequence += 1;
          return `event-child-${String(eventSequence)}`;
        },
      });
      const outcome = await orchestrator.handleChildRequest(
        childRequest(input, request, childRunId),
        {
          parentAuthority,
          objective: request.objective,
          modelId: input.modelId,
          workspaceRoot: input.workspaceRoot,
          ...(research === undefined ? {} : { research }),
          deadlineMs: Math.min(Date.parse(input.authorityExpiresAt), Date.now() + 120_000),
          signal: signal ?? new AbortController().signal,
        },
      );
      return { status: "completed", auxiliary: outcome };
    },
  };
}

function childRequest(
  input: ProductionAuxiliaryPortInput,
  request: CodingToolActionOf<"child-agent">,
  childRunId: CodeTaskChildRunId,
): AuxiliaryCapabilityRequestV1 {
  return {
    ...target(input, request.idempotencyKey),
    schemaVersion: CODE_TASK_AUXILIARY_SCHEMA_VERSION,
    capability: "child-agent",
    childRunId,
    maxToolCalls: request.maxToolCalls,
  };
}

function target(
  input: ProductionAuxiliaryPortInput,
  idempotencyKey: string,
): AuxiliaryCapabilityTarget {
  return {
    taskId: input.taskId as CodeTaskTaskId,
    runId: input.runId as CodeTaskRunId,
    workspaceId: input.workspaceId() as CodeTaskWorkspaceId,
    stateRevision: input.authority.state().revision,
    idempotencyKey: idempotencyKey as CodeTaskIdempotencyKey,
  };
}

function childId(actionId: string): CodeTaskChildRunId {
  const digest = createHash("sha256").update(actionId, "utf8").digest("base64url").slice(0, 32);
  return `chr_${digest}` as CodeTaskChildRunId;
}

function chargeChildCall(
  guard: CodingToolMutationGuard,
  childRunId: CodeTaskChildRunId,
  sequence: number,
): boolean {
  return (
    guard.chargeDelegatedRead?.(
      `${childRunId}:read:${String(sequence)}`,
      `${childRunId}:read:${String(sequence)}`,
    ) === true
  );
}

function stopReason(
  guard: CodingToolMutationGuard,
  signal: AbortSignal | undefined,
): ReadOnlyChildStopReason | undefined {
  if (signal?.aborted === true) return "parent-stopped";
  return guard.check() ? undefined : "authority-revoked";
}

function activeResearchScope(
  input: ProductionAuxiliaryPortInput,
): AuxiliaryResearchScopeV1 | undefined {
  const grant = input.researchGrantRegistry?.activeGrants(input.runId, Date.now())[0];
  return grant === undefined ? undefined : researchScope(grant);
}

function researchScope(grant: ResolvedResearchGrant): AuxiliaryResearchScopeV1 {
  return {
    grantId: grant.grantId as CodeTaskGrantId,
    domains: grant.domains,
    expiresAt: new Date(grant.expiresAtMs).toISOString(),
    queryTextDigest:
      grant.queryTextDigest === undefined
        ? { outcome: "absent" }
        : { outcome: "known", value: grant.queryTextDigest },
  };
}

function stoppedChild(reasonCode: string): AuxiliaryCapabilityOutcomeV1 {
  return {
    schemaVersion: CODE_TASK_AUXILIARY_SCHEMA_VERSION,
    status: "stopped",
    capability: "child-agent",
    reasonCode,
  };
}
