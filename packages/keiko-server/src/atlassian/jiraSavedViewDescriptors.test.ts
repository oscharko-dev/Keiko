import { expect, it, vi } from "vitest";
import { describeCatalogSchemaMismatch } from "@oscharko-dev/keiko-tool-catalog";
import { jiraSavedViewDeclarationForTool } from "./jiraSavedViewDescriptors.js";
import { createJiraProviderForCatalog } from "./jiraManagedProvider.js";

const ID = "9007199254740993";
const PERMISSION = {
  id: "20",
  type: "project",
  projectId: ID,
  projectKey: "APP",
  view: true,
  edit: false,
};
it.each([
  [
    "jira.dashboards",
    { startAt: 0, maxResults: 1 },
    { items: [{ id: ID, name: "Delivery" }], startAt: 0, total: 2, nextStartAt: 1 },
  ],
  ["jira.dashboard", { dashboardId: ID }, { items: [{ id: ID, name: "Delivery" }] }],
  ["jira.filter-share-scope", {}, { scope: "PRIVATE" }],
  [
    "jira.filter-permissions",
    { filterId: ID },
    { filterId: ID, items: [PERMISSION], total: 1, startAt: 0 },
  ],
  [
    "jira.filter-permission",
    { filterId: ID, permissionId: "20" },
    { filterId: ID, items: [PERMISSION] },
  ],
] as const)("declares the closed %s read contract", (name, args, result) => {
  const declaration = jiraSavedViewDeclarationForTool(name);
  if (declaration === undefined) throw new TypeError("Missing saved-view declaration");
  expect(declaration.risk).toBe("read");
  expect(describeCatalogSchemaMismatch(declaration.descriptor.inputSchema, args)).toBeUndefined();
  expect(
    describeCatalogSchemaMismatch(declaration.descriptor.resultSchema, {
      outcome: "succeeded",
      ...result,
    }),
  ).toBeUndefined();
  const connection = vi.fn();
  const provider = createJiraProviderForCatalog(connection, [name]);
  expect(provider.tools()).toHaveLength(1);
  expect(provider.tools()[0]?.descriptor.inputSchema).toEqual(declaration.descriptor.inputSchema);
  expect(connection).not.toHaveBeenCalled();
});
it.each([
  ["jira.dashboards", { filter: "arbitrary" }],
  ["jira.dashboards", { startAt: -1 }],
  ["jira.dashboards", { maxResults: 101 }],
  ["jira.dashboard", { dashboardId: "../1" }],
  ["jira.dashboard", { dashboardId: 12 }],
  ["jira.filter-share-scope", { scope: "GLOBAL" }],
  ["jira.filter-permissions", { filterId: "01" }],
  [
    "jira.filter-permission",
    { filterId: "1", permissionId: "2", url: "https://untrusted.invalid" },
  ],
] as const)("refuses unsupported %s arguments", (name, args) => {
  const declaration = jiraSavedViewDeclarationForTool(name);
  if (declaration === undefined) throw new TypeError("Missing saved-view declaration");
  expect(describeCatalogSchemaMismatch(declaration.descriptor.inputSchema, args)).toBeDefined();
});
it("does not offer unsupported sharing mutations or subscription endpoints", () => {
  for (const name of ["jira.create-filter", "jira.filter-subscriptions", "constructor"])
    expect(jiraSavedViewDeclarationForTool(name)).toBeUndefined();
});
it("keeps default sharing facts closed and does not claim effective access", () => {
  const scope = jiraSavedViewDeclarationForTool("jira.filter-share-scope");
  const permission = jiraSavedViewDeclarationForTool("jira.filter-permission");
  if (scope === undefined || permission === undefined) throw new TypeError("Missing declaration");
  expect(
    describeCatalogSchemaMismatch(scope.descriptor.resultSchema, {
      outcome: "succeeded",
      scope: "unknown",
    }),
  ).toBeDefined();
  expect(
    describeCatalogSchemaMismatch(permission.descriptor.resultSchema, {
      outcome: "succeeded",
      items: [{ ...PERMISSION, effectiveAccess: true }],
    }),
  ).toBeDefined();
});
