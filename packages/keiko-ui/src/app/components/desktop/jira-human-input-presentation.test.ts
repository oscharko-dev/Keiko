import { describe, expect, it } from "vitest";
import type { JiraHumanInputView } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  jiraHumanInputReviewFacts,
  sameJiraHumanInputReview,
} from "./jira-human-input-presentation";

const view: JiraHumanInputView = {
  requestId: `jhi_${"a".repeat(64)}`,
  revision: "7765d9e4-fc9a-46d5-aea4-24880fec5e1e",
  purpose: "update-user-password",
  state: "awaiting-input",
  expiresAt: 1,
  fields: ["password"],
  optionalFields: [],
  review: {
    jiraBaseUrl: "https://jira.example.invalid/context",
    actorUserKey: "actor-key",
    actorUsername: "actor-name",
    targetKind: "user",
    targetUserKey: "target-key",
    targetUsername: "target-name",
  },
};
describe("private input review facts", () => {
  it("presents the bound destination, exact target and fixed purpose without navigation", () => {
    const facts = jiraHumanInputReviewFacts(view, (key) => key);
    expect(facts).toEqual([
      {
        label: "chat.jira.humanInput.review.server",
        value: "https://jira.example.invalid/context",
      },
      {
        label: "chat.jira.humanInput.review.purpose",
        value: "chat.jira.humanInput.review.userPassword",
      },
      { label: "chat.jira.humanInput.review.actorUsername", value: "actor-name" },
      { label: "chat.jira.humanInput.review.actorKey", value: "actor-key" },
      { label: "chat.jira.humanInput.review.targetKey", value: "target-key" },
      { label: "chat.jira.humanInput.review.targetUsername", value: "target-name" },
    ]);
    expect(facts?.every((fact) => !Object.hasOwn(fact, "href"))).toBe(true);
  });
  it("only permits old missing review to acquire validated server facts and never permits retargeting", () => {
    const old = { ...view };
    Reflect.deleteProperty(old, "review");
    expect(jiraHumanInputReviewFacts(old, (key) => key)).toBeUndefined();
    expect(sameJiraHumanInputReview(old, view)).toBe(true);
    expect(sameJiraHumanInputReview(view, old)).toBe(false);
    expect(sameJiraHumanInputReview(view, { ...view, state: "consumed" })).toBe(true);
    const review = view.review;
    if (review === undefined) throw new TypeError("Expected review fixture");
    for (const changed of [
      { ...review, jiraBaseUrl: "https://another-jira.invalid/context" },
      { ...review, jiraBaseUrl: "https://jira.example.invalid/another-context" },
      { ...review, targetUsername: "other-user" },
      { ...review, targetUserKey: "other-key" },
      { ...review, actorUsername: "other-actor" },
    ])
      expect(sameJiraHumanInputReview(view, { ...view, review: changed })).toBe(false);
    expect(
      sameJiraHumanInputReview(view, { ...view, purpose: "validate-update-user-password" }),
    ).toBe(false);
  });
});
