import { describe, expect, it } from "vitest";
import {
  GIT_DELIVERY_OBSERVATION_FAILURE_STATES,
  gitDeliveryObservationFailure,
  isGitDeliveryObservationFailure,
  isGitDeliveryReadCompleteness,
} from "./git-delivery-observation.js";

describe("shared bounded provider observation contract", () => {
  it("does not trade inherited fields for unapproved payload keys", () => {
    const failure: unknown = Object.assign(Object.create({ state: "unknown" }) as object, {
      reason: "provider-forbidden",
      body: "private",
    });
    expect(isGitDeliveryObservationFailure(failure)).toBe(false);
    const complete: unknown = Object.assign(
      Object.create({ pages: 1, entries: 0, bytes: 0 }) as object,
      { complete: true, body: "private", prompt: "private", query: "private" },
    );
    expect(isGitDeliveryReadCompleteness(complete)).toBe(false);
  });
  it("defines one closed classification shared by CI and lifecycle readers", () => {
    for (const [reason, state] of Object.entries(GIT_DELIVERY_OBSERVATION_FAILURE_STATES)) {
      const failure = gitDeliveryObservationFailure(
        reason as keyof typeof GIT_DELIVERY_OBSERVATION_FAILURE_STATES,
      );
      expect(failure).toEqual({ reason, state });
      expect(isGitDeliveryObservationFailure(failure)).toBe(true);
      expect(isGitDeliveryObservationFailure({ ...failure, state: "technical-ready" })).toBe(false);
      expect(isGitDeliveryObservationFailure({ ...failure, message: "private body" })).toBe(false);
    }
    expect(isGitDeliveryObservationFailure(null)).toBe(false);
    expect(isGitDeliveryObservationFailure({ reason: "invented", state: "unknown" })).toBe(false);
  });
  it("distinguishes local authority, provider visibility and retryable observations", () => {
    expect(gitDeliveryObservationFailure("authority-denied").state).toBe("blocked");
    expect(gitDeliveryObservationFailure("provider-forbidden").state).toBe("unknown");
    expect(gitDeliveryObservationFailure("provider-not-found").state).toBe("unknown");
    expect(gitDeliveryObservationFailure("rate-limited").state).toBe("pending");
  });
  it("requires bounded explicit completeness and a reason on incomplete reads", () => {
    const complete = { complete: true, pages: 1, entries: 5, bytes: 20 };
    expect(isGitDeliveryReadCompleteness(complete)).toBe(true);
    const failure = gitDeliveryObservationFailure("pagination-exhausted");
    expect(isGitDeliveryReadCompleteness({ ...complete, complete: false, failure })).toBe(true);
    for (const bad of [
      { ...complete, complete: false },
      { ...complete, failure },
      { ...complete, pages: -1 },
      { ...complete, entries: 1.5 },
      { ...complete, bytes: Infinity },
      { ...complete, token: "private" },
      null,
    ])
      expect(isGitDeliveryReadCompleteness(bad)).toBe(false);
  });
});
