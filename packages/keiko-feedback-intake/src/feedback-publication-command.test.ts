import { describe, expect, it } from "vitest";
import {
  assertFeedbackPublicationClaim,
  assertFeedbackPublicationCommand,
  feedbackPublicationCommandDigest,
} from "./feedback-publication-command.js";

const command = {
  action: "prepare-publication" as const,
  itemId: "11111111-1111-4111-8111-111111111111",
  expectedVersion: 1,
  expectedPayloadDigest: "a".repeat(64),
  idempotencyKey: "publication-command-key",
  actor: {
    issuer: "https://issuer.example",
    subject: "publisher-1",
    permissionPolicyVersion: "publish-v1",
  },
  targetKey: "public",
};

describe("feedback publication command validation", () => {
  it("accepts complete prepare and bound commands with stable content-free digests", () => {
    expect(() => {
      assertFeedbackPublicationCommand(command);
    }).not.toThrow();
    const bound = {
      ...command,
      action: "approve-publication" as const,
      preparationId: "22222222-2222-4222-8222-222222222222",
      expectedProjectionDigest: "b".repeat(64),
      expectedTargetPolicyDigest: "c".repeat(64),
    };
    delete (bound as { targetKey?: string }).targetKey;
    expect(() => {
      assertFeedbackPublicationCommand(bound);
    }).not.toThrow();
    expect(feedbackPublicationCommandDigest(command)).toBe(
      feedbackPublicationCommandDigest(command),
    );
    expect(feedbackPublicationCommandDigest(bound)).not.toBe(
      feedbackPublicationCommandDigest(command),
    );
  });

  it("fails closed for malformed claims, digest bindings, and unrecognized command keys", () => {
    expect(() => {
      assertFeedbackPublicationClaim({
        outboxId: "bad",
        workerId: "worker",
        leaseDurationMs: 1_000,
      });
    }).toThrow("invalid-request");
    expect(() => {
      assertFeedbackPublicationCommand({ ...command, expectedPayloadDigest: "bad" });
    }).toThrow("invalid-request");
    expect(() => {
      assertFeedbackPublicationCommand({ ...command, untrusted: true } as typeof command);
    }).toThrow("invalid-request");
  });
});
