import { CatalogDispatchFault } from "./catalogToolErrors.js";
import { createManagedMcpHost, ManagedMcpError } from "@oscharko-dev/keiko-mcp";
import {
  createKeikoToolCatalog,
  compileToolProjection,
  captureCatalogJson,
  gatewayToolDefinitions,
  type ToolCatalog,
} from "@oscharko-dev/keiko-tool-catalog";
import type { ToolDefinition } from "@oscharko-dev/keiko-contracts";
import {
  NATIVE_TOOL_CATALOG_RUNTIME,
  type CatalogJsonObject,
  type CatalogJsonValue,
  type CatalogVersionRef,
  type CompiledToolProjection,
  type ToolResultReason,
  type ToolResultStatus,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type {
  ManagedMcpFailure,
  ManagedMcpHost,
  ManagedMcpProvider,
  ManagedMcpToolDeclaration,
} from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import type {
  CatalogConsumer,
  CatalogHandlerContext,
  CatalogHandlerResult,
  CatalogToolHandlerBinding,
} from "./catalogToolPorts.js";
import type { CatalogLifecycleLogPort } from "./catalogToolLifecycle.js";
import { emitServerDiagnostic, serverDiagnosticFromError } from "../diagnostics-log.js";

const MCP_FAILURES: Readonly<
  Record<ManagedMcpFailure, readonly [Exclude<ToolResultStatus, "completed">, ToolResultReason]>
> = {
  "not-admitted": ["failed", "handler-unavailable"],
  "connector-scope-missing": ["failed", "handler-unavailable"],
  closed: ["failed", "handler-unavailable"],
  "invalid-arguments": ["invalid", "invalid-arguments"],
  "descriptor-drift": ["failed", "handler-mismatch"],
  "protocol-error": ["failed", "handler-failed"],
  "tool-error": ["failed", "handler-failed"],
  "log-unavailable": ["failed", "handler-failed"],
  "deadline-exceeded": ["timeout", "deadline-exceeded"],
  aborted: ["cancelled", "parent-cancelled"],
  "result-too-large": ["failed", "handler-failed"],
  backoff: ["failed", "handler-unavailable"],
};
function catalogFailure(error: unknown): unknown {
  if (!(error instanceof ManagedMcpError)) return error;
  if (error.reason === "tool-error" && error.structuredResult !== undefined)
    return new CatalogDispatchFault(
      "failed",
      "provider-reported-error",
      error,
      error.structuredResult,
    );
  const [status, reason] = MCP_FAILURES[error.reason];
  return new CatalogDispatchFault(status, reason, error);
}
/** Server-owned mapping. Model arguments never select a provider, context or handler. */
export interface ManagedCatalogRoute<Consumer extends CatalogConsumer> {
  readonly name: string;
  readonly alias: string;
  readonly catalogAction: string;
  readonly previewAction: CatalogToolHandlerBinding<Consumer>["previewAction"];
  readonly actionFor: CatalogToolHandlerBinding<Consumer>["actionFor"];
  readonly resultFor: (
    data: CatalogJsonObject,
    context: CatalogHandlerContext<Consumer>,
  ) => CatalogHandlerResult;
}
export interface ManagedProviderCatalog<Consumer extends CatalogConsumer> {
  readonly catalog: ToolCatalog;
  readonly projection: CompiledToolProjection;
  readonly handlerBindings: readonly CatalogToolHandlerBinding<Consumer>[];
  readonly close: () => Promise<void>;
}
export interface ManagedProviderCatalogInput<Consumer extends CatalogConsumer> {
  readonly providers: readonly ManagedMcpProvider<CatalogHandlerContext<Consumer>>[];
  readonly routes: readonly ManagedCatalogRoute<Consumer>[];
  readonly profile: CatalogVersionRef;
  readonly log: CatalogLifecycleLogPort;
  readonly correlationId: string;
  readonly now: () => number;
}
function objectArguments(value: CatalogJsonValue): CatalogJsonObject {
  const captured = captureCatalogJson(value);
  if (captured === null || typeof captured !== "object" || Array.isArray(captured))
    throw new TypeError("Managed provider arguments must be an object");
  return captured as CatalogJsonObject;
}
function bindManagedTool<Consumer extends CatalogConsumer>(
  host: ManagedMcpHost<CatalogHandlerContext<Consumer>>,
  declaration: ManagedMcpToolDeclaration,
  route: ManagedCatalogRoute<Consumer>,
): CatalogToolHandlerBinding<Consumer> {
  const { descriptor, name } = declaration;
  return Object.freeze({
    toolRef: descriptor.toolRef,
    descriptorDigest: descriptor.descriptorDigest,
    handlerId: descriptor.handlerRequirement.id,
    handlerVersion: descriptor.handlerRequirement.contractVersion,
    catalogAction: route.catalogAction,
    readiness: (): "ready" | "unavailable" => {
      if (host.protocolEra() !== "modern") return "unavailable";
      try {
        host.catalog(); // Refuse drift before a new offer as well as before dispatch.
        return "ready";
      } catch (error) {
        throw catalogFailure(error);
      }
    },
    previewAction: route.previewAction,
    actionFor: route.actionFor,
    execute: async (
      args: CatalogJsonValue,
      context: CatalogHandlerContext<Consumer>,
    ): Promise<CatalogHandlerResult> => {
      try {
        return route.resultFor(await host.call(name, objectArguments(args), context), context);
      } catch (error) {
        throw catalogFailure(error);
      }
    },
  });
}
interface RouteIdentity {
  readonly name: string;
  readonly alias: string;
}
type DeclarationIdentity = Pick<ManagedMcpToolDeclaration, "name" | "descriptor">;
interface ManagedCatalogEntry<
  Route extends RouteIdentity,
  Declaration extends DeclarationIdentity,
> {
  readonly route: Route;
  readonly declaration: Declaration;
}
function managedCatalogEntries<
  Route extends RouteIdentity,
  Declaration extends DeclarationIdentity,
>(
  routes: readonly Route[],
  declarations: readonly Declaration[],
): readonly ManagedCatalogEntry<Route, Declaration>[] {
  if (
    routes.length !== declarations.length ||
    new Set(routes.map((route) => route.name)).size !== routes.length
  )
    throw new TypeError("Managed provider routes must exactly cover admitted tools");
  return routes.map((route) => {
    const declaration = declarations.find((tool) => tool.name === route.name);
    if (declaration === undefined) throw new TypeError("Unknown managed provider route");
    return { route, declaration };
  });
}
function managedToolCatalog(
  entries: readonly ManagedCatalogEntry<RouteIdentity, DeclarationIdentity>[],
  profile: CatalogVersionRef,
  referenceTimeMs: number,
): ToolCatalog {
  return createKeikoToolCatalog(
    [
      {
        profile,
        adapterDialect: { id: "gateway-json-schema", version: 1 },
        adapterRuntime: NATIVE_TOOL_CATALOG_RUNTIME,
        entries: entries.map(({ route, declaration }) => ({
          alias: route.alias,
          descriptor: declaration.descriptor,
        })),
      },
    ],
    [],
    { referenceTimeMs },
  );
}
/**
 * The tool definitions a model call is advertised for these declarations: the catalog this module
 * compiles for a turn, materialized by the compiler's own transport projection. Pure: no host is
 * admitted and nothing is connected, so a size reading cannot restate the production formula.
 */
export function managedCatalogToolDefinitions(
  routes: readonly RouteIdentity[],
  declarations: readonly DeclarationIdentity[],
  profile: CatalogVersionRef,
  referenceTimeMs: number,
): readonly ToolDefinition[] {
  const entries = managedCatalogEntries(routes, declarations);
  return gatewayToolDefinitions(managedToolCatalog(entries, profile, referenceTimeMs), profile);
}
/** The same compiler-owned projection for a private captured result; it grants no authority. */
export function managedCatalogProjection(
  routes: readonly RouteIdentity[],
  declarations: readonly DeclarationIdentity[],
  profile: CatalogVersionRef,
  referenceTimeMs: number,
): CompiledToolProjection {
  const entries = managedCatalogEntries(routes, declarations);
  return compileToolProjection(managedToolCatalog(entries, profile, referenceTimeMs), profile);
}
function compileManagedCatalog<Consumer extends CatalogConsumer>(
  host: ManagedMcpHost<CatalogHandlerContext<Consumer>>,
  input: ManagedProviderCatalogInput<Consumer>,
): ManagedProviderCatalog<Consumer> {
  const declarations = host.catalog();
  const routes = input.routes.map((route) => Object.freeze({ ...route }));
  const entries = managedCatalogEntries(routes, declarations);
  const catalog = managedToolCatalog(entries, input.profile, input.now());
  return Object.freeze({
    catalog,
    projection: compileToolProjection(catalog, input.profile),
    handlerBindings: Object.freeze(
      entries.map(({ route, declaration }) => bindManagedTool(host, declaration, route)),
    ),
    close: (): Promise<void> => host.close(),
  });
}
/** Compose once per application; bind this admitted catalog to each consumer using the existing binder. */
export async function createManagedProviderCatalog<Consumer extends CatalogConsumer>(
  input: ManagedProviderCatalogInput<Consumer>,
): Promise<ManagedProviderCatalog<Consumer>> {
  const host = createManagedMcpHost<CatalogHandlerContext<Consumer>>({
    providers: input.providers,
    log: input.log.primary,
  });
  try {
    await host.admit(input.correlationId);
    return compileManagedCatalog(host, input);
  } catch (error) {
    reportManagedCatalogFailure(input, error);
    try {
      await host.close();
    } catch (cleanupError) {
      reportManagedCatalogFailure(input, cleanupError);
    }
    throw error;
  }
}

function reportManagedCatalogFailure<Consumer extends CatalogConsumer>(
  input: ManagedProviderCatalogInput<Consumer>,
  error: unknown,
): void {
  emitServerDiagnostic(
    input.log.diagnostics,
    serverDiagnosticFromError({
      correlationId: input.correlationId,
      operation: "tool-catalog.binding-failed",
      source: "tool-catalog-binding",
      error,
      redact: () => "server-operation-failed",
    }),
  );
}
