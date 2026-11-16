import { expect, it } from "vitest";
import { jiraIdentityObservationDetails as details } from "./jira-identity-observation-presentation";

it("keeps validation failure, explicit false and empty operations separate from tool success", () => {
  const cards = details("jira_anonymization_validation", {
    outcome: "succeeded",
    userKey: "U1",
    validation: {
      success: false,
      deleted: false,
      businessLogicValidationFailed: true,
      userName: "",
      operations: [],
      errors: {},
      warnings: [],
    },
  });
  expect(cards[0]?.labels).toEqual(
    expect.arrayContaining([
      "chat.jira.identity.validationFalse",
      "chat.jira.identity.deletedFalse",
      "chat.jira.identity.businessFailedTrue",
      "chat.jira.identity.blankUsername",
    ]),
  );
  expect(cards[1]?.facts).toContainEqual({
    label: "chat.jira.identity.operationCount",
    value: "0",
  });
  expect(cards.flatMap((card) => card.labels)).toContain("chat.jira.identity.errorsUnknown");
  expect(cards.flatMap((card) => card.facts)).toContainEqual({
    label: "chat.jira.identity.warningGroups",
    value: "0",
  });
});
it("preserves COMPLETED with errors, zero progress and requested-only task context", () => {
  const cards = details("jira_anonymization_progress", {
    outcome: "succeeded",
    taskSelection: "selected-task",
    selectedTaskId: "9007199254740993",
    progress: {
      userKey: "U1",
      status: "COMPLETED",
      currentProgress: 0,
      currentSubTask: "",
      isRerun: false,
      errors: [
        {
          operation: "plugin:handler",
          messages: ["One handler failed."],
          fields: [{ field: "target", message: "Review owner." }],
        },
      ],
      warnings: [],
    },
  });
  expect(cards[0]?.labels).toEqual(
    expect.arrayContaining([
      "chat.jira.identity.completionCaveat",
      "chat.jira.identity.requestedTaskOnly",
      "chat.jira.identity.progressUnitsUnknown",
      "chat.jira.identity.rerunFalse",
      "chat.jira.identity.emptySubtask",
    ]),
  );
  expect(cards[0]?.facts).toContainEqual({ label: "chat.jira.jobs.nativeProgress", value: "0" });
  expect(cards[0]?.facts).toContainEqual({
    label: "chat.jira.jobs.selectedTaskId",
    value: "9007199254740993",
  });
  expect(cards.some((card) => card.body === "One handler failed.")).toBe(true);
  expect(cards.some((card) => card.name === "target" && card.body === "Review owner.")).toBe(true);
  expect(cards.flatMap((card) => card.labels)).not.toContain("chat.jira.identity.validationTrue");
});
it("does not replace unknown session counters or missing progress with zero", () => {
  const session = details("jira_current_session", {
    outcome: "succeeded",
    userKey: "U1",
    username: "Bound",
    loginInfo: { failedLoginCount: 0 },
  });
  expect(session[0]?.facts).toContainEqual({
    label: "chat.jira.identity.failedLoginCount",
    value: "0",
  });
  expect(session[0]?.labels).toContain("chat.jira.identity.loginCountUnknown");
  expect(session[0]?.facts.some((entry) => entry.label === "chat.jira.identity.loginCount")).toBe(
    false,
  );
  expect(
    details("jira_anonymization_progress", { progress: { userKey: "U1" } })[0]?.labels,
  ).toEqual(
    expect.arrayContaining([
      "chat.jira.jobs.progressUnknown",
      "chat.jira.jobs.taskSelectionUnknown",
      "chat.jira.identity.rerunUnknown",
    ]),
  );
});
it("does not render unapproved links, cookie material or stale success data after refusal", () => {
  const data = {
    outcome: "succeeded",
    userKey: "U1",
    username: "Bound",
    self: "https://untrusted.invalid",
    session: { value: "omitted" },
  };
  expect(JSON.stringify(details("jira_current_session", data))).not.toMatch(/untrusted|omitted/u);
  expect(details("jira_current_session", { ...data, outcome: "failed" })).toEqual([]);
  expect(details("jira_login", data)).toEqual([]);
});
