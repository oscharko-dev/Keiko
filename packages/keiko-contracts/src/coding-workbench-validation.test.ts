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

describe("native permission requests (#3897)", () => {
  const nativeEvent = (permissionRequest: Record<string, unknown>): unknown => ({
    schemaVersion: "1",
    eventId: "event-1",
    runId: "run-1",
    occurredAt: "2026-10-23T12:00:00.000Z",
    kind: "permission-requested",
    permissionRequest: {
      requestId: "permission-91",
      kind: "workspace-write",
      actionClass: "workspace-write",
      reasonCode: "approval-required",
      expiresAt: "2026-10-23T12:01:00.000Z",
      ...permissionRequest,
    },
  });

  it("admits an edit ask that names its OpenCode permission without a command label", () => {
    expect(validateCodingWorkbenchRuntimeEvent(nativeEvent({ nativePermission: "edit" })).ok).toBe(
      true,
    );
    expect(
      validateCodingWorkbenchRuntimeEvent(nativeEvent({ nativePermission: "external_directory" }))
        .ok,
    ).toBe(true);
  });

  it("refuses a malformed permission name and a native permission beside a supervised kind", () => {
    for (const nativePermission of ["", "Edit", "edit now", "x".repeat(40), 42]) {
      expect(validateCodingWorkbenchRuntimeEvent(nativeEvent({ nativePermission })).ok).toBe(false);
    }
    expect(
      validateCodingWorkbenchRuntimeEvent(
        nativeEvent({ nativePermission: "edit", actionKind: "file-edit" }),
      ).ok,
    ).toBe(false);
  });
});
