import {
  JIRA_PERMISSION_SCHEME_MUTATIONS,
  type JiraPermissionSchemeMutation,
  type JiraMutationAttempt,
  type JiraMutationReceipt,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { asArray, asRecord } from "./atlassian-sync-classify.js";
import { jiraPropertyPathKey } from "./jira-entity-property-values.js";
import {
  jiraPermissionGrantProjection,
  jiraPermissionSchemeProjection,
} from "./jira-managed-access-schemes.js";
import { jiraNativeId } from "./jira-native-values.js";
import { savedExactKeys, savedName, savedText } from "./jira-saved-configuration-values.js";

export { JIRA_PERMISSION_SCHEME_MUTATIONS, type JiraPermissionSchemeMutation };
export interface PermissionSchemeReceipt extends JiraMutationReceipt {
  readonly schemeId?: string;
  readonly schemePresent?: boolean;
  readonly permissionId?: string;
  readonly grantPresent?: boolean;
  readonly attributeKey?: string;
  readonly attributeEnabled?: boolean;
}
export type PermissionSchemeFailure = Omit<
  Extract<JiraMutationAttempt, { ok: false }>,
  "receipt"
> & { readonly receipt?: PermissionSchemeReceipt };
export type PermissionSchemeAttempt =
  PermissionSchemeFailure | { readonly ok: true; readonly receipt: PermissionSchemeReceipt };
export type PermissionSchemeObservation<T> =
  PermissionSchemeFailure | { readonly ok: true; readonly value: T };
export type PermissionHolder = Readonly<{ type: string; parameter?: string }>;
export type PermissionGrantValue = Readonly<{
  permission: string;
  holder: PermissionHolder;
}>;
export type PermissionGrantSnapshot = PermissionGrantValue & { readonly id: string };
export type PermissionSchemeMetadata = Readonly<{
  id: string;
  name: string;
  description: string;
}>;
export type PermissionSchemeSnapshot = PermissionSchemeMetadata & {
  readonly permissions: readonly PermissionGrantSnapshot[];
};
export type PermissionSchemeTarget = Readonly<{
  name?: string;
  description?: string;
  permissions?: readonly PermissionGrantValue[];
}>;
export interface PermissionSchemeInput {
  readonly operation: JiraPermissionSchemeMutation;
  readonly actor: string;
  readonly expected?: PermissionSchemeSnapshot;
  readonly target?: PermissionSchemeTarget;
  readonly grant?: PermissionGrantValue;
  readonly permissionId?: string;
  readonly attribute?: {
    readonly key: string;
    readonly expectedValue: "true" | "false";
    readonly enabled: boolean;
  };
}
export const PERMISSION_SCHEME_MALFORMED: PermissionSchemeFailure = {
  ok: false,
  reason: "malformed-payload",
};
export function permissionSchemeRefusal(
  message: string,
  reason: "field-validation" | "conflict" | "unavailable" = "field-validation",
  receipt?: PermissionSchemeReceipt,
): PermissionSchemeFailure {
  return {
    ok: false,
    reason,
    detail: { messages: [message] },
    ...(receipt === undefined ? {} : { receipt }),
  };
}
const HOLDER_FIELDS = new Set(["type", "parameter"]);
const GRANT_FIELDS = new Set(["id", "permission", "holder"]);
const TARGET_GRANT_FIELDS = new Set(["permission", "holder"]);
const SNAPSHOT_FIELDS = new Set(["id", "name", "description", "permissions"]);
const SIMPLE_HOLDERS = new Set([
  "anyone",
  "reporter",
  "projectLead",
  "assignee",
  "reporterWithCreatePermission",
  "assigneeWithAssignablePermission",
]);
const PARAMETER_HOLDERS = new Set([
  "group",
  "user",
  "projectRole",
  "userCustomField",
  "groupCustomField",
]);
const ANONYMOUS_READ_PERMISSIONS: ReadonlySet<string> = new Set([
  "BROWSE_PROJECTS",
  "VIEW_DEV_TOOLS",
  "VIEW_READONLY_WORKFLOW",
]);
const BROWSE_ONLY_HOLDERS = new Set([
  "reporterWithCreatePermission",
  "assigneeWithAssignablePermission",
]);
function holder(value: unknown): PermissionHolder | undefined {
  const raw = asRecord(value);
  if (raw === undefined || !savedExactKeys(raw, HOLDER_FIELDS) || !savedText(raw.type, 128))
    return undefined;
  if (raw.parameter === undefined) return { type: raw.type };
  return savedText(raw.parameter, 255, true)
    ? { type: raw.type, parameter: raw.parameter }
    : undefined;
}
function simpleHolderAllowed(selected: PermissionHolder, permission: string): boolean {
  // Native anyone grants access even without login. Observed grants stay readable/removable;
  // a new grant must belong to the reviewed anonymous read set.
  return (
    selected.parameter === undefined &&
    (!BROWSE_ONLY_HOLDERS.has(selected.type) || permission === "BROWSE_PROJECTS") &&
    (selected.type !== "anyone" || ANONYMOUS_READ_PERMISSIONS.has(permission))
  );
}
function newHolder(value: unknown, permission: string): PermissionHolder | undefined {
  const selected = holder(value);
  if (selected === undefined) return undefined;
  if (SIMPLE_HOLDERS.has(selected.type))
    return simpleHolderAllowed(selected, permission) ? selected : undefined;
  if (!PARAMETER_HOLDERS.has(selected.type) || !savedText(selected.parameter, 255))
    return undefined;
  if (selected.type === "projectRole" && !jiraNativeId(selected.parameter)) return undefined;
  // Preserve exact custom-field parameters; no numeric/customfield prefix conversion.
  return selected;
}
/** Native extension-holder observations remain readable; new grants support documented built-ins. */
export function permissionGrantSnapshot(value: unknown): PermissionGrantSnapshot | undefined {
  const projected = jiraPermissionGrantProjection(value);
  const selectedHolder = holder(projected?.holder);
  return projected !== undefined &&
    jiraNativeId(projected.id) &&
    savedText(projected.permission, 255) &&
    selectedHolder !== undefined
    ? { id: projected.id, permission: projected.permission, holder: selectedHolder }
    : undefined;
}
function expectedGrant(value: unknown): PermissionGrantSnapshot | undefined {
  const raw = asRecord(value);
  if (raw === undefined || !savedExactKeys(raw, GRANT_FIELDS) || !jiraNativeId(raw.id))
    return undefined;
  // A reviewed holder cannot smuggle expanded users/groups or a null parameter through projection.
  return holder(raw.holder) === undefined ? undefined : permissionGrantSnapshot(raw);
}
function newGrant(value: unknown): PermissionGrantValue | undefined {
  const raw = asRecord(value);
  if (
    raw === undefined ||
    !savedExactKeys(raw, TARGET_GRANT_FIELDS) ||
    !savedText(raw.permission, 255)
  )
    return undefined;
  const selected = newHolder(raw.holder, raw.permission);
  return selected === undefined ? undefined : { permission: raw.permission, holder: selected };
}
export function samePermissionGrant(
  left: PermissionGrantValue,
  right: PermissionGrantValue,
): boolean {
  return (
    left.permission === right.permission &&
    left.holder.type === right.holder.type &&
    left.holder.parameter === right.holder.parameter
  );
}
function grantValues<T extends PermissionGrantValue>(
  value: unknown,
  project: (value: unknown) => T | undefined,
): readonly T[] | undefined {
  const rows = asArray(value);
  if (rows === undefined || rows.length > TOOL_CATALOG_LIMITS.maxArrayItems) return undefined;
  const grants: T[] = [];
  for (const row of rows) {
    const selected = project(row);
    if (
      selected === undefined ||
      grants.some((existing) => samePermissionGrant(existing, selected))
    )
      return undefined;
    grants.push(selected);
  }
  return grants;
}
export function permissionGrantSnapshots(
  value: unknown,
): readonly PermissionGrantSnapshot[] | undefined {
  const rows = grantValues(value, permissionGrantSnapshot);
  if (rows === undefined) return undefined;
  return new Set(rows.map(({ id }) => id)).size === rows.length ? rows : undefined;
}
export function jiraPermissionSchemeInputSnapshot(
  value: unknown,
): PermissionSchemeSnapshot | undefined {
  const raw = asRecord(value);
  if (
    raw === undefined ||
    !savedExactKeys(raw, SNAPSHOT_FIELDS) ||
    !jiraNativeId(raw.id) ||
    !savedName(raw.name) ||
    !savedText(raw.description, 32768, true)
  )
    return undefined;
  const permissions = grantValues(raw.permissions, expectedGrant);
  if (permissions === undefined) return undefined;
  return new Set(permissions.map(({ id }) => id)).size === permissions.length
    ? { id: raw.id, name: raw.name, description: raw.description, permissions }
    : undefined;
}
export function permissionSchemeMetadata(value: unknown): PermissionSchemeMetadata | undefined {
  const projected = jiraPermissionSchemeProjection(value);
  return projected !== undefined &&
    jiraNativeId(projected.id) &&
    savedName(projected.name) &&
    savedText(projected.description, 32768, true)
    ? { id: projected.id, name: projected.name, description: projected.description }
    : undefined;
}
const COMMON = ["expectedActorKey", "expectedScheme"];
const INPUT_FIELDS: Readonly<Record<JiraPermissionSchemeMutation, ReadonlySet<string>>> = {
  "jira.create-permission-scheme": new Set([
    "expectedActorKey",
    "name",
    "description",
    "permissions",
  ]),
  "jira.update-permission-scheme": new Set([...COMMON, "name", "description", "permissions"]),
  "jira.delete-permission-scheme": new Set([...COMMON, "confirmUnverifiedDeletion"]),
  "jira.add-permission-grant": new Set([...COMMON, "grant"]),
  "jira.delete-permission-grant": new Set([...COMMON, "permissionId"]),
  "jira.set-permission-scheme-attribute": new Set([
    ...COMMON,
    "attributeKey",
    "expectedValue",
    "enabled",
  ]),
};
function targetMetadata(
  args: CatalogJsonObject,
  create: boolean,
): Pick<PermissionSchemeTarget, "name" | "description"> | undefined {
  const selected: { name?: string; description?: string } = {};
  if (create || args.name !== undefined) {
    if (!savedName(args.name)) return undefined;
    selected.name = args.name;
  }
  if (create || args.description !== undefined) {
    if (!savedText(args.description, 32768, true)) return undefined;
    selected.description = args.description;
  }
  return selected;
}
function target(args: CatalogJsonObject, create: boolean): PermissionSchemeTarget | undefined {
  const metadata = targetMetadata(args, create);
  if (metadata === undefined) return undefined;
  if (!create && args.permissions === undefined)
    return Object.keys(metadata).length === 0 ? undefined : metadata;
  const permissions = grantValues(args.permissions, newGrant);
  return permissions === undefined ? undefined : { ...metadata, permissions };
}
function schemeTargetInput(
  base: PermissionSchemeInput,
  args: CatalogJsonObject,
): PermissionSchemeInput | undefined {
  const selected = target(args, base.operation === "jira.create-permission-scheme");
  return selected === undefined ? undefined : { ...base, target: selected };
}
function grantInput(
  base: PermissionSchemeInput,
  args: CatalogJsonObject,
): PermissionSchemeInput | undefined {
  const selected = newGrant(args.grant);
  return selected === undefined ? undefined : { ...base, grant: selected };
}
function attributeInput(
  base: PermissionSchemeInput,
  args: CatalogJsonObject,
): PermissionSchemeInput | undefined {
  return jiraPropertyPathKey(args.attributeKey) &&
    (args.expectedValue === "true" || args.expectedValue === "false") &&
    typeof args.enabled === "boolean"
    ? {
        ...base,
        attribute: {
          key: args.attributeKey,
          expectedValue: args.expectedValue,
          enabled: args.enabled,
        },
      }
    : undefined;
}
const SELECT_INPUT: Readonly<
  Record<
    JiraPermissionSchemeMutation,
    (base: PermissionSchemeInput, args: CatalogJsonObject) => PermissionSchemeInput | undefined
  >
> = {
  "jira.create-permission-scheme": schemeTargetInput,
  "jira.update-permission-scheme": schemeTargetInput,
  "jira.delete-permission-scheme": (base, args) =>
    args.confirmUnverifiedDeletion === true ? base : undefined,
  "jira.add-permission-grant": grantInput,
  "jira.delete-permission-grant": (base, args) =>
    jiraNativeId(args.permissionId) &&
    base.expected?.permissions.some(({ id }) => id === args.permissionId)
      ? { ...base, permissionId: args.permissionId }
      : undefined,
  "jira.set-permission-scheme-attribute": attributeInput,
};
export function parsePermissionSchemeInput(
  operation: JiraPermissionSchemeMutation,
  args: CatalogJsonObject,
): PermissionSchemeInput | undefined {
  if (!savedExactKeys(args, INPUT_FIELDS[operation]) || !savedText(args.expectedActorKey, 255))
    return undefined;
  const expected =
    operation === "jira.create-permission-scheme"
      ? undefined
      : jiraPermissionSchemeInputSnapshot(args.expectedScheme);
  if (operation !== "jira.create-permission-scheme" && expected === undefined) return undefined;
  if (
    new TextEncoder().encode(JSON.stringify(args)).byteLength > TOOL_CATALOG_LIMITS.maxArgumentBytes
  )
    return undefined;
  return SELECT_INPUT[operation](
    { operation, actor: args.expectedActorKey, ...(expected === undefined ? {} : { expected }) },
    args,
  );
}
export function samePermissionSet(
  actual: readonly PermissionGrantSnapshot[],
  expected: readonly PermissionGrantValue[],
  identities: boolean,
): boolean {
  return (
    actual.length === expected.length &&
    expected.every((grant) =>
      actual.some(
        (other) =>
          samePermissionGrant(other, grant) &&
          (!identities || ("id" in grant && other.id === grant.id)),
      ),
    )
  );
}
export function isJiraPermissionSchemeMutation(name: string): name is JiraPermissionSchemeMutation {
  return (JIRA_PERMISSION_SCHEME_MUTATIONS as readonly string[]).includes(name);
}
