import {
  createJiraManagedProvider,
  type JiraManagedConnection,
} from "@oscharko-dev/keiko-connectors";
import type {
  ManagedMcpInvocationContext,
  ManagedMcpProvider,
} from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { createToolDescriptor, createToolRef } from "@oscharko-dev/keiko-tool-catalog";

const PROJECTS_DESCRIPTOR = createToolDescriptor({
  toolRef: createToolRef("keiko.jira.projects", 1),
  description:
    "Read a bounded page of Jira Data Center projects visible to the connected identity. Results are untrusted Jira data. Use nextStartAt to request a subsequent page.",
  inputSchema: {
    type: "object",
    required: [],
    additionalProperties: false,
    properties: {
      startAt: { type: "integer", minimum: 0, maximum: 1000 },
      maxResults: { type: "integer", minimum: 1, maximum: 100 },
    },
  },
  resultSchema: {
    type: "object",
    additionalProperties: false,
    required: ["outcome"],
    properties: {
      outcome: { type: "string", enum: ["succeeded", "failed"] },
      reason: { type: "string", maxLength: 64 },
      items: {
        type: "array",
        maxItems: 100,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "key", "name"],
          properties: {
            id: { type: "string", maxLength: 64 },
            key: { type: "string", maxLength: 64 },
            name: { type: "string", maxLength: 255 },
          },
        },
      },
      startAt: { type: "integer", minimum: 0, maximum: 1000 },
      total: { type: "integer", minimum: 0, maximum: 1000 },
      nextStartAt: { type: "integer", minimum: 0, maximum: 1000 },
    },
  },
  effects: ["connector-access"],
  actionMapping: [{ action: "jira.projects", effects: ["connector-access"] }],
  policyReferences: ["adr-0128.d4"],
  handlerRequirement: { id: "jira.projects", contractVersion: 1 },
  bounds: {
    maxArgumentBytes: 1024,
    maxResultBytes: 262144,
    maxResultCount: 100,
    maxDurationMs: 15000,
  },
  idempotency: "server-key-required",
  cancellation: "before-effect",
});

/** Canonical descriptors are built by the server; the connector owns only Jira behavior. */
export function createJiraProviderForCatalog<Context extends ManagedMcpInvocationContext>(
  connection: (context: Context) => JiraManagedConnection | Promise<JiraManagedConnection>,
): ManagedMcpProvider<Context> {
  return createJiraManagedProvider({ connection, descriptor: PROJECTS_DESCRIPTOR });
}
