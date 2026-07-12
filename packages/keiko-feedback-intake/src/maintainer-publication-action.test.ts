import { describe, expect, it } from "vitest";
import { parseMaintainerPublicationRequest } from "./maintainer-publication-action.js";

const PREPARATION = "11111111-1111-4111-8111-111111111111";
const DIGEST = "a".repeat(64);

describe("maintainer publication request parser", () => {
  it("accepts only the closed prepare projection", () => {
    const request = {
      action: "prepare-publication",
      expectedVersion: 1,
      targetKey: "public-feedback",
      idempotencyKey: "prepare-request-key",
    } as const;
    expect(parseMaintainerPublicationRequest(request)).toEqual(request);
    expect(parseMaintainerPublicationRequest({ ...request, itemId: PREPARATION })).toBeUndefined();
    expect(
      parseMaintainerPublicationRequest({ ...request, expectedPayloadDigest: DIGEST }),
    ).toBeUndefined();
    expect(parseMaintainerPublicationRequest({ ...request, actor: {} })).toBeUndefined();
    expect(parseMaintainerPublicationRequest({ ...request, expectedVersion: 0 })).toBeUndefined();
  });

  it.each(["approve-publication", "cancel-publication-route-private"] as const)(
    "accepts only exact identifier and digest fields for %s",
    (action) => {
      const request = {
        action,
        preparationId: PREPARATION,
        expectedProjectionDigest: DIGEST,
        expectedTargetPolicyDigest: "b".repeat(64),
        idempotencyKey: "bound-request-key",
      } as const;
      expect(parseMaintainerPublicationRequest(request)).toEqual(request);
      expect(parseMaintainerPublicationRequest({ ...request, expectedVersion: 1 })).toBeUndefined();
      expect(
        parseMaintainerPublicationRequest({ ...request, preparationId: "not-a-uuid" }),
      ).toBeUndefined();
      expect(
        parseMaintainerPublicationRequest({ ...request, expectedProjectionDigest: "A".repeat(64) }),
      ).toBeUndefined();
    },
  );
});
