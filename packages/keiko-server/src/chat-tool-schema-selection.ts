import type { ContextProfile, ToolDefinition } from "@oscharko-dev/keiko-contracts";
import type { CompiledToolProjection } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { OfferedToolSet } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-lifecycle";
import type { GatewayCallRequest } from "@oscharko-dev/keiko-model-gateway";
import { countGatewayPromptTokens } from "@oscharko-dev/keiko-model-gateway/internal/prompt-token-accounting";

/** Match both parts of the attested reference; unoffered definitions consume no prompt budget. */
export function offeredDefinitions(
  managed: { readonly projection: CompiledToolProjection },
  definitions: readonly ToolDefinition[],
  offered: OfferedToolSet,
): readonly ToolDefinition[] {
  const refs = new Set(
    offered.toolRefs.map((ref) => `${ref.canonicalId}@${String(ref.contractVersion)}`),
  );
  const aliases = new Set(
    managed.projection.tools
      .filter((tool) =>
        refs.has(`${tool.toolRef.canonicalId}@${String(tool.toolRef.contractVersion)}`),
      )
      .map((tool) => tool.alias),
  );
  return definitions.filter((tool) => aliases.has(tool.name));
}

/** The same accounting the gateway uses, against this request's selected transport schemas. */
export function chatToolSelectionFits(
  request: GatewayCallRequest,
  tools: readonly ToolDefinition[],
  profile: ContextProfile,
  remainingPromptTokens: number,
  reasoningHistoryField?: "reasoning_content" | "reasoning",
): boolean {
  const promptTokens = countGatewayPromptTokens({ ...request, tools }, profile.tokenAccounting, {
    contextWindow: profile.maxInputTokens,
    reasoningHistoryField,
  });
  return (
    promptTokens +
      (request.maxOutputTokens ?? profile.reservedOutputTokens) +
      profile.safetyMarginTokens <=
      profile.maxInputTokens &&
    promptTokens <= (profile.inputTokenLimit ?? Number.POSITIVE_INFINITY) &&
    promptTokens <= remainingPromptTokens
  );
}
