import { expect, it, vi } from "vitest";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { describeCatalogSchemaMismatch } from "@oscharko-dev/keiko-tool-catalog";
import { jiraCoreMetadataDeclarationForTool } from "./jiraCoreMetadataDescriptors.js";
import { createJiraProviderForCatalog } from "./jiraManagedProvider.js";

const ISSUE_TYPE = { id: "1", name: "Synthetic task", subtask: false, avatarId: "7" };
const PRIORITY = { id: "2", name: "Synthetic priority", statusColor: "blue" };
const RESOLUTION = { id: "3", name: "Synthetic resolution", description: "" };
const CATEGORY = { id: "4", key: "new", name: "Synthetic category", colorName: "blue-gray" };
const STATUS = { id: "5", name: "Synthetic status", statusCategory: CATEGORY };
const PROJECT_CATEGORY = { id: "6", name: "Synthetic project category" };
const PROJECT_TYPE = {
  key: "software",
  formattedKey: "Software",
  descriptionI18nKey: "type.software",
  color: "#ffffff",
};
const page = (item: CatalogJsonObject) => ({ items: [item], startAt: 0, total: 1 });
it("admits strict optional issue-type review facts without inventing missing description", () => {
  const declaration = jiraCoreMetadataDeclarationForTool("jira.issue-type");
  if (declaration === undefined) throw new TypeError("Missing declaration");
  const snapshot = { ...ISSUE_TYPE, description: null };
  expect(
    describeCatalogSchemaMismatch(declaration.descriptor.resultSchema, {
      outcome: "succeeded",
      ...ISSUE_TYPE,
      reviewSnapshot: snapshot,
    }),
  ).toBeUndefined();
  expect(
    describeCatalogSchemaMismatch(declaration.descriptor.resultSchema, {
      outcome: "succeeded",
      ...ISSUE_TYPE,
      reviewSnapshot: ISSUE_TYPE,
    }),
  ).toBeDefined();
  expect(
    describeCatalogSchemaMismatch(declaration.descriptor.resultSchema, {
      outcome: "succeeded",
      ...ISSUE_TYPE,
    }),
  ).toBeUndefined();
});
it.each([
  ["jira.global-issue-types", {}, page(ISSUE_TYPE)],
  ["jira.issue-type", { issueTypeId: "1" }, ISSUE_TYPE],
  [
    "jira.issue-type-page",
    { query: "task", projectIds: ["9223372036854775807"] },
    { items: [ISSUE_TYPE], startAt: 0, nextStartAt: 1 },
  ],
  ["jira.issue-type-alternatives", { issueTypeId: "8" }, { issueTypeId: "8", ...page(ISSUE_TYPE) }],
  ["jira.priorities", {}, page(PRIORITY)],
  ["jira.priority", { priorityId: "2" }, PRIORITY],
  ["jira.priority-page", { query: "", projectIds: ["7"] }, { items: [PRIORITY], startAt: 0 }],
  ["jira.resolutions", {}, page(RESOLUTION)],
  ["jira.resolution", { resolutionId: "3" }, RESOLUTION],
  ["jira.resolution-page", { query: "fixed" }, { items: [RESOLUTION], startAt: 0 }],
  ["jira.statuses", {}, page(STATUS)],
  ["jira.status", { statusIdOrName: "Synthetic status" }, STATUS],
  [
    "jira.status-page",
    { query: "", projectIds: ["7"], issueTypeIds: ["1"] },
    { items: [STATUS], startAt: 0, nextStartAt: 1 },
  ],
  ["jira.status-categories", {}, page(CATEGORY)],
  ["jira.status-category", { statusCategoryIdOrKey: "new" }, CATEGORY],
  ["jira.project-categories", {}, page(PROJECT_CATEGORY)],
  ["jira.project-category", { projectCategoryId: "6" }, PROJECT_CATEGORY],
  [
    "jira.project-statuses",
    { projectIdOrKey: "SYN" },
    {
      projectId: "7",
      projectKey: "SYN",
      ...page({ id: "1", name: "Synthetic task", subtask: false, statuses: [STATUS] }),
    },
  ],
  ["jira.project-types", {}, page(PROJECT_TYPE)],
  ["jira.project-type-definition", { projectTypeKey: "software" }, PROJECT_TYPE],
] as const)(
  "declares %s through the existing provider with native-only metadata",
  (name, args, result) => {
    const declaration = jiraCoreMetadataDeclarationForTool(name);
    if (declaration === undefined) throw new TypeError("Missing core metadata declaration");
    expect(declaration.risk).toBe("read");
    expect(describeCatalogSchemaMismatch(declaration.descriptor.inputSchema, args)).toBeUndefined();
    expect(
      describeCatalogSchemaMismatch(declaration.descriptor.resultSchema, {
        outcome: "succeeded",
        ...result,
      }),
    ).toBeUndefined();
    const connection = vi.fn();
    expect(createJiraProviderForCatalog(connection, [name]).tools()).toHaveLength(1);
    expect(connection).not.toHaveBeenCalled();
  },
);
it.each([
  ["jira.global-issue-types", { query: "task" }],
  ["jira.issue-type", { issueTypeId: 1 }],
  ["jira.issue-type-page", { projectIds: ["7", "7"] }],
  ["jira.issue-type-alternatives", { issueTypeId: "1", maxResults: 101 }],
  ["jira.priorities", { projectIds: ["7"] }],
  ["jira.priority", { priorityId: "0" }],
  ["jira.priority-page", { projectIds: [7] }],
  ["jira.resolutions", { query: "fixed" }],
  ["jira.resolution", { resolutionId: "../3" }],
  ["jira.resolution-page", { projectIds: ["7"] }],
  ["jira.statuses", { issueTypeIds: ["1"] }],
  ["jira.status", { statusIdOrName: "" }],
  ["jira.status-page", { issueTypeIds: ["1", "1"] }],
  ["jira.status-categories", { request: "http" }],
  ["jira.status-category", { statusCategoryIdOrKey: "../new" }],
  ["jira.project-categories", { startAt: -1 }],
  ["jira.project-category", { projectCategoryId: "6", maxResults: 1 }],
  ["jira.project-statuses", { projectIdOrKey: "../SYN" }],
  ["jira.project-types", { accessible: true }],
  ["jira.project-type-definition", { projectTypeKey: "software", expand: "all" }],
] as const)("refuses unsupported %s selectors", (name, args) => {
  const declaration = jiraCoreMetadataDeclarationForTool(name);
  if (declaration === undefined) throw new TypeError("Missing core metadata declaration");
  expect(describeCatalogSchemaMismatch(declaration.descriptor.inputSchema, args)).toBeDefined();
});
it.each([
  ["jira.issue-type", { ...ISSUE_TYPE, iconUrl: "https://synthetic.invalid/icon" }],
  ["jira.resolution", { ...RESOLUTION, id: 3 }],
  ["jira.resolution", { name: "Missing identity" }],
  ["jira.resolutions", { items: [{ name: "Missing identity" }], startAt: 0, total: 1 }],
  ["jira.resolution-page", { items: [{ name: "Missing identity" }], startAt: 0 }],
  [
    "jira.status",
    { ...STATUS, statusCategory: { ...CATEGORY, self: "https://synthetic.invalid/category" } },
  ],
  [
    "jira.project-statuses",
    {
      projectId: "7",
      projectKey: "SYN",
      ...page({
        id: "1",
        name: "Synthetic task",
        statuses: [{ name: "Missing native status ID" }],
      }),
    },
  ],
  ["jira.project-type-definition", { ...PROJECT_TYPE, accessible: true }],
  ["jira.project-type-definition", { ...PROJECT_TYPE, icon: "unprojected-markup" }],
] as const)("rejects unprojected %s result facts", (name, result) => {
  const declaration = jiraCoreMetadataDeclarationForTool(name);
  if (declaration === undefined) throw new TypeError("Missing core metadata declaration");
  expect(
    describeCatalogSchemaMismatch(declaration.descriptor.resultSchema, {
      outcome: "succeeded",
      ...result,
    }),
  ).toBeDefined();
});
