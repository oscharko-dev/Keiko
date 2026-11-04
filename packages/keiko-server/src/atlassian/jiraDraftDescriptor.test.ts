import { expect, it } from "vitest";
import { JIRA_DRAFT_STAGE_DECLARATION } from "./jiraDraftDescriptor.js";

// Lab S14 of epic #4173: a model staged four epics without requirementIds, so none traced its
// requirement. The staged item form only points at jira.draft's to keep the catalog small; it must
// still name the trace argument, the one member a model cannot infer from the fields it reads.
it("names requirementIds in the staged item form", () => {
  const schema = JIRA_DRAFT_STAGE_DECLARATION.descriptor.inputSchema as {
    properties: { items: { items: { description: string } } };
  };
  expect(schema.properties.items.items.description).toContain("requirementIds");
});
