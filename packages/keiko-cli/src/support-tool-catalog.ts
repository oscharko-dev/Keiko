import {
  captureToolInvocationReceipt,
  toolLifecyclePhaseFor,
  type ToolInvocationReceipt,
  type ToolLifecycleEvent,
  type ToolLifecycleOperation,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-lifecycle";
import { isErrorKind } from "@oscharko-dev/keiko-contracts/runtime/observability";
export type ToolDiagnosticRedactor = (fields: unknown) => Record<string, unknown> | undefined;
export type ToolLifecycleValidator = (source: unknown) => ToolLifecycleEvent;

export type ToolCatalogLogEvidence =
  | {
      readonly kind: "unavailable";
      readonly operation: ToolLifecycleOperation;
      readonly reason: "lifecycle-validator-unavailable";
    }
  | {
      readonly kind: "lifecycle";
      readonly event: ToolLifecycleEvent;
      readonly restoredFields: readonly string[];
      readonly receipt?: ToolInvocationReceipt;
    }
  | {
      readonly kind: "sink-failure";
      readonly sink: "primary" | "auxiliary" | "unknown";
      readonly diagnostics: "validated" | "unavailable";
      readonly frames?: readonly string[];
      readonly causeChain?: readonly string[];
      readonly errorKind?: string;
    }
  | {
      readonly kind: "invalid";
      readonly operation: ToolLifecycleOperation;
      readonly reason: "invalid-lifecycle-evidence";
    };

const LOG_ENVELOPE = new Set([
  "ts",
  "schemaVersion",
  "pid",
  "instanceId",
  "seq",
  "level",
  "category",
]);

function restoreTerminalFields(candidate: Record<string, unknown>): readonly string[] {
  const restored: string[] = [];
  const restore = (key: string, value: unknown): void => {
    if (!Object.hasOwn(candidate, key)) {
      candidate[key] = value;
      restored.push(key);
    }
  };
  if (candidate.op !== "tool-catalog.invocation-settled") return restored;
  if (
    candidate.budgetDisposition === "not-reserved" &&
    candidate.effectStarted === false &&
    candidate.status !== "completed"
  ) {
    restore("reservationId", null);
    restore("toolRef", null);
  }
  if (candidate.status === "failed" && isErrorKind(candidate.errorKind)) {
    restore("frames", []);
    restore("causeChain", []);
  }
  return restored;
}

function receiptFor(event: ToolLifecycleEvent): ToolInvocationReceipt | undefined {
  if (event.op !== "tool-catalog.invocation-settled") return undefined;
  return captureToolInvocationReceipt({
    invocationId: event.invocationId,
    reservationId: event.reservationId,
    settlementId: event.settlementId,
    budgetDisposition: event.budgetDisposition,
    effectStarted: event.effectStarted,
    status: event.status,
  });
}

function lifecycleEvidence(
  record: Readonly<Record<string, unknown>>,
  validateLifecycle: ToolLifecycleValidator,
): ToolCatalogLogEvidence {
  const candidate = Object.fromEntries(
    Object.entries(record).filter(([key]) => !LOG_ENVELOPE.has(key)),
  );
  const restoredFields = restoreTerminalFields(candidate);
  try {
    if (record.category !== "security") throw new TypeError("Invalid lifecycle category");
    const event = validateLifecycle(candidate);
    const receipt = receiptFor(event);
    return {
      kind: "lifecycle",
      event,
      restoredFields,
      ...(receipt === undefined ? {} : { receipt }),
    };
  } catch {
    return {
      kind: "invalid",
      operation: record.op as ToolLifecycleOperation,
      reason: "invalid-lifecycle-evidence",
    };
  }
}

/** Reads structured evidence inside the existing log parser; this does not grant runtime authority. */
export function readToolCatalogEvidence(
  record: Readonly<Record<string, unknown>>,
  validateLifecycle?: ToolLifecycleValidator,
  redactDiagnostics?: ToolDiagnosticRedactor,
): ToolCatalogLogEvidence | undefined {
  if (typeof record.op !== "string") return undefined;
  if (toolLifecyclePhaseFor(record.op) !== undefined) {
    if (validateLifecycle === undefined)
      return {
        kind: "unavailable",
        operation: record.op as ToolLifecycleOperation,
        reason: "lifecycle-validator-unavailable",
      };
    return lifecycleEvidence(record, validateLifecycle);
  }
  if (record.op !== "tool-catalog.lifecycle-sink-failed") return undefined;
  return {
    kind: "sink-failure",
    sink: sinkIdentity(record.source),
    ...sinkDiagnostics(record, redactDiagnostics),
    ...(isErrorKind(record.errorKind) ? { errorKind: record.errorKind } : {}),
  };
}

function sinkDiagnostics(
  record: Readonly<Record<string, unknown>>,
  redact: ToolDiagnosticRedactor | undefined,
): Pick<
  Extract<ToolCatalogLogEvidence, { kind: "sink-failure" }>,
  "diagnostics" | "frames" | "causeChain"
> {
  if (redact === undefined) return { diagnostics: "unavailable" };
  const fields = redact({ frames: record.frames, causeChain: record.causeChain });
  const frames = diagnosticStrings(fields?.frames);
  const causeChain = diagnosticStrings(fields?.causeChain);
  return {
    diagnostics: "validated",
    ...(frames === undefined ? {} : { frames }),
    ...(causeChain === undefined ? {} : { causeChain }),
  };
}

function diagnosticStrings(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) && value.every((item): item is string => typeof item === "string")
    ? value
    : undefined;
}

function sinkIdentity(source: unknown): "primary" | "auxiliary" | "unknown" {
  if (source === "tool-catalog-lifecycle-primary") return "primary";
  if (source === "tool-catalog-lifecycle-auxiliary") return "auxiliary";
  return "unknown";
}

export function toolCatalogWarnings(
  evidence: readonly ToolCatalogLogEvidence[],
): readonly string[] {
  const warnings: string[] = [];
  if (evidence.some((entry) => entry.kind === "unavailable"))
    warnings.push(
      "tool lifecycle validator unavailable — qualified identity and settlement remain unknown",
    );
  if (
    evidence.some((entry) => entry.kind === "sink-failure" && entry.diagnostics === "unavailable")
  )
    warnings.push(
      "tool sink diagnostic validator unavailable — structured failure details remain unknown",
    );
  if (evidence.some((entry) => entry.kind === "invalid"))
    warnings.push(
      "invalid tool lifecycle evidence — identity and settlement cannot be reconstructed for those lines",
    );
  if (evidence.some((entry) => entry.kind === "lifecycle" && entry.restoredFields.length > 0))
    warnings.push(
      "tool lifecycle restoredFields names omissions reconstructed from the closed contract; absent nullable fields are not independently observed",
    );
  if (evidence.some((entry) => entry.kind === "sink-failure"))
    warnings.push(
      "tool lifecycle sink failure was observed; an auxiliary failure is not a primary failure and absent records do not prove successful persistence",
    );
  if (
    evidence.some(
      (entry) =>
        entry.kind === "lifecycle" &&
        (entry.receipt?.budgetDisposition === "commit-uncertain" ||
          entry.receipt?.budgetDisposition === "release-uncertain"),
    )
  )
    warnings.push(
      "tool budget acknowledgement is uncertain — do not infer a committed or released reservation",
    );
  return warnings;
}
