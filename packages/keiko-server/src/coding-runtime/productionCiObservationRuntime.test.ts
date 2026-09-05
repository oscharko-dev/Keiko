import { describe, expect, it } from "vitest";
import type { CodingWorkbenchRuntimeEvent } from "@oscharko-dev/keiko-contracts";
import { validateCodingWorkbenchRuntimeEvent } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-validation";
import { readySnapshot } from "../gitDelivery/ciObservationTest/_support.js";
import { publishCiObservation } from "./productionCiObservationRuntime.js";

describe("production CI readiness events", () => {
  it.each(["technical-ready", "pending", "failed", "blocked", "unknown"] as const)(
    "publishes the %s observation through the normal evidence validator",
    (state) => {
      const events: CodingWorkbenchRuntimeEvent[] = [];
      const snapshot = { ...readySnapshot(), state };
      publishCiObservation(snapshot, (event): void => {
        events.push(event);
      });
      expect(events).toHaveLength(1);
      expect(validateCodingWorkbenchRuntimeEvent(events[0]).ok).toBe(true);
      expect(events[0]).toMatchObject({
        runId: snapshot.runId,
        occurredAt: snapshot.observedAt,
        kind: "artifact-produced",
        artifactKind: "ci-readiness",
        artifactLabel: `ci-readiness-${state}`,
      });
      expect(JSON.stringify(events)).not.toContain(snapshot.repository);
    },
  );
});
