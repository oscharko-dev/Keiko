import { isRecord } from "./run-result-validation.js";
import {
  CHANGESET_EDIT_ARGUMENT_LIMITS,
  GENERIC_TOOL_ARGUMENT_LIMITS,
  GOVERNED_CHANGESET_EDIT_TOOL_ALIAS,
  type CatalogCompatibility,
  type CatalogDigest,
  type CatalogJsonValue,
  type CatalogProfile,
  type CompiledToolProjection,
  type ToolArgumentLimits,
  type ToolDescriptor,
  type ToolRef,
} from "./governed-tool-catalog.js";
import type { ToolCallMetadata } from "./tools.js";
import type {
  BoundToolInvocation,
  CatalogToolDispatchOutcome,
  OfferedToolSet,
} from "./governed-tool-lifecycle.js";

/** Content identity only. The server's handler/authority owners still decide availability. */
export interface ToolCatalogSource {
  readonly catalogRevision: CatalogDigest;
  readonly descriptors: readonly ToolDescriptor[];
  readonly profiles: readonly CatalogProfile[];
  readonly compatibility: readonly CatalogCompatibility[];
}
export interface ToolInvocationBinding {
  readonly catalog: ToolCatalogSource;
  readonly projection: CompiledToolProjection;
  readonly offered: OfferedToolSet;
}
export interface ToolInvocationBudgetReservation {
  readonly reservationId: string;
}
/** Accounting is supplied by the run owner; a binder never creates another run counter. */
export interface ToolInvocationBudgetPort<Context> {
  readonly available: (descriptor: ToolDescriptor, context: Context) => boolean;
  readonly reserve: (
    descriptor: ToolDescriptor,
    context: Context,
    invocationId: string,
  ) => ToolInvocationBudgetReservation | undefined;
  readonly check: (reservation: ToolInvocationBudgetReservation, context: Context) => boolean;
  readonly commit: (reservation: ToolInvocationBudgetReservation) => void;
  readonly release: (reservation: ToolInvocationBudgetReservation) => void;
}
export interface GovernedToolCallRequest {
  readonly toolCallId: string;
  readonly invocation: BoundToolInvocation;
  readonly signal: AbortSignal;
}
/** Trusted handler evidence has no output/argument body and is scoped to the active invocation. */
export interface ToolHandlerExecutionEvidence {
  readonly toolRef: ToolRef;
  readonly toolCallId: string;
  readonly durationMs: number;
  readonly commandExecuted: boolean;
  readonly metadata?: ToolCallMetadata;
}
export interface WorkspaceCatalogHandlerCall {
  readonly toolCallId: string;
  readonly toolRef: ToolRef;
  readonly descriptorDigest: CatalogDigest;
  readonly arguments: CatalogJsonValue;
  readonly signal: AbortSignal;
  readonly beforeEffect: () => boolean;
  readonly observeExecution: (evidence: ToolHandlerExecutionEvidence) => void;
}
/** Governed tool execution accepts only a server-bound canonical invocation. */
export interface CatalogToolPort {
  readonly kind: "catalog";
  readonly offer: () => GatewayToolCatalogAdvertisement;
  readonly execute: (request: GovernedToolCallRequest) => Promise<CatalogToolDispatchOutcome>;
}
/** One tool definition as the provider sees it; mirrors `ToolDefinition` in `gateway.ts`. */
export interface GatewayNativeToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}

/**
 * The native OpenCode tool advertisement (#3897): the pinned runtime's own tool definitions,
 * forwarded to the provider as data and bound back by name only. Nothing in it registers a
 * handler, effect or authority in Keiko (ADR-0175 D2); OpenCode executes every call under the
 * server-owned permission policy. Admission is bounded shape, pinned by `toolSetDigest`.
 */
export interface GatewayNativeToolAdvertisement {
  readonly kind: "native";
  readonly runtime: { readonly id: "opencode"; readonly version: string };
  readonly tools: readonly GatewayNativeToolDefinition[];
  readonly toolSetDigest: string;
  readonly offered: { readonly offerId: string; readonly expiresAt: string };
}

/**
 * One byte contract for the native advertisement, shared by the server's admission, this validator
 * and the gateway's capture (#3897 review): `maxSchemaBytes` bounds one tool's parameter schema and
 * `maxTotalBytes` all complete tool definitions (name, description and schema), both as UTF-8 JSON
 * (`gatewayNativeToolDefinitionBytes`).
 */
export const GATEWAY_NATIVE_TOOL_ADVERTISEMENT_LIMITS = Object.freeze({
  maxTools: 128,
  maxToolNameChars: 64,
  maxDescriptionChars: 16_384,
  maxSchemaBytes: 64 * 1024,
  maxTotalBytes: 512 * 1024,
});

/** The capture budget of a whole advertisement: its tools plus the bounded envelope fields. */
export const GATEWAY_NATIVE_ADVERTISEMENT_CAPTURE_BYTES =
  GATEWAY_NATIVE_TOOL_ADVERTISEMENT_LIMITS.maxTotalBytes + 16 * 1024;

const UTF8 = new TextEncoder();

function utf8JsonBytes(value: unknown): number {
  return UTF8.encode(JSON.stringify(value)).length;
}

/** The UTF-8 JSON bytes one complete tool definition counts against `maxTotalBytes`. */
export function gatewayNativeToolDefinitionBytes(tool: GatewayNativeToolDefinition): number {
  return utf8JsonBytes({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  });
}

