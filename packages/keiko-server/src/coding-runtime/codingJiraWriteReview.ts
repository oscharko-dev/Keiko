import type {
  CodingWorkbenchNativeJiraNames,
  CodingWorkbenchNativeJiraWriteReview,
} from "@oscharko-dev/keiko-contracts";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { jiraOperationNameKey } from "../atlassian/jiraCatalogDiscovery.js";

const MAX_NAMES = 64;
const MAX_NAME_CHARS = 256;

type Family = "projects" | "issueTypes" | "fields";

/** The reads whose result names the ids a write later uses, as Chat's card reads them. */
const FAMILY_OF_READ: Readonly<Record<string, Family>> = {
  [jiraOperationNameKey("jira.projects")]: "projects",
  [jiraOperationNameKey("jira.issue-types")]: "issueTypes",
  [jiraOperationNameKey("jira.create-fields")]: "fields",
};

/**
 * What Jira called the ids this run has read so far, per family: the same facts Chat's approval
 * card takes from the conversation's completed reads. Bounded; a later read of an id wins.
 */
export interface CodingJiraRunNames {
  readonly note: (tool: string, data: CatalogJsonObject) => void;
  readonly review: (call: {
    readonly tool: string;
    readonly arguments: CatalogJsonObject;
  }) => CodingWorkbenchNativeJiraWriteReview;
}

function entriesOf(
  family: Family,
  data: CatalogJsonObject,
): readonly (readonly [string, string])[] {
  const items = data.items;
  if (!Array.isArray(items)) return [];
  return items.flatMap((item): readonly (readonly [string, string])[] => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return [];
    const { id, name, key } = item as Record<string, unknown>;
    if (typeof id !== "string" || typeof name !== "string") return [];
    const shown = family === "projects" && typeof key === "string" ? `${name} (${key})` : name;
    return [[id, shown.slice(0, MAX_NAME_CHARS)]];
  });
}

function bounded(map: ReadonlyMap<string, string>): CodingWorkbenchNativeJiraNames {
  return [...map].slice(-MAX_NAMES);
}

export function createCodingJiraRunNames(): CodingJiraRunNames {
  const known: Record<Family, Map<string, string>> = {
    projects: new Map(),
    issueTypes: new Map(),
    fields: new Map(),
  };
  return {
    note: (tool, data): void => {
      const family = FAMILY_OF_READ[jiraOperationNameKey(tool)];
      if (family === undefined) return;
      for (const [id, name] of entriesOf(family, data)) {
        known[family].delete(id);
        known[family].set(id, name);
      }
    },
    review: (call) => ({
      tool: call.tool,
      input: call.arguments,
      names: {
        projects: bounded(known.projects),
        issueTypes: bounded(known.issueTypes),
        fields: bounded(known.fields),
      },
    }),
  };
}
