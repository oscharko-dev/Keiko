import type { JiraMutationOperation } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";

/**
 * The canonical tool id of a managed Jira mutation. External MCP tools are named `keiko.mcp.*`, so
 * no other provider can share it; receipts bind to it (#4178).
 */
export function jiraMutationToolId(name: JiraMutationOperation): string {
  return `keiko.${name}`;
}
