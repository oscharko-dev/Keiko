"use client";

import { useState, type ReactNode } from "react";
import type { CodingWorkbenchGatewayServiceRepairOutcome } from "@oscharko-dev/keiko-contracts";

import { repairCodingGatewayService } from "@/lib/coding-gateway-service-api";
import { useCodingWorkbenchTranslate } from "./coding-workbench-i18n";
import type { CodingWorkbenchMessageKey } from "./coding-workbench-i18n.en";
import { gatewayServiceRepairable } from "./codingWorkbenchLabels";
import windowStyles from "./CodingWorkbenchWindow.module.css";

// One click instead of a terminal command (ADR-0043 D19): Repair asks the server to run the same
// idempotent native install `keiko gateway-service repair` runs. Windows asks the person through
// UAC; the server records the closed outcome under this request's correlation.

type RepairStatus =
  | { readonly kind: "idle" }
  | { readonly kind: "pending" }
  | {
      readonly kind: "settled";
      readonly outcome: CodingWorkbenchGatewayServiceRepairOutcome | "error";
    };

const OUTCOME_KEYS: Readonly<
  Record<CodingWorkbenchGatewayServiceRepairOutcome | "error", CodingWorkbenchMessageKey>
> = {
  ready: "codingWorkbench.gatewayService.repairReady",
  declined: "codingWorkbench.gatewayService.repairDeclined",
  failed: "codingWorkbench.gatewayService.repairFailed",
  unavailable: "codingWorkbench.gatewayService.repairUnavailable",
  busy: "codingWorkbench.gatewayService.repairBusy",
  error: "codingWorkbench.gatewayService.repairFailed",
};

export interface CodingWorkbenchGatewayRepairProps {
  /** The server's closed unavailable reason; Repair shows only for a repairable broker state. */
  readonly reason: string | undefined;
  /** Reads readiness again, so a repaired broker clears the notice without a reload. */
  readonly onRepaired: () => Promise<void>;
  /** Injectable for tests; production posts to the server's repair route. */
  readonly repair?: () => Promise<{ readonly outcome: CodingWorkbenchGatewayServiceRepairOutcome }>;
}

export function CodingWorkbenchGatewayRepair({
  reason,
  onRepaired,
  repair = repairCodingGatewayService,
}: CodingWorkbenchGatewayRepairProps): ReactNode {
  const t = useCodingWorkbenchTranslate();
  const [status, setStatus] = useState<RepairStatus>({ kind: "idle" });
  const repairable = gatewayServiceRepairable(reason);
  if (!repairable && status.kind !== "settled") return null;

  const onRepair = (): void => {
    setStatus({ kind: "pending" });
    // The request failure itself is the settled `error` sentence; the readiness read reports its
    // own failures through the Workbench's existing refresh state.
    void repair().then(
      ({ outcome }) => {
        setStatus({ kind: "settled", outcome });
        return onRepaired();
      },
      () => {
        setStatus({ kind: "settled", outcome: "error" });
      },
    );
  };

  return (
    <div data-testid="coding-workbench-gateway-repair">
      {repairable ? (
        <button
          className={`${windowStyles.button} ${windowStyles.buttonPrimary}`}
          type="button"
          disabled={status.kind === "pending"}
          onClick={onRepair}
        >
          {t("codingWorkbench.gatewayService.repair")}
        </button>
      ) : null}
      {status.kind === "pending" ? (
        <output className={windowStyles.boundaryNote}>
          {t("codingWorkbench.gatewayService.repairing")}
        </output>
      ) : null}
      {status.kind === "settled" ? (
        <output className={windowStyles.boundaryNote} data-outcome={status.outcome}>
          {t(OUTCOME_KEYS[status.outcome])}
        </output>
      ) : null}
    </div>
  );
}
