import {
  isSafeAtlassianConnectorBaseUrl,
  type JiraInstanceSettingMutation,
  type JiraMutationAttempt,
  type JiraMutationReceipt,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
  type CatalogJsonValue,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { sha256Hex } from "@oscharko-dev/keiko-security";
import {
  JIRA_NONSECRET_APPLICATION_KINDS,
  projectJiraApplicationValue,
} from "./jira-managed-application-settings.js";
import { savedExactKeys, savedText } from "./jira-saved-configuration-values.js";
import { jiraObservedInstanceBaseUrl } from "./jira-instance-base-url-value.js";

export {
  JIRA_INSTANCE_SETTING_MUTATIONS,
  type JiraInstanceSettingMutation,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
export interface InstanceSettingReceipt extends JiraMutationReceipt {
  readonly valueDigest?: string;
  readonly columnIds?: readonly string[];
  readonly baseUrlDigest?: string;
  readonly readOnlyEnabled?: boolean;
}
export type InstanceSettingFailure = Omit<
  Extract<JiraMutationAttempt, { ok: false }>,
  "receipt"
> & { readonly receipt?: InstanceSettingReceipt };
export type InstanceSettingAttempt =
  InstanceSettingFailure | { readonly ok: true; readonly receipt: InstanceSettingReceipt };
export type InstanceSettingObservation<T> =
  InstanceSettingFailure | { readonly ok: true; readonly value: T };
interface Common {
  readonly actor: string;
}
export type InstanceSettingInput = Common &
  (
    | {
        readonly kind: "property";
        readonly key: string;
        readonly expected: string;
        readonly value: string;
      }
    | {
        readonly kind: "columns";
        readonly expected: readonly string[];
        readonly value: readonly string[];
      }
    | { readonly kind: "base-url"; readonly expected: string; readonly value: string }
    | { readonly kind: "read-only"; readonly expected: boolean; readonly value: boolean }
  );
export const INSTANCE_SETTING_MALFORMED: InstanceSettingFailure = {
  ok: false,
  reason: "malformed-payload",
};
export function instanceSettingRefusal(
  message: string,
  reason: "field-validation" | "conflict" | "unavailable" = "field-validation",
  receipt?: InstanceSettingReceipt,
): InstanceSettingFailure {
  return {
    ok: false,
    reason,
    detail: { messages: [message] },
    ...(receipt === undefined ? {} : { receipt }),
  };
}
const FIELDS: Readonly<Record<JiraInstanceSettingMutation, ReadonlySet<string>>> = {
  "jira.set-application-property": new Set([
    "expectedActorKey",
    "propertyKey",
    "expectedValue",
    "value",
  ]),
  "jira.set-system-columns": new Set(["expectedActorKey", "expectedColumns", "columns"]),
  "jira.set-instance-base-url": new Set([
    "expectedActorKey",
    "expectedBaseUrl",
    "baseUrl",
    "confirmInstanceWide",
  ]),
  "jira.set-read-only-mode": new Set([
    "expectedActorKey",
    "expectedEnabled",
    "enabled",
    "confirmInstanceWide",
  ]),
};
export function isJiraInstanceSettingMutation(name: string): name is JiraInstanceSettingMutation {
  return Object.hasOwn(FIELDS, name);
}
function applicationWire(key: string, value: CatalogJsonValue | undefined): string | undefined {
  const kinds: Readonly<Record<string, string>> = JIRA_NONSECRET_APPLICATION_KINDS;
  if (!Object.hasOwn(kinds, key) || typeof value !== kinds[key]) return undefined;
  const native = typeof value === "string" ? value : String(value);
  const projected = projectJiraApplicationValue(key, native);
  return "item" in projected && projected.item.valueState === "observed" ? native : undefined;
}
function propertyInput(args: CatalogJsonObject, actor: string): InstanceSettingInput | undefined {
  if (typeof args.propertyKey !== "string") return undefined;
  const expected = applicationWire(args.propertyKey, args.expectedValue);
  const value = applicationWire(args.propertyKey, args.value);
  return expected === undefined || value === undefined
    ? undefined
    : { kind: "property", actor, key: args.propertyKey, expected, value };
}
function columns(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) &&
    value.length > 0 &&
    value.length <= TOOL_CATALOG_LIMITS.maxArrayItems &&
    value.every((id) => savedText(id, 255))
    ? Object.freeze([...value])
    : undefined;
}
function columnInput(args: CatalogJsonObject, actor: string): InstanceSettingInput | undefined {
  const expected = columns(args.expectedColumns);
  const value = columns(args.columns);
  return expected === undefined || value === undefined
    ? undefined
    : { kind: "columns", actor, expected, value };
}
function urlInput(args: CatalogJsonObject, actor: string): InstanceSettingInput | undefined {
  return args.confirmInstanceWide === true &&
    jiraObservedInstanceBaseUrl(args.expectedBaseUrl) &&
    isSafeAtlassianConnectorBaseUrl(args.baseUrl) &&
    savedText(args.baseUrl, 2048) &&
    !args.baseUrl.includes("\\")
    ? { kind: "base-url", actor, expected: args.expectedBaseUrl, value: args.baseUrl }
    : undefined;
}
function readOnlyInput(args: CatalogJsonObject, actor: string): InstanceSettingInput | undefined {
  return args.confirmInstanceWide === true &&
    typeof args.expectedEnabled === "boolean" &&
    typeof args.enabled === "boolean"
    ? { kind: "read-only", actor, expected: args.expectedEnabled, value: args.enabled }
    : undefined;
}
const SELECT: Readonly<
  Record<
    JiraInstanceSettingMutation,
    (args: CatalogJsonObject, actor: string) => InstanceSettingInput | undefined
  >
> = {
  "jira.set-application-property": propertyInput,
  "jira.set-system-columns": columnInput,
  "jira.set-instance-base-url": urlInput,
  "jira.set-read-only-mode": readOnlyInput,
};
export function parseInstanceSettingInput(
  operation: JiraInstanceSettingMutation,
  args: CatalogJsonObject,
): InstanceSettingInput | undefined {
  if (!savedExactKeys(args, FIELDS[operation]) || !savedText(args.expectedActorKey, 255))
    return undefined;
  if (
    new TextEncoder().encode(JSON.stringify(args)).byteLength > TOOL_CATALOG_LIMITS.maxArgumentBytes
  )
    return undefined;
  return SELECT[operation](args, args.expectedActorKey);
}
export function instanceSettingReceipt(input: InstanceSettingInput): InstanceSettingReceipt {
  const userKey = input.actor;
  switch (input.kind) {
    case "property":
      return Object.freeze({
        userKey,
        propertyKey: input.key,
        valueDigest: sha256Hex(input.value),
      });
    case "columns":
      return Object.freeze({ userKey, columnIds: Object.freeze([...input.value]) });
    case "base-url":
      return Object.freeze({ userKey, baseUrlDigest: sha256Hex(input.value) });
    case "read-only":
      return Object.freeze({ userKey, readOnlyEnabled: input.value });
  }
}
export function sameInstanceSetting(
  left: string | boolean | readonly string[],
  right: string | boolean | readonly string[],
): boolean {
  if (typeof left === "string" || typeof left === "boolean") return left === right;
  return (
    Array.isArray(right) &&
    left.length === right.length &&
    left.every((id, index) => id === right[index])
  );
}
