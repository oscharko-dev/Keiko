import { expect, it } from "vitest";
import {
  JIRA_DRAFT_PAGE_ITEMS_MAX,
  JIRA_REQUIREMENT_REFERENCE_CHARS_MAX,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { JIRA_REQUIREMENT_IDS_MAX } from "@oscharko-dev/keiko-connectors";
import { JIRA_DRAFT_STAGE_DECLARATION } from "./jiraDraftDescriptor.js";

// Lab S14 of epic #4173: a model staged four epics without requirementIds, so none traced its
// requirement. The staged catalog must expose the real trace and required issue-field contracts.
it("offers typed, bounded staged items including requirement traces and required summaries", () => {
  expect(JIRA_DRAFT_STAGE_DECLARATION.descriptor.inputSchema).toMatchObject({
    properties: {
      items: {
        type: "array",
        minItems: 1,
        maxItems: JIRA_DRAFT_PAGE_ITEMS_MAX,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["ref", "projectId", "issueTypeId", "fields"],
          properties: {
            ref: { type: "string", maxLength: 32 },
            projectId: { type: "string", pattern: "^[0-9]{1,32}$" },
            issueTypeId: { type: "string", pattern: "^[0-9]{1,32}$" },
            fields: {
              type: "object",
              additionalProperties: true,
              required: ["summary"],
              properties: { summary: { type: "string", minLength: 1 } },
            },
            requirementIds: {
              type: "array",
              maxItems: JIRA_REQUIREMENT_IDS_MAX,
              items: { type: "string", maxLength: JIRA_REQUIREMENT_REFERENCE_CHARS_MAX },
            },
          },
        },
      },
    },
  });
});
