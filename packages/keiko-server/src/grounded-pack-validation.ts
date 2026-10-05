import {
  validateConnectedContextPack,
  type ConnectedContextPack,
} from "@oscharko-dev/keiko-contracts/connected-context";
import { ContextPackValidationError } from "@oscharko-dev/keiko-workflows";
import { correlationIdOrUnknown } from "./correlation.js";
import type { UiHandlerDeps } from "./deps.js";
import {
  emitServerDiagnostic,
  safeProperty,
  serverDiagnosticFromError,
  type PackValidationReason,
} from "./diagnostics-log.js";

export const GROUNDED_PACK_VALIDATION_MESSAGE = "Grounded answer context pack failed validation.";

export interface GroundedPackValidationFailure {
  readonly error: unknown;
  readonly validationReasons: readonly PackValidationReason[];
  readonly violationCount?: number | undefined;
  readonly validatorThrew: boolean;
  readonly originalCode?: "CONTEXT_PACK_OMISSIONS_INVALID" | undefined;
}

const REASON_CLASSES: readonly (readonly [RegExp, PackValidationReason])[] = [
  [/^omitted.*scopePath invalid/u, "omissions-invalid-path"],
  [/omitted.*duplicate/u, "omissions-duplicate"],
  [/omitted.*overlap/u, "omissions-overlap"],
  [/omitted.*outside selected scope/u, "omissions-outside-scope"],
  [/schemaVersion/u, "schema-version"],
  [/stableId/u, "stable-id"],
  [/omitted/u, "omissions"],
  [/scope/u, "scope"],
  [/query/u, "query"],
  [/excerpt|atom/u, "excerpts"],
  [/files|file\[/u, "files"],
  [/budget|usage/u, "budget"],
  [/uncertainty/u, "uncertainty"],
  [/emittedAt/u, "timestamp"],
  [/ledger/u, "ledger"],
  [/diagnostics/u, "diagnostics"],
  [/^pack invalid$/u, "invalid-shape"],
];

function closedValidationReasons(reasons: readonly unknown[]): readonly PackValidationReason[] {
  return [
    ...new Set(
      reasons.map((reason): PackValidationReason => {
        if (typeof reason !== "string") return "other";
        return REASON_CLASSES.find(([pattern]) => pattern.test(reason))?.[1] ?? "other";
      }),
    ),
  ];
}

export function caughtGroundedPackValidation(
  error: unknown,
): GroundedPackValidationFailure | undefined {
  if (!(error instanceof ContextPackValidationError)) return undefined;
  const reasons = safeProperty(error, "validationReasons");
  return {
    error,
    originalCode: error.code,
    violationCount: error.violationCount,
    validatorThrew: true,
    validationReasons: closedValidationReasons(
      Array.isArray(reasons) ? reasons : ["pack.omitted invalid"],
    ),
  };
}

interface GroundedPackValidationContext {
  readonly deps: Pick<UiHandlerDeps, "diagnostics" | "redactor">;
  readonly correlationId: string | undefined;
  readonly outcome: "request-failed" | "source-skipped";
  readonly sourceIndex?: number;
}

function recordInspectedPackFailure(
  failure: GroundedPackValidationFailure,
  context: GroundedPackValidationContext,
): GroundedPackValidationFailure {
  recordGroundedPackValidation(
    context.deps,
    context.correlationId,
    failure,
    context.outcome,
    context.sourceIndex,
  );
  return failure;
}

export function inspectGroundedPack(
  pack: ConnectedContextPack,
  context: GroundedPackValidationContext,
): GroundedPackValidationFailure | undefined {
  let result: ReturnType<typeof validateConnectedContextPack>;
  try {
    result = validateConnectedContextPack(pack);
  } catch (error) {
    return recordInspectedPackFailure(
      { error, validationReasons: ["invalid-shape"], validatorThrew: true },
      context,
    );
  }
  if (result.ok) return undefined;
  return recordInspectedPackFailure(
    {
      error: new TypeError(GROUNDED_PACK_VALIDATION_MESSAGE),
      violationCount: result.reasons.length,
      validationReasons: closedValidationReasons(result.reasons),
      validatorThrew: false,
    },
    context,
  );
}

export function recordGroundedPackValidation(
  deps: Pick<UiHandlerDeps, "diagnostics" | "redactor">,
  correlationId: string | undefined,
  failure: GroundedPackValidationFailure,
  outcome: "request-failed" | "source-skipped",
  sourceIndex?: number,
): void {
  emitServerDiagnostic(deps.diagnostics, {
    ...serverDiagnosticFromError({
      correlationId: correlationIdOrUnknown(correlationId),
      operation: "POST /api/chats/messages/grounded",
      source: "grounded.qa.pack-validation",
      error: failure.error,
      summary: "grounded-context-pack-validation-failed",
      redact: (message): string => deps.redactor(message) as string,
    }),
    code: "GROUNDED_PACK_VALIDATION_FAILED",
    diagnosticStage: "grounded-pack-validation",
    diagnosticOutcome: outcome,
    validationReasons: failure.validationReasons,
    violationCount: failure.violationCount,
    validatorThrew: failure.validatorThrew,
    originalCode: failure.originalCode,
    sourceIndex,
    ...(outcome === "request-failed" ? { httpStatus: 500 } : {}),
  });
}
