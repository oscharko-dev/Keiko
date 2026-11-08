import { expect } from "vitest";
import type { AtlassianHttpBodyRequest, AtlassianHttpBodyResult } from "@oscharko-dev/keiko-connectors";
import { response } from "./jira-managed-remote.js";

export const SCREEN_CONFIGURATION_TABS = [{ id: "21", name: "Fields" }, { id: "22", name: "Other" }] as const;
export const SCREEN_CONFIGURATION_FIELDS = [
  { id: "summary", name: "Summary", type: "system", showWhenEmpty: false },
  { id: "description", name: "Description", type: "system", showWhenEmpty: null },
] as const;
export const SCREEN_CONFIGURATION_PARENT = { screenId: "11", expectedScreenName: "Review screen", tabId: "21", expectedTabs: SCREEN_CONFIGURATION_TABS };
const FIELDS = { ...SCREEN_CONFIGURATION_PARENT, expectedFields: SCREEN_CONFIGURATION_FIELDS };
export const SCREEN_CONFIGURATION_FIXTURE_CASES = [
  { tool: "jira.add-default-screen-field", method: "POST", path: "/screens/addToDefault/customfield_10001", expectedOutcome: "succeeded-unconfirmed",
    args: { fieldId: "customfield_10001", expectedFieldName: "Review", acceptUnverifiedDefault: true },
    expectedReceipt: { fieldId: "customfield_10001", fieldPresent: true } },
  { tool: "jira.add-screen-tab-field", method: "POST", path: "/screens/11/tabs/21/fields", expectedOutcome: "succeeded",
    args: { ...FIELDS, fieldId: "customfield_10001", expectedFieldName: "Review" },
    expectedReceipt: { screenId: "11", tabId: "21", fieldId: "customfield_10001", fieldPresent: true } },
  { tool: "jira.remove-screen-tab-field", method: "DELETE", path: "/screens/11/tabs/21/fields/description", expectedOutcome: "succeeded",
    args: { ...FIELDS, fieldId: "description" },
    expectedReceipt: { screenId: "11", tabId: "21", fieldId: "description", fieldPresent: false } },
  { tool: "jira.move-screen-tab-field", method: "POST", path: "/screens/11/tabs/21/fields/summary/move", expectedOutcome: "succeeded",
    args: { ...FIELDS, fieldId: "summary", position: "Last" },
    expectedReceipt: { screenId: "11", tabId: "21", fieldId: "summary" } },
  { tool: "jira.set-screen-field-show-when-empty", method: "PUT", path: "/screens/11/tabs/21/fields/summary/updateShowWhenEmptyIndicator/true", expectedOutcome: "succeeded",
    args: { ...FIELDS, fieldId: "summary", showWhenEmpty: true },
    expectedReceipt: { screenId: "11", tabId: "21", fieldId: "summary", showWhenEmpty: true } },
  { tool: "jira.move-screen-tab", method: "POST", path: "/screens/11/tabs/21/move/1", expectedOutcome: "succeeded",
    args: { ...SCREEN_CONFIGURATION_PARENT, position: 1 }, expectedReceipt: { screenId: "11", tabId: "21" } },
] as const;
type Case = (typeof SCREEN_CONFIGURATION_FIXTURE_CASES)[number];
interface NativeField { readonly id: string; readonly name: string; readonly type?: string; readonly showWhenEmpty?: boolean }

/** Synthetic native wire fixture. Assertions concern actual method/URL/body; there is no
 * fabricated HTTP-port expect field and no implementation-derived expected receipt. */
export function screenConfigurationTransportFixture(apiRoot: string, selected: Case): {
  readonly read: (request: AtlassianHttpBodyRequest) => AtlassianHttpBodyResult | undefined;
  readonly write: (request: AtlassianHttpBodyRequest) => AtlassianHttpBodyResult | undefined;
  readonly snapshot: () => { readonly fieldIds: readonly string[]; readonly tabIds: readonly string[]; readonly writes: number };
} {
  let fields: readonly NativeField[] = [{ id: "summary", name: "Summary", type: "system", showWhenEmpty: false },
    { id: "description", name: "Description", type: "system" }];
  let tabs: readonly { readonly id: number; readonly name: string }[] = [{ id: 21, name: "Fields" }, { id: 22, name: "Other" }];
  const added = { id: "customfield_10001", name: "Review", type: "custom" };
  let writes = 0;
  function change(request: AtlassianHttpBodyRequest): void {
    switch (selected.tool) {
      case "jira.add-screen-tab-field":
        expect(request.bodyJson).toBe(JSON.stringify({ fieldId: "customfield_10001" }));
        fields = [...fields, added];
        break;
      case "jira.remove-screen-tab-field":
        expect(request.bodyJson).toBeUndefined();
        fields = fields.filter((field) => field.id !== "description");
        break;
      case "jira.move-screen-tab-field":
        expect(request.bodyJson).toBe(JSON.stringify({ position: "Last" }));
        fields = [...fields].reverse();
        break;
      case "jira.set-screen-field-show-when-empty":
        expect(request.bodyJson).toBeUndefined();
        fields = fields.map((field) => field.id === "summary" ? { ...field, showWhenEmpty: true } : field);
        break;
      case "jira.move-screen-tab":
        expect(request.bodyJson).toBeUndefined();
        tabs = [...tabs].reverse();
        break;
      default:
        expect(request.bodyJson).toBeUndefined();
    }
  }
  return {
    snapshot: () => ({ fieldIds: fields.map((field) => field.id), tabIds: tabs.map((tab) => String(tab.id)), writes }),
    read(request) {
      const url = new URL(request.url);
      if (url.pathname === `${apiRoot}/screens`) {
        expect(url.search).toBe("?startAt=0&maxResults=100&search=Review+screen");
        return response({ startAt: 0, maxResults: 100, total: 1, isLast: true, screens: [{ id: 11, name: "Review screen" }] });
      }
      if (url.pathname === `${apiRoot}/screens/11/tabs`) return response(tabs);
      if (url.pathname === `${apiRoot}/screens/11/tabs/21/fields`) return response(fields);
      if (url.pathname === `${apiRoot}/screens/11/availableFields` || url.pathname === `${apiRoot}/field`) return response([added]);
      return undefined;
    },
    write(request) {
      const url = new URL(request.url);
      if (url.pathname !== `${apiRoot}${selected.path}`) return undefined;
      expect(request.method).toBe(selected.method);
      expect(url.search).toBe("");
      writes++;
      expect(writes).toBe(1);
      change(request);
      return response(undefined, 204);
    },
  };
}
