import { describe, expect, it, vi } from "vitest";
import {
  createJiraProviderForCatalog,
  jiraOperationContracts,
  jiraOperationForTool,
} from "./jiraManagedProvider.js";
import { JIRA_MUTATION_DECLARATIONS } from "./jiraManagedMutationDescriptors.js";
import {
  createJiraOperationContract,
  createJiraOperationContracts,
  matchesJiraOperationBinding,
  isJiraOperationBinding,
} from "./jiraOperationRegistry.js";
import { createToolDescriptor } from "@oscharko-dev/keiko-tool-catalog";

describe("server-owned Jira operation contracts", () => {
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
    expect(entries.filter((entry) => entry.definition.kind === "native")).toHaveLength(21);
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
