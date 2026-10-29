// Isolated MCP acceptance fixture. The existing package pruner removes __tests__ artifacts.
import { appendFileSync } from "node:fs";
import { McpServer, fromJsonSchema } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

const counter = process.argv[2];
if (!counter) throw new TypeError("An isolated effect counter is required");
const server = new McpServer({ name: "synthetic-mcp-browser", version: "1.0.0" });
server.registerTool(
  "read_probe",
  {
    description: "Return a synthetic acceptance marker without external data.",
    inputSchema: fromJsonSchema({ type: "object", properties: {}, additionalProperties: false }),
  },
  () => ({ content: [{ type: "text", text: "MCP_AUDIT_READ_OK" }] }),
);
server.registerTool(
  "write_probe",
  {
    description: "Append one synthetic effect in the isolated acceptance counter.",
    inputSchema: fromJsonSchema<{
      nonce: string;
      resultMode?: "complete" | "reject" | "dropBefore" | "dropAfter";
    }>({
      type: "object",
      properties: {
        nonce: { type: "string", minLength: 1, maxLength: 64 },
        resultMode: { type: "string", enum: ["complete", "reject", "dropBefore", "dropAfter"] },
      },
      required: ["nonce"],
      additionalProperties: false,
    }),
  },
  ({ nonce, resultMode }) => {
    if (resultMode === "reject")
      return { isError: true, content: [{ type: "text", text: "MCP_AUDIT_REJECTED" }] };
    if (resultMode === "dropBefore") process.exit(0);
    appendFileSync(counter, JSON.stringify({ kind: "write", nonce }) + "\n", { mode: 0o600 });
    if (resultMode === "dropAfter") process.exit(0);
    return { content: [{ type: "text", text: "MCP_AUDIT_WRITE_OK" }] };
  },
);
await server.connect(new StdioServerTransport());
