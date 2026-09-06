import type { ServerLogSink } from "../observability/server-log.js";
import { processServerLogSink } from "../process-log-sink.js";
import { UNKNOWN_CORRELATION_ID } from "../correlation.js";
import type { CodingRuntimeDeliveryResult } from "@oscharko-dev/keiko-contracts/runtime/coding-runtime-delivery";
import type { CodingRuntimeCiResult } from "@oscharko-dev/keiko-contracts/runtime/coding-runtime-ci";
import type { CodingRepositoryResult } from "@oscharko-dev/keiko-contracts/runtime/coding-repository-search";
import type {
  AuxiliaryCapabilityOutcomeV1,
  VerifiedCommitResult,
  CodingRuntimeGitResult,
} from "@oscharko-dev/keiko-contracts";

import type { CodingToolDelegatePort, CodingToolMutationGuard } from "./codingToolFacadePorts.js";
import type {
  CiRepairExecutionBudget,
  CiRepairExecutionLease,
} from "./codingRuntimeCiRepairController.js";
import type {
  CodingToolActionRequest,
  CodingToolEgressReadResult,
  CodingToolReadResult,
  CodingToolVerificationFailure,
  CodingToolVerificationResult,
} from "./codingToolIpc.js";

export type CodingToolActionOf<Kind extends CodingToolActionRequest["action"]> = Extract<
  CodingToolActionRequest,
  { readonly action: Kind }
>;

export interface GovernedCodingToolPort<Kind extends CodingToolActionRequest["action"]> {
  readonly execute: (
    request: CodingToolActionOf<Kind>,
    signal: AbortSignal | undefined,
    mutationGuard: CodingToolMutationGuard,
  ) => Promise<GovernedCodingToolResult>;
}

type GovernedCodingToolRead = CodingToolReadResult | CodingToolEgressReadResult;
export type GovernedCodingToolResult =
  | {
      readonly status: "completed";
      readonly read?: GovernedCodingToolRead | undefined;
      readonly auxiliary?: AuxiliaryCapabilityOutcomeV1 | undefined;
      readonly draftDelivery?: CodingRuntimeDeliveryResult;
      readonly verifiedCommit?: VerifiedCommitResult;
      readonly git?: CodingRuntimeGitResult;
      readonly ci?: CodingRuntimeCiResult;
      readonly search?: CodingRepositoryResult;
      readonly verification?: CodingToolVerificationResult;
    }
  // `reasonCode` is a closed-vocabulary marker. The facade forwards only its own allowlisted,
  // body-free codes and collapses every unrecognized value to a bare failed outcome.
  | {
      readonly status: "failed";
      readonly reasonCode?: string | undefined;
      readonly verificationFailure?: CodingToolVerificationFailure | undefined;
    };

export interface CodingToolGovernedPorts {
  readonly repositoryRead: GovernedCodingToolPort<"read">;
  readonly repositoryDiscover: GovernedCodingToolPort<"discover">;
  readonly repositorySearch: GovernedCodingToolPort<"search">;
  readonly editorChangeset: GovernedCodingToolPort<"edit">;
  readonly commandRunner: GovernedCodingToolPort<"command">;
  readonly verificationRunner: GovernedCodingToolPort<"verification">;
  readonly gitAuthority: GovernedCodingToolPort<"git">;
  readonly deliveryAuthority: GovernedCodingToolPort<"delivery">;
  readonly connectorAuthority: GovernedCodingToolPort<"connector">;
  readonly egressAuthority: GovernedCodingToolPort<"egress">;
  readonly skillAuthority?: GovernedCodingToolPort<"skill"> | undefined;
  readonly childAgentAuthority?: GovernedCodingToolPort<"child-agent"> | undefined;
}

export function createCodingToolGovernedDelegate(
  ports: CodingToolGovernedPorts,
  budget?: CiRepairExecutionBudget,
  activityLog: ServerLogSink = processServerLogSink(),
): CodingToolDelegatePort {
  return {
    execute: async (request, signal, mutationGuard): Promise<unknown> => {
      if (signal?.aborted === true) return { outcome: "failed" };
      if (!mutationGuard.check()) return { outcome: "failed" };
      const lease = budget?.admitTool(request);
      if (budget !== undefined && lease === undefined)
        return { outcome: "failed", reasonCode: "ci-repair-budget-blocked" };
      const guard = withRepairLease(mutationGuard, lease, budget);
      let result: GovernedCodingToolResult | undefined;
      try {
        result = await dispatch(ports, request, signal, guard);
        if (!completionLive(result, guard, signal)) {
          return discardedResult(activityLog, request, guard);
        }
        return governedOutcome(request.action, result);
      } finally {
        lease?.settle(result);
      }
    },
  };
}

function discardedResult(
  activityLog: ServerLogSink,
  request: CodingToolActionRequest,
  guard: CodingToolMutationGuard,
): { readonly outcome: "failed" } {
  activityLog.write({
    category: "process",
    op: "coding-runtime.tool-result",
    correlationId: guard.binding?.runId ?? UNKNOWN_CORRELATION_ID,
    extra: { actionKind: request.action, state: "discarded", reason: "authority-denied" },
  });
  return { outcome: "failed" };
}

