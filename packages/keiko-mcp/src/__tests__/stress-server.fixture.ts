// Isolated MCP stress fixture over stdio: results of chosen size, a call that never answers and a
// call that kills the server mid-flight. The existing package pruner removes __tests__ artifacts.
import { McpServer, fromJsonSchema } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

const server = new McpServer({ name: "synthetic-mcp-stress", version: "1.0.0" });
server.registerTool(
  "small",
  {
    description: "Return a tiny marker.",
    inputSchema: fromJsonSchema({ type: "object", properties: {}, additionalProperties: false }),
  },
  () => ({ content: [{ type: "text", text: "STRESS_SMALL_OK" }] }),
);
server.registerTool(
  "big",
  {
    description: "Return a text result of the requested number of bytes.",
    inputSchema: fromJsonSchema<{ bytes: number }>({
      type: "object",
      properties: { bytes: { type: "integer", minimum: 1, maximum: 64000000 } },
      required: ["bytes"],
      additionalProperties: false,
    }),
  },
  ({ bytes }) => ({ content: [{ type: "text", text: "x".repeat(bytes) }] }),
);
server.registerTool(
  "stall",
  {
    description: "Never answers.",
    inputSchema: fromJsonSchema({ type: "object", properties: {}, additionalProperties: false }),
  },
  () => new Promise<never>(() => undefined),
);
server.registerTool(
  "crash",
  {
    description: "Kills the server while the call is open.",
    inputSchema: fromJsonSchema({ type: "object", properties: {}, additionalProperties: false }),
  },
  () => {
    process.exit(3);
  },
);
await server.connect(new StdioServerTransport());
