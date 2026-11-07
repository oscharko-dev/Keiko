import { TOOL_CATALOG_LIMITS, type CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpToolDeclaration } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { object, text } from "./jiraManagedSchemas.js";
import {
  jiraNativePagingSchema as PAGING,
  jiraNativeReadResult,
  jiraNativeDeclaration,
  type JiraNativeDefinition,
} from "./jiraProjectStructureDescriptors.js";

const MAX = TOOL_CATALOG_LIMITS.maxArrayItems;
const NAME = { ...text(255), minLength: 1 };
const VALUE = { ...text(2048), minLength: 1 };
const BOOL = { type: "boolean" };
const PREDICATE = { type: "string", enum: ["by", "from", "to"] };
const LIST = { type: "array", maxItems: MAX, items: NAME };
const COMPLETION = object({
  value: VALUE,
  types: LIST,
  operators: LIST,
  cfid: { ...text(128), minLength: 1 },
  auto: BOOL,
  orderable: BOOL,
  searchable: BOOL,
}, ["value"]);
function page(item: CatalogJsonObject): CatalogJsonObject {
  return {
    items: { type: "array", maxItems: 100, items: item },
    startAt: PAGING.startAt,
    total: { type: "integer", minimum: 0, maximum: MAX },
    nextStartAt: PAGING.startAt,
  };
}
function read(description: string, input: CatalogJsonObject, result: CatalogJsonObject): JiraNativeDefinition {
  return { description, input, result: jiraNativeReadResult(result), risk: "read", maxResultCount: 100 };
}

export const JIRA_JQL_READ_DEFINITIONS = {
  "jira.jql-autocomplete": read(
    "Read and locally page one selected native autocomplete collection: visible fields, visible functions or reserved words. Preserve observed values, supplied type/operator metadata and normalized native flags under the explicit collection scope. This does not execute a search, validate arbitrary JQL, grant permission or establish that a field can be edited. Native display/highlight HTML is not returned.",
    object({ category: { type: "string", enum: ["fields", "functions", "reserved-words"] }, ...PAGING }, ["category"]),
    {
      category: { type: "string", enum: ["fields", "functions", "reserved-words"] },
      metadataScope: { type: "string", enum: ["visible-fields", "visible-functions", "reserved-words"] },
      ...page(COMPLETION),
    },
  ),
  "jira.jql-suggestions": read(
    "Read native JQL value suggestions for a named field and optional value prefix, with optional by/from/to predicate context. predicateValue requires predicateName. Paging selects the returned bounded native suggestion list locally, without forwarding an invented offset. Return exact plain suggestion values and explicit native-suggestions scope, omitting display HTML. No query execution, JQL-validity claim or permission grant.",
    {
      ...object({
        fieldName: NAME,
        fieldValue: text(2048),
        predicateName: PREDICATE,
        predicateValue: text(2048),
        ...PAGING,
      }, ["fieldName"]),
      dependentRequired: { predicateValue: ["predicateName"] },
    },
    {
      category: { type: "string", enum: ["suggestions"] },
      metadataScope: { type: "string", enum: ["native-suggestions"] },
      fieldName: NAME,
      fieldValue: text(2048),
      predicateName: PREDICATE,
      predicateValue: text(2048),
      ...page(object({ value: VALUE }, ["value"])),
    },
  ),
} as const satisfies Readonly<Record<string, JiraNativeDefinition>>;

export function jiraJqlDeclarationForTool(name: string): ManagedMcpToolDeclaration | undefined {
  const definitions: Readonly<Record<string, JiraNativeDefinition>> = JIRA_JQL_READ_DEFINITIONS;
  const selected = Object.hasOwn(definitions, name) ? definitions[name] : undefined;
  return selected === undefined ? undefined : jiraNativeDeclaration(name, selected);
}
