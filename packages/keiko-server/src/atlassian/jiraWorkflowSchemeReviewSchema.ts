import { TOOL_CATALOG_LIMITS } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { object, text } from "./jiraManagedSchemas.js";
import { jiraNativeIdentitySchema as ID } from "./jiraProjectStructureDescriptors.js";

const NAME = { ...text(255), minLength: 1 };
export const jiraWorkflowSchemeMappingsSchema = {
  type: "array",
  maxItems: TOOL_CATALOG_LIMITS.maxArrayItems,
  items: object({ issueTypeId: ID, workflow: NAME }, ["issueTypeId", "workflow"]),
};
export const jiraWorkflowSchemeReviewFields = {
  id: ID,
  draft: { type: "boolean" },
  name: NAME,
  description: { anyOf: [text(32768), { type: "null" }] },
  defaultWorkflow: { anyOf: [NAME, { type: "null" }] },
  mappings: jiraWorkflowSchemeMappingsSchema,
  originalDefaultWorkflow: { anyOf: [NAME, { type: "null" }] },
  originalMappings: jiraWorkflowSchemeMappingsSchema,
};
export const jiraWorkflowSchemeReviewRequired = [
  "id",
  "draft",
  "name",
  "description",
  "defaultWorkflow",
  "mappings",
] as const;
export const jiraWorkflowSchemeReviewSchema = object(
  jiraWorkflowSchemeReviewFields,
  jiraWorkflowSchemeReviewRequired,
);
