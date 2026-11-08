import { describe, expect, it } from "vitest";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { executeJiraProjectRead, readJiraBoundProject } from "./jira-managed-projects.js";
import {
  jiraProjectReview,
  jiraProjectReviewFields,
  sameProjectReview,
} from "./jira-project-review.js";

const REVIEW = {
  id: "9223372036854775807",
  key: "SYN",
  name: "Reviewed project",
  archived: false,
  projectTypeKey: "software",
} as const;
function native(body: Record<string, unknown>): JiraMutationRequest {
  return () => Promise.resolve({ ok: true, status: 200, body });
}

describe("native ProjectBean review evidence", () => {
  it("retains exact int64, observed false and the actual optional project type", () => {
    expect(jiraProjectReview(REVIEW, true)).toEqual(REVIEW);
    expect(jiraProjectReviewFields(jiraProjectReview(REVIEW))).toEqual({ reviewSnapshot: REVIEW });
    expect(sameProjectReview(REVIEW, { ...REVIEW, archived: true })).toBe(false);
    expect(sameProjectReview(REVIEW, { ...REVIEW, projectTypeKey: "business" })).toBe(false);
  });
  it.each([undefined, null, "false", 0])("never defaults archived=%s", (archived) => {
    expect(jiraProjectReview({ ...REVIEW, archived })).toBeUndefined();
    expect(jiraProjectReviewFields(undefined)).toEqual({});
  });
  it("keeps a missing native type unknown and refuses explicit null in a reviewed input", () => {
    const withoutType = {
      id: REVIEW.id,
      key: REVIEW.key,
      name: REVIEW.name,
      archived: REVIEW.archived,
    };
    expect(jiraProjectReview(withoutType, true)).toEqual(withoutType);
    expect(jiraProjectReview({ ...withoutType, projectTypeKey: null })).toEqual(withoutType);
    expect(jiraProjectReview({ ...withoutType, projectTypeKey: null }, true)).toBeUndefined();
    expect(jiraProjectReview({ ...REVIEW, ignored: true }, true)).toBeUndefined();
  });
  it("adds an optional matched snapshot to ordinary project reads without native self URLs", async () => {
    const result = await executeJiraProjectRead(
      "jira.project",
      { projectIdOrKey: REVIEW.id },
      native({ ...REVIEW, self: "https://remote.invalid/project/other" }),
    );
    expect(result.data).toMatchObject({
      projectId: REVIEW.id,
      projectKey: REVIEW.key,
      projectName: REVIEW.name,
      reviewSnapshot: REVIEW,
    });
    expect(JSON.stringify(result)).not.toContain("remote.invalid");
  });
  it.each([undefined, null, "unknown"])(
    "preserves ordinary facts while withholding archived=%s review",
    async (archived) => {
      const request = native({ ...REVIEW, archived });
      const result = await executeJiraProjectRead(
        "jira.project",
        { projectIdOrKey: REVIEW.id },
        request,
      );
      expect(result.data).toMatchObject({
        outcome: "succeeded",
        projectId: REVIEW.id,
        projectName: REVIEW.name,
      });
      expect(result.data).not.toHaveProperty("reviewSnapshot");
      const bound = await readJiraBoundProject(request, REVIEW.id);
      expect(bound).toMatchObject({ ok: true, project: { projectId: REVIEW.id } });
      if (!bound.ok) throw new TypeError("Expected ordinary bound project facts");
      expect(bound.project.reviewSnapshot).toBeUndefined();
    },
  );
  it("does not let a same-name project replace an exact selected numeric ID", async () => {
    const result = await readJiraBoundProject(native({ ...REVIEW, id: "42" }), REVIEW.id);
    expect(result).toMatchObject({ ok: false, reason: "conflict" });
  });
});
