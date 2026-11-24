import { describe, expect, it } from "vitest";
import { ATLASSIAN_ACTION_APPROVAL_TTL_MS } from "../atlassian/actionApprovalLimits.js";
import { MCP_EXTERNAL_CALL_MAX_MS } from "@oscharko-dev/keiko-mcp";
import { GOVERNED_TOOL_SETTLEMENT_GRACE_MS } from "@oscharko-dev/keiko-contracts/runtime/tools";
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
      MCP_EXTERNAL_CALL_MAX_MS +
        GOVERNED_TOOL_SETTLEMENT_GRACE_MS +
        ATLASSIAN_ACTION_APPROVAL_TTL_MS,
    );
  });
  it("keeps a read to its own work and lets the client's own ceiling answer first", () => {
    // Owner decision 2026-11-24: 300 s, the external client's own call ceiling (was 60 s).
    expect(MCP_EXTERNAL_CALL_MAX_MS).toBe(300_000);
    expect(declaration("read").descriptor.bounds.maxDurationMs).toBe(
      300_000 + GOVERNED_TOOL_SETTLEMENT_GRACE_MS,
    );
    expect(declaration("read").descriptor.bounds.maxDurationMs).toBeGreaterThan(
      MCP_EXTERNAL_CALL_MAX_MS,
    );
  });
});
