import { afterEach, expect, it, vi } from "vitest";
import {
  JIRA_MANAGED_READ_TOOLS,
  JIRA_MUTATION_OPERATIONS,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { ManagedMcpToolDeclaration } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";

afterEach(() => {
  vi.doUnmock("./jiraAccessDescriptors.js");
  vi.doUnmock("./jiraManagedMutationDescriptors.js");
  vi.restoreAllMocks();
  vi.resetModules();
});

it("isolates an unrequested invalid read schema while preserving later fail-closed lookup", async () => {
  vi.resetModules();
  const { ToolCatalogError } = await import("@oscharko-dev/keiko-tool-catalog");
  vi.doMock("./jiraAccessDescriptors.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("./jiraAccessDescriptors.js")>();
    return {
      ...actual,
      jiraAccessDeclarationForTool: (name: string): ManagedMcpToolDeclaration | undefined => {
        if (name === "jira.notification-schemes") throw new ToolCatalogError("invalid-schema");
        return actual.jiraAccessDeclarationForTool(name);
      },
    };
  });
  const registry = await import("./jiraOperationRegistry.js");
  const bind = vi.spyOn(registry, "createJiraOperationContract");
  const provider = await import("./jiraManagedProvider.js");
  expect(bind).not.toHaveBeenCalled();
  expect(
    registry.jiraOperationDefinitions().some((entry) => entry.tool === "jira.notification-schemes"),
  ).toBe(true);
  expect(bind).not.toHaveBeenCalled();
  const selected = provider.jiraOperationForTool("jira.projects");
  expect(selected).toBeDefined();
  expect(provider.jiraOperationForTool("jira.projects")).toBe(selected);
  expect(bind).toHaveBeenCalledTimes(1);
  const connection = vi.fn();
  expect(provider.createJiraProviderForCatalog(connection, ["jira.projects"]).tools()).toHaveLength(
    1,
  );
  expect(connection).not.toHaveBeenCalled();
  expect(() => provider.jiraOperationForTool("jira.notification-schemes")).toThrow(
    ToolCatalogError,
  );
  expect(() => provider.jiraOperationContracts()).toThrow(ToolCatalogError);
  expect(provider.jiraOperationForTool("jira.projects")).toBe(selected);
});

// Compiles the complete Jira catalog (443 contracts, about 3.4 s per pass without coverage,
// measured 2026-11-09); the bound is sized to that work, like the other whole-catalog cases.
it("does not compile unrequested mutations and still refuses an explicitly requested invalid write", async () => {
  vi.resetModules();
  vi.doMock("./jiraManagedMutationDescriptors.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("./jiraManagedMutationDescriptors.js")>();
    return {
      ...actual,
      jiraMutationDeclaration: (
        name: Parameters<typeof actual.jiraMutationDeclaration>[0],
      ): ManagedMcpToolDeclaration => {
        if (name === "jira.create-project")
          throw new TypeError("Synthetic invalid mutation schema");
        return actual.jiraMutationDeclaration(name);
      },
    };
  });
  const provider = await import("./jiraManagedProvider.js");
  expect(provider.jiraOperationForTool("jira.projects")?.definition.tool).toBe("jira.projects");
  expect(() => provider.jiraOperationForTool("jira.create-project")).toThrow(
    "Synthetic invalid mutation schema",
  );
  expect(() => provider.jiraOperationForTool("jira.create-project")).toThrow(
    "Synthetic invalid mutation schema",
  );
  expect(() => provider.jiraOperationContracts()).toThrow("Synthetic invalid mutation schema");
}, 60_000);

// Compiles the complete Jira catalog (443 contracts, about 3.4 s per pass without coverage,
// measured 2026-11-09); the bound is sized to that work, like the other whole-catalog cases.
it("memoizes composite members once and matches the complete raw-declaration batch exactly", async () => {
  vi.resetModules();
  const registry = await import("./jiraOperationRegistry.js");
  const bind = vi.spyOn(registry, "createJiraOperationContract");
  const provider = await import("./jiraManagedProvider.js");
  expect(bind).not.toHaveBeenCalled();
  const draft = provider.jiraOperationForTool("jira.draft");
  expect(draft?.definition).toMatchObject({
    kind: "composite",
    members: ["jira.create", "jira.edit"],
  });
  expect(bind.mock.calls.map(([declaration]) => declaration.name)).toEqual([
    "jira.draft",
    "jira.create",
    "jira.edit",
  ]);
  expect(provider.jiraOperationForTool("jira.draft")).toBe(draft);
  expect(bind).toHaveBeenCalledTimes(3);
  expect(provider.jiraOperationForTool("jira.unregistered")).toBeUndefined();
  expect(bind).toHaveBeenCalledTimes(3);
  const complete = provider.jiraOperationContracts();
  expect(complete.map((entry) => entry.definition.tool)).toEqual([
    ...JIRA_MANAGED_READ_TOOLS,
    ...JIRA_MUTATION_OPERATIONS,
  ]);
  expect(provider.jiraOperationContracts()).toBe(complete);
  expect(bind).toHaveBeenCalledTimes(complete.length);
  const raw = complete.map((entry) => {
    const declaration = bind.mock.calls.find(
      ([candidate]) => candidate.name === entry.definition.tool,
    )?.[0];
    if (declaration === undefined) throw new TypeError("Missing captured raw declaration");
    expect(JSON.stringify(declaration.descriptor.resultSchema)).not.toContain('"operationBinding"');
    return declaration;
  });
  const batch = registry.createJiraOperationContracts(raw);
  expect(complete).toEqual(batch);
  for (const entry of complete) {
    expect(provider.jiraOperationForTool(entry.definition.tool)).toBe(entry);
    expect(Object.isFrozen(entry)).toBe(true);
  }
}, 60_000);
