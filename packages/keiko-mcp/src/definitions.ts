import type { Tool } from "@modelcontextprotocol/client";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import {
  isBoundedExternalJsonSchema,
  isExternalJsonSchemaDialect,
} from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { deepFreeze } from "@oscharko-dev/keiko-contracts/runtime/deep-freeze";
import { canonicalise } from "@oscharko-dev/keiko-security/hashing";
import type {
  ManagedMcpEffect,
  ManagedMcpFailure,
  ManagedMcpInvocationContext,
  ManagedMcpProvider,
  ManagedMcpTool,
} from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";

export class ManagedMcpError extends Error {
  readonly #structuredResult: CatalogJsonObject | undefined;

  /**
   * `none` is claimed only where the failure provably happened before a `tools/call` frame was
   * released to the transport; every other failure may have changed the remote system.
   */
  public constructor(
    public readonly reason: ManagedMcpFailure,
    structuredResult?: CatalogJsonObject,
    public readonly effect: ManagedMcpEffect = "possible",
  ) {
    super("Managed MCP operation failed");
    this.name = "ManagedMcpError";
    this.#structuredResult =
      structuredResult === undefined ? undefined : deepFreeze(structuredResult);
  }

  /** Validated provider data; deliberately absent from enumerable error diagnostics. */
  public get structuredResult(): CatalogJsonObject | undefined {
    return this.#structuredResult;
  }
}
/** A failure that happened before any effect-bearing frame was sent. */
export function noEffectError(reason: ManagedMcpFailure): ManagedMcpError {
  return new ManagedMcpError(reason, undefined, "none");
}

/** Longest tool description forwarded to a model, in UTF-8 bytes. */
export const MAX_TOOL_DESCRIPTION_BYTES = 2048;

/** Cut at a code-point boundary so a truncated description is still valid text. */
export function boundedDescription(
  description: string,
  maxBytes: number = MAX_TOOL_DESCRIPTION_BYTES,
): string {
  if (Buffer.byteLength(description, "utf8") <= maxBytes) return description;
  let used = 0;
  let end = 0;
  for (const point of description) {
    used += Buffer.byteLength(point, "utf8");
    if (used > maxBytes) break;
    end += point.length;
  }
  return description.slice(0, end);
}

const RISKS: ReadonlySet<string> = new Set(["read", "write"]);

function admittedSchemaDialect(schema: CatalogJsonObject): boolean {
  return (
    schema.$schema === undefined ||
    (isExternalJsonSchemaDialect(schema.$schema) && isBoundedExternalJsonSchema(schema))
  );
}

function admittedInputSchema(schema: CatalogJsonObject): boolean {
  return (
    schema.type === "object" &&
    admittedSchemaDialect(schema) &&
    (schema.$schema !== undefined || schema.additionalProperties === false)
  );
}

export function toolDefinition<Context extends ManagedMcpInvocationContext>(
  tool: ManagedMcpTool<Context>,
): Tool {
  const descriptor = tool.descriptor;
  if (!RISKS.has(tool.risk) || (tool.risk === "write" && descriptor.idempotency === "read-only"))
    throw new ManagedMcpError("invalid-arguments");
  if (
    !/^[A-Za-z0-9_.:-]{1,128}$/.test(tool.name) ||
    !admittedInputSchema(descriptor.inputSchema) ||
    !admittedSchemaDialect(descriptor.resultSchema) ||
    descriptor.resultSchema.type !== "object"
  )
    throw new ManagedMcpError("invalid-arguments");
  return {
    name: tool.name,
    description: descriptor.description,
    inputSchema: { ...descriptor.inputSchema, type: "object" },
    outputSchema: { ...descriptor.resultSchema, type: "object" },
    annotations: {
      readOnlyHint: tool.risk === "read",
      idempotentHint: tool.risk === "read",
      destructiveHint: tool.risk === "write",
      openWorldHint: true,
    },
  };
}

export function toolsOf<Context extends ManagedMcpInvocationContext>(
  providers: readonly ManagedMcpProvider<Context>[],
): readonly ManagedMcpTool<Context>[] {
  const tools = providers.flatMap((provider) => [...provider.tools()]);
  if (
    tools.length === 0 ||
    tools.some((tool) => typeof tool.execute !== "function") ||
    tools.length > 320 ||
    new Set(tools.map((tool) => tool.name)).size !== tools.length ||
    new Set(providers.map((provider) => provider.id)).size !== providers.length
  )
    throw new ManagedMcpError("descriptor-drift");
  return tools;
}

export function definitionIdentity(tools: readonly Tool[]): string {
  return canonicalise(
    tools
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
        annotations: tool.annotations,
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  );
}
