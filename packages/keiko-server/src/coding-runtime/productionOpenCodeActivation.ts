import {
  createFetchEditorAgentHttpTransport,
  EditorAgentHttpClient,
} from "@oscharko-dev/keiko-tools";

import type { OpenCodeGatewayReadinessRegistry } from "../coding-sidecar-gateway.js";
import type { CodingRuntimeEvidenceAggregator } from "./codingRuntimeEvidenceAggregator.js";
import { createProductionOpenCodeBackend } from "./productionOpenCodeBackend.js";
import type { ProductionCodingRuntimeResolverInput } from "./productionCodingRuntimeResolver.js";
import { discoverQualifiedPortableOpenCode } from "./productionPortableCodingRuntime.js";
import type { SecureWorkspaceTextReadPort } from "./secureWorkspaceTextRead.js";

type ProductionOpenCodePorts = Pick<
  ProductionCodingRuntimeResolverInput,
  "backend" | "editorAgentClient" | "secureWorkspaceTextRead"
>;

export interface ProductionOpenCodeActivationInput {
  readonly env: NodeJS.ProcessEnv;
  readonly runtimeStateDir: string;
  readonly runtimeEvidence: Pick<CodingRuntimeEvidenceAggregator, "observe">;
  readonly gatewayReadiness: Pick<
    OpenCodeGatewayReadinessRegistry,
    "waitForObservedRequest" | "clear"
  >;
  /**
   * Point-of-use verified secure read port for the packaged install. The packaged platform
   * inspection (signature and immutable-tree proof) is a separately owned deliverable; until a
   * deployment supplies this port, activation fails closed and coding readiness stays unavailable.
   */
  readonly secureWorkspaceTextRead?: SecureWorkspaceTextReadPort | undefined;
  readonly editorAgentClient?:
    ProductionCodingRuntimeResolverInput["editorAgentClient"] | undefined;
  readonly fetch?: typeof globalThis.fetch | undefined;
}

/**
 * Assembles the production OpenCode runtime ports from the attested portable payload. Every
 * prerequisite is mandatory: a qualified portable OpenCode artifact, a valid loopback UI port for
 * gateway and editor-agent routing, and a verified secure-read port. Any missing prerequisite
 * yields `undefined`, which keeps the runtime host unqualified and the Code surface unavailable.
 */
export function resolveProductionOpenCodePorts(
  input: ProductionOpenCodeActivationInput,
): ProductionOpenCodePorts | undefined {
  const portable = discoverQualifiedPortableOpenCode({ env: input.env });
  const loopback = loopbackBaseUrl(input.env);
  const secureWorkspaceTextRead = input.secureWorkspaceTextRead;
  if (portable === undefined || loopback === undefined || secureWorkspaceTextRead === undefined) {
    return undefined;
  }
  return {
    backend: createProductionOpenCodeBackend({
      portable,
      runtimeStateRoot: input.runtimeStateDir,
      gatewayUrl: `${loopback}/api/coding-sidecar/gateway`,
      runtimeEvidence: input.runtimeEvidence,
      gatewayReadiness: input.gatewayReadiness,
      ...(input.fetch ? { fetch: input.fetch } : {}),
    }),
    secureWorkspaceTextRead,
    editorAgentClient:
      input.editorAgentClient ??
      new EditorAgentHttpClient({
        baseUrl: loopback,
        transport: createFetchEditorAgentHttpTransport(input.fetch ?? fetch),
      }),
  };
}

function loopbackBaseUrl(env: NodeJS.ProcessEnv): string | undefined {
  const port = Number(env.KEIKO_UI_PORT);
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) return undefined;
  return `http://127.0.0.1:${String(port)}`;
}
