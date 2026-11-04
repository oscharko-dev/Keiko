import { describe, expect, it } from "vitest";
import { ATLASSIAN_ACTION_APPROVAL_TTL_MS } from "../atlassian/actionApprovalLimits.js";
import { mcpChatDeclaration } from "./mcpChatDescriptors.js";

type Server = Parameters<typeof mcpChatDeclaration>[0];

function declaration(risk: "read" | "write"): ReturnType<typeof mcpChatDeclaration> {
  const server = { name: "lab", tools: { tool: risk } } as unknown as Server;
  return mcpChatDeclaration(server, {
    name: "tool",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  });
}

describe("the time an MCP Chat tool may take", () => {
  it("adds the human's decision to a write, which waits in place for it", () => {
    expect(declaration("write").descriptor.bounds.maxDurationMs).toBe(
      60000 + ATLASSIAN_ACTION_APPROVAL_TTL_MS,
    );
  });
  it("keeps a read to its own work", () => {
    expect(declaration("read").descriptor.bounds.maxDurationMs).toBe(60000);
  });
});
