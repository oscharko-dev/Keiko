// Finite legacy-native transport materialization. Canonical descriptors own every schema.
import type { ToolDefinition } from "@oscharko-dev/keiko-contracts";
import { createInitialToolCatalog, gatewayToolDefinitions } from "@oscharko-dev/keiko-tool-catalog";

export const TOOL_DEFINITIONS: readonly ToolDefinition[] = gatewayToolDefinitions(
  createInitialToolCatalog(),
  { id: "legacy-native", version: 1 },
);
