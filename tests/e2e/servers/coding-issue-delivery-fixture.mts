import { readFileSync, writeFileSync } from "node:fs";
import { createProductionDraftDeliveryDependencies } from "../../../packages/keiko-server/src/coding-runtime/productionDraftDeliveryDependencies.js";
import type { DraftDeliveryDependencies } from "../../../packages/keiko-server/src/gitDelivery/draftDeliveryTypes.js";
import type { UiHandlerDeps } from "../../../packages/keiko-server/src/deps.js";
import type { CodingRuntimeSnapshotStore } from "../../../packages/keiko-server/src/coding-runtime/codingRuntimeSnapshotStore.js";
import type { ProductionRuntimeBackendInput } from "../../../packages/keiko-server/src/coding-runtime/productionCodingRuntimeResolver.js";
import type { CodingToolResult } from "../../../packages/keiko-server/src/coding-runtime/codingToolIpc.js";
import {
  DELIVERY_TITLE,
  deliveryProviderState,
  type DeliveryFixtureOperation,
} from "../support/coding-issue-delivery.js";

export function deferredDeliveryDependencies(
  deps: () => UiHandlerDeps,
  snapshots: CodingRuntimeSnapshotStore,
  ciReader?: DraftDeliveryDependencies["ciReader"],
): DraftDeliveryDependencies {
  let cached: DraftDeliveryDependencies | undefined;
  const actual = (): DraftDeliveryDependencies => {
    cached ??= createProductionDraftDeliveryDependencies(deps(), snapshots);
    if (cached === undefined) throw new Error("delivery-fixture-dependencies-unavailable");
    return cached;
  };
  return {
    snapshots,
    get mutationDeps(): DraftDeliveryDependencies["mutationDeps"] {
      return actual().mutationDeps;
    },
    get execution(): NonNullable<DraftDeliveryDependencies["execution"]> {
      const value = actual().execution;
      if (value === undefined) throw new Error("delivery-fixture-execution-unavailable");
      return value;
    },
    ciReader: (context) =>
      ciReader === undefined ? actual().ciReader?.(context) : ciReader(context),
    resolveTarget: (context) => actual().resolveTarget(context),
    inspectionAdapter: (context) => actual().inspectionAdapter(context),
    publishSeams: (context) => actual().publishSeams(context),
    pullRequestSeams: (context) => actual().pullRequestSeams(context),
  };
}

/** Selects the one accepted ref at the controlled provider boundary, never grants runtime authority. */
export function selectDeliveryProviderRef(
  stateDir: string,
  run: ProductionRuntimeBackendInput,
): void {
  const path = deliveryProviderState(stateDir);
  const state = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  writeFileSync(path, JSON.stringify({ ...state, headRef: run.context.branch.headRef }));
}

export class DeliveryFixtureDriver {
  private proposalId: string | undefined;
  public async invoke(
    run: ProductionRuntimeBackendInput,
    operation: DeliveryFixtureOperation,
    id: number,
  ): Promise<CodingToolResult> {
    const intent = operation.startsWith("push") ? "push" : "pull-request";
    let phase = "execute";
    if (operation.endsWith("propose")) phase = "propose";
    if (operation === "reconcile") phase = "reconcile";
    const identity = `delivery-fixture-${String(id)}`;
    const result = await run.toolFacade.execute({
      capability: run.minted.toolFacadeCapability,
      body: JSON.stringify({
        action: "delivery",
        intent,
        phase,
        actionId: identity,
        idempotencyKey: identity,
        ...(phase === "execute" ? { proposalId: this.proposalId } : {}),
        ...(operation === "pr-propose" ? { title: DELIVERY_TITLE } : {}),
      }),
    });
    if ("draftDelivery" in result && result.draftDelivery.status === "recorded")
      this.proposalId = result.draftDelivery.record.proposalId;
    return result;
  }
}
