import { describe, expect, it, vi } from "vitest";
import {
  createJiraProviderForCatalog,
  jiraOperationContracts,
  jiraOperationForTool,
} from "./jiraManagedProvider.js";
import { jiraMutationDeclarations } from "./jiraManagedMutationDescriptors.js";
import {
  createJiraOperationContract,
  createJiraOperationContracts,
  matchesJiraOperationBinding,
  isJiraOperationBinding,
} from "./jiraOperationRegistry.js";
import { createToolDescriptor } from "@oscharko-dev/keiko-tool-catalog";
import { jiraRequiredConnectorScope } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";

const JIRA_MUTATION_DECLARATIONS = jiraMutationDeclarations();

describe("server-owned Jira operation contracts", () => {
  it.each([
    { tool: "jira.create-permission-scheme", identity: "POST /rest/api/2/permissionscheme", permissionPolicy: "instance-admin-permission-scheme-create-and-readback" },
    { tool: "jira.update-permission-scheme", identity: "PUT /rest/api/2/permissionscheme/{schemeId}", permissionPolicy: "instance-admin-permission-scheme-update-and-readback" },
    { tool: "jira.delete-permission-scheme", identity: "DELETE /rest/api/2/permissionscheme/{schemeId}", permissionPolicy: "instance-admin-permission-scheme-delete-unconfirmed" },
    { tool: "jira.add-permission-grant", identity: "POST /rest/api/2/permissionscheme/{schemeId}/permission", permissionPolicy: "instance-admin-permission-grant-add-and-readback" },
    { tool: "jira.delete-permission-grant", identity: "DELETE /rest/api/2/permissionscheme/{schemeId}/permission/{permissionId}", permissionPolicy: "instance-admin-permission-grant-delete-and-absence" },
    { tool: "jira.set-permission-scheme-attribute", identity: "PUT /rest/api/2/permissionscheme/{permissionSchemeId}/attribute/{key}", permissionPolicy: "instance-admin-permission-attribute-and-readback" },
    { tool: "jira.create-role", identity: "POST /rest/api/2/role", permissionPolicy: "instance-admin-role-create-and-readback" },
    { tool: "jira.update-role", identity: "POST /rest/api/2/role/{id}", permissionPolicy: "instance-admin-role-update-and-readback" },
    { tool: "jira.replace-role", identity: "PUT /rest/api/2/role/{id}", permissionPolicy: "instance-admin-role-replace-and-readback" },
    { tool: "jira.delete-role", identity: "DELETE /rest/api/2/role/{id}", permissionPolicy: "instance-admin-role-delete-unconfirmed" },
    { tool: "jira.add-role-default-actors", identity: "POST /rest/api/2/role/{id}/actors", permissionPolicy: "instance-admin-role-default-actors-unconfirmed" },
    { tool: "jira.delete-role-default-actor", identity: "DELETE /rest/api/2/role/{id}/actors", permissionPolicy: "instance-admin-role-default-actors-unconfirmed" },
    { tool: "jira.add-project-role-actors", identity: "POST /rest/api/2/project/{projectIdOrKey}/role/{id}", permissionPolicy: "instance-admin-project-role-actors-unconfirmed" },
    { tool: "jira.set-project-role-actors", identity: "PUT /rest/api/2/project/{projectIdOrKey}/role/{id}", permissionPolicy: "instance-admin-project-role-actors-unconfirmed" },
    { tool: "jira.delete-project-role-actor", identity: "DELETE /rest/api/2/project/{projectIdOrKey}/role/{id}", permissionPolicy: "instance-admin-project-role-actors-unconfirmed" },
  ] as const)("binds access configuration $tool to its exact native identity and admin scope", ({ tool, identity, permissionPolicy }) => {
    expect(jiraOperationForTool(tool)?.definition).toMatchObject({
      kind: "native", identity, permissionPolicy, effects: ["remote-write"],
    });
    expect(jiraRequiredConnectorScope(tool)).toBe("issue-tracker.admin");
  });
  it.each([
    { tool: "jira.create-project-category", identity: "POST /rest/api/2/projectCategory", permissionPolicy: "instance-admin-project-category-create-and-readback" },
    { tool: "jira.update-project-category", identity: "PUT /rest/api/2/projectCategory/{id}", permissionPolicy: "instance-admin-project-category-update-and-readback" },
    { tool: "jira.delete-project-category", identity: "DELETE /rest/api/2/projectCategory/{id}", permissionPolicy: "instance-admin-project-category-delete-unconfirmed" },
    { tool: "jira.upsert-version-remote-link", identity: "POST /rest/api/2/version/{versionId}/remotelink", permissionPolicy: "version-remote-link-upsert-and-readback" },
    { tool: "jira.upsert-version-remote-link-by-global-id", identity: "POST /rest/api/2/version/{versionId}/remotelink/{globalId}", permissionPolicy: "version-remote-link-upsert-and-readback" },
    { tool: "jira.delete-version-remote-link", identity: "DELETE /rest/api/2/version/{versionId}/remotelink/{globalId}", permissionPolicy: "version-remote-link-delete-and-absence" },
    { tool: "jira.delete-version-remote-links", identity: "DELETE /rest/api/2/version/{versionId}/remotelink", permissionPolicy: "version-remote-links-delete-and-absence" },
    { tool: "jira.epic-remove-issues", identity: "POST /rest/agile/1.0/epic/none/issue", permissionPolicy: "epic-removal-and-readback" },
    { tool: "jira.rank-epic", identity: "PUT /rest/agile/1.0/epic/{epicIdOrKey}/rank", permissionPolicy: "rank-and-position-uncertainty" },
    { tool: "jira.rank-issues", identity: "PUT /rest/agile/1.0/issue/rank", permissionPolicy: "rank-and-position-uncertainty" },
    { tool: "jira.set-issue-estimation", identity: "PUT /rest/agile/1.0/issue/{issueIdOrKey}/estimation", permissionPolicy: "issue-estimation-and-readback" },
  ] as const)("binds planning/version/category $tool to its independent native identity", ({ tool, identity, permissionPolicy }) => {
    expect(jiraOperationForTool(tool)?.definition).toMatchObject({
      kind: "native", identity, permissionPolicy, effects: ["remote-write"],
    });
  });
  it.each([
    { tool: "jira.add-default-screen-field", identity: "POST /rest/api/2/screens/addToDefault/{fieldId}", permissionPolicy: "instance-admin-default-screen-field-unconfirmed" },
    { tool: "jira.add-screen-tab-field", identity: "POST /rest/api/2/screens/{screenId}/tabs/{tabId}/fields", permissionPolicy: "instance-admin-screen-field-add-and-readback" },
    { tool: "jira.remove-screen-tab-field", identity: "DELETE /rest/api/2/screens/{screenId}/tabs/{tabId}/fields/{id}", permissionPolicy: "instance-admin-screen-field-delete-and-absence" },
    { tool: "jira.move-screen-tab-field", identity: "POST /rest/api/2/screens/{screenId}/tabs/{tabId}/fields/{id}/move", permissionPolicy: "instance-admin-screen-field-order-and-readback" },
    { tool: "jira.set-screen-field-show-when-empty", identity: "PUT /rest/api/2/screens/{screenId}/tabs/{tabId}/fields/{id}/updateShowWhenEmptyIndicator/{newValue}", permissionPolicy: "instance-admin-screen-field-display-and-readback" },
    { tool: "jira.move-screen-tab", identity: "POST /rest/api/2/screens/{screenId}/tabs/{tabId}/move/{pos}", permissionPolicy: "instance-admin-screen-tab-order-and-readback" },
    { tool: "jira.delete-board", identity: "DELETE /rest/agile/1.0/board/{boardId}", permissionPolicy: "board-delete-unconfirmed" },
    { tool: "jira.set-board-refined-velocity", identity: "PUT /rest/agile/1.0/board/{boardId}/settings/refined-velocity", permissionPolicy: "board-refined-velocity-and-readback" },
    { tool: "jira.replace-sprint", identity: "PUT /rest/agile/1.0/sprint/{sprintId}", permissionPolicy: "sprint-replace-and-readback" },
    { tool: "jira.delete-sprint", identity: "DELETE /rest/agile/1.0/sprint/{sprintId}", permissionPolicy: "sprint-delete-and-membership-uncertainty" },
    { tool: "jira.swap-sprints", identity: "POST /rest/agile/1.0/sprint/{sprintId}/swap", permissionPolicy: "sprint-swap-and-position-uncertainty" },
    { tool: "jira.unmap-sprints", identity: "PUT /rest/agile/1.0/sprint/unmap", permissionPolicy: "sprint-unmap-and-readback" },
    { tool: "jira.unmap-all-sprints", identity: "PUT /rest/agile/1.0/sprint/unmap-all", permissionPolicy: "instance-admin-sprint-unmap-all-unconfirmed" },
  ] as const)("binds $tool to its independently expected native identity", ({ tool, identity, permissionPolicy }) => {
    expect(jiraOperationForTool(tool)?.definition).toMatchObject({
      kind: "native", identity, permissionPolicy, effects: ["remote-write"],
    });
  });
  it("binds every administration write to an explicit instance-admin permission contract", () => {
    const admin = jiraOperationContracts().filter((entry) =>
      jiraRequiredConnectorScope(entry.definition.tool) === "issue-tracker.admin" &&
      entry.definition.effects.includes("remote-write"));
    expect(admin).toHaveLength(38);
    for (const contract of admin) {
      expect(contract.definition.permissionPolicy).toMatch(/^instance-admin-/);
      expect(contract.definition.effects).toContain("remote-write");
      expect(isJiraOperationBinding(contract.binding)).toBe(true);
    }
    expect(jiraOperationForTool("jira.set-issue-property")?.definition.permissionPolicy)
      .toBe("entity-property-and-readback");
  });
  it("keeps three explicit admin observations read-only and two POST observations outside mutation authority", () => {
    for (const tool of ["jira.anonymization-validation", "jira.anonymization-rerun-validation", "jira.anonymization-progress"] as const) {
      const contract = jiraOperationForTool(tool);
      expect(jiraRequiredConnectorScope(tool)).toBe("issue-tracker.admin");
      expect(contract?.declaration.risk).toBe("read");
      expect(contract?.definition.effects).toEqual(["remote-read"]);
      expect(contract?.definition.permissionPolicy).toBe("instance-admin-anonymization-observation");
    }
    for (const tool of ["jira.search-post", "jira.worklogs-by-id"] as const) {
      const contract = jiraOperationForTool(tool);
      expect(jiraRequiredConnectorScope(tool)).toBe("issue-tracker.read");
      expect(contract?.definition).toMatchObject({ method: "POST", effects: ["remote-read"] });
      expect(contract?.declaration.risk).toBe("read");
    }
    expect(jiraOperationForTool("jira.current-session")?.definition).toMatchObject({
      identity: "GET /rest/auth/1/session", apiRoot: "/rest/auth/1", effects: ["remote-read"],
    });
  });
  it("reads a closed historical binding without granting current execution authority", () => {
    const contract = jiraOperationForTool("jira.comment");
    if (contract === undefined) throw new TypeError("Missing comment contract");
    const historical = { ...contract.binding, contractDigest: "0".repeat(64) };
    expect(isJiraOperationBinding(historical)).toBe(true);
    expect(matchesJiraOperationBinding(contract, historical)).toBe(false);
    for (const invalid of [
      { ...historical, identity: "" },
      { ...historical, identity: "a".repeat(193) },
      { ...historical, identity: "POST\n/rest/api/2/issue" },
      { ...historical, contractDigest: "x".repeat(64) },
      { ...historical, [Symbol("extra")]: true },
      Object.assign(Object.create({ inherited: true }) as object, historical),
      {
        get identity(): never {
          throw new TypeError("Accessor must not run");
        },
        contractDigest: historical.contractDigest,
      },
    ])
      expect(isJiraOperationBinding(invalid)).toBe(false);
  });
  it("keeps executable native operations distinct from local compositions", () => {
    const entries = jiraOperationContracts();
    expect(entries.filter((entry) => entry.definition.kind === "native")).toHaveLength(323);
    expect(entries.filter((entry) => entry.definition.kind === "composite")).toHaveLength(3);
    expect(jiraOperationForTool("jira.discover")).toBeUndefined();
    expect(jiraOperationForTool("DELETE /rest/api/2/project")).toBeUndefined();
    expect(new Set(entries.map((entry) => entry.definition.deployment))).toEqual(
      new Set(["data-center"]),
    );
    expect(
      entries.every((entry) => Object.isFrozen(entry.binding) && Object.isFrozen(entry.definition)),
    ).toBe(true);
  });

  it("changes the binding when typed input, result bounds or permissions change", () => {
    const original = JIRA_MUTATION_DECLARATIONS.find((item) => item.name === "jira.comment");
    if (original === undefined) throw new TypeError("Missing comment declaration");
    const contract = createJiraOperationContract(original);
    expect(createJiraOperationContract(original)).toEqual(contract);
    const { descriptorDigest: _digest, ...declaration } = original.descriptor;
    for (const change of [
      {
        inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
      },
      { bounds: { ...declaration.bounds, maxResultBytes: declaration.bounds.maxResultBytes + 1 } },
      { policyReferences: [...declaration.policyReferences, "test.permission-policy"] },
    ]) {
      const changed = createJiraOperationContract({
        ...original,
        descriptor: createToolDescriptor({ ...declaration, ...change }),
      });
      expect(changed.binding.contractDigest).not.toBe(contract.binding.contractDigest);
      expect(changed.declaration.descriptor.descriptorDigest).not.toBe(
        contract.declaration.descriptor.descriptorDigest,
      );
      expect(matchesJiraOperationBinding(changed, contract.binding)).toBe(false);
    }
    expect(() => createJiraOperationContract({ ...original, risk: "read" })).toThrow("effect");
    expect(() => createJiraOperationContract({ ...original, name: "jira.unregistered" })).toThrow(
      "Unknown Jira operation",
    );
  });

  it("rejects foreign, stale and extended operation bindings", () => {
    const contract = jiraOperationForTool("jira.comment");
    if (contract === undefined) throw new TypeError("Missing comment contract");
    expect(matchesJiraOperationBinding(contract, structuredClone(contract.binding))).toBe(true);
    for (const binding of [
      undefined,
      null,
      [],
      {},
      { ...contract.binding, identity: "POST /rest/api/2/issue" },
      { ...contract.binding, contractDigest: "0".repeat(64) },
      { ...contract.binding, authority: "allowed" },
    ])
      expect(matchesJiraOperationBinding(contract, binding)).toBe(false);
  });

  it("invalidates the draft contract when a constituent contract changes", () => {
    const before = createJiraOperationContracts(JIRA_MUTATION_DECLARATIONS);
    const after = createJiraOperationContracts(
      JIRA_MUTATION_DECLARATIONS.map((declaration) => {
        if (declaration.name !== "jira.create") return declaration;
        const { descriptorDigest: _digest, ...descriptor } = declaration.descriptor;
        return {
          ...declaration,
          descriptor: createToolDescriptor({
            ...descriptor,
            policyReferences: [...descriptor.policyReferences, "test.changed-create-policy"],
          }),
        };
      }),
    );
    expect(
      after.find((entry) => entry.definition.tool === "jira.draft")?.binding.contractDigest,
    ).not.toBe(
      before.find((entry) => entry.definition.tool === "jira.draft")?.binding.contractDigest,
    );
    expect(
      after.find((entry) => entry.definition.tool === "jira.comment")?.binding.contractDigest,
    ).toBe(
      before.find((entry) => entry.definition.tool === "jira.comment")?.binding.contractDigest,
    );
  });

  it("keeps Cloud outside the Data Center operation path", async () => {
    const http = vi.fn();
    const provider = createJiraProviderForCatalog(
      () => ({
        deployment: "cloud",
        baseUrl: "https://jira.example.invalid",
        http,
      }),
      ["jira.projects"],
    );
    const result = await provider.tools()[0]?.execute(
      {},
      {
        invocationId: "cloud-refusal",
        correlationId: "synthetic",
        signal: new AbortController().signal,
        beforeEffect: () => true,
      },
    );
    expect(result).toMatchObject({
      isError: true,
      data: { outcome: "failed", reason: "unsupported-deployment" },
    });
    expect(http).not.toHaveBeenCalled();
  });

  it("binds catalog validation and results to the native operation contract", () => {
    const provider = createJiraProviderForCatalog(vi.fn(), ["jira.projects"]);
    const descriptor = provider.tools()[0]?.descriptor;
    expect(descriptor?.toolRef.contractVersion).toBe(3);
    expect(descriptor?.policyReferences).toContainEqual(
      expect.stringMatching(/^jira-operation-contract\.[a-f0-9]{64}$/u),
    );
    expect(descriptor?.resultSchema.required).toContain("operationBinding");
  });

  it("overwrites a provider-supplied binding with the reviewed server contract", async () => {
    const provider = createJiraProviderForCatalog(
      () => ({
        deployment: "data-center",
        baseUrl: "https://jira.example.invalid/context",
        http: vi.fn(),
      }),
      ["jira.comment"],
      vi.fn(() =>
        Promise.resolve({
          data: {
            outcome: "succeeded",
            operationBinding: {
              identity: "DELETE /rest/api/2/project",
              contractDigest: "0".repeat(64),
            },
          },
        }),
      ),
    );
    const result = await provider.tools()[0]?.execute(
      { issueKey: "SYN-1", body: "Approved" },
      {
        invocationId: "synthetic",
        correlationId: "synthetic",
        signal: new AbortController().signal,
        beforeEffect: () => true,
      },
    );
    expect(result?.data.operationBinding).toHaveProperty(
      "identity",
      "POST /rest/api/2/issue/{issueIdOrKey}/comment",
    );
    expect(result?.data.operationBinding).toHaveProperty(
      "contractDigest",
      expect.stringMatching(/^[a-f0-9]{64}$/u),
    );
    expect(result?.data.operationBinding).not.toHaveProperty("contractDigest", "0".repeat(64));
  });
});
