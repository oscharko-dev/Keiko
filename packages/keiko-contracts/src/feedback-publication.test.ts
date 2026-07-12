import { describe, expect, it } from "vitest";
import {
  FEEDBACK_PUBLICATION_FAILURE_CODES_V1,
  FEEDBACK_PUBLICATION_OUTBOX_STATUSES_V1,
  isFeedbackPublicationTargetPolicySnapshotV1,
} from "./feedback-publication.js";

describe("feedback publication contracts", () => {
  const target = {
    apiOrigin: "https://api.github.com",
    repositoryId: "123456",
    owner: "oscharko-dev",
    repository: "Keiko",
    installationId: "987654",
    labels: ["type: user finding", "source: feedback"],
    targetKey: "keiko-public-findings",
    labelPolicyVersion: "labels-2026-07",
    targetPolicyVersion: "github-target-v1",
  } as const;

  it("accepts only a complete fixed-origin target-policy snapshot", () => {
    expect(isFeedbackPublicationTargetPolicySnapshotV1(target)).toBe(true);
    expect(isFeedbackPublicationTargetPolicySnapshotV1({ ...target, repositoryId: "0" })).toBe(
      false,
    );
    expect(
      isFeedbackPublicationTargetPolicySnapshotV1({
        ...target,
        repositoryId: "9223372036854775808",
      }),
    ).toBe(false);
    expect(
      isFeedbackPublicationTargetPolicySnapshotV1({
        ...target,
        labels: ["duplicate", "duplicate"],
      }),
    ).toBe(false);
    expect(
      isFeedbackPublicationTargetPolicySnapshotV1({ ...target, apiOrigin: "https://evil.test" }),
    ).toBe(false);
  });

  it("pins target and label policy identifiers to approval-column limits", () => {
    expect(
      isFeedbackPublicationTargetPolicySnapshotV1({
        ...target,
        targetKey: "t".repeat(100),
        labelPolicyVersion: "l".repeat(64),
        targetPolicyVersion: "p".repeat(128),
      }),
    ).toBe(true);
    expect(
      isFeedbackPublicationTargetPolicySnapshotV1({ ...target, targetKey: "t".repeat(101) }),
    ).toBe(false);
    expect(
      isFeedbackPublicationTargetPolicySnapshotV1({
        ...target,
        labelPolicyVersion: "l".repeat(65),
      }),
    ).toBe(false);
    expect(
      isFeedbackPublicationTargetPolicySnapshotV1({
        ...target,
        targetPolicyVersion: "p".repeat(129),
      }),
    ).toBe(false);
  });

  it("keeps delivery and failure vocabularies closed", () => {
    expect(FEEDBACK_PUBLICATION_OUTBOX_STATUSES_V1).toEqual([
      "unclaimed",
      "claimed",
      "may-have-committed",
      "retryable-failure",
      "manual-reconciliation",
      "succeeded",
      "cancelled-private",
    ]);
    expect(FEEDBACK_PUBLICATION_FAILURE_CODES_V1).toContain("target-policy-drift");
    expect(FEEDBACK_PUBLICATION_FAILURE_CODES_V1).toContain("manual-remediation-required");
  });
});
