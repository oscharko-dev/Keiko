import type {
  CatalogJsonObject,
  CatalogJsonValue,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import {
  jiraMutationReceiptFits,
  type JiraMutationRequest,
} from "./jira-managed-mutation-metadata.js";
import { dispatchFailure, JiraAcknowledgedMutationError } from "./jira-mutation-failure.js";
import { readSavedActor } from "./jira-saved-configuration-values.js";
import {
  admitJiraSystemColumns,
  readInstanceSetting,
} from "./jira-instance-setting-observations.js";
import {
  INSTANCE_SETTING_MALFORMED,
  instanceSettingReceipt,
  instanceSettingRefusal,
  parseInstanceSettingInput,
  sameInstanceSetting,
  type InstanceSettingAttempt,
  type InstanceSettingFailure,
  type InstanceSettingInput,
  type InstanceSettingReceipt,
  type JiraInstanceSettingMutation,
} from "./jira-instance-setting-mutation-values.js";
export {
  JIRA_INSTANCE_SETTING_MUTATIONS,
  isJiraInstanceSettingMutation,
  type JiraInstanceSettingMutation,
} from "./jira-instance-setting-mutation-values.js";

function nativeEffect(input: InstanceSettingInput): {
  readonly path: string;
  readonly body: CatalogJsonValue;
} {
  switch (input.kind) {
    case "property":
      return {
        path: `application-properties/${input.key}`,
        body: { id: input.key, value: input.value },
      };
    case "columns":
      return { path: "settings/columns", body: { columns: input.value } };
    case "base-url":
      return { path: "settings/baseUrl", body: input.value };
    // ReadOnlyModeUpdateRequest (11.3): omitted banner fields stay unchanged;
    // empty strings would clear/reset them and must never be synthesized here.
    case "read-only":
      return { path: "readonly-mode", body: { enabled: input.value } };
  }
}
async function admission(
  request: JiraMutationRequest,
  input: InstanceSettingInput,
  receipt: InstanceSettingReceipt,
): Promise<InstanceSettingFailure | undefined> {
  const actor = await readSavedActor(request, input.actor);
  if (!actor.ok) return actor;
  const current = await readInstanceSetting(request, input);
  if (!current.ok) return current;
  if (!sameInstanceSetting(current.value, input.expected))
    return instanceSettingRefusal(
      "The exact reviewed instance setting changed. Read and review the current value or complete ordered columns before writing.",
      "conflict",
    );
  if (!sameInstanceSetting(current.value, input.value))
    return input.kind === "columns" ? admitJiraSystemColumns(request, input.value) : undefined;
  return {
    ...instanceSettingRefusal(
      "The independently observed configuration already equals the requested target. Nothing was written; effective instance-wide behavior is not inferred.",
      "conflict",
      receipt,
    ),
    detail: {
      unchanged: true,
      messages: [
        "The exact reviewed instance configuration is unchanged. No native write was sent.",
      ],
    },
  };
}
async function confirm(
  request: JiraMutationRequest,
  input: InstanceSettingInput,
  receipt: InstanceSettingReceipt,
): Promise<InstanceSettingAttempt> {
  const actor = await readSavedActor(request, input.actor);
  if (!actor.ok) return { ...actor, receipt };
  const current = await readInstanceSetting(request, input);
  if (!current.ok) return { ...current, receipt };
  if (!sameInstanceSetting(current.value, input.value))
    return instanceSettingRefusal(
      "Jira acknowledged the request, but the independent configuration read did not match. Keep the requested target receipt and do not replay.",
      "unavailable",
      receipt,
    );
  if (input.kind === "base-url")
    return instanceSettingRefusal(
      "Jira acknowledged the base URL change and its configuration was observed. This cannot establish all global URL, proxy, notification or routing consequences. The connection destination remains unchanged. Do not replay the request.",
      "unavailable",
      receipt,
    );
  return { ok: true, receipt };
}
async function beforeEffect(
  request: JiraMutationRequest,
  input: InstanceSettingInput,
): Promise<InstanceSettingFailure | undefined> {
  const actor = await readSavedActor(request, input.actor);
  if (!actor.ok) return actor;
  return input.kind === "columns" ? admitJiraSystemColumns(request, input.value) : undefined;
}
/** Fixed system configuration calls. The trusted connection, custody and outbound URL never change. */
export async function executeJiraInstanceSettingMutation(
  operation: JiraInstanceSettingMutation,
  args: CatalogJsonObject,
  request: JiraMutationRequest,
  check = false,
): Promise<InstanceSettingAttempt> {
  const input = parseInstanceSettingInput(operation, args);
  if (input === undefined)
    return instanceSettingRefusal(
      "Use the exact actor and typed expected value. Only four documented nonsecret application keys are supported. System column lists are complete, ordered and nonempty, with repetitions preserved. Base URL/read-only changes require confirmInstanceWide:true; desired base URL must be HTTPS without credentials/query/fragment. Banner fields and arbitrary properties are unsupported.",
    );
  const receipt = instanceSettingReceipt(input);
  if (!jiraMutationReceiptFits(receipt))
    return instanceSettingRefusal(
      "The requested ordered column receipt exceeds the existing 16 KiB bound. Reduce the column sequence before any request.",
    );
  const refused = await admission(request, input, receipt);
  if (refused !== undefined) return refused;
  if (check) return { ok: true, receipt: {} };
  const dispatchRefusal = await beforeEffect(request, input);
  if (dispatchRefusal !== undefined) return dispatchRefusal;
  return dispatchInstanceSetting(request, input, receipt);
}
async function dispatchInstanceSetting(
  request: JiraMutationRequest,
  input: InstanceSettingInput,
  receipt: InstanceSettingReceipt,
): Promise<InstanceSettingAttempt> {
  const effect = nativeEffect(input);
  const response = await request(effect.path, "PUT", effect.body, "none");
  if (!response.ok) return { ...dispatchFailure(response), receipt };
  if (response.status < 200 || response.status >= 300)
    return { ...INSTANCE_SETTING_MALFORMED, receipt };
  try {
    return await confirm(request, input, receipt);
  } catch (error) {
    throw new JiraAcknowledgedMutationError(error, receipt);
  }
}
