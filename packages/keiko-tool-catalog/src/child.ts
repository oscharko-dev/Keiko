// ADR-0175 D2: the read-only child's canonical identity is `keiko.child.workspace.read@1`, alias
// `keiko_child_workspace_read` -- distinct from the legacy `read_file` alias, which stays scoped
// to `legacy-native@1` only. #3407 owns assigning this unique alias and the real durable event
// composition; this registration set owns only the descriptor content.
import { TOOL_CATALOG_LIMITS } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { DEFAULT_SANDBOX_POLICY } from "@oscharko-dev/keiko-contracts/runtime/tools";
import { createToolRef } from "./identity.js";
import { createToolDescriptor } from "./descriptor.js";
import { NATIVE_TOOL_CATALOG_RUNTIME } from "./dialect.js";
import type { CatalogRegistrationSet } from "./composer.js";

const CHILD_WORKSPACE_READ_ALIAS = "keiko_child_workspace_read";

/** The "child" registration set: the one read-only tool a read-only child run is offered. */
export function childRegistrationSet(): CatalogRegistrationSet {
  return {
    profile: { id: "child", version: 1 },
    adapterDialect: { id: "child-agent-json-schema", version: 1 },
    adapterRuntime: NATIVE_TOOL_CATALOG_RUNTIME,
    nativeExtensions: [],
    compatibility: [],
    entries: [
      {
        alias: CHILD_WORKSPACE_READ_ALIAS,
        descriptor: createToolDescriptor({
          toolRef: createToolRef("keiko.child.workspace.read", 1),
          description:
            "Read one bounded repository text file through the parent's secure read authority.",
          inputSchema: {
            type: "object",
            properties: {
              relativePath: { type: "string", minLength: 1, maxLength: 512 },
            },
            required: ["relativePath"],
            additionalProperties: false,
          },
          resultSchema: { type: "string", maxLength: TOOL_CATALOG_LIMITS.maxStringBytes },
          effects: ["workspace-read"],
          actionMapping: [{ action: CHILD_WORKSPACE_READ_ALIAS, effects: ["workspace-read"] }],
          policyReferences: ["workspace-read"],
          handlerRequirement: { id: "child-workspace-read-port", contractVersion: 1 },
          bounds: {
            maxArgumentBytes: TOOL_CATALOG_LIMITS.maxArgumentBytes,
            maxResultBytes: TOOL_CATALOG_LIMITS.maxResultBytes,
            maxResultCount: 1,
            maxDurationMs: DEFAULT_SANDBOX_POLICY.defaultTimeoutMs,
          },
          idempotency: "read-only",
          cancellation: "before-effect",
        }),
      },
    ],
  };
}

export { CHILD_WORKSPACE_READ_ALIAS };
