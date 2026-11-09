import { afterEach, describe, expect, it } from "vitest";
import type { JiraMutationAttempt } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { createBufferedServerLogSink } from "../../../../tests/support/buffered-server-log.js";
import { resetServerLogger } from "../../../../tests/support/activity-log-test-support.js";
import { createServerLogger, setServerLogger } from "../observability/index.js";
import { JIRA_LOGGED_SYSTEM_FIELD_IDS, recordJiraTemplateAttempt } from "./jiraTemplateLog.js";

afterEach(resetServerLogger);

function logs(): ReturnType<typeof createBufferedServerLogSink> {
  const sink = createBufferedServerLogSink();
  setServerLogger(createServerLogger({ sink, level: "debug" }));
  return sink;
}

const REFUSED: JiraMutationAttempt = {
  ok: false,
  reason: "field-validation",
  detail: {
    fieldId: "customfield_10042",
    validation: "required-field",
    messages: ["Customer secret value must be set."],
  },
};

describe("dispatch-stage Jira field refusal evidence", () => {
  it("records which validation fired and the closed field class, never the custom id or message", () => {
    const sink = logs();
    recordJiraTemplateAttempt("corr-field-1", "jira.create", REFUSED);
    const events = sink.events.filter(({ op }) => op === "jira.field.admission");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ correlationId: "corr-field-1" });
    expect(events[0]?.extra).toMatchObject({
      stage: "dispatch",
      refusedCount: 1,
      validations: ["required-field"],
      fieldClass: "custom",
    });
    expect(events[0]?.extra).not.toHaveProperty("systemFieldId");
    const text = sink.lines().join("\n");
    expect(text).not.toMatch(/customfield_10042|Customer secret/u);
  });

  it("names a known system field by its closed id and counts template violations", () => {
    const sink = logs();
    recordJiraTemplateAttempt("corr-field-2", "jira.create", {
      ok: false,
      reason: "field-validation",
      detail: { fieldId: "labels", validation: "invalid-field" },
      violations: [{ ruleId: "label-missing", subject: "anforderung", template: "KER/Story" }],
    });
    const event = sink.events.find(({ op }) => op === "jira.field.admission");
    expect(event?.extra).toMatchObject({
      fieldClass: "system",
      systemFieldId: "labels",
      templateViolationCount: 1,
    });
  });

  it("classes an unknown field id as other without logging it", () => {
    const sink = logs();
    recordJiraTemplateAttempt("corr-field-3", "jira.create", {
      ok: false,
      reason: "field-validation",
      detail: { fieldId: "requirementIds", validation: "unsupported-field" },
    });
    const event = sink.events.find(({ op }) => op === "jira.field.admission");
    expect(event?.extra).toMatchObject({ fieldClass: "other" });
    expect(sink.lines().join("\n")).not.toContain("requirementIds");
  });

  it("emits nothing for a successful create or a refusal of another reason", () => {
    const sink = logs();
    recordJiraTemplateAttempt("corr-ok", "jira.create", { ok: true, receipt: {} });
    recordJiraTemplateAttempt("corr-conflict", "jira.create", { ok: false, reason: "conflict" });
    expect(sink.events.filter(({ op }) => op === "jira.field.admission")).toEqual([]);
  });

  it("pins the logged system field allow-list", () => {
    expect(JIRA_LOGGED_SYSTEM_FIELD_IDS).toContain("summary");
    expect(new Set(JIRA_LOGGED_SYSTEM_FIELD_IDS).size).toBe(JIRA_LOGGED_SYSTEM_FIELD_IDS.length);
  });
});
