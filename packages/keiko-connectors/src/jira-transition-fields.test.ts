import { describe, expect, it, vi } from "vitest";
import {
  parseJiraIssueTemplate,
  type JiraIssueTemplate,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import {
  field,
  fixtureRead,
  fixtureWrite,
  response,
  type SyntheticJira,
} from "../../../tests/support/jira-managed-remote.js";
import type { AtlassianHttpBodyPort } from "./atlassian-http-port.js";
import { executeJiraManagedMutation } from "./jira-managed-mutations.js";

// #4354 (owner rule, audit): a status change is free; the fields a transition carries are an edit
// of exactly those fields, judged by the edit rule (never worse), and with no governing template
// they pass.
function template(...rules: readonly string[]): JiraIssueTemplate {
  const result = parseJiraIssueTemplate(
    [
      "---",
      "keiko: jira-issue-template",
      "version: 1",
      "project: SYN",
      "issueType: Task",
      "activateOn: [create, edit]",
      ...rules,
      "---",
      "# Task",
    ].join("\n"),
  );
  if (!result.ok) throw new TypeError("fixture template must parse");
  return result.template;
}
function run(
  args: CatalogJsonObject,
  templates: readonly JiraIssueTemplate[],
  transitionAnswer?: { readonly status: number; readonly body: unknown },
): {
  readonly result: ReturnType<typeof executeJiraManagedMutation>;
  readonly writes: () => number;
  readonly requests: () => number;
} {
  const state: SyntheticJira = {
    fields: {
      summary: "A sufficiently long summary of this synthetic issue",
      status: { id: "1" },
      labels: ["initial"],
      project: { id: "10000", key: "SYN" },
      issuetype: { id: "3", name: "Task" },
    },
    comment: "",
  };
  const http = vi.fn<AtlassianHttpBodyPort>((request) => {
    const path = new URL(request.url).pathname;
    if (
      request.method === "POST" &&
      transitionAnswer !== undefined &&
      path.endsWith("/transitions")
    )
      return Promise.resolve(response(transitionAnswer.body, transitionAnswer.status));
    if (request.method !== "GET")
      return Promise.resolve(fixtureWrite(path, request.bodyJson, state, request.upload));
    if (path.endsWith("/transitions"))
      return Promise.resolve(
        response({
          transitions: [
            {
              id: "31",
              name: "Done",
              to: { id: "3", name: "Done" },
              fields: { summary: field("summary", "string") },
            },
          ],
        }),
      );
    return Promise.resolve(fixtureRead(path, state));
  });
  const controller = new AbortController();
  return {
    result: executeJiraManagedMutation(
      "jira.transition",
      args,
      {
        invocationId: "synthetic",
        correlationId: "synthetic",
        signal: controller.signal,
        beforeEffect: () => true,
      },
      {
        deployment: "data-center",
        baseUrl: "https://jira.example.invalid/context",
        http,
        issueTemplates: () => ({ templates, unreadable: 0 }),
      },
    ),
    writes: (): number => http.mock.calls.filter(([request]) => request.method !== "GET").length,
    requests: (): number => http.mock.calls.length,
  };
}
const GOVERNING = [template("summaryMinLength: 40")];
const TRANSITION: CatalogJsonObject = { issueKey: "SYN-1", transitionId: "31" };

describe("the fields a transition carries (#4354)", () => {
  it("refuses a transition whose carried field would violate the governing edit template, before any effect", async () => {
    const jira = run({ ...TRANSITION, fields: { summary: "Too short" } }, GOVERNING);
    expect(await jira.result).toMatchObject({
      ok: false,
      reason: "field-validation",
      violations: [{ ruleId: "summary-too-short" }],
    });
    expect(jira.writes()).toBe(0);
  });

  it("lets the same transition through without fields: the status change is free", async () => {
    const jira = run(TRANSITION, GOVERNING);
    expect(await jira.result).toMatchObject({ ok: true });
    expect(jira.writes()).toBe(1);
  });

  it("lets a transition through whose carried field conforms", async () => {
    const jira = run(
      {
        ...TRANSITION,
        fields: { summary: "A sufficiently long summary that satisfies the rule of the template" },
      },
      GOVERNING,
    );
    expect(await jira.result).toMatchObject({ ok: true });
    expect(jira.writes()).toBe(1);
  });

  // The transition id is checked against what Jira lists for the issue right now, so a step that
  // vanished, or never existed, is refused before any write (the listing side of KEIKO-0814).
  it("refuses a transition id Jira no longer lists as invalid-transition, before any effect", async () => {
    const jira = run({ ...TRANSITION, transitionId: "99" }, GOVERNING);
    expect(await jira.result).toMatchObject({
      ok: false,
      reason: "invalid-transition",
      detail: {
        fieldId: "transitionId",
        messages: [
          "The transition id is not available for this issue in its current status: read jira.transitions for the ids it offers now. Nothing was changed.",
        ],
      },
    });
    expect(jira.writes()).toBe(0);
  });

  // KEIKO-0814 on the managed path, the case the retired legacy action pinned: Jira listed the id,
  // then the workflow moved and the POST is refused. The model gets the typed outcome and one POST
  // was sent, never a generic status failure and never a second attempt.
  it.each([
    [404, { errorMessages: ["Issue Does Not Exist"], errors: {} }],
    [400, { errorMessages: ["Transition id '31' is not valid for this issue."], errors: {} }],
  ])("maps a %i on the POST of a listed transition to invalid-transition", async (status, body) => {
    const jira = run(TRANSITION, [], { status, body });
    expect(await jira.result).toMatchObject({ ok: false, reason: "invalid-transition" });
    expect(jira.writes()).toBe(1);
  });

  // The control of the retired legacy pin: a failure that is not a moved workflow stays derived from
  // the status Jira answered, never invalid-transition.
  it.each([
    [500, "unavailable"],
    [409, "conflict"],
  ] as const)("keeps a %i on the POST of a transition as %s", async (status, reason) => {
    const jira = run(TRANSITION, [], {
      status,
      body: { errorMessages: ["Synthetic refusal"], errors: {} },
    });
    const result = await jira.result;
    expect(result).toMatchObject({ ok: false, reason });
    expect(result).not.toMatchObject({ reason: "invalid-transition" });
  });

  it("keeps a 400 that names a refused field a field refusal, not a moved workflow", async () => {
    const jira = run(TRANSITION, [], {
      status: 400,
      body: { errorMessages: [], errors: { summary: "Summary is too long" } },
    });
    expect(await jira.result).toMatchObject({ ok: false, reason: "field-validation" });
  });

  // The invariant of the retired legacy action's "hostile issue key" test, on the managed path: a
  // key that is not an issue key never becomes part of a URL.
  it.each(["../../rest/api/2/user", "SYN-1/../../x", "syn 1", ""])(
    "refuses the hostile issue key %j before any request",
    async (issueKey) => {
      const jira = run({ ...TRANSITION, issueKey }, GOVERNING);
      expect(await jira.result).toMatchObject({ ok: false });
      expect(jira.requests()).toBe(0);
    },
  );

  // AC7.2 at the connector: the field the transition carries conforms; the labels rule was already
  // broken in a field the transition does not touch. The change goes through and the attempt names
  // that rule as a notice, from the real executor and its collector, not from a hand-built attempt.
  it("names a rule an untouched field already broke as a notice on the attempt", async () => {
    const jira = run(
      {
        ...TRANSITION,
        fields: { summary: "A sufficiently long summary that satisfies the rule of the template" },
      },
      [template("summaryMinLength: 40", "requiredLabels: [reviewed]")],
    );
    const result = await jira.result;
    expect(result).toMatchObject({
      ok: true,
      templateNotices: [{ ruleId: "label-missing", template: "SYN/Task" }],
    });
    expect(jira.writes()).toBe(1);
  });

  it("lets a transition with a carried field through when no template governs it", async () => {
    const jira = run({ ...TRANSITION, fields: { summary: "Too short" } }, []);
    expect(await jira.result).toMatchObject({ ok: true });
    expect(jira.writes()).toBe(1);
  });
});
