import { randomBytes, createHash } from "node:crypto";
import type { CodingWorkbenchRuntimeEvent } from "@oscharko-dev/keiko-contracts";
import type { ReadinessSnapshot } from "@oscharko-dev/keiko-contracts/runtime/git-delivery-provider";
import { validateCodingWorkbenchRuntimeEvent } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-validation";
import {
  CiObservationController,
  type CiObservationService,
} from "../gitDelivery/ciObservationService.js";
import type { DraftDeliveryDependencies } from "../gitDelivery/draftDeliveryTypes.js";
import type {
  VerifiedCommitRuntimeBinding,
  VerifiedCommitRuntimeDependencies,
} from "./productionVerifiedCommitRuntime.js";
import { resolveDraftDeliveryContext } from "./productionDraftDeliveryRuntime.js";
import type { CiRepairExecutionBudget } from "./codingRuntimeCiRepairController.js";

export function createProductionCiObservationService(
  deps: DraftDeliveryDependencies | undefined,
  verified: VerifiedCommitRuntimeDependencies | undefined,
  binding: VerifiedCommitRuntimeBinding,
  onEvent: (event: CodingWorkbenchRuntimeEvent) => void,
  repairBudget?: CiRepairExecutionBudget,
): CiObservationService | undefined {
  if (
    deps?.snapshots.ciReadiness === undefined ||
    deps.snapshots.ciRepairBudget === undefined ||
    verified === undefined
  )
    return undefined;
  return new CiObservationController({
    ...deps,
    persistence: deps.snapshots.ciReadiness,
    context: () => resolveDraftDeliveryContext(verified, binding),
    onChanged: (snapshot): void => {
      repairBudget?.observed(snapshot);
      publishCiObservation(snapshot, onEvent);
    },
  });
}
export function publishCiObservation(
  snapshot: ReadinessSnapshot,
  onEvent: (event: CodingWorkbenchRuntimeEvent) => void,
): void {
  const encoded = JSON.stringify(snapshot);
  const event: CodingWorkbenchRuntimeEvent = {
    schemaVersion: "1",
    eventId: `event-${BigInt(`0x${randomBytes(16).toString("hex")}`).toString(10)}`,
    runId: snapshot.runId,
    occurredAt: snapshot.observedAt,
    kind: "artifact-produced",
    artifactKind: "ci-readiness",
    artifactLabel: `ci-readiness-${snapshot.state}`,
    artifactDigest: createHash("sha256").update(encoded).digest("hex"),
    artifactBytes: Buffer.byteLength(encoded, "utf8"),
  };
  if (!validateCodingWorkbenchRuntimeEvent(event).ok)
    throw new TypeError("Invalid CI readiness event");
  onEvent(event);
}
