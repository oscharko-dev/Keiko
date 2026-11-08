import { asRecord } from "./atlassian-sync-classify.js";
import { jiraReadOnlyProjection } from "./jira-configuration-values.js";
import { jiraObservedInstanceBaseUrl } from "./jira-instance-base-url-value.js";
import { projectJiraApplicationValue } from "./jira-managed-application-settings.js";
import { projectJiraFilterColumnState } from "./jira-managed-column-reads.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { dispatchFailure } from "./jira-mutation-failure.js";
import { INSTANCE_SETTING_MALFORMED, instanceSettingRefusal, type InstanceSettingInput, type InstanceSettingObservation } from "./jira-instance-setting-mutation-values.js";

export type InstanceSettingValue = string | boolean | readonly string[];
async function property(request: JiraMutationRequest, key: string): Promise<InstanceSettingObservation<string>> {
  const response = await request(`application-properties?${new URLSearchParams({ key }).toString()}`, "GET", undefined, "json-object-or-array");
  if (!response.ok) return dispatchFailure(response);
  if (response.status !== 200 || (response.items !== undefined && response.items.length !== 1)) return INSTANCE_SETTING_MALFORMED;
  const raw = asRecord(response.items === undefined ? response.body : response.items[0]);
  if (raw?.key !== key) return instanceSettingRefusal("The selected application-property response does not match the reviewed exact key.", "conflict");
  const projected = projectJiraApplicationValue(key, raw.value);
  if ("reason" in projected) return { ok: false, reason: projected.reason };
  return projected.item.valueState === "observed" && typeof raw.value === "string" ? { ok: true, value: raw.value }
    : instanceSettingRefusal("The exact nonsecret application value is unavailable; missing/null is not an empty string or false.", "unavailable");
}
async function columns(request: JiraMutationRequest): Promise<InstanceSettingObservation<readonly string[]>> {
  const response = await request("settings/columns", "GET", undefined, "json-array");
  if (!response.ok) return dispatchFailure(response);
  if (response.status !== 200 || response.items === undefined) return INSTANCE_SETTING_MALFORMED;
  const state = projectJiraFilterColumnState(response);
  if (!state.ok) return state;
  return state.columns === undefined ? instanceSettingRefusal("The complete system default column sequence is unavailable. No user/filter layout is substituted.", "unavailable")
    : { ok: true, value: Object.freeze([...state.columns]) };
}
async function baseUrl(request: JiraMutationRequest): Promise<InstanceSettingObservation<string>> {
  const response = await request("serverInfo", "GET", undefined, "json");
  if (!response.ok) return dispatchFailure(response);
  if (response.status !== 200) return INSTANCE_SETTING_MALFORMED;
  const value = response.body?.baseUrl;
  return jiraObservedInstanceBaseUrl(value) ? { ok: true, value }
    : instanceSettingRefusal("The native configured base URL is unavailable or unsafe to retain as a review fact. It is not replaced with the stored connection URL.", "unavailable");
}
async function readOnly(request: JiraMutationRequest): Promise<InstanceSettingObservation<boolean>> {
  const response = await request("readonly-mode", "GET", undefined, "json");
  if (!response.ok) return dispatchFailure(response);
  if (response.status !== 200) return INSTANCE_SETTING_MALFORMED;
  const observed = jiraReadOnlyProjection(response.body);
  return typeof observed?.enabled === "boolean" ? { ok: true, value: observed.enabled }
    : instanceSettingRefusal("The native read-only enabled flag is unavailable. Missing/null is not disabled.", "unavailable");
}
export function readInstanceSetting(request: JiraMutationRequest, input: InstanceSettingInput): Promise<InstanceSettingObservation<InstanceSettingValue>> {
  switch (input.kind) {
    case "property": return property(request, input.key);
    case "columns": return columns(request);
    case "base-url": return baseUrl(request);
    case "read-only": return readOnly(request);
  }
}
