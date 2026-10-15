import { join } from "node:path";
import { realpathSync } from "node:fs";
import { createDefaultChatCapability, parseGatewayConfig } from "@oscharko-dev/keiko-model-gateway";
import { buildUiHandlerDeps, type UiHandlerDeps } from "../../packages/keiko-server/src/deps.js";
import { citationBehaviourObserverFor } from "../../packages/keiko-server/src/grounded-citation-capability.js";

/** Establish reliability through the same bounded, generation-owned producer as real turns. */
export function reliableCitationRuntime(root: string, modelId: string): UiHandlerDeps {
  const canonicalRoot = realpathSync(root);
  const deps = buildUiHandlerDeps({
    configPath: join(canonicalRoot, "citation-repair-gateway.json"),
    evidenceDir: join(canonicalRoot, "citation-repair-evidence"),
    uiDbPath: join(canonicalRoot, "citation-repair-ui.db"),
    env: {},
  });
  deps.gatewayConfig?.set(
    parseGatewayConfig({
      providers: [{ modelId, baseUrl: "https://citation.example.invalid/v1", apiKey: "fixture" }],
      capabilities: [createDefaultChatCapability(modelId)],
    }),
    true,
  );
  for (let index = 0; index < 3; index += 1)
    citationBehaviourObserverFor(deps, modelId, "citation-repair-reliability")("cites");
  return deps;
}
