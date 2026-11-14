import { afterEach, describe, expect, it } from "vitest";
import type { JiraMutationAttempt } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { jiraEpicLinkRefusalMessage } from "@oscharko-dev/keiko-connectors";
import { createBufferedServerLogSink } from "../../../../tests/support/buffered-server-log.js";
import { resetServerLogger } from "../../../../tests/support/activity-log-test-support.js";
import { createServerLogger, setServerLogger } from "../observability/index.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";
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

// #4354 (audit): every behaviour the package changed leaves its body-free line through the
// registered operation; each is asserted through the real registered formatter.
describe("the lines of the #4354 write path", () => {
  const MISSING: JiraMutationAttempt = {
    ok: false,
    reason: "field-validation",
    violations: [{ ruleId: "template-missing", subject: "Story", template: "SYN/Story" }],
  };
  it.each(["template-missing", "template-not-activated"] as const)(
    "records %s on the template admission line with its count and no name",
    (ruleId) => {
      const sink = logs();
      recordJiraTemplateAttempt("corr-missing", "jira.create", {
        ...MISSING,
        violations: [{ ruleId, subject: "Secret Issue Type", template: "SYN/Secret Issue Type" }],
      });
      const events = sink.events.filter(({ op }) => op === "jira.template.admission");
      expect(events).toHaveLength(1);
      expect(events[0]?.extra).toMatchObject({
        operation: "jira.create",
        stage: "dispatch",
        violationCount: 1,
        ruleIds: [ruleId],
      });
      expectActivityLogProof(
        "jira.template.admission.line",
        formatActivityLogProofLine(events[0] ?? {}),
      );
      expect(sink.lines().join("\n")).not.toContain("Secret Issue Type");
    },
  );

  it("records the pre-existing violations an edit passed with on the notice stage", () => {
    const sink = logs();
    recordJiraTemplateAttempt("corr-notice", "jira.edit", {
      ok: true,
      receipt: { issueKey: "SYN-1" },
      templateNotices: [
        { ruleId: "section-missing", subject: "Private section title", template: "SYN/Story" },
      ],
    });
    const events = sink.events.filter(({ op }) => op === "jira.template.admission");
    expect(events).toHaveLength(1);
    expect(events[0]?.level).toBe("info");
    expect(events[0]?.extra).toMatchObject({
      operation: "jira.edit",
      stage: "notice",
      violationCount: 1,
      ruleIds: ["section-missing"],
    });
    expectActivityLogProof(
      "jira.template.admission.line",
      formatActivityLogProofLine(events[0] ?? {}),
    );
    expect(sink.lines().join("\n")).not.toContain("Private section title");
  });

  it("tells an Epic Link refusal apart on the field admission line, without key or text", () => {
    const sink = logs();
    recordJiraTemplateAttempt("corr-epic", "jira.create", {
      ok: false,
      reason: "field-validation",
      detail: {
        fieldId: "customfield_10014",
        validation: "invalid-epic-link",
        messages: [jiraEpicLinkRefusalMessage("SYN-5")],
      },
    });
    const events = sink.events.filter(({ op }) => op === "jira.field.admission");
    expect(events).toHaveLength(1);
    expect(events[0]?.extra).toMatchObject({
      stage: "dispatch",
      refusedCount: 1,
      validations: ["invalid-epic-link"],
      fieldClass: "custom",
    });
    expectActivityLogProof(
      "jira.field.admission.line",
      formatActivityLogProofLine(events[0] ?? {}),
    );
    const text = sink.lines().join("\n");
    expect(text).not.toContain("SYN-5");
    expect(text).not.toContain("customfield_10014");
  });
});
