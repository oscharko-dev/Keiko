import { describe, expect, it } from "vitest";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { WORKFLOW_SCHEME_MUTATION_FIXTURE_CASES as CASES, WORKFLOW_SCHEME_REVIEW as SCHEME, WORKFLOW_DRAFT_REVIEW as DRAFT, workflowSchemeMutationFixture } from "../../../tests/support/jira-workflow-scheme-mutation-fixture.js";
import { executeJiraWorkflowSchemeMutation as execute, isJiraWorkflowSchemeMutation } from "./jira-managed-workflow-scheme-mutations.js";
import { jiraWorkflowSchemeReviewSnapshot } from "./jira-workflow-scheme-values.js";
import { JiraAcknowledgedMutationError } from "./jira-mutation-failure.js";

describe("reviewed workflow scheme configuration and explicit drafts", () => {
  it.each(CASES)("sends one fixed $name request and independently observes the same parent", async (test) => {
    const f = workflowSchemeMutationFixture(test.draft);
    const result = await execute(test.name, structuredClone(test.args), f.request);
    expect(isJiraWorkflowSchemeMutation(test.name)).toBe(true);
    expect(f.calls.filter(({ method }) => method !== "GET")).toEqual([{ path: test.path, method: test.method, body: test.body,
      expect: test.method === "POST" ? "json" : "none" }]);
    expect(result.receipt).toEqual(test.receipt);
    expect(result.ok).toBe(test.confirmed);
    expect(f.calls.at(-1)?.method).toBe("GET");
    expect(f.calls.some(({ path }) => /publish|migrat|assign/iu.test(path))).toBe(false);
  });
  it.each(CASES)("preflight $name is read-only and retains no simulated success receipt", async (test) => {
    const f = workflowSchemeMutationFixture(test.draft); const before = f.snapshot();
    expect(await execute(test.name, structuredClone(test.args), f.request, true)).toEqual({ ok: true, receipt: {} });
    expect(f.calls.every(({ method }) => method === "GET")).toBe(true);
    expect(f.snapshot()).toEqual(before);
  });
  it.each(CASES)("does not replay $name after a lost acknowledgement", async (test) => {
    const f = workflowSchemeMutationFixture(test.draft); f.controls.lostAck = true;
    const result = await execute(test.name, structuredClone(test.args), f.request);
    expect(result).toMatchObject({ ok: false, reason: "timeout" });
    const expected = { ...test.receipt };
    if (test.name === "jira.create-workflow-scheme") Reflect.deleteProperty(expected, "schemeId");
    if (test.name === "jira.create-workflow-scheme-draft") Reflect.deleteProperty(expected, "draftSchemeId");
    expect(result.receipt).toEqual(expected);
    expect(f.calls.filter(({ method }) => method !== "GET")).toHaveLength(1);
    expect(f.calls.at(-1)?.method).not.toBe("GET");
  });
  it.each(CASES)("keeps exact $name context when readback is denied", async (test) => {
    const f = workflowSchemeMutationFixture(test.draft); f.controls.denyReadback = true;
    expect(await execute(test.name, structuredClone(test.args), f.request)).toMatchObject({ ok: false, reason: "permission-denied", receipt: test.receipt });
    expect(f.calls.filter(({ method }) => method !== "GET")).toHaveLength(1);
  });
  it.each([CASES[0], CASES[3]])("does not manufacture the missing ACK identity for $name", async (test) => {
    for (const control of ["missingAckId", "unsafeAckId"] as const) {
      const f = workflowSchemeMutationFixture(); f.controls[control] = true;
      const result = await execute(test.name, structuredClone(test.args), f.request);
      expect(result).toMatchObject({ ok: false, reason: "unavailable" });
      expect(result.receipt).not.toHaveProperty(test.name === "jira.create-workflow-scheme" ? "schemeId" : "draftSchemeId");
      expect(f.calls.at(-1)?.method).toBe("POST");
      expect(f.calls.filter(({ method }) => method === "POST")).toHaveLength(1);
    }
  });
  it("requires explicitly reviewed drafts instead of native auto-create or auto-target behavior", async () => {
    const existing = workflowSchemeMutationFixture(true);
    expect(await execute(CASES[1].name, CASES[1].args, existing.request)).toMatchObject({ ok: false, reason: "conflict" });
    expect(existing.calls.every(({ method }) => method === "GET")).toBe(true);
    const missing = workflowSchemeMutationFixture();
    expect(await execute(CASES[4].name, CASES[4].args, missing.request)).toMatchObject({ ok: false, reason: "conflict" });
    expect(missing.calls.every(({ method }) => method === "GET")).toBe(true);
  });
  it("rejects active-scheme native refusals without a fallback draft write", async () => {
    const f = workflowSchemeMutationFixture(); f.controls.nativeReject = true;
    expect(await execute(CASES[6].name, CASES[6].args, f.request)).toMatchObject({ ok: false, reason: "field-validation" });
    expect(f.calls.filter(({ method }) => method !== "GET")).toHaveLength(1);
    expect(f.calls.some(({ path }) => path.includes("createdraft"))).toBe(false);
  });
  it("does not interpret draft:false as project activity or deploy a newly copied draft", async () => {
    const f = workflowSchemeMutationFixture();
    const result = await execute(CASES[3].name, CASES[3].args, f.request);
    expect(result).toEqual({ ok: true, receipt: CASES[3].receipt });
    expect(result.receipt).not.toHaveProperty("active");
    expect(result.receipt).not.toHaveProperty("published");
    expect(f.calls.filter(({ method }) => method !== "GET").map(({ path }) => path)).toEqual(["workflowscheme/37/createdraft"]);
  });
  it.each(["changeParentAfter", "changeDraftIdAfter", "missingDraftReadback", "omitDefaultAfter"] as const)("leaves draft configuration unconfirmed after %s", async (control) => {
    const f = workflowSchemeMutationFixture(true); f.controls[control] = true;
    expect(await execute(CASES[8].name, CASES[8].args, f.request)).toMatchObject({ ok: false, receipt: CASES[8].receipt });
    expect(f.calls.filter(({ method }) => method === "PUT")).toHaveLength(1);
  });
  it("uses the readable parent fallback, never a draft404, to establish draft deletion", async () => {
    const f = workflowSchemeMutationFixture(true);
    expect(await execute(CASES[5].name, CASES[5].args, f.request)).toEqual({ ok: true, receipt: CASES[5].receipt });
    expect(f.calls.at(-1)?.path).toBe("workflowscheme/37?returnDraftIfExists=true");
    const refused = workflowSchemeMutationFixture(true); refused.controls.denyReadback = true;
    expect(await execute(CASES[5].name, CASES[5].args, refused.request)).toMatchObject({ ok: false });
  });
  it("cannot establish deletion of the base from a selected404", async () => {
    const f = workflowSchemeMutationFixture();
    expect(await execute(CASES[2].name, CASES[2].args, f.request)).toMatchObject({ ok: false, receipt: CASES[2].receipt });
    expect(f.snapshot().schemePresent).toBe(false);
  });
  it("does not turn an effective fallback name into a confirmed configured-null deletion", async () => {
    const f = workflowSchemeMutationFixture(true);
    const request: typeof f.request = async (...parameters) => {
      const result = await f.request(...parameters);
      const afterWrite = f.calls.some(({ method }) => method === "DELETE");
      if (afterWrite && result.ok && result.body?.draft === true)
        return { ...result, body: { ...result.body, defaultWorkflow: "Native effective fallback" } };
      return result;
    };
    expect(await execute(CASES[9].name, CASES[9].args, request)).toMatchObject({ ok: false, receipt: CASES[9].receipt });
    expect(f.calls.filter(({ method }) => method === "DELETE")).toHaveLength(1);
  });
  it("retains the bound target after post-write actor drift instead of confirming under a new user", async () => {
    const f = workflowSchemeMutationFixture(true);
    const request: typeof f.request = async (...parameters) => {
      const result = await f.request(...parameters);
      if (parameters[1] === "PUT") f.actor.key = "different-actor";
      return result;
    };
    expect(await execute(CASES[8].name, CASES[8].args, request)).toMatchObject({ ok: false, reason: "conflict", receipt: CASES[8].receipt });
    expect(f.calls.filter(({ method }) => method === "PUT")).toHaveLength(1);
  });
  it("independently verifies known targets after bodyless successful acknowledgements", async () => {
    const f = workflowSchemeMutationFixture(true); f.controls.acknowledgementStatus = 204;
    expect(await execute(CASES[4].name, CASES[4].args, f.request)).toEqual({ ok: true, receipt: CASES[4].receipt });
    expect(f.calls.at(-1)?.path).toBe("workflowscheme/37/draft");
  });
  it("retains configured null distinctly from an unavailable field or effective fallback", () => {
    const native = { id: 37, draft: false, name: "Delivery", description: null, defaultWorkflow: null, issueTypeMappings: {} };
    expect(jiraWorkflowSchemeReviewSnapshot(native)).toEqual({ id: "37", draft: false, name: "Delivery", description: null, defaultWorkflow: null, mappings: [] });
    for (const field of ["description", "defaultWorkflow", "issueTypeMappings"]) {
      const missing: Record<string, unknown> = { ...native }; delete missing[field];
      expect(jiraWorkflowSchemeReviewSnapshot(missing)).toBeUndefined();
    }
    expect(jiraWorkflowSchemeReviewSnapshot({ ...native, id: Number.MAX_SAFE_INTEGER + 1 })).toBeUndefined();
  });
  it("requires complete original draft facts without filling omitted fields from the parent", () => {
    const native = { id: "8", draft: true, name: "Delivery", description: "", defaultWorkflow: null, issueTypeMappings: {} };
    expect(jiraWorkflowSchemeReviewSnapshot(native)).toBeUndefined();
    expect(jiraWorkflowSchemeReviewSnapshot({ ...native, originalDefaultWorkflow: null, originalIssueTypeMappings: {} })).toMatchObject({ originalDefaultWorkflow: null, originalMappings: [] });
  });
  it("does not let malformed parent selection masquerade as no draft", async () => {
    const f = workflowSchemeMutationFixture(); f.controls.malformedSelection = true;
    expect(await execute(CASES[3].name, CASES[3].args, f.request)).toMatchObject({ ok: false, reason: "unavailable" });
    expect(f.calls.every(({ method }) => method === "GET")).toBe(true);
  });
  it.each(["wrongWorkflow", "wrongIssueType"] as const)("binds exact target identities before effects: %s", async (control) => {
    const f = workflowSchemeMutationFixture(); f.controls[control] = true;
    expect(await execute(CASES[10].name, CASES[10].args, f.request)).toMatchObject({ ok: false, reason: "conflict" });
    expect(f.calls.every(({ method }) => method === "GET")).toBe(true);
  });
  it("treats explicit empty workflow membership and false default as a reviewed removal target", async () => {
    const f = workflowSchemeMutationFixture(true);
    const result = await execute(CASES[16].name, { ...CASES[16].args, issueTypeIds: [], defaultMapping: false }, f.request);
    expect(result).toMatchObject({ ok: true, receipt: { mappingPresent: false, workflowName: "Flow" } });
    expect(f.calls.find(({ method }) => method === "PUT")?.body).toEqual({ workflow: "Flow", issueTypes: [], defaultMapping: false });
  });
  it("makes a no-op only from complete matching configuration after target binding", async () => {
    const f = workflowSchemeMutationFixture(true);
    const result = await execute(CASES[8].name, { ...CASES[8].args, workflowName: "Default" }, f.request);
    expect(result).toMatchObject({ ok: false, reason: "conflict", detail: { unchanged: true } });
    expect(f.calls.some(({ path }) => path === "workflow?workflowName=Default")).toBe(true);
    expect(f.calls.every(({ method }) => method === "GET")).toBe(true);
  });
  it("checks stale mapping sets and original mappings, not just scheme names", async () => {
    const f = workflowSchemeMutationFixture(true);
    expect(await execute(CASES[8].name, { ...CASES[8].args, expectedDraft: { ...DRAFT, originalMappings: [] } }, f.request)).toMatchObject({ ok: false, reason: "conflict" });
    expect(f.calls.every(({ method }) => method === "GET")).toBe(true);
  });
  it("copies caller-owned mapping rows and review facts before the first await", async () => {
    const f = workflowSchemeMutationFixture();
    const args: CatalogJsonObject = { ...CASES[0].args, mappings: [{ issueTypeId: "1", workflow: "Flow" }] };
    const result = execute(CASES[0].name, args, f.request);
    Reflect.set(args, "name", "Mutated");
    const mappings = args.mappings;
    if (!Array.isArray(mappings)) throw new TypeError("Expected test mappings");
    mappings.splice(0, 1, { issueTypeId: "2", workflow: "Second" });
    await result;
    expect(f.calls.find(({ method }) => method === "POST")?.body).toEqual({ name: "New", description: "", defaultWorkflow: "Default", issueTypeMappings: { "1": "Flow" } });
  });
  it("forwards post-ACK programming errors with the known immutable receipt", async () => {
    const f = workflowSchemeMutationFixture(true); f.controls.throwReadback = true;
    let thrown: unknown;
    try { await execute(CASES[8].name, CASES[8].args, f.request); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(JiraAcknowledgedMutationError);
    if (!(thrown instanceof JiraAcknowledgedMutationError)) throw new TypeError("Expected acknowledged error");
    expect(thrown.receipt).toEqual(CASES[8].receipt); expect(thrown.cause).toBeInstanceOf(Error);
    expect(Object.isFrozen(thrown.receipt)).toBe(true);
  });
  it.each([
    { updateDraftIfNeeded: true }, { publish: true }, { mappings: [{ issueTypeId: "01", workflow: "Flow" }] },
    { mappings: [{ issueTypeId: "1", workflow: "Flow" }, { issueTypeId: "1", workflow: "Next" }] },
    { defaultWorkflow: "\ud800" },
  ])("refuses unsupported/malformed input before requests: %j", async (extra) => {
    const f = workflowSchemeMutationFixture();
    expect(await execute(CASES[1].name, { ...CASES[1].args, ...extra }, f.request)).toMatchObject({ ok: false, reason: "field-validation" });
    expect(f.calls).toEqual([]);
  });
  it("does not replace a missing reviewed description with null", async () => {
    const f = workflowSchemeMutationFixture();
    const expected: Record<string, string | boolean | readonly { readonly issueTypeId: string; readonly workflow: string }[]> = { ...SCHEME };
    delete expected.description;
    expect(await execute(CASES[1].name, { ...CASES[1].args, expectedScheme: expected }, f.request)).toMatchObject({ ok: false, reason: "field-validation" });
    expect(f.calls).toEqual([]);
  });
});
