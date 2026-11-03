// Isolated MCP acceptance fixture. The existing package pruner removes __tests__ artifacts.
import { appendFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { McpServer, fromJsonSchema } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

const counter = process.argv[2];
if (!counter) throw new TypeError("An isolated effect counter is required");
const descendantRecord = process.argv[3];
if (descendantRecord !== undefined) {
  const child = spawn(
    process.execPath,
    [
      "--eval",
      "process.on('SIGTERM',()=>{});process.stdout.write('ready');setInterval(()=>{},1000);",
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.stdout.once("data", () => {
      resolve();
    });
  });
  writeFileSync(descendantRecord, JSON.stringify([process.pid, child.pid]), { mode: 0o600 });
}
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
      resultMode?: "complete" | "reject" | "dropBefore" | "dropAfter" | "errorAfter";
    }>({
      type: "object",
      properties: {
        nonce: { type: "string", minLength: 1, maxLength: 64 },
        resultMode: {
          type: "string",
          enum: ["complete", "reject", "dropBefore", "dropAfter", "errorAfter"],
        },
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
    if (resultMode === "errorAfter")
      return { isError: true, content: [{ type: "text", text: "MCP_AUDIT_ERROR_AFTER_EFFECT" }] };
    return { content: [{ type: "text", text: "MCP_AUDIT_WRITE_OK" }] };
  },
);
await server.connect(new StdioServerTransport());
