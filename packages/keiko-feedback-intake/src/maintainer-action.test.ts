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
const ITEM = "11111111-1111-4111-8111-111111111111";
const TARGET = "22222222-2222-4222-8222-222222222222";

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
        ? { targetItemId: TARGET }
        : action === "reject"
          ? { reason: "not-actionable" }
          : action === "place-legal-hold"
            ? {
                policyKey: "operator-policy-1",
                reviewAt: "2026-07-12T00:00:00.000Z",
                expiresAt: "2026-07-13T00:00:00.000Z",
              }
            : {};
    const parsed = parseMaintainerAction({ ...base, action, ...extras }, ITEM, actor);
    expect(parsed).toBeDefined();
    if (parsed !== undefined) expect(permissionForAction(parsed)).toBe(permission);
  });

  it.each(["approve", "expire", "request-follow-up"])("does not expose %s", (action) => {
    expect(parseMaintainerAction({ ...base, action }, ITEM, actor)).toBeUndefined();
  });

  it("rejects unknown properties and malformed closed fields", () => {
    expect(
      parseMaintainerAction({ ...base, action: "archive", annotation: "hidden" }, ITEM, actor),
    ).toBeUndefined();
    expect(
      parseMaintainerAction({ ...base, action: "reject", reason: "arbitrary" }, ITEM, actor),
    ).toBeUndefined();
  });

  it("rejects non-canonical path and duplicate-target UUIDs", () => {
    expect(parseMaintainerAction({ ...base, action: "archive" }, "not-a-uuid", actor)).toBeUndefined();
    expect(
      parseMaintainerAction(
        { ...base, action: "mark-duplicate", targetItemId: "not-a-uuid" },
        ITEM,
        actor,
      ),
    ).toBeUndefined();
  });
});
