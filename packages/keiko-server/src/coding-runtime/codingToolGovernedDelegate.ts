import type { AuxiliaryCapabilityOutcomeV1 } from "@oscharko-dev/keiko-contracts";

import type { CodingToolDelegatePort, CodingToolMutationGuard } from "./codingToolFacadePorts.js";
import type { CodingToolActionRequest } from "./codingToolIpc.js";

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

interface GovernedCodingToolRead {
  readonly text: string;
  readonly byteCount: number;
  readonly digest: string;
}
type GovernedCodingToolResult =
  | {
      readonly status: "completed";
      readonly read?: GovernedCodingToolRead | undefined;
      readonly auxiliary?: AuxiliaryCapabilityOutcomeV1 | undefined;
    }
  | { readonly status: "failed" };

export interface CodingToolGovernedPorts {
  readonly repositoryRead: GovernedCodingToolPort<"read">;
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
      // Repository reads AND research fetches (#2387) carry their governed payload back; every
      // other action returns only the bare outcome.
      return (request.action === "read" || request.action === "egress") &&
        result.status === "completed" &&
        result.read !== undefined
        ? { outcome: "completed", read: result.read }
        : (request.action === "skill" || request.action === "child-agent") &&
            result.status === "completed" &&
            result.auxiliary !== undefined
          ? { outcome: "completed", auxiliary: result.auxiliary }
          : { outcome: result.status };
    },
  };
}

function dispatch(
  ports: CodingToolGovernedPorts,
  request: CodingToolActionRequest,
  signal: AbortSignal | undefined,
  mutationGuard: CodingToolMutationGuard,
): Promise<GovernedCodingToolResult> {
  switch (request.action) {
    case "read":
      return ports.repositoryRead.execute(request, signal, mutationGuard);
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
