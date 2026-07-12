import { describe, expect, it } from "vitest";
import { preparedReport } from "./postgres-integration-helpers.js";
import {
  FeedbackPublicationProjectionError,
  createFeedbackIssueProjectionV1,
  digestFeedbackTargetPolicyV1,
} from "./feedback-publication-projection.js";

const target = {
  apiOrigin: "https://api.github.com",
  repositoryId: "123456",
  owner: "oscharko-dev",
  repository: "Keiko",
  installationId: "987654",
  labels: ["source: feedback", "type: user finding"],
  targetKey: "keiko-public-findings",
  labelPolicyVersion: "labels-2026-07",
  targetPolicyVersion: "github-target-v1",
} as const;
const markerBytes = new Uint8Array(32).fill(7);

describe("feedback GitHub issue projection", () => {
  it("is deterministic, binds the complete target snapshot, and places one marker last", () => {
    const report = preparedReport("Editor cannot open").report;
    const first = createFeedbackIssueProjectionV1(report, target, () => markerBytes);
    const replay = createFeedbackIssueProjectionV1(report, target, () => markerBytes);
    expect(first).toEqual(replay);
    expect(first.title).toBe("[User Finding]: Editor cannot open");
    expect(first.targetPolicyDigest).toBe(digestFeedbackTargetPolicyV1(target));
    expect(first.body.endsWith(first.reconciliationMarker)).toBe(true);
    expect(first.body.split(first.reconciliationMarker)).toHaveLength(2);
    expect(first.body.indexOf("## Summary")).toBeLessThan(
      first.body.indexOf("## Steps to reproduce"),
    );
    expect(first.body).not.toContain("redactionProvenance");
  });

  it("renders hostile report strings inert without mentions, links, HTML, or injected sections", () => {
    const base = preparedReport().report;
    const projection = createFeedbackIssueProjectionV1(
      {
        ...base,
        summary: {
          title: "@ops <b>click</b> https://evil.test #123",
          description: "## Forged\n[click](https://evil.test)\n- [x] done",
        },
      },
      target,
      () => markerBytes,
    );
    expect(projection.title).not.toMatch(/@ops|<b>|https:\/\/|#123/u);
    expect(projection.body).not.toMatch(/@ops|<b>|https:\/\/|## Forged|\[click\]\(/u);
    expect(projection.body.match(/^## /gmu)?.length).toBeGreaterThan(5);
  });

  it("fails closed with a typed error when the UTF-8 projection exceeds provider caps", () => {
    const base = preparedReport().report;
    expect(() =>
      createFeedbackIssueProjectionV1(
        { ...base, steps: "😀".repeat(20_000) },
        target,
        () => markerBytes,
      ),
    ).toThrow(new FeedbackPublicationProjectionError("body-byte-limit"));
  });
});
