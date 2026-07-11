import { describe, expect, it } from "vitest";
import { parseMaintainerAction, permissionForAction } from "./maintainer-action.js";

const actor = {
  issuer: "https://issuer.example",
  subject: "operator-1",
  permissionPolicyVersion: "policy-v1",
};
const base = {
  expectedVersion: 1,
  expectedPayloadDigest: "a".repeat(64),
  idempotencyKey: "idempotency-key-1",
};

describe("maintainer action contract", () => {
  it.each([
    ["archive", "feedback.review"],
    ["mark-duplicate", "feedback.review"],
    ["reject", "feedback.review"],
    ["route-private-security", "feedback.security"],
    ["place-legal-hold", "feedback.legal-hold"],
  ] as const)("maps %s to %s", (action, permission) => {
    const extras =
      action === "mark-duplicate"
        ? { targetItemId: "target" }
        : action === "reject"
          ? { reason: "not-actionable" }
          : action === "place-legal-hold"
            ? {
                policyKey: "operator-policy-1",
                reviewAt: "2026-07-12T00:00:00.000Z",
                expiresAt: "2026-07-13T00:00:00.000Z",
              }
            : {};
    const parsed = parseMaintainerAction({ ...base, action, ...extras }, "item", actor);
    expect(parsed).toBeDefined();
    if (parsed !== undefined) expect(permissionForAction(parsed)).toBe(permission);
  });

  it.each(["approve", "expire", "request-follow-up"])("does not expose %s", (action) => {
    expect(parseMaintainerAction({ ...base, action }, "item", actor)).toBeUndefined();
  });

  it("rejects unknown properties and malformed closed fields", () => {
    expect(
      parseMaintainerAction({ ...base, action: "archive", annotation: "hidden" }, "item", actor),
    ).toBeUndefined();
    expect(
      parseMaintainerAction({ ...base, action: "reject", reason: "arbitrary" }, "item", actor),
    ).toBeUndefined();
  });
});
