import { deepFreeze } from "./deep-freeze.js";
import { TOOL_RESULT_REASONS } from "./governed-tool-catalog.js";
import type {
  CatalogDigest,
  CatalogJsonValue,
  CatalogVersionRef,
  ToolRef,
  ToolResultReason,
  ToolResultEnvelope,
  ToolResultStatus,
} from "./governed-tool-catalog.js";

/** The #3412 generated declaration pins these runtime operation/phase pairs. */
export const TOOL_LIFECYCLE_OPERATIONS = deepFreeze({
  projection: "tool-catalog.projection",
  "bind-ready": "tool-catalog.bind-ready",
  "bind-unavailable": "tool-catalog.bind-unavailable",
  "invocation-started": "tool-catalog.invocation-started",
  terminal: "tool-catalog.invocation-settled",
  discarded: "tool-catalog.completion-discarded",
} as const);
export type ToolLifecyclePhase = keyof typeof TOOL_LIFECYCLE_OPERATIONS;
export type ToolLifecycleOperation = (typeof TOOL_LIFECYCLE_OPERATIONS)[ToolLifecyclePhase];
export const TOOL_HANDLER_READINESS = Object.freeze([
  "ready",
  "unavailable",
  "dry-run",
  "unsupported",
  "mismatch",
] as const);
export type ToolHandlerReadiness = (typeof TOOL_HANDLER_READINESS)[number];
export const TOOL_BUDGET_DISPOSITIONS = Object.freeze([
  "committed",
  "released",
  "not-reserved",
  "commit-uncertain",
  "release-uncertain",
] as const);
export type ToolBudgetDisposition = (typeof TOOL_BUDGET_DISPOSITIONS)[number];

export interface BoundToolSet {
  readonly catalogRevision: CatalogDigest;
  readonly profile: CatalogVersionRef;
  readonly projectionDigest: CatalogDigest;
  readonly handlerSetDigest: CatalogDigest;
  readonly readiness: ToolHandlerReadiness;
}
export interface OfferedToolSet {
  readonly binding: BoundToolSet;
  readonly offerId: string;
  readonly toolRefs: readonly ToolRef[];
  readonly expiresAt: string;
}
export interface BoundToolInvocation {
  readonly kind: "bound";
  readonly toolRef: ToolRef;
  readonly projectionDigest: CatalogDigest;
  readonly offerId: string;
  readonly arguments: CatalogJsonValue;
}
export type CatalogToolDispatchOutcome =
  | {
      readonly kind: "settled";
      readonly result: ToolResultEnvelope;
      readonly receipt: ToolInvocationReceipt;
    }
  | { readonly kind: "replayed"; readonly receipt: ToolInvocationReceipt };

/** Body-free replay evidence. It contains no cached arguments or model result body. */
export interface ToolInvocationReceipt {
  readonly invocationId: string;
  readonly reservationId: string | null;
  readonly settlementId: string;
  readonly budgetDisposition: ToolBudgetDisposition;
  readonly effectStarted: boolean;
  readonly status: ToolResultStatus;
}

const RECEIPT_KEYS = [
  "invocationId",
  "reservationId",
  "settlementId",
  "budgetDisposition",
  "effectStarted",
  "status",
];
const RECEIPT_ID = /^[A-Za-z0-9_.-]{1,128}$/u;
function requireReceipt(condition: boolean): asserts condition {
  if (!condition) throw new TypeError("Invalid tool invocation receipt");
}
function receiptFields(value: unknown): Record<string, unknown> {
  requireReceipt(typeof value === "object" && value !== null);
  const prototype: unknown = Object.getPrototypeOf(value);
  requireReceipt(prototype === Object.prototype || prototype === null);
  requireReceipt(Reflect.ownKeys(value).length === RECEIPT_KEYS.length);
  return Object.fromEntries(
    RECEIPT_KEYS.map((key) => {
      const field = Object.getOwnPropertyDescriptor(value, key);
      requireReceipt(field !== undefined && "value" in field && field.enumerable === true);
      return [key, field.value as unknown];
    }),
  );
}
const COMMIT_DISPOSITIONS = new Set(["committed", "commit-uncertain"]);
const UNCERTAIN_DISPOSITIONS = new Set(["commit-uncertain", "release-uncertain"]);
function validateReceiptAccounting(receipt: Record<string, unknown>): void {
  if (receipt.budgetDisposition === "not-reserved")
    requireReceipt(receipt.reservationId === null && !receipt.effectStarted);
  else
    requireReceipt(
      typeof receipt.reservationId === "string" &&
        RECEIPT_ID.test(receipt.reservationId) &&
        typeof receipt.budgetDisposition === "string" &&
        (TOOL_BUDGET_DISPOSITIONS as readonly string[]).includes(receipt.budgetDisposition) &&
        receipt.effectStarted === COMMIT_DISPOSITIONS.has(receipt.budgetDisposition),
    );
  if (
    typeof receipt.budgetDisposition === "string" &&
    UNCERTAIN_DISPOSITIONS.has(receipt.budgetDisposition)
  )
    requireReceipt(receipt.status === "failed");
}
/** Copy only bounded scalar receipt evidence; never accept cached result or argument payloads. */
export function captureToolInvocationReceipt(value: unknown): ToolInvocationReceipt {
  const receipt = receiptFields(value);
  requireReceipt(typeof receipt.invocationId === "string" && RECEIPT_ID.test(receipt.invocationId));
  requireReceipt(typeof receipt.settlementId === "string" && RECEIPT_ID.test(receipt.settlementId));
  requireReceipt(
    typeof receipt.status === "string" && Object.hasOwn(TOOL_RESULT_REASONS, receipt.status),
  );
  requireReceipt(typeof receipt.effectStarted === "boolean");
  validateReceiptAccounting(receipt);
  return deepFreeze(receipt) as unknown as ToolInvocationReceipt;
}

