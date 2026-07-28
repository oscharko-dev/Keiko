import type { AuxiliaryCapabilityOutcomeV1 } from "@oscharko-dev/keiko-contracts";

import type { CodingToolDelegatePort, CodingToolMutationGuard } from "./codingToolFacadePorts.js";
import type {
  CodingToolActionRequest,
  CodingToolEgressReadResult,
  CodingToolReadResult,
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
type GovernedCodingToolResult =
  | {
      readonly status: "completed";
      readonly read?: GovernedCodingToolRead | undefined;
      readonly auxiliary?: AuxiliaryCapabilityOutcomeV1 | undefined;
    }
  // `reasonCode` is a closed-vocabulary marker (see codingToolReadEditPorts.ts's `EditOutcome`),
  // populated only by the editor-changeset port; every other port's failure carries none.
  | { readonly status: "failed"; readonly reasonCode?: string | undefined };

export interface CodingToolGovernedPorts {
  readonly repositoryRead: GovernedCodingToolPort<"read">;
  readonly repositoryDiscover: GovernedCodingToolPort<"discover">;
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
): CodingToolDelegatePort {
  return {
    execute: async (request, signal, mutationGuard): Promise<unknown> => {
      if (signal?.aborted === true) return { outcome: "failed" };
      if (!mutationGuard.check()) return { outcome: "failed" };
      const result = await dispatch(ports, request, signal, mutationGuard);
      return governedOutcome(request.action, result);
    },
  };
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
  if (result.status === "failed" && result.reasonCode !== undefined) {
    return { outcome: "failed", reasonCode: result.reasonCode };
  }
  if (result.status !== "completed") return { outcome: result.status };
  if (READ_BEARING_ACTIONS.has(action) && result.read !== undefined) {
    return { outcome: "completed", read: result.read };
  }
  if (AUXILIARY_BEARING_ACTIONS.has(action) && result.auxiliary !== undefined) {
    return { outcome: "completed", auxiliary: result.auxiliary };
  }
  return { outcome: result.status };
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
