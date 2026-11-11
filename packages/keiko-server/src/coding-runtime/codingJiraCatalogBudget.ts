import type { CodingWorkbenchContextUsage } from "@oscharko-dev/keiko-contracts";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ExternalMcpTool } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { countGatewayPromptTokens } from "@oscharko-dev/keiko-model-gateway/internal/prompt-token-accounting";
import type { OpenCodeContextGeometry } from "./opencodeLaunchProfile.js";

/** A read of existing accounting, never a second reservation or a guessed empty conversation. */
export function codingJiraCatalogFits(input: {
  readonly tools: readonly ExternalMcpTool[];
  readonly result: CatalogJsonObject;
  readonly usage: CodingWorkbenchContextUsage | undefined;
  readonly geometry: OpenCodeContextGeometry;
}): boolean | undefined {
  const { usage, geometry } = input;
  if (usage?.state !== "available" || usage.source !== "provider-reported") return undefined;
  // A sample from different model geometry cannot establish this run's remaining context.
  if (
    usage.capacityTokens !== geometry.contextWindowTokens ||
    usage.reservedOutputTokens !== geometry.maxOutputTokens
  )
    return undefined;
  const metadataTokens = countGatewayPromptTokens(
    {
      tools: input.tools.map((tool) => ({
        name: tool.name,
        description: tool.description ?? "",
        parameters: tool.inputSchema,
      })),
      messages: [
        {
          role: "tool",
          toolCallId: "jira-catalog-selection",
          content: JSON.stringify(input.result),
        },
      ],
    },
    undefined,
    { contextWindow: geometry.contextWindowTokens },
  );
  // Keep the observed input, including other tools/history, and conservatively retain all of
  // that response's reserved output. Do not subtract old schemas or invent a compaction gain.
  // The next gateway request still performs its own complete accounting and reservation.
  const promptTokens = usage.usedInputTokens + usage.reservedOutputTokens + metadataTokens;
  return (
    Number.isSafeInteger(promptTokens) &&
    promptTokens <= geometry.maxInputTokens &&
    promptTokens + geometry.maxOutputTokens <= geometry.contextWindowTokens
  );
}
