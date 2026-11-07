import { afterEach, expect, it } from "vitest";
import { createServerLogger, setServerLogger } from "../observability/index.js";
import { resetServerLogger } from "../../../../tests/support/activity-log-test-support.js";
import { createBufferedServerLogSink } from "../../../../tests/support/buffered-server-log.js";
import {
  recordJiraFieldRefusal,
  recordJiraTemplateRefusal,
  type JiraTemplateOperation,
} from "./jiraTemplateLog.js";

afterEach(resetServerLogger);

it.each([
  "jira.board-create",
  "jira.sprint-create",
  "jira.sprint-update",
  "jira.sprint-move-issues",
  "jira.backlog-move-issues",
  "jira.epic-update",
  "jira.epic-move-issues",
] as const satisfies readonly JiraTemplateOperation[])(
  "retains the body-free template and field refusals for %s",
  (operation) => {
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "debug" }));
    recordJiraTemplateRefusal("agile-refusal", {
      operation,
      stage: "pre-approval",
      violations: [{ ruleId: "field-unavailable" }],
    });
    recordJiraFieldRefusal("agile-refusal", {
      operation,
      refusedCount: 1,
      validations: ["invalid-field"],
    });
    expect(
      sink.events.map(({ op, correlationId, extra }) => ({ op, correlationId, extra })),
    ).toEqual([
      {
        op: "jira.template.admission",
        correlationId: "agile-refusal",
        extra: {
          operation,
          stage: "pre-approval",
          violationCount: 1,
          ruleIds: ["field-unavailable"],
          completeness: "complete",
          loss: "none",
        },
      },
      {
        op: "jira.field.admission",
        correlationId: "agile-refusal",
        extra: {
          operation,
          refusedCount: 1,
          validations: ["invalid-field"],
          completeness: "complete",
          loss: "none",
        },
      },
    ]);
  },
);

it.each(["jira.proxy", "constructor"])("does not log unregistered operation %s", (operation) => {
  const sink = createBufferedServerLogSink();
  setServerLogger(createServerLogger({ sink, level: "debug" }));
  recordJiraTemplateRefusal("agile-refusal", {
    operation,
    stage: "dispatch",
    violations: [{ ruleId: "field-unavailable" }],
  });
  expect(sink.events).toEqual([]);
});
