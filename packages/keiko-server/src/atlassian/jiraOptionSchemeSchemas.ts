import { TOOL_CATALOG_LIMITS } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { object, text } from "./jiraManagedSchemas.js";
import { jiraNativeIdentitySchema as ID } from "./jiraProjectStructureDescriptors.js";
const NAME = { ...text(255), minLength: 1 };
export const JIRA_SCHEME_OPTION_IDS_SCHEMA = {
  type: "array",
  minItems: 1,
  maxItems: TOOL_CATALOG_LIMITS.maxArrayItems,
  uniqueItems: true,
  items: ID,
};
const NULL_DESCRIPTION = { anyOf: [text(32768), { type: "null" }] };
const NULL_ID = { anyOf: [ID, { type: "null" }] };
export const JIRA_ISSUE_TYPE_SCHEME_REVIEW_SCHEMA = object(
  {
    id: ID,
    name: NAME,
    description: NULL_DESCRIPTION,
    issueTypeIds: JIRA_SCHEME_OPTION_IDS_SCHEMA,
    defaultIssueTypeId: NULL_ID,
  },
  ["id", "name", "description", "issueTypeIds", "defaultIssueTypeId"],
);
export const JIRA_PRIORITY_SCHEME_REVIEW_SCHEMA = object(
  {
    id: ID,
    name: NAME,
    description: NULL_DESCRIPTION,
    optionIds: JIRA_SCHEME_OPTION_IDS_SCHEMA,
    defaultOptionId: NULL_ID,
    defaultScheme: { type: "boolean" },
  },
  ["id", "name", "description", "optionIds", "defaultOptionId", "defaultScheme"],
);
