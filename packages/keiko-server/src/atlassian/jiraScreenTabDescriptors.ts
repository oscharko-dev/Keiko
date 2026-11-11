import { TOOL_CATALOG_LIMITS } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpToolDeclaration } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { object, text } from "./jiraManagedSchemas.js";
import {
  jiraNativeIdentitySchema as ID,
  jiraNativeProjectSchema as FIELD_ID,
  jiraNativeWriteResult,
  jiraNativeDeclaration,
  type JiraNativeDefinition,
} from "./jiraProjectStructureDescriptors.js";

const NAME = { ...text(255), minLength: 1 };
const SCREEN = { screenId: ID, expectedScreenName: NAME };
const TAB = { ...SCREEN, tabId: ID, expectedName: NAME };
const RECEIPT = jiraNativeWriteResult({ screenId: ID, tabId: ID });

export const JIRA_SCREEN_TAB_WRITE_DEFINITIONS = {
  "jira.create-screen-tab": {
    description:
      "Create one native tab on the exact screen after matching its observed ID and reviewed screen name and reading the complete current tabs. Supply a nonempty name without outer whitespace; a duplicate existing name refuses before POST. Send at most one POST and confirm only the acknowledged new tab ID and exact name under the same readable screen. A lost acknowledgement with no tab ID remains unknown: never infer identity from a name or replay creation.",
    input: object({ ...SCREEN, name: NAME }, ["screenId", "expectedScreenName", "name"]),
    result: RECEIPT,
    risk: "write",
    maxResultCount: 1,
  },
  "jira.rename-screen-tab": {
    description:
      "Rename one exact native screen tab after matching the observed screen ID/name, tab ID and reviewed tab name. Supply the exact new nonempty name without outer whitespace. A changed snapshot or another tab with that name refuses before PUT; an already equal name reports unchanged without writing. Send at most one PUT and independently confirm the same tab's name on the same readable screen. Unknown outcomes are never replayed.",
    input: object({ ...TAB, name: NAME }, [
      "screenId",
      "expectedScreenName",
      "tabId",
      "expectedName",
      "name",
    ]),
    result: RECEIPT,
    risk: "write",
    maxResultCount: 1,
  },
  "jira.delete-screen-tab": {
    description:
      "Delete one exact native screen tab only after matching its reviewed screen name, tab name and complete ordered field-ID snapshot. expectedFieldIds may explicitly be empty but must contain no duplicates. Require at least one other tab before DELETE. Send at most one DELETE, then confirm exact tab absence and a remaining tab under the same readable screen; missing or inaccessible parent state is not proof of deletion. Unknown outcomes are never replayed.",
    input: object(
      {
        ...TAB,
        expectedFieldIds: {
          type: "array",
          maxItems: TOOL_CATALOG_LIMITS.maxArrayItems,
          uniqueItems: true,
          items: FIELD_ID,
        },
      },
      ["screenId", "expectedScreenName", "tabId", "expectedName", "expectedFieldIds"],
    ),
    result: RECEIPT,
    risk: "write",
    maxResultCount: 1,
  },
} as const satisfies Readonly<Record<string, JiraNativeDefinition>>;

export function jiraScreenTabDeclarationForTool(
  name: string,
): ManagedMcpToolDeclaration | undefined {
  const definitions: Readonly<Record<string, JiraNativeDefinition>> =
    JIRA_SCREEN_TAB_WRITE_DEFINITIONS;
  const selected = Object.hasOwn(definitions, name) ? definitions[name] : undefined;
  return selected === undefined ? undefined : jiraNativeDeclaration(name, selected);
}
