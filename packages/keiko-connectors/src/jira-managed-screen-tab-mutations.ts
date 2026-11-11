import {
  isSafeAtlassianIdentifier,
  type JiraMutationAttempt,
  type JiraMutationReceipt,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { asArray } from "./atlassian-sync-classify.js";
import { jiraCreationAcknowledgement } from "./jira-creation-acknowledgement.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { dispatchFailure, JiraAcknowledgedMutationError } from "./jira-mutation-failure.js";
import {
  jiraNativeId,
  jiraNativeName,
  jiraNativeNumericId,
  jiraNativeText,
} from "./jira-native-values.js";
import {
  bindJiraScreen,
  readJiraScreenTabs,
  readJiraScreenTabFields,
  type JiraScreenTabSelection,
} from "./jira-screen-tab-admission.js";

type TabWrite = keyof typeof FIELDS;
interface ScreenTabReceipt extends JiraMutationReceipt {
  readonly screenId?: string;
  readonly tabId?: string;
}
type Failure = Omit<Extract<JiraMutationAttempt, { readonly ok: false }>, "receipt"> & {
  readonly receipt?: ScreenTabReceipt;
};
export type JiraScreenTabMutationAttempt =
  Failure | { readonly ok: true; readonly receipt: ScreenTabReceipt };
interface Input extends JiraScreenTabSelection {
  readonly name?: string;
  readonly tabId?: string;
  readonly expectedName?: string;
  readonly expectedFieldIds?: readonly string[];
}
interface Plan {
  readonly selected: Input;
  readonly tabs: readonly CatalogJsonObject[];
}
const MALFORMED: Failure = { ok: false, reason: "malformed-payload" };
const CONFLICT: Failure = { ok: false, reason: "conflict" };
const INVALID: Failure = {
  ok: false,
  reason: "field-validation",
  detail: {
    validation: "invalid-field",
    messages: [
      "Select the exact screen ID and reviewed screen name. Rename or delete also needs the tab ID and reviewed tab name. Delete requires the complete ordered reviewed field IDs.",
    ],
  },
};
const FIELDS = {
  "jira.create-screen-tab": new Set(["screenId", "expectedScreenName", "name"]),
  "jira.rename-screen-tab": new Set([
    "screenId",
    "expectedScreenName",
    "tabId",
    "expectedName",
    "name",
  ]),
  "jira.delete-screen-tab": new Set([
    "screenId",
    "expectedScreenName",
    "tabId",
    "expectedName",
    "expectedFieldIds",
  ]),
} as const satisfies Readonly<Record<string, ReadonlySet<string>>>;
function deletionFields(value: unknown): readonly string[] | undefined {
  const values = asArray(value);
  if (values === undefined || values.length > TOOL_CATALOG_LIMITS.maxArrayItems) return undefined;
  return values.every(isSafeAtlassianIdentifier) && new Set(values).size === values.length
    ? values
    : undefined;
}
function operationInput(
  operation: TabWrite,
  args: CatalogJsonObject,
): Pick<Input, "name" | "tabId" | "expectedName" | "expectedFieldIds"> | undefined {
  if (operation === "jira.create-screen-tab")
    return jiraNativeName(args.name, 255) ? { name: args.name } : undefined;
  if (!jiraNativeId(args.tabId) || !jiraNativeText(args.expectedName, 255)) return undefined;
  if (operation === "jira.rename-screen-tab")
    return jiraNativeName(args.name, 255)
      ? { name: args.name, tabId: args.tabId, expectedName: args.expectedName }
      : undefined;
  const fields = deletionFields(args.expectedFieldIds);
  return fields === undefined
    ? undefined
    : { tabId: args.tabId, expectedName: args.expectedName, expectedFieldIds: fields };
}
function input(operation: TabWrite, args: CatalogJsonObject): Input | undefined {
  if (
    Object.keys(args).some((key) => !FIELDS[operation].has(key)) ||
    !jiraNativeId(args.screenId) ||
    !jiraNativeText(args.expectedScreenName, 255)
  )
    return undefined;
  const selected = operationInput(operation, args);
  return selected === undefined
    ? undefined
    : { ...selected, screenId: args.screenId, expectedScreenName: args.expectedScreenName };
}
function unchanged(selected: Input): Failure {
  return {
    ...CONFLICT,
    receipt: {
      screenId: selected.screenId,
      ...(selected.tabId === undefined ? {} : { tabId: selected.tabId }),
    },
    detail: {
      unchanged: true,
      messages: ["The tab already has the requested name. Nothing was written."],
    },
  };
}
function inspectNewTab(selected: Input, tabs: readonly CatalogJsonObject[]): Failure | undefined {
  if (tabs.length >= TOOL_CATALOG_LIMITS.maxArrayItems)
    return { ok: false, reason: "bounds-exceeded" };
  return tabs.some((tab) => tab.name === selected.name) ? CONFLICT : undefined;
}
function inspectTab(
  operation: TabWrite,
  selected: Input,
  tabs: readonly CatalogJsonObject[],
): Failure | undefined {
  if (operation === "jira.create-screen-tab") return inspectNewTab(selected, tabs);
  const current = tabs.find((tab) => tab.id === selected.tabId);
  if (current === undefined || current.name !== selected.expectedName) return CONFLICT;
  if (operation === "jira.rename-screen-tab") {
    if (current.name === selected.name) return unchanged(selected);
    return tabs.some((tab) => tab.id !== selected.tabId && tab.name === selected.name)
      ? CONFLICT
      : undefined;
  }
  return tabs.length < 2
    ? {
        ...CONFLICT,
        detail: {
          messages: [
            "A screen must retain at least one tab. Create or select another tab before deleting this one. Nothing was deleted.",
          ],
        },
      }
    : undefined;
}
async function inspectFields(
  request: JiraMutationRequest,
  selected: Input,
): Promise<Failure | undefined> {
  if (selected.tabId === undefined || selected.expectedFieldIds === undefined) return INVALID;
  const fields = await readJiraScreenTabFields(request, selected.screenId, selected.tabId);
  if (!fields.ok) return fields;
  const expected = selected.expectedFieldIds;
  return fields.items.length === expected.length &&
    fields.items.every((field, index) => field.id === expected[index])
    ? undefined
    : {
        ...CONFLICT,
        detail: {
          messages: [
            "The tab's field layout changed after review. Read and review its current field IDs before deleting it. Nothing was deleted.",
          ],
        },
      };
}
async function inspect(
  request: JiraMutationRequest,
  operation: TabWrite,
  selected: Input,
): Promise<Failure | { readonly ok: true; readonly plan: Plan }> {
  const screen = await bindJiraScreen(request, selected);
  if (!screen.ok) return screen;
  const tabs = await readJiraScreenTabs(request, selected.screenId);
  if (!tabs.ok) return tabs;
  const refusal = inspectTab(operation, selected, tabs.items);
  if (refusal !== undefined) return refusal;
  if (operation === "jira.delete-screen-tab") {
    const fields = await inspectFields(request, selected);
    if (fields !== undefined) return fields;
  }
  return { ok: true, plan: { selected, tabs: tabs.items } };
}
async function confirm(
  request: JiraMutationRequest,
  operation: TabWrite,
  selected: Input,
  receipt: ScreenTabReceipt,
): Promise<JiraScreenTabMutationAttempt> {
  try {
    const screen = await bindJiraScreen(request, selected);
    if (!screen.ok) return { ...screen, receipt };
    const tabs = await readJiraScreenTabs(request, selected.screenId);
    if (!tabs.ok) return { ...tabs, receipt };
    const current = tabs.items.find((tab) => tab.id === receipt.tabId);
    const matches =
      operation === "jira.delete-screen-tab"
        ? current === undefined && tabs.items.length > 0
        : current !== undefined && current.name === selected.name;
    return matches ? { ok: true, receipt } : { ...CONFLICT, receipt };
  } catch (error) {
    throw new JiraAcknowledgedMutationError(error, receipt);
  }
}
async function create(
  request: JiraMutationRequest,
  plan: Plan,
): Promise<JiraScreenTabMutationAttempt> {
  const selected = plan.selected;
  const receipt: ScreenTabReceipt = { screenId: selected.screenId };
  const response = await request(
    `screens/${selected.screenId}/tabs`,
    "POST",
    { name: selected.name },
    "json",
  );
  const acknowledged = jiraCreationAcknowledgement(response, jiraNativeNumericId, receipt);
  if (!acknowledged.ok) return acknowledged;
  const identified = { ...receipt, tabId: acknowledged.id };
  if (plan.tabs.some((tab) => tab.id === acknowledged.id))
    return { ...CONFLICT, receipt: identified };
  return confirm(request, "jira.create-screen-tab", selected, identified);
}
async function modify(
  request: JiraMutationRequest,
  operation: Exclude<TabWrite, "jira.create-screen-tab">,
  plan: Plan,
): Promise<JiraScreenTabMutationAttempt> {
  const selected = plan.selected;
  if (selected.tabId === undefined) return INVALID;
  const receipt: ScreenTabReceipt = { screenId: selected.screenId, tabId: selected.tabId };
  const remove = operation === "jira.delete-screen-tab";
  const response = await request(
    `screens/${selected.screenId}/tabs/${selected.tabId}`,
    remove ? "DELETE" : "PUT",
    remove ? undefined : { name: selected.name },
    "none",
  );
  if (!response.ok) return { ...dispatchFailure(response), receipt };
  if (response.status < 200 || response.status >= 300) return { ...MALFORMED, receipt };
  // Existing IDs came from native membership admission. A PUT acknowledgement cannot retarget
  // them; like the version owner, use the following independent GET as the result evidence.
  return confirm(request, operation, selected, receipt);
}
export function isJiraScreenTabMutation(name: string): name is TabWrite {
  return Object.hasOwn(FIELDS, name);
}
/** Existing authority, exact approval and journal owners surround this one-effect native adapter. */
export async function executeJiraScreenTabMutation(
  operation: TabWrite,
  args: CatalogJsonObject,
  request: JiraMutationRequest,
  check = false,
): Promise<JiraScreenTabMutationAttempt> {
  const selected = input(operation, args);
  if (selected === undefined) return INVALID;
  const inspected = await inspect(request, operation, selected);
  if (!inspected.ok) return inspected;
  if (check) return { ok: true, receipt: {} };
  return operation === "jira.create-screen-tab"
    ? create(request, inspected.plan)
    : modify(request, operation, inspected.plan);
}
