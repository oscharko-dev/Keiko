import { describe, expect, it, vi } from "vitest";
import {
  isJiraHumanInputView,
  JIRA_HUMAN_INPUT_FIELD_SETS,
  type JiraHumanInputView,
} from "./jira-human-input.js";
import { copyJiraHumanInputReview } from "./jira-human-input-review.js";

const view: JiraHumanInputView = {
  requestId: `jhi_${"a".repeat(64)}`,
  revision: "7765d9e4-fc9a-46d5-aea4-24880fec5e1e",
  purpose: "validate-update-user-password",
  state: "awaiting-input",
  expiresAt: 1,
  fields: JIRA_HUMAN_INPUT_FIELD_SETS["validate-update-user-password"].required,
  optionalFields: JIRA_HUMAN_INPUT_FIELD_SETS["validate-update-user-password"].optional,
};
describe("bounded persisted Jira human-input views", () => {
  const review = {
    jiraBaseUrl: "https://jira.example.invalid/context",
    actorUserKey: "actor-key",
    actorUsername: "actor-name",
    targetKind: "user",
    targetUserKey: "target-key",
    targetUsername: "target-name",
  } as const;
  it("preserves complete target review while keeping legacy views readable", () => {
    expect(isJiraHumanInputView({ ...view, review })).toBe(true);
    expect(copyJiraHumanInputReview(review, view.purpose)).toEqual(review);
    expect(isJiraHumanInputView({ ...view, review: undefined })).toBe(false);
    expect(copyJiraHumanInputReview(review, "login")).toBeUndefined();
    expect(
      copyJiraHumanInputReview(
        { ...review, targetUserKey: review.actorUserKey, targetUsername: review.actorUsername },
        "login",
      ),
    ).toBeDefined();
  });
  it("refuses credentials, foreign fields, changed purpose, unsafe destinations and misleading identity text", () => {
    for (const change of [
      { jiraBaseUrl: "https://name:secret@jira.example.invalid" },
      { jiraBaseUrl: "https://jira.example.invalid/?secret=value" },
      { jiraBaseUrl: "https://jira.example.invalid/#fragment" },
      { jiraBaseUrl: "http://jira.example.invalid" },
      { password: "synthetic hidden value" },
      { targetUsername: "target\u202ename" },
      { targetUserKey: "bad\ud800" },
      { targetKind: "proposed-user" },
    ])
      expect(isJiraHumanInputView({ ...view, review: { ...review, ...change } })).toBe(false);
    expect(copyJiraHumanInputReview(review, "validate-license")).toBeUndefined();
  });
  it("never evaluates getter-backed review identities or accepts inherited evidence", () => {
    const getter = vi.fn(() => "foreign");
    const changed = { ...review };
    Object.defineProperty(changed, "targetUsername", { get: getter, enumerable: true });
    expect(isJiraHumanInputView({ ...view, review: changed })).toBe(false);
    expect(getter).not.toHaveBeenCalled();
    expect(isJiraHumanInputView({ ...view, review: Object.create(review) })).toBe(false);
    const symbol = { ...review };
    Object.defineProperty(symbol, Symbol("private"), { value: "hidden" });
    expect(isJiraHumanInputView({ ...view, review: symbol })).toBe(false);
  });
  it("retains historical expired views without granting current execution", () => {
    expect(isJiraHumanInputView(view)).toBe(true);
    expect(isJiraHumanInputView({ ...view, state: "expired" })).toBe(true);
  });
  it.each([
    { values: { password: "synthetic private input" } },
    { target: "model-selected" },
    { fields: ["license"] },
    { optionalFields: [] },
    { expiresAt: Infinity },
    { requestId: "unknown" },
    { state: "approved" },
    { revision: "secret-digest" },
  ])("refuses extra material and drift from the canonical purpose %#", (delta) => {
    expect(isJiraHumanInputView({ ...view, ...delta })).toBe(false);
  });
  it("does not invoke accessors or accept inherited required fields", () => {
    const raw = { ...view };
    Object.defineProperty(raw, "purpose", {
      get: () => {
        throw new Error("Do not evaluate model accessors");
      },
    });
    expect(isJiraHumanInputView(raw)).toBe(false);
    expect(isJiraHumanInputView(Object.create(view))).toBe(false);
    const extra = [...view.fields];
    Object.defineProperty(extra, "privateValue", { value: "synthetic forbidden material" });
    expect(isJiraHumanInputView({ ...view, fields: extra })).toBe(false);
  });
  it("uses the same closed owner-shutdown field for a historical human attestation", () => {
    expect(
      isJiraHumanInputView({
        ...view,
        purpose: "unlock-user-anonymization",
        fields: ["ownerShutdownConfirmation"],
        optionalFields: [],
      }),
    ).toBe(true);
    expect(
      isJiraHumanInputView({
        ...view,
        purpose: "unlock-user-anonymization",
        fields: ["password"],
        optionalFields: [],
      }),
    ).toBe(false);
  });
});