/** The UTF-8 JSON bytes of one tool's parameter schema, bounded by `maxSchemaBytes`. */
export function gatewayNativeToolSchemaBytes(
  parameters: Readonly<Record<string, unknown>>,
): number {
  return utf8JsonBytes(parameters);
}

/**
 * Native tools whose arguments are consumed byte for byte: workspace file content (#4009) and
 * executable source, a Code Mode program or a shell command line, whose meaning a heuristic rewrite
 * would change (#3897 review). Configured provider literals are still removed from them.
 */
export const GATEWAY_NATIVE_EXACT_CONTENT_TOOLS: readonly string[] = Object.freeze([
  "edit",
  "write",
  "patch",
  "execute",
  "shell",
]);

/**
 * The native tools whose arguments are workspace file content. Their calls are captured under the
 * changeset-edit argument ceilings (`CHANGESET_EDIT_ARGUMENT_LIMITS`), like the governed changeset
 * edit: Keiko refuses no file content at the generic 64 KiB string bound (owner decision,
 * 2026-10-28). Every other native tool keeps the generic ceilings.
 */
export const GATEWAY_NATIVE_FILE_CONTENT_TOOLS: readonly string[] = Object.freeze([
  "edit",
  "write",
  "patch",
]);

/**
 * The argument ceilings of a tool call known by name alone, as the coding runtime records it in its
 * own history: the changeset ceilings for the governed changeset edit and the native file-content
 * tools, the generic ones for every other tool.
 */
export function toolArgumentLimitsByToolName(toolName: string): ToolArgumentLimits {
  return toolName === GOVERNED_CHANGESET_EDIT_TOOL_ALIAS ||
    GATEWAY_NATIVE_FILE_CONTENT_TOOLS.includes(toolName)
    ? CHANGESET_EDIT_ARGUMENT_LIMITS
    : GENERIC_TOOL_ARGUMENT_LIMITS;
}

const NATIVE_TOOL_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;

interface CheckedNativeToolDefinition {
  readonly record: Record<string, unknown>;
  readonly bytes: number;
}

function checkedNativeToolDefinition(value: unknown): CheckedNativeToolDefinition | undefined {
  const record = plainRecord(value);
  if (record === undefined || Object.keys(record).length !== 3) return undefined;
  const { name, description, parameters } = record;
  if (typeof name !== "string" || !NATIVE_TOOL_NAME.test(name)) return undefined;
  const schema = plainRecord(parameters);
  if (!boundedDescription(description) || schema === undefined) return undefined;
  if (
    gatewayNativeToolSchemaBytes(schema) > GATEWAY_NATIVE_TOOL_ADVERTISEMENT_LIMITS.maxSchemaBytes
  )
    return undefined;
  return {
    record,
    bytes: gatewayNativeToolDefinitionBytes({ name, description, parameters: schema }),
  };
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function boundedDescription(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= GATEWAY_NATIVE_TOOL_ADVERTISEMENT_LIMITS.maxDescriptionChars
  );
}

function validNativeRuntime(value: unknown): boolean {
  const runtime = plainRecord(value);
  return (
    runtime?.id === "opencode" &&
    typeof runtime.version === "string" &&
    /^\d+\.\d+\.\d+$/u.test(runtime.version)
  );
}

function validNativeOffer(value: unknown): boolean {
  const offered = plainRecord(value);
  return (
    typeof offered?.offerId === "string" &&
    offered.offerId.length > 0 &&
    typeof offered.expiresAt === "string" &&
    !Number.isNaN(Date.parse(offered.expiresAt))
  );
}

function validNativeTools(value: unknown): boolean {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > GATEWAY_NATIVE_TOOL_ADVERTISEMENT_LIMITS.maxTools
  )
    return false;
  const names = new Set<string>();
  let total = 0;
  for (const tool of value) {
    const checked = checkedNativeToolDefinition(tool);
    if (checked === undefined) return false;
    const name = checked.record.name;
    if (typeof name !== "string" || !NATIVE_TOOL_NAME.test(name)) return false;
    if (names.has(name)) return false;
    names.add(name);
    total += checked.bytes;
    if (total > GATEWAY_NATIVE_TOOL_ADVERTISEMENT_LIMITS.maxTotalBytes) return false;
  }
  return true;
}

/** Bounded-shape admission of a native advertisement; never inspects what a tool would do. */
export function isGatewayNativeToolAdvertisement(
  value: unknown,
): value is GatewayNativeToolAdvertisement {
  const record = plainRecord(value);
  const keys = ["kind", "runtime", "tools", "toolSetDigest", "offered"];
  if (record?.kind !== "native" || Object.keys(record).length !== keys.length) return false;
  if (!keys.every((key) => Object.hasOwn(record, key))) return false;
  return (
    validNativeRuntime(record.runtime) &&
    typeof record.toolSetDigest === "string" &&
    DIGEST.test(record.toolSetDigest) &&
    validNativeOffer(record.offered) &&
    validNativeTools(record.tools)
  );
}

export type GatewayToolCatalogAdvertisement = ToolInvocationBinding & { readonly kind: "bound" };

/** What a gateway request may advertise: the Keiko catalog projection, or the native tool set. */
export type GatewayToolAdvertisement =
  GatewayToolCatalogAdvertisement | GatewayNativeToolAdvertisement;

/** The catalog binding of an advertisement, or nothing for a native tool set (#3897). */
export function boundGatewayToolCatalog(
  advertisement: GatewayToolAdvertisement | undefined,
): GatewayToolCatalogAdvertisement | undefined {
  return advertisement?.kind === "bound" ? advertisement : undefined;
}
