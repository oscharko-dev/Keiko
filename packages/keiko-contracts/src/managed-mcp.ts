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
  /** Private local-provider result capture; never supplied through MCP arguments or metadata. */
  readonly retainProviderResult?:
    ((result: ManagedMcpToolResult) => ManagedMcpToolResult) | undefined;
  /** Closed local authority refusal, never a provider-reported Jira response. */
  readonly retainLocalFailure?: ((reason: "connector-scope-missing") => void) | undefined;
  /** Server-private credential floor for tokens materialized during this invocation; never serialized. */
  readonly observeCredential?: (value: string) => void;
  /** Private durable mutation admission, supplied by the composing consumer. */
  readonly beginMutation?:
    | ((input: {
        readonly sessionId: string | undefined;
        readonly toolName: string;
        readonly argumentsValue: CatalogJsonObject;
        /** Composed by Keiko's local connection adapter, never protocol metadata. */
        readonly localProvider?: "jira";
      }) => ManagedMcpMutationInvocation | undefined)
    | undefined;
  /** Local Jira read-result retention; no mutation permit or journal acknowledgement. */
  readonly beginReadCapture?:
    | ((input: {
        readonly toolName: string;
        readonly argumentsValue: CatalogJsonObject;
        readonly signal: AbortSignal;
        readonly localProvider: "jira";
      }) => ManagedMcpReadCapture | undefined)
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
  /** Persist an already validated local-provider result against this invocation's snapshot. */
  readonly retainProviderResult?:
    ((result: ManagedMcpToolResult) => ManagedMcpToolResult) | undefined;
  readonly retainLocalFailure?: ((reason: "connector-scope-missing") => void) | undefined;
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

export interface ManagedMcpReadCapture {
  readonly invocationId: string;
  readonly retainProviderResult: (result: ManagedMcpToolResult) => ManagedMcpToolResult;
  readonly retainLocalFailure: (reason: "connector-scope-missing") => void;
  /** Closed relay failures remain technical read outcomes, never mutation acknowledgement. */
  readonly retainRelayFailure: (reason: ManagedMcpFailure) => void;
  readonly release: () => void;
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
  /** Human-readable protocol metadata; hints never replace descriptor-owned authority. */
  readonly title?: string | undefined;
  readonly annotations?:
    | {
        readonly openWorldHint?: boolean | undefined;
        readonly idempotentHint?: boolean | undefined;
      }
    | undefined;
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
  | "connector-scope-missing"
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
  /** Server-owned adapter identity; an external server named Jira cannot set this marker. */
  readonly localProvider?: "jira";
  /** Server-owned local catalog reads only; never populated from external MCP metadata. */
  readonly localMetadataTools?: readonly ("jira.discover" | "jira.describe")[];
  /** Aborts on connection closure or schema drift; it never authorizes reconnect/replay. */
  readonly signal: AbortSignal;
  /** Server-owned guidance for the relayed server; an external server's own text never fills it. */
  readonly instructions?: string;
  readonly tools: readonly ExternalMcpTool[];
  /**
   * The connection calls `context.beforeDispatch` exactly once at the gate that releases the
   * `tools/call` frame, before anything can reach the server. Only such a connection lets a
   * durable mutation record become dispatched at that gate; for every other connection the relay
   * records the dispatch before the call starts, so an effect can never outrun its record.
   */
  readonly dispatchGate?: true | undefined;
  readonly call: (
    name: string,
    argumentsValue: CatalogJsonObject,
    context: ManagedMcpInvocationContext,
  ) => Promise<CatalogJsonObject>;
  readonly close: () => Promise<void>;
}
