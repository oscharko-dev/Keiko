import { TOOL_CATALOG_LIMITS } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpToolDeclaration } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { object, text } from "./jiraManagedSchemas.js";
import {
  jiraNativeDeclaration,
  jiraNativeIdentitySchema as ID,
  jiraNativePagingSchema as PAGING,
  jiraNativeReadDefinition as read,
  jiraNativeBoundedLocalPageFields as page,
  type JiraNativeDefinition,
} from "./jiraProjectStructureDescriptors.js";

const MAX = TOOL_CATALOG_LIMITS.maxArrayItems;
const BOOL = { type: "boolean" };
const CACHED_DUPLICATES = {
  type: "string",
  enum: ["cached-duplicate-accounts"],
};
export const JIRA_ACCOUNT_DIAGNOSTIC_READ_DEFINITIONS = {
  "jira.password-policy": read(
    "Read and locally page the native password requirement messages for an explicit hasOldPassword context, defaulting to false. These messages describe requirements only: this operation never receives or tests a password, proves acceptance, or grants permission. Empty requirements are a known empty list, not proof that every password is permitted.",
    object({ hasOldPassword: BOOL, ...PAGING }),
    {
      ...page(object({ requirement: { ...text(1024), minLength: 1 } }, ["requirement"])),
      policyScope: { type: "string", enum: ["requirements-only"] },
      hasOldPassword: BOOL,
    },
    100,
  ),
  "jira.duplicate-user-count": read(
    "Observe the exact native cached duplicate-account count with flush=false. A reported zero is an observation of that cache, not a fresh directory scan, complete account audit, or proof of instance health. Missing or unsafe counts remain unavailable; this operation never flushes the cache or changes accounts.",
    object({}),
    {
      count: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
      observationScope: CACHED_DUPLICATES,
    },
  ),
  "jira.duplicate-users": read(
    "Read and locally page the bounded cached duplicate-account map with flush=false. Preserve exact usernames and directory IDs; supplied directory names and userActive flags are observations, with false distinct from unknown. The total describes returned cached usernames only, not all users or freshly scanned duplicates. No cache flush, directory synchronization or account mutation occurs.",
    object(PAGING),
    {
      ...page(
        object(
          {
            username: { ...text(255), minLength: 1 },
            directories: {
              type: "array",
              maxItems: MAX,
              items: object(
                {
                  directoryId: ID,
                  directoryName: { ...text(255), minLength: 1 },
                  userActive: BOOL,
                },
                ["directoryId"],
              ),
            },
          },
          ["username", "directories"],
        ),
      ),
      observationScope: CACHED_DUPLICATES,
    },
    100,
  ),
  "jira.search-error": read(
    "Observe the stored native search error in the connected user's current HTTP context. HTTP204 explicitly means no stored error in that context; HTTP200 must supply a nonempty readable message. This is not a browser-session inspection, JQL validation, issue search, or evidence that another request succeeded. It changes no search, filter or session state.",
    object({}),
    {
      scope: { type: "string", enum: ["current-user-http-context"] },
      errorPresent: BOOL,
      message: { ...text(4096), minLength: 1 },
    },
  ),
} as const satisfies Readonly<Record<string, JiraNativeDefinition>>;

export function jiraAccountDiagnosticDeclarationForTool(
  name: string,
): ManagedMcpToolDeclaration | undefined {
  const definitions: Readonly<Record<string, JiraNativeDefinition>> =
    JIRA_ACCOUNT_DIAGNOSTIC_READ_DEFINITIONS;
  const selected = Object.hasOwn(definitions, name) ? definitions[name] : undefined;
  return selected === undefined ? undefined : jiraNativeDeclaration(name, selected);
}
