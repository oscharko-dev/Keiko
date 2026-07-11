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
  ) => Promise<{ readonly status: "completed" | "failed" }>;
}

export interface CodingToolGovernedPorts {
  readonly editorChangeset: GovernedCodingToolPort<"edit">;
  readonly commandRunner: GovernedCodingToolPort<"command">;
  readonly verificationRunner: GovernedCodingToolPort<"verification">;
  readonly gitAuthority: GovernedCodingToolPort<"git">;
  readonly deliveryAuthority: GovernedCodingToolPort<"delivery">;
  readonly connectorAuthority: GovernedCodingToolPort<"connector">;
  readonly egressAuthority: GovernedCodingToolPort<"egress">;
}

export function createCodingToolGovernedDelegate(
  ports: CodingToolGovernedPorts,
): CodingToolDelegatePort {
  return {
    execute: async (request, signal, mutationGuard): Promise<unknown> => {
      if (signal?.aborted === true) return { outcome: "failed" };
      if (!mutationGuard.check()) return { outcome: "failed" };
      const result = await dispatch(ports, request, signal, mutationGuard);
      return { outcome: result.status };
    },
  };
}

function dispatch(
  ports: CodingToolGovernedPorts,
  request: CodingToolActionRequest,
  signal: AbortSignal | undefined,
  mutationGuard: CodingToolMutationGuard,
): Promise<{ readonly status: "completed" | "failed" }> {
  switch (request.action) {
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
  }
}
