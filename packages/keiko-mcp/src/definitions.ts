import type { Tool } from "@modelcontextprotocol/client";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import {
  isBoundedExternalJsonSchema,
  isExternalJsonSchemaDialect,
} from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { deepFreeze } from "@oscharko-dev/keiko-contracts/runtime/deep-freeze";
import { canonicalise } from "@oscharko-dev/keiko-security/hashing";
import type {
  ManagedMcpFailure,
  ManagedMcpInvocationContext,
  ManagedMcpProvider,
  ManagedMcpTool,
  ManagedMcpToolDeclaration,
} from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";

export class ManagedMcpError extends Error {
  readonly #structuredResult: CatalogJsonObject | undefined;

  public constructor(
    public readonly reason: ManagedMcpFailure,
    structuredResult?: CatalogJsonObject,
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

const ANNOTATION_HINT_KEYS: ReadonlySet<string> = new Set(["openWorldHint", "idempotentHint"]);
function validMetadata(
  tool: Pick<ManagedMcpTool<ManagedMcpInvocationContext>, "title" | "annotations">,
): boolean {
  if (
    tool.title !== undefined &&
    (typeof tool.title !== "string" ||
      tool.title.length < 1 ||
      tool.title.length > 128 ||
      /\p{Cc}/u.test(tool.title))
  )
    return false;
  return validHints(tool.annotations);
}
function validHints(hints: unknown): boolean {
  return (
    hints === undefined ||
    (typeof hints === "object" &&
      hints !== null &&
      !Array.isArray(hints) &&
      Object.entries(hints).every(
        ([key, value]) => ANNOTATION_HINT_KEYS.has(key) && typeof value === "boolean",
      ))
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
    !validMetadata(tool) ||
    !admittedInputSchema(descriptor.inputSchema) ||
    !admittedSchemaDialect(descriptor.resultSchema) ||
    descriptor.resultSchema.type !== "object"
  )
    throw new ManagedMcpError("invalid-arguments");
  return {
    name: tool.name,
    title: tool.title ?? tool.name,
    description: descriptor.description,
    inputSchema: { ...descriptor.inputSchema, type: "object" },
    outputSchema: { ...descriptor.resultSchema, type: "object" },
    annotations: protocolAnnotations(tool),
  };
}

function protocolAnnotations(tool: ManagedMcpToolDeclaration): NonNullable<Tool["annotations"]> {
  return {
    readOnlyHint: tool.risk === "read",
    idempotentHint: tool.annotations?.idempotentHint ?? tool.risk === "read",
    destructiveHint: tool.risk === "write",
    openWorldHint: tool.annotations?.openWorldHint ?? true,
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
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
        annotations: tool.annotations,
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  );
}