function withRepairLease(
  guard: CodingToolMutationGuard,
  lease: CiRepairExecutionLease | undefined,
  budget: CiRepairExecutionBudget | undefined,
): CodingToolMutationGuard {
  return lease === undefined
    ? guard
    : {
        ...guard,
        check: (): boolean => guard.check() && lease.check(),
        chargeDelegatedRead: (delegationId, idempotencyKey): boolean =>
          guard.chargeDelegatedRead?.(delegationId, idempotencyKey) === true &&
          budget?.chargeDelegatedRead?.(delegationId, idempotencyKey) === true,
      };
}
function completionLive(
  result: GovernedCodingToolResult,
  guard: CodingToolMutationGuard,
  signal: AbortSignal | undefined,
): boolean {
  return result.status !== "completed" || (signal?.aborted !== true && guard.check());
}

// Repository reads AND research fetches (#2387) carry their governed payload back; skills and
// read-only child agents carry their auxiliary outcome. Every other action, and every non-completed
// result, returns the bare outcome only — a payload never rides out on a status the port did not
// complete.
const READ_BEARING_ACTIONS: ReadonlySet<CodingToolActionRequest["action"]> = new Set([
  "read",
  "discover",
  "egress",
]);
const AUXILIARY_BEARING_ACTIONS: ReadonlySet<CodingToolActionRequest["action"]> = new Set([
  "skill",
  "child-agent",
]);

function governedOutcome(
  action: CodingToolActionRequest["action"],
  result: GovernedCodingToolResult,
): unknown {
  if (result.status === "failed") return governedFailureOutcome(action, result);
  const domain = gitOutcome(action, result);
  if (domain !== undefined) return domain;
  if (READ_BEARING_ACTIONS.has(action) && result.read !== undefined) {
    return { outcome: "completed", read: result.read };
  }
  if (AUXILIARY_BEARING_ACTIONS.has(action) && result.auxiliary !== undefined) {
    return { outcome: "completed", auxiliary: result.auxiliary };
  }
  return { outcome: "completed" };
}

function governedFailureOutcome(
  action: CodingToolActionRequest["action"],
  result: Extract<GovernedCodingToolResult, { readonly status: "failed" }>,
): unknown {
  if (result.reasonCode === undefined) return { outcome: "failed" };
  return action === "verification" && result.verificationFailure !== undefined
    ? {
        outcome: "failed",
        reasonCode: result.reasonCode,
        verificationFailure: result.verificationFailure,
      }
    : { outcome: "failed", reasonCode: result.reasonCode };
}

function gitOutcome(
  action: CodingToolActionRequest["action"],
  result: Extract<GovernedCodingToolResult, { readonly status: "completed" }>,
): unknown {
  return (
    deliveryOutcome(action, result) ??
    searchOutcome(action, result) ??
    verificationOutcome(action, result)
  );
}

function verificationOutcome(
  action: CodingToolActionRequest["action"],
  result: Extract<GovernedCodingToolResult, { readonly status: "completed" }>,
): unknown {
  return action === "verification" && result.verification !== undefined
    ? { outcome: "completed", verification: result.verification }
    : undefined;
}

function deliveryOutcome(
  action: CodingToolActionRequest["action"],
  result: Extract<GovernedCodingToolResult, { readonly status: "completed" }>,
): unknown {
  if (action === "git" && result.ci !== undefined) return { outcome: "completed", ci: result.ci };
  if (action === "git" && result.git !== undefined)
    return { outcome: "completed", git: result.git };
  if (action === "delivery" && result.draftDelivery !== undefined)
    return { outcome: "completed", draftDelivery: result.draftDelivery };
  if (action === "delivery" && result.verifiedCommit !== undefined)
    return { outcome: "completed", verifiedCommit: result.verifiedCommit };
  return undefined;
}

function searchOutcome(
  action: CodingToolActionRequest["action"],
  result: Extract<GovernedCodingToolResult, { readonly status: "completed" }>,
): unknown {
  return action === "search" && result.search !== undefined
    ? { outcome: "completed", search: result.search }
    : undefined;
}

// One exhaustive line per governed action class: the switch IS the routing table and the compiler
// proves it total. A lookup object would need an `as never` cast to keep the per-action request
// types, trading a proven narrowing for an unchecked one.
// eslint-disable-next-line complexity -- exhaustive port routing table, see above
function dispatch(
  ports: CodingToolGovernedPorts,
  request: CodingToolActionRequest,
  signal: AbortSignal | undefined,
  mutationGuard: CodingToolMutationGuard,
): Promise<GovernedCodingToolResult> {
  switch (request.action) {
    case "read":
      return ports.repositoryRead.execute(request, signal, mutationGuard);
    case "discover":
      return ports.repositoryDiscover.execute(request, signal, mutationGuard);
    case "search":
      return ports.repositorySearch.execute(request, signal, mutationGuard);
    case "edit":
      return ports.editorChangeset.execute(request, signal, mutationGuard);
    case "command":
      return ports.commandRunner.execute(request, signal, mutationGuard);
    case "verification":
      return ports.verificationRunner.execute(request, signal, mutationGuard);
    case "git":
      return ports.gitAuthority.execute(request, signal, mutationGuard);
    case "delivery":
      return ports.deliveryAuthority.execute(request, signal, mutationGuard);
    case "connector":
      return ports.connectorAuthority.execute(request, signal, mutationGuard);
    case "egress":
      return ports.egressAuthority.execute(request, signal, mutationGuard);
    case "skill":
      return ports.skillAuthority?.execute(request, signal, mutationGuard) ?? failed();
    case "child-agent":
      return ports.childAgentAuthority?.execute(request, signal, mutationGuard) ?? failed();
  }
}

function failed(): Promise<GovernedCodingToolResult> {
  return Promise.resolve({ status: "failed" });
}
