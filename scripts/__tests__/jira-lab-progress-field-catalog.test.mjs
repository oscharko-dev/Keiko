// The progress oracle resolves installed template references as the product does (#4321): Jira
// Data Center's field list omits the system field `parent`, which a Sub-task template names.
import { describe, expect, it } from "vitest";
import { parseJiraIssueTemplate } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  progressEvidenceFields,
  templateFieldCatalog,
} from "../testing/jira-chat-lab/requirements/progress-simulation.mjs";

const SUB_TASK = parseJiraIssueTemplate(
  [
    "---",
    "keiko: jira-issue-template",
    "version: 1",
    "project: LIM1",
    "issueType: Sub-task",
    "activateOn: [create]",
    "parentField: parent",
    "---",
  ].join("\n"),
);
if (!SUB_TASK.ok) throw new TypeError("The Sub-task template fixture must parse");
const DATA_CENTER_FIELDS = [
  { id: "summary", name: "Summary" },
  { id: "customfield_10107", name: "Parent Link" },
];
const scope = { templates: [{ rules: SUB_TASK.template }] };

describe("progress oracle template field catalog", () => {
  it("binds a Sub-task template's parent although the native field list omits it", () => {
    expect(() =>
      progressEvidenceFields({
        fieldIds: {},
        templateScope: scope,
        fieldCatalog: DATA_CENTER_FIELDS,
      }),
    ).toThrow("Template field binding unavailable");
    expect(
      progressEvidenceFields({
        fieldIds: {},
        templateScope: scope,
        fieldCatalog: templateFieldCatalog(DATA_CENTER_FIELDS),
      }),
    ).toContain("parent");
  });

  it("keeps one entry per field id when the native list also names a system field", () => {
    const catalog = templateFieldCatalog([...DATA_CENTER_FIELDS, { id: "parent", name: "Parent" }]);
    expect(catalog.filter((field) => field.id === "parent")).toEqual([
      { id: "parent", name: "Parent" },
    ]);
    expect(
      progressEvidenceFields({ fieldIds: {}, templateScope: scope, fieldCatalog: catalog }),
    ).toContain("parent");
  });

  it("still refuses a template field that neither Jira nor the system list knows", () => {
    const unknown = { templates: [{ rules: { ...SUB_TASK.template, requiredFields: ["Nope"] } }] };
    expect(() =>
      progressEvidenceFields({
        fieldIds: {},
        templateScope: unknown,
        fieldCatalog: templateFieldCatalog(DATA_CENTER_FIELDS),
      }),
    ).toThrow("Template field binding unavailable");
  });
});
