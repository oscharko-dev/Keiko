"use client";
import { useLayoutEffect, useRef, useState } from "react";
import { useOptionalWidgetTranslate as useTranslate } from "@/lib/optional-widget-i18n";
import { ApiError } from "@/lib/api";
import { clientErrorEvidence } from "@/lib/client-error-evidence";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { bffRequestErrorKind } from "@/lib/http";

export type ConnectorOperation = "verify" | "delete" | "rename" | "rotate" | "refresh" | "create";
interface Owner {
  active: boolean;
  busy: boolean;
}
interface OperationState {
  readonly key: string;
  readonly operation?: ConnectorOperation;
  readonly error?: string;
  readonly unconfirmed: boolean;
}
interface OperationResult {
  readonly busy: boolean;
  readonly operation: ConnectorOperation | undefined;
  readonly error: string | undefined;
  readonly unconfirmed: boolean;
  readonly run: <T>(
    kind: ConnectorOperation,
    request: () => Promise<T>,
    complete: (value: T) => void,
    failure?: (error: unknown) => string,
  ) => void;
}
const INVALIDATING_OPERATIONS = new Set<ConnectorOperation>(["verify", "rotate", "delete"]);
async function execute<T>(input: {
  readonly owner: Owner;
  readonly key: string;
  readonly request: () => Promise<T>;
  readonly complete: (value: T) => void;
  readonly failure: (error: unknown) => string;
  readonly publish: (update: (current: OperationState) => OperationState) => void;
}): Promise<void> {
  const { owner, key, publish } = input;
  try {
    const value = await input.request();
    if (owner.active) {
      input.complete(value);
      publish(() => ({ key, unconfirmed: false }));
    }
  } catch (error) {
    reportClientDiagnostic("Connector operation failed.", {
      kind: "other",
      correlationId: error instanceof ApiError ? error.correlationId : undefined,
      errorKind: bffRequestErrorKind(error),
      errorEvidence: clientErrorEvidence(error),
    });
    if (owner.active)
      publish((current) => ({
        key,
        unconfirmed: current.unconfirmed,
        error: input.failure(error),
      }));
  } finally {
    owner.busy = false;
  }
}
/** Async completion belongs to one mounted credential generation, never to its replacement. */
export function useConnectorOperation(key: string): OperationResult {
  const t = useTranslate();
  const owner = useRef<Owner>({ active: false, busy: false });
  const [state, setState] = useState<OperationState>({ key, unconfirmed: false });
  useLayoutEffect(() => {
    const current = { active: true, busy: false };
    owner.current = current;
    return (): void => {
      current.active = false;
    };
  }, [key]);
  const local: OperationState = state.key === key ? state : { key, unconfirmed: false };
  return {
    busy: local.operation !== undefined,
    operation: local.operation,
    error: local.error,
    unconfirmed: local.unconfirmed,
    run: (kind, request, complete, failure): void => {
      const current = owner.current;
      if (!current.active || current.busy) return;
      current.busy = true;
      setState((previous) => ({
        key,
        operation: kind,
        unconfirmed: INVALIDATING_OPERATIONS.has(kind) || previous.unconfirmed,
      }));
      void execute({
        owner: current,
        key,
        request,
        complete,
        publish: setState,
        failure: failure ?? ((): string => t("atlassianConnectors.live.operationFailed")),
      });
    },
  };
}
