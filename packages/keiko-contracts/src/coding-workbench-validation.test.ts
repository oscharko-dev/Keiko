import { describe, expect, it } from "vitest";

import {
  validateCodingWorkbenchPermissionRequest,
  validateCodingWorkbenchRuntimeEvent,
} from "./coding-workbench-validation.js";

describe("coding workbench auxiliary event validation", () => {
  it("accepts a content-free skill event and rejects raw result content", () => {
    const event = {
      schemaVersion: "1",
      eventId: "evt-2387",
      runId: "run-2387",
      occurredAt: "2026-07-19T00:00:00.000Z",
      kind: "skill-invoked",
      skillId: "skl_repo-structure-summary@1",
      skillInvocation: "implicit",
      auxiliaryOutcome: "accepted",
    };
    expect(validateCodingWorkbenchRuntimeEvent(event).ok).toBe(true);
    expect(validateCodingWorkbenchRuntimeEvent({ ...event, result: "raw content" }).ok).toBe(false);
  });

  it("rejects impossible calendar dates instead of accepting their rolled-forward instants", () => {
    expect(
      validateCodingWorkbenchPermissionRequest({
        requestId: "perm-2387",
        kind: "workspace-write",
        actionClass: "workspace-write",
        reasonCode: "verification-required",
        expiresAt: "2026-02-31T00:00:00Z",
      }).ok,
    ).toBe(false);
    expect(
      validateCodingWorkbenchRuntimeEvent({
        schemaVersion: "1",
        eventId: "evt-2387",
        runId: "run-2387",
        occurredAt: "2026-04-31T00:00:00.000Z",
        kind: "skill-invoked",
        skillId: "skl_repo-structure-summary@1",
        skillInvocation: "implicit",
        auxiliaryOutcome: "accepted",
      }).ok,
    ).toBe(false);
  });
});