export interface ToolLifecycleIdentity {
  readonly correlationId: string;
  readonly parentCorrelationId?: string;
  readonly catalogRevision: CatalogDigest;
  readonly profile: CatalogVersionRef;
  readonly projectionDigest: CatalogDigest;
}
export type ToolLifecycleProjection = ToolLifecycleIdentity & {
  readonly op: typeof TOOL_LIFECYCLE_OPERATIONS.projection;
  readonly readiness: ToolHandlerReadiness;
  readonly resultCount?: number;
};
export type ToolLifecycleBound = ToolLifecycleIdentity & {
  readonly op: (typeof TOOL_LIFECYCLE_OPERATIONS)["bind-ready"];
  readonly readiness: "ready";
  readonly handlerSetDigest: CatalogDigest;
};
export type ToolLifecycleUnavailable = ToolLifecycleIdentity & {
  readonly op: (typeof TOOL_LIFECYCLE_OPERATIONS)["bind-unavailable"];
  readonly readiness: Exclude<ToolHandlerReadiness, "ready">;
  readonly reason: ToolResultReason<"failed" | "invalid" | "denied">;
};
export type ToolLifecycleStarted = ToolLifecycleIdentity & {
  readonly op: (typeof TOOL_LIFECYCLE_OPERATIONS)["invocation-started"];
  readonly invocationId: string;
  readonly toolRef: ToolRef;
  readonly state: "started";
  readonly reason: "none";
  readonly reservationId: string;
};
interface ToolLifecycleSettlement {
  readonly op: typeof TOOL_LIFECYCLE_OPERATIONS.terminal;
  readonly invocationId: string;
  readonly toolRef: ToolRef | null;
  readonly settlementId: string;
  readonly reservationId: string | null;
  readonly durationMs: number;
  readonly effectStarted: boolean;
  readonly budgetDisposition: ToolBudgetDisposition;
  readonly inputBytes?: number;
  readonly outputBytes?: number;
  readonly resultCount?: number;
  readonly truncated?: boolean;
}
export interface ToolLifecycleFailureDiagnostics {
  readonly errorKind: string;
  readonly frames: readonly string[];
  readonly causeChain: readonly string[];
}
export type ToolLifecycleTerminal = {
  readonly [Status in ToolResultStatus]: ToolLifecycleIdentity &
    ToolLifecycleSettlement & {
      readonly status: Status;
      readonly reason: ToolResultReason<Status>;
    } & (Status extends "failed"
      ? ToolLifecycleFailureDiagnostics
      : Readonly<Record<never, never>>);
}[ToolResultStatus];
export type ToolLifecycleDiscarded = ToolLifecycleIdentity & {
  readonly op: typeof TOOL_LIFECYCLE_OPERATIONS.discarded;
  readonly invocationId: string;
  readonly toolRef: ToolRef;
  readonly settlementId: string;
  readonly reason: "late-completion";
};
export type ToolLifecycleEvent =
  | ToolLifecycleProjection
  | ToolLifecycleBound
  | ToolLifecycleUnavailable
  | ToolLifecycleStarted
  | ToolLifecycleTerminal
  | ToolLifecycleDiscarded;

export function toolLifecyclePhaseFor(operation: string): ToolLifecyclePhase | undefined {
  return (Object.keys(TOOL_LIFECYCLE_OPERATIONS) as ToolLifecyclePhase[]).find(
    (phase) => TOOL_LIFECYCLE_OPERATIONS[phase] === operation,
  );
}
