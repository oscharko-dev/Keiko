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
  SkillCategory,
  SkillDiscoveryResultV1,
  SkillUnavailableReason,
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
import {
  OPENCODE_SKILL_PROFILE,
  type SkillCatalog,
  type SkillCatalogEntry,
} from "./skillCatalog.js";
import {
  approvedSkillProjection,
  invocableSkillDiscovery,
  skillReadiness,
  unavailableSkillCounts,
  type SkillReadinessFacts,
  type SkillStaticFacts,
} from "./skillDiscovery.js";
import type { WorkspaceRootAccess } from "../task-workspace/workspace-root-access.js";
import type { ServerLogSink } from "../observability/server-log.js";
import {
  createSkillInvocationPort,
  type SkillReevaluationDecision,
} from "./skillInvocationPort.js";

/** The skill categories this port has a handler for; a skill of any other category cannot run. */
export const SKILL_HANDLER_CATEGORIES: ReadonlySet<SkillCategory> = new Set([
  "repository-analysis",
]);

/** What a production run knows of a skill before authority and budget: its profile and handlers. */
export const PRODUCTION_SKILL_STATIC_FACTS: SkillStaticFacts = Object.freeze({
  profile: OPENCODE_SKILL_PROFILE,
  handlerMounted: (category: SkillCategory): boolean => SKILL_HANDLER_CATEGORIES.has(category),
});

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
  readonly activityLog: ServerLogSink;
}

export interface ProductionAuxiliaryPorts {
  readonly skillAuthority: GovernedCodingToolPort<"skill">;
  readonly skillDiscovery: GovernedCodingToolPort<"skill-discover">;
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
  const discovery: SkillDiscoveryBinding = { catalogDigest: undefined };
  return {
    skillAuthority: skillPort(authorizedInput, discovery),
    skillDiscovery: skillDiscoveryPort(authorizedInput, discovery),
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

// The digest of the catalog as this run's model last discovered it. A skill invocation after the
// catalog changed is refused until the model discovers again (#3417), so the listing the model acts
// on is always the one the catalog holds now. Absent until the first discovery: an explicit
// `$skill` request from the task needs none.
interface SkillDiscoveryBinding {
  catalogDigest: CodeTaskSha256Digest | undefined;
}

// A skill that is not ready is refused with the closed reason its readiness names. A missing handler
// keeps the reason code this port has always used, an exhausted budget the one its charge uses.
const READINESS_DECISIONS: Readonly<Record<SkillUnavailableReason, SkillReevaluationDecision>> = {
  disabled: { decision: "denied", reasonCode: "skill-disabled" },
  incompatible: { decision: "denied", reasonCode: "skill-incompatible" },
  "handler-unavailable": { decision: "unavailable", reasonCode: "skill-handler-unavailable" },
  "authority-denied": { decision: "denied", reasonCode: "skill-authority-denied" },
  "budget-exhausted": { decision: "denied", reasonCode: "authority-budget-exceeded" },
};

// The live facts of one readiness decision: the exact managed workspace with a parent authority
// that still allows the workspace read, and budget for the one delegated read a skill performs.
function liveSkillFacts(
  input: ProductionAuxiliaryPortInput,
  guard: CodingToolMutationGuard,
): SkillReadinessFacts {
  return {
    ...PRODUCTION_SKILL_STATIC_FACTS,
    authorityAllowsRead: (): boolean =>
      hasExactWorkspaceAccess(input) &&
      guard.resolveParentAuthority?.()?.actionClasses.includes("workspace-read") === true,
    delegatedReadFits: (): boolean => guard.canChargeDelegatedRead?.() === true,
  };
}

function skillPort(
  input: ProductionAuxiliaryPortInput,
  binding: SkillDiscoveryBinding,
): GovernedCodingToolPort<"skill"> {
  return {
    execute: async (request, signal, guard): Promise<AuxiliaryPortResult> => {
      const invocation = input.explicitSkills.consume(request.skillId) ? "explicit" : "implicit";
      const decision = await executeApprovedSkill(
        input,
        request,
        invocation,
        signal,
        guard,
        binding,
      );
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

interface SkillDiscoveryPortResult {
  readonly status: "completed";
  readonly skills: SkillDiscoveryResultV1;
}

// Discovery lists the ready skills the model may invoke now, binds the run to the catalog digest it
// listed, and records one body-free line: counts, the digest, the revision and the duration.
function skillDiscoveryPort(
  input: ProductionAuxiliaryPortInput,
  binding: SkillDiscoveryBinding,
): GovernedCodingToolPort<"skill-discover"> {
  return {
    execute: (_request, _signal, guard): Promise<SkillDiscoveryPortResult> => {
      const startedAt = Date.now();
      const projection = approvedSkillProjection(input.catalog, liveSkillFacts(input, guard));
      const skills = invocableSkillDiscovery(
        projection,
        (skillId) =>
          input.catalog.isImplicitAllowed(skillId) || input.explicitSkills.isPending(skillId),
      );
      binding.catalogDigest = skills.catalogDigest;
      input.activityLog.write({
        category: "process",
        op: "coding-runtime.skill-discovery",
        correlationId: input.runId,
        durationMs: Date.now() - startedAt,
        extra: {
          runId: input.runId,
          catalogRevision: input.catalog.revision(),
          catalogDigest: skills.catalogDigest,
          approvedCount: projection.skills.length,
          listedCount: skills.skills.length,
          unavailableByReason: unavailableSkillCounts(projection),
        },
      });
      return Promise.resolve({ status: "completed", skills });
    },
  };
}

type SkillAdmission =
  | { readonly admitted: true; readonly entry: SkillCatalogEntry }
  | { readonly admitted: false; readonly decision: SkillReevaluationDecision };

// Every check that must hold before a skill's effect, in order: approval, a discovery that is still
// current, implicit permission, and the readiness decision discovery itself applies.
function admitSkill(
  input: ProductionAuxiliaryPortInput,
  request: CodingToolActionOf<"skill">,
  invocation: "explicit" | "implicit",
  guard: CodingToolMutationGuard,
  binding: SkillDiscoveryBinding,
): SkillAdmission {
  const entry = input.catalog.get(request.skillId);
  if (entry === undefined) return refusedSkill("skill-not-approved");
  if (binding.catalogDigest !== undefined && binding.catalogDigest !== input.catalog.digest()) {
    return refusedSkill("skill-discovery-stale");
  }
  if (invocation === "implicit" && !entry.implicitAllowed) {
    return refusedSkill("implicit-not-permitted");
  }
  const readiness = skillReadiness(entry, liveSkillFacts(input, guard));
  return readiness.state === "ready"
    ? { admitted: true, entry }
    : { admitted: false, decision: READINESS_DECISIONS[readiness.reason] };
}

function refusedSkill(reasonCode: string): SkillAdmission {
  return { admitted: false, decision: { decision: "denied", reasonCode } };
}

async function executeApprovedSkill(
  input: ProductionAuxiliaryPortInput,
  request: CodingToolActionOf<"skill">,
  invocation: "explicit" | "implicit",
  signal: AbortSignal | undefined,
  guard: CodingToolMutationGuard,
  binding: SkillDiscoveryBinding,
): Promise<SkillReevaluationDecision> {
  const admission = admitSkill(input, request, invocation, guard, binding);
  if (!admission.admitted) return admission.decision;
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
  // A catalog change while the read ran leaves its result bound to a definition no longer approved.
  if (input.catalog.get(request.skillId) !== admission.entry) {
    return { decision: "denied", reasonCode: "skill-changed" };
  }
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
        activityLog: input.activityLog,
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
