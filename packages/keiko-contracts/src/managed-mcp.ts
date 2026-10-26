import type { CatalogJsonObject, ToolDescriptor } from "./governed-tool-catalog.js";
import type { ActivityLogEventEnvelope, RegisteredActivityLogEvent } from "./observability.js";

export const MANAGED_MCP_PROTOCOL_VERSION = "2026-07-28";

/** Resolved by server composition; never serialized into MCP arguments or metadata. */
export interface ManagedMcpInvocationContext {
  readonly invocationId: string;
  readonly correlationId: string;
  readonly signal: AbortSignal;
  readonly beforeEffect: () => boolean;
}

export interface ManagedMcpToolResult {
  readonly data: CatalogJsonObject;
  readonly isError?: boolean;
}

export interface ManagedMcpTool<Context extends ManagedMcpInvocationContext> {
  readonly name: string;
  /** Descriptive protocol hint; the server-owned action/authority port remains authoritative. */
  readonly risk: "read" | "write";
  readonly descriptor: ToolDescriptor;
  readonly execute: (
    argumentsValue: CatalogJsonObject,
    context: Context,
  ) => Promise<ManagedMcpToolResult>;
}

export interface ManagedMcpProvider<Context extends ManagedMcpInvocationContext> {
  readonly id: string;
  /** A changed declaration requires fresh admission; existing hosts refuse drift. */
  readonly tools: () => readonly ManagedMcpTool<Context>[];
}

export interface ManagedMcpLogPort {
  readonly write: (event: RegisteredActivityLogEvent & ActivityLogEventEnvelope) => void;
}

export type ManagedMcpFailure =
  | "not-admitted"
  | "invalid-arguments"
  | "descriptor-drift"
  | "protocol-error"
  | "tool-error"
  | "log-unavailable"
  | "deadline-exceeded"
  | "aborted"
  | "closed";

export interface ManagedMcpHost<Context extends ManagedMcpInvocationContext> {
  readonly admit: (correlationId: string) => Promise<void>;
  readonly protocolEra: () => "modern" | undefined;
  readonly call: (
    name: string,
    argumentsValue: CatalogJsonObject,
    context: Context,
  ) => Promise<CatalogJsonObject>;
  readonly close: () => Promise<void>;
}
