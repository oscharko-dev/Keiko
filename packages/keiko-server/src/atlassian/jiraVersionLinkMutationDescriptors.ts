import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpToolDeclaration } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { object, text } from "./jiraManagedSchemas.js";
import { jiraPropertyValueRowSchema } from "./jiraEntityPropertyDescriptors.js";
import {
  jiraVersionLinkGlobalIdSchema as GLOBAL_ID,
  jiraVersionLinkPathIdSchema as PATH_ID,
} from "./jiraRemoteVersionLinkDescriptors.js";
import {
  jiraNativeIdentitySchema as ID,
  jiraNativeVersionFields,
  jiraNativeDeclaration,
  jiraNativeWriteResult,
  type JiraNativeDefinition,
} from "./jiraProjectStructureDescriptors.js";

const NAME = { ...text(255), minLength: 1 };
const VERSION_SNAPSHOT = object(
  Object.fromEntries(
    Object.entries(jiraNativeVersionFields).map(([key, value]) => [
      key,
      key === "name" ? value : { anyOf: [value, { type: "null" }] },
    ]),
  ),
  Object.keys(jiraNativeVersionFields),
);
const NODES = {
  type: "array",
  minItems: 1,
  maxItems: TOOL_CATALOG_LIMITS.maxArrayItems,
  items: jiraPropertyValueRowSchema,
  description:
    "Complete existing typed JSON Pointer nodes. Null/empty/false/zero remain actual values. Decode only through the existing property inverse; strings are literal data, not JSON source.",
};
const LINKS = {
  type: "array",
  maxItems: TOOL_CATALOG_LIMITS.maxArrayItems,
  items: object({ globalId: GLOBAL_ID, valueNodes: NODES }, ["globalId", "valueNodes"]),
  description:
    "Complete reviewed native version-link set, with distinct exact global IDs and every full link value. Opaque or unavailable identities cannot authorize a mutation. An empty array means the entire native collection was observed empty, never unreadable.",
};
const CONTEXT = {
  versionId: ID,
  expectedProjectId: ID,
  expectedActorKey: NAME,
  expectedVersionSnapshot: VERSION_SNAPSHOT,
  expectedLinks: LINKS,
};
const REQUIRED = Object.keys(CONTEXT);
const RECEIPT = {
  versionId: ID,
  projectId: ID,
  projectKey: text(128),
  userKey: NAME,
  linkPresent: { type: "boolean" },
};
const COMMON =
  "A governed native write under ordinary issue-tracker.write; Jira still independently enforces version/project permissions. Bind the actor, project and exact version metadata and compare the complete reviewed link set before one effect. This pre-read is not an atomic compare-and-swap. These are version-link metadata operations, not issue-field or issue-relation changes. Native self and Location URLs are comparison-only and never followed. Independently rebind the same actor/project/version and verify every desired link and retained value after acknowledgement. A 404 is not absence; unknown results preserve known identities and are never replayed. linkPresent in an uncertain receipt is only the requested target state.";
function definition(
  description: string,
  input: CatalogJsonObject,
  all: boolean,
): JiraNativeDefinition {
  return {
    description: `${description} ${COMMON}`,
    input,
    risk: "write",
    maxResultCount: 1,
    result: jiraNativeWriteResult({
      ...RECEIPT,
      ...(all
        ? {
            globalIds: {
              type: "array",
              maxItems: TOOL_CATALOG_LIMITS.maxArrayItems,
              uniqueItems: true,
              items: GLOBAL_ID,
            },
          }
        : { globalId: GLOBAL_ID }),
    }),
  };
}
export const JIRA_VERSION_LINK_WRITE_DEFINITIONS = {
  "jira.upsert-version-remote-link": definition(
    "POST one complete raw JSON link value to the version collection. The value must be an object whose native globalId equals the explicit reviewed globalId. Jira would generate an ID if omitted; that input form is intentionally unsupported. An existing global ID is replaced, not duplicated. Preserve the raw value without adding a bean wrapper or parsing strings again.",
    object({ ...CONTEXT, globalId: GLOBAL_ID, valueNodes: NODES }, [
      ...REQUIRED,
      "globalId",
      "valueNodes",
    ]),
    false,
  ),
  "jira.upsert-version-remote-link-by-global-id": definition(
    "POST one complete raw JSON value to the exact global-ID path. Explicit null, false, zero, strings and empty containers are supported bounded values. If an object contains globalId it must agree with the selected path. Match the full expected link set, including any existing selected value, before replacement.",
    object({ ...CONTEXT, globalId: PATH_ID, valueNodes: NODES }, [
      ...REQUIRED,
      "globalId",
      "valueNodes",
    ]),
    false,
  ),
  "jira.delete-version-remote-link": definition(
    "DELETE the exact global ID only when it exists in the complete reviewed set. Confirm its absence from the independently readable complete same-version set while all other values remain unchanged; a selected 404 or forbidden collection is not deletion proof.",
    object({ ...CONTEXT, globalId: PATH_ID }, [...REQUIRED, "globalId"]),
    false,
  ),
  "jira.delete-version-remote-links": definition(
    "DELETE all remote links for one exact reviewed version only with confirmAll:true and the full expectedLinks set. The independent native collection must be explicitly empty afterward under the same readable parent. Reviewed globalIds remain in the receipt; they are not a claim about links hidden by incomplete evidence.",
    object({ ...CONTEXT, confirmAll: { type: "boolean", enum: [true] } }, [
      ...REQUIRED,
      "confirmAll",
    ]),
    true,
  ),
} as const satisfies Readonly<Record<string, JiraNativeDefinition>>;
export function jiraVersionLinkMutationDeclarationForTool(
  name: string,
): ManagedMcpToolDeclaration | undefined {
  const definitions: Readonly<Record<string, JiraNativeDefinition>> =
    JIRA_VERSION_LINK_WRITE_DEFINITIONS;
  const selected = Object.hasOwn(definitions, name) ? definitions[name] : undefined;
  return selected === undefined ? undefined : jiraNativeDeclaration(name, selected);
}
