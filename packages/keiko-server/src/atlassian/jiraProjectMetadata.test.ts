import { expect, it, vi } from "vitest";
import { describeCatalogSchemaMismatch } from "@oscharko-dev/keiko-tool-catalog";
import {
  createJiraProviderForCatalog,
  jiraOperationBindingForTool,
} from "./jiraManagedProvider.js";

it.each(["jira.create-project", "jira.update-project"] as const)(
  "advertises the actual native lead/website bounds for %s",
  (operation) => {
    const provider = createJiraProviderForCatalog(vi.fn(), [operation], vi.fn());
    const descriptor = provider.tools()[0]?.descriptor;
    if (descriptor === undefined) throw new TypeError("Missing project descriptor");
    const base =
      operation === "jira.create-project"
        ? { key: "SYN", name: "Synthetic", lead: "owner", projectTypeKey: "software" }
        : { projectIdOrKey: "SYN" };
    expect(
      describeCatalogSchemaMismatch(descriptor.inputSchema, {
        ...base,
        lead: "x".repeat(128),
        url: "https://example.invalid/".padEnd(2048, "x"),
      }),
    ).toBeUndefined();
    expect(
      describeCatalogSchemaMismatch(descriptor.inputSchema, { ...base, lead: "x".repeat(129) }),
    ).toBeDefined();
    expect(
      describeCatalogSchemaMismatch(descriptor.inputSchema, {
        ...base,
        url: "https://example.invalid/".padEnd(2049, "x"),
      }),
    ).toBeDefined();
    expect(
      describeCatalogSchemaMismatch(descriptor.inputSchema, { ...base, description: "", url: "" }),
    ).toBeUndefined();
  },
);

it("admits only the closed count of omitted optional project metadata", () => {
  const descriptor = createJiraProviderForCatalog(vi.fn(), ["jira.project"]).tools()[0]?.descriptor;
  const binding = jiraOperationBindingForTool("jira.project");
  if (descriptor === undefined || binding === undefined)
    throw new TypeError("Missing project read descriptor");
  const result = {
    outcome: "succeeded",
    operationBinding: { ...binding },
    projectId: "10000",
    projectKey: "SYN",
    projectName: "Synthetic",
    omittedMetadataCount: 5,
  };
  expect(describeCatalogSchemaMismatch(descriptor.resultSchema, result)).toBeUndefined();
  for (const count of [-1, 6, 1.5])
    expect(
      describeCatalogSchemaMismatch(descriptor.resultSchema, {
        ...result,
        omittedMetadataCount: count,
      }),
    ).toBeDefined();
  expect(
    describeCatalogSchemaMismatch(descriptor.resultSchema, {
      ...result,
      invalidMetadataFields: ["url"],
    }),
  ).toBeDefined();
});
