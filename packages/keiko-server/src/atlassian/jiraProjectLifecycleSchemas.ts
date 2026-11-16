import { object, text } from "./jiraManagedSchemas.js";
import { jiraNativeIdentitySchema as ID } from "./jiraProjectStructureDescriptors.js";

export const JIRA_PROJECT_REVIEW_SCHEMA = object(
  {
    id: ID,
    key: { ...text(128), minLength: 1 },
    name: { ...text(255), minLength: 1 },
    archived: { type: "boolean" },
    projectTypeKey: { ...text(128), minLength: 1 },
  },
  ["id", "key", "name", "archived"],
);
