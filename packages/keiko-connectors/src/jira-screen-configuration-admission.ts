import type {
  JiraMutationAttempt,
  JiraMutationReceipt,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { projectJiraCollection } from "./jira-managed-metadata.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { jiraScreenFieldProjection } from "./jira-managed-screen-reads.js";
import { dispatchFailure } from "./jira-mutation-failure.js";
import {
  bindJiraScreen,
  readJiraScreenTabs,
  readJiraScreenTabFields,
} from "./jira-screen-tab-admission.js";
import {
  screenFieldSnapshot,
  type ScreenConfigurationInput,
  type ScopedScreenConfigurationInput,
  type ScreenFieldSnapshot,
  type ScreenTabSnapshot,
} from "./jira-screen-configuration-inputs.js";

export interface JiraScreenConfigurationReceipt extends JiraMutationReceipt {
  readonly fieldPresent?: boolean;
  readonly showWhenEmpty?: boolean;
}
type ScreenConfigurationFailure = Omit<
  Extract<JiraMutationAttempt, { readonly ok: false }>,
  "receipt"
> & {
  readonly receipt?: JiraScreenConfigurationReceipt;
};
export type JiraScreenConfigurationAttempt =
  | ScreenConfigurationFailure
  | { readonly ok: true; readonly receipt: JiraScreenConfigurationReceipt };
type Observation<T> = ScreenConfigurationFailure | { readonly ok: true; readonly value: T };
interface ScreenState {
  readonly tabs: readonly CatalogJsonObject[];
  readonly fields: readonly ScreenFieldSnapshot[];
}
export const SCREEN_CONFIGURATION_MALFORMED: ScreenConfigurationFailure = {
  ok: false,
  reason: "malformed-payload",
};
const SCREEN_CONFIGURATION_CONFLICT: ScreenConfigurationFailure = {
  ok: false,
  reason: "conflict",
  detail: {
    messages: [
      "The screen, tab or complete reviewed field layout changed. Read and review the current layout before preparing this operation again. Nothing was written.",
    ],
  },
};
export function screenConfigurationReceipt(
  input: ScreenConfigurationInput,
): JiraScreenConfigurationReceipt {
  if (input.kind === "default") return { fieldId: input.fieldId, fieldPresent: true };
  const parent = { screenId: input.screenId, tabId: input.tabId };
  if (input.kind === "tab-move") return parent;
  return {
    ...parent,
    fieldId: input.fieldId,
    ...(input.kind === "add" || input.kind === "remove"
      ? { fieldPresent: input.kind === "add" }
      : {}),
    ...(input.kind === "show" ? { showWhenEmpty: input.showWhenEmpty } : {}),
  };
}
export function screenConfigurationUnconfirmed(
  receipt: JiraScreenConfigurationReceipt,
  message: string,
): ScreenConfigurationFailure {
  return { ok: false, reason: "unavailable", receipt, detail: { messages: [message] } };
}
function screenConfigurationUnchanged(input: ScreenConfigurationInput): ScreenConfigurationFailure {
  return {
    ok: false,
    reason: "conflict",
    receipt: screenConfigurationReceipt(input),
    detail: {
      unchanged: true,
      messages: [
        "The independently read screen layout already matches the requested change. Nothing was written.",
      ],
    },
  };
}
function sameScreenField(left: ScreenFieldSnapshot, right: ScreenFieldSnapshot): boolean {
  return (
    left.id === right.id &&
    left.name === right.name &&
    left.type === right.type &&
    left.showWhenEmpty === right.showWhenEmpty
  );
}
function sameScreenTabs(
  actual: readonly CatalogJsonObject[],
  expected: readonly ScreenTabSnapshot[],
): boolean {
  return (
    actual.length === expected.length &&
    actual.every((tab, index) => {
      const reviewed = expected[index];
      return reviewed !== undefined && tab.id === reviewed.id && tab.name === reviewed.name;
    })
  );
}
function sameFields(
  actual: readonly ScreenFieldSnapshot[],
  expected: readonly ScreenFieldSnapshot[],
): boolean {
  return (
    actual.length === expected.length &&
    actual.every((field, index) => {
      const reviewed = expected[index];
      return reviewed !== undefined && sameScreenField(field, reviewed);
    })
  );
}
export async function readScreenConfigurationState(
  request: JiraMutationRequest,
  input: ScopedScreenConfigurationInput,
): Promise<Observation<ScreenState>> {
  const screen = await bindJiraScreen(request, input);
  if (!screen.ok) return screen;
  const tabs = await readJiraScreenTabs(request, input.screenId);
  if (!tabs.ok) return tabs;
  const expected = input.expectedTabs.find((tab) => tab.id === input.tabId);
  if (
    expected === undefined ||
    !tabs.items.some((tab) => tab.id === input.tabId && tab.name === expected.name)
  )
    return SCREEN_CONFIGURATION_CONFLICT;
  if (input.kind === "tab-move") return { ok: true, value: { tabs: tabs.items, fields: [] } };
  const fields = await readJiraScreenTabFields(request, input.screenId, input.tabId);
  if (!fields.ok) return fields;
  const projected = fields.items.map(screenFieldSnapshot);
  return projected.every((field): field is ScreenFieldSnapshot => field !== undefined)
    ? { ok: true, value: { tabs: tabs.items, fields: projected } }
    : SCREEN_CONFIGURATION_MALFORMED;
}
async function observedField(
  request: JiraMutationRequest,
  path: string,
  fieldId: string,
  expectedName: string,
): Promise<Observation<ScreenFieldSnapshot>> {
  const response = await request(path, "GET", undefined, "json-array");
  if (!response.ok) return dispatchFailure(response);
  if (response.status !== 200 || response.items === undefined)
    return SCREEN_CONFIGURATION_MALFORMED;
  if (response.items.length > TOOL_CATALOG_LIMITS.maxArrayItems)
    return { ok: false, reason: "bounds-exceeded" };
  const items = projectJiraCollection(
    response.items,
    TOOL_CATALOG_LIMITS.maxArrayItems,
    jiraScreenFieldProjection,
    "id",
  );
  if (items === undefined) return SCREEN_CONFIGURATION_MALFORMED;
  const field = screenFieldSnapshot(items.find((item) => item.id === fieldId));
  return field?.name !== expectedName ? SCREEN_CONFIGURATION_CONFLICT : { ok: true, value: field };
}
async function inspectFields(
  request: JiraMutationRequest,
  input: Exclude<ScopedScreenConfigurationInput, { readonly kind: "tab-move" }>,
  fields: readonly ScreenFieldSnapshot[],
): Promise<ScreenConfigurationFailure | undefined> {
  if (!sameFields(fields, input.expectedFields)) return SCREEN_CONFIGURATION_CONFLICT;
  if (input.kind === "add") {
    if (fields.length >= TOOL_CATALOG_LIMITS.maxArrayItems)
      return { ok: false, reason: "bounds-exceeded" };
    const field = await observedField(
      request,
      `screens/${input.screenId}/availableFields`,
      input.fieldId,
      input.expectedFieldName,
    );
    return field.ok ? undefined : field;
  }
  const target = fields.find((field) => field.id === input.fieldId);
  if (input.kind === "show" && target?.showWhenEmpty === input.showWhenEmpty)
    return screenConfigurationUnchanged(input);
  return input.kind === "field-move" &&
    input.desiredFieldIds.every((id, index) => id === fields[index]?.id)
    ? screenConfigurationUnchanged(input)
    : undefined;
}
export async function inspectScreenConfiguration(
  request: JiraMutationRequest,
  input: ScreenConfigurationInput,
): Promise<ScreenConfigurationFailure | undefined> {
  if (input.kind === "default") {
    const field = await observedField(request, "field", input.fieldId, input.expectedFieldName);
    return field.ok ? undefined : field;
  }
  const current = await readScreenConfigurationState(request, input);
  if (!current.ok) return current;
  if (!sameScreenTabs(current.value.tabs, input.expectedTabs)) return SCREEN_CONFIGURATION_CONFLICT;
  if (input.kind === "tab-move")
    return input.desiredTabIds.every((id, index) => id === input.expectedTabs[index]?.id)
      ? screenConfigurationUnchanged(input)
      : undefined;
  return inspectFields(request, input, current.value.fields);
}
function fieldsAfter(
  input: Exclude<ScopedScreenConfigurationInput, { readonly kind: "tab-move" }>,
  actual: readonly ScreenFieldSnapshot[],
): boolean {
  if (input.kind === "add") {
    const added = actual.find((field) => field.id === input.fieldId);
    return (
      added?.name === input.expectedFieldName &&
      sameFields(
        actual.filter((field) => field.id !== input.fieldId),
        input.expectedFields,
      )
    );
  }
  if (input.kind === "remove")
    return sameFields(
      actual,
      input.expectedFields.filter((field) => field.id !== input.fieldId),
    );
  if (input.kind === "show")
    return sameFields(
      actual,
      input.expectedFields.map((field) =>
        field.id === input.fieldId ? { ...field, showWhenEmpty: input.showWhenEmpty } : field,
      ),
    );
  const originals = new Map(input.expectedFields.map((field) => [field.id, field]));
  return (
    actual.length === input.desiredFieldIds.length &&
    actual.every((field, index) => {
      const original = originals.get(field.id);
      return (
        field.id === input.desiredFieldIds[index] &&
        original !== undefined &&
        sameScreenField(field, original)
      );
    })
  );
}
export function screenConfigurationMatches(
  input: ScopedScreenConfigurationInput,
  actual: ScreenState,
): boolean {
  if (input.kind !== "tab-move")
    return sameScreenTabs(actual.tabs, input.expectedTabs) && fieldsAfter(input, actual.fields);
  const originals = new Map(input.expectedTabs.map((tab) => [tab.id, tab.name]));
  return (
    actual.tabs.length === input.desiredTabIds.length &&
    actual.tabs.every(
      (tab, index) =>
        tab.id === input.desiredTabIds[index] &&
        typeof tab.id === "string" &&
        tab.name === originals.get(tab.id),
    )
  );
}
