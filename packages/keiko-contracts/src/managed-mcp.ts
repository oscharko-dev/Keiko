import type { CatalogJsonObject, ToolDescriptor } from "./governed-tool-catalog.js";
import type { ActivityLogEventEnvelope, RegisteredActivityLogEvent } from "./observability.js";
export {
  EXTERNAL_JSON_SCHEMA_DEFAULT,
  isBoundedExternalJsonSchema,
  isExternalJsonSchemaDialect,
} from "./external-json-schema.js";

export const MANAGED_MCP_PROTOCOL_VERSION = "2026-07-28";

/** Resolved by server composition; never serialized into MCP arguments or metadata. */
export interface ManagedMcpInvocationContext {
  /** Server-private credential floor for tokens materialized during this invocation; never serialized. */
  readonly observeCredential?: (value: string) => void;
  /** Private durable mutation admission, supplied by the composing consumer. */
  readonly beginMutation?:
    | ((input: {
        readonly sessionId: string | undefined;
        readonly toolName: string;
        readonly argumentsValue: CatalogJsonObject;
      }) => ManagedMcpMutationInvocation | undefined)
    | undefined;
  /** Server-private recovery fence; never supplied by model tool arguments. */
  readonly onUncertainMutation?: (() => void | Promise<void>) | undefined;
  /**
   * Runs exactly once per call at the gate that releases the `tools/call` frame to the transport,
   * after every pre-send check passed. `false` refuses the frame; nothing has left the process.
   */
  readonly beforeDispatch?: (() => boolean) | undefined;
  readonly invocationId: string;
  readonly correlationId: string;
  readonly signal: AbortSignal;
  readonly beforeEffect: () => boolean;
}

export interface ManagedMcpMutationInvocation {
  readonly invocationId: string;
  /**
   * Marks the durable record dispatched. Called at the transport gate, not at admission, so a
   * failure before the frame left the process stays provably effect-free. Absent: the record was
   * already dispatched when the permit was issued.
   */
  readonly dispatch?: (() => boolean) | undefined;
  /** The call failed before `dispatch`: settle the record as not dispatched. */
  readonly release?: (() => void) | undefined;
  /** The upstream replied successfully; the consumer has not acknowledged receipt yet. */
  readonly acknowledge: () => void;
  /** Conservatively retain the observed outcome if delivery cannot be confirmed. */
  readonly fail: () => void;
}

export interface ManagedMcpToolResult {
  readonly data: CatalogJsonObject;
  readonly isError?: boolean;
}

export interface ManagedMcpToolDeclaration {
  readonly name: string;
  /** Descriptive protocol hint; the server-owned action/authority port remains authoritative. */
  readonly risk: "read" | "write";
  readonly descriptor: ToolDescriptor;
}

export interface ManagedMcpTool<
  Context extends ManagedMcpInvocationContext,
> extends ManagedMcpToolDeclaration {
  readonly execute: (
    argumentsValue: CatalogJsonObject,
    context: Context,
  ) => Promise<ManagedMcpToolResult>;
}

export interface ManagedMcpProvider<Context extends ManagedMcpInvocationContext> {
  readonly id: string;
  /** Return stable handler references. Changed metadata or handlers require a new host/admission. */
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
  | "closed"
  | "result-too-large"
  | "backoff";

/**
 * Whether a failed call may have changed the remote system. `none` is only claimed when the
 * `tools/call` frame never passed the dispatch gate; everything else is `possible`.
 */
export type ManagedMcpEffect = "none" | "possible";

export interface ManagedMcpHost<Context extends ManagedMcpInvocationContext> {
  readonly admit: (correlationId: string) => Promise<void>;
  /** Verified metadata only; no handlers, credentials or consumer context. */
  readonly catalog: () => readonly ManagedMcpToolDeclaration[];
  readonly protocolEra: () => "modern" | undefined;
  readonly call: (
    name: string,
    argumentsValue: CatalogJsonObject,
    context: Context,
  ) => Promise<CatalogJsonObject>;
  readonly close: () => Promise<void>;
}
/** External protocol metadata is untrusted; catalog admission supplies execution authority. */
export interface ExternalMcpTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: CatalogJsonObject;
  readonly outputSchema?: CatalogJsonObject;
  readonly annotations?: CatalogJsonObject;
}
export interface ExternalMcpConnection {
  /** Aborts on connection closure or schema drift; it never authorizes reconnect/replay. */
  readonly signal: AbortSignal;
  /** Server-owned guidance for the relayed server; an external server's own text never fills it. */
  readonly instructions?: string;
  readonly tools: readonly ExternalMcpTool[];
  readonly call: (
    name: string,
    argumentsValue: CatalogJsonObject,
    context: ManagedMcpInvocationContext,
  ) => Promise<CatalogJsonObject>;
  readonly close: () => Promise<void>;
}
