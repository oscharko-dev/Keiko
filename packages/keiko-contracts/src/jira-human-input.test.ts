import { describe, expect, it } from "vitest";
import { isJiraHumanInputView, JIRA_HUMAN_INPUT_FIELD_SETS, type JiraHumanInputView } from "./jira-human-input.js";

const view: JiraHumanInputView = {
  requestId: `jhi_${"a".repeat(64)}`, revision: "7765d9e4-fc9a-46d5-aea4-24880fec5e1e",
  purpose: "validate-update-user-password", state: "awaiting-input", expiresAt: 1,
  fields: JIRA_HUMAN_INPUT_FIELD_SETS["validate-update-user-password"].required,
  optionalFields: JIRA_HUMAN_INPUT_FIELD_SETS["validate-update-user-password"].optional,
};
describe("bounded persisted Jira human-input views", () => {
  it("retains historical expired views without granting current execution", () => {
    expect(isJiraHumanInputView(view)).toBe(true);
    expect(isJiraHumanInputView({ ...view, state: "expired" })).toBe(true);
  });
  it.each([
    { values: { password: "synthetic private input" } }, { target: "model-selected" },
    { fields: ["license"] }, { optionalFields: [] }, { expiresAt: Infinity },
    { requestId: "unknown" }, { state: "approved" }, { revision: "secret-digest" },
  ])("refuses extra material and drift from the canonical purpose %#", (delta) => {
    expect(isJiraHumanInputView({ ...view, ...delta })).toBe(false);
  });
  it("does not invoke accessors or accept inherited required fields", () => {
    const raw = { ...view };
    Object.defineProperty(raw, "purpose", { get: () => { throw new Error("Do not evaluate model accessors"); } });
    expect(isJiraHumanInputView(raw)).toBe(false);
    expect(isJiraHumanInputView(Object.create(view))).toBe(false);
    const extra = [...view.fields]; Object.defineProperty(extra, "privateValue", { value: "synthetic forbidden material" });
    expect(isJiraHumanInputView({ ...view, fields: extra })).toBe(false);
  });
  it("uses the same closed owner-shutdown field for a historical human attestation", () => {
    expect(isJiraHumanInputView({ ...view, purpose: "unlock-user-anonymization", fields: ["ownerShutdownConfirmation"], optionalFields: [] })).toBe(true);
    expect(isJiraHumanInputView({ ...view, purpose: "unlock-user-anonymization", fields: ["password"], optionalFields: [] })).toBe(false);
  });
});
