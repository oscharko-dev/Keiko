import assert from "node:assert/strict";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { AtlassianWriteHttpOutcome } from "../../packages/keiko-connectors/src/atlassian-write-http.js";
import type { JiraMutationRequest } from "../../packages/keiko-connectors/src/jira-managed-mutation-metadata.js";
import { asRecord } from "../../packages/keiko-connectors/src/atlassian-sync-classify.js";

const ACTOR = "synthetic-actor";
export const WORKFLOW_SCHEME_REVIEW = { id: "37", draft: false, name: "Delivery", description: "Reviewed", defaultWorkflow: "Default",
  mappings: [{ issueTypeId: "1", workflow: "Flow" }, { issueTypeId: "2", workflow: "Second" }] } as const;
export const WORKFLOW_DRAFT_REVIEW = { ...WORKFLOW_SCHEME_REVIEW, id: "9007199254740993", draft: true,
  originalDefaultWorkflow: "Default", originalMappings: WORKFLOW_SCHEME_REVIEW.mappings } as const;
const REVIEW = { expectedActorKey: ACTOR, expectedScheme: WORKFLOW_SCHEME_REVIEW };
const DRAFT_REVIEW = { ...REVIEW, expectedDraft: WORKFLOW_DRAFT_REVIEW };
const BASE_RECEIPT = { userKey: ACTOR, schemeId: "37", workflowSchemeScope: "scheme", schemePresent: true } as const;
const DRAFT_RECEIPT = { ...BASE_RECEIPT, workflowSchemeScope: "draft", draftSchemeId: "9007199254740993" } as const;
export const WORKFLOW_SCHEME_MUTATION_FIXTURE_CASES = [
  { name: "jira.create-workflow-scheme", args: { expectedActorKey: ACTOR, name: "New", description: "", defaultWorkflow: "Default", mappings: [] },
    path: "workflowscheme", method: "POST", body: { name: "New", description: "", defaultWorkflow: "Default", issueTypeMappings: {} },
    receipt: { ...BASE_RECEIPT, schemeId: "9223372036854775807" }, confirmed: true, draft: false },
  { name: "jira.update-workflow-scheme", args: { ...REVIEW, name: "Renamed" }, path: "workflowscheme/37", method: "PUT", body: { name: "Renamed", updateDraftIfNeeded: false },
    receipt: { ...BASE_RECEIPT, workflowMappingChanged: false }, confirmed: true, draft: false },
  { name: "jira.delete-workflow-scheme", args: { ...REVIEW, confirmUnverifiedDeletion: true }, path: "workflowscheme/37", method: "DELETE", body: undefined,
    receipt: { ...BASE_RECEIPT, schemePresent: false }, confirmed: false, draft: false },
  { name: "jira.create-workflow-scheme-draft", args: REVIEW, path: "workflowscheme/37/createdraft", method: "POST", body: undefined,
    receipt: DRAFT_RECEIPT, confirmed: true, draft: false },
  { name: "jira.update-workflow-scheme-draft", args: { ...DRAFT_REVIEW, description: "" }, path: "workflowscheme/37/draft", method: "PUT", body: { description: "" },
    receipt: DRAFT_RECEIPT, confirmed: true, draft: true },
  { name: "jira.delete-workflow-scheme-draft", args: { ...DRAFT_REVIEW, confirmUnverifiedDeletion: true }, path: "workflowscheme/37/draft", method: "DELETE", body: undefined,
    receipt: { ...DRAFT_RECEIPT, schemePresent: false }, confirmed: true, draft: true },
  { name: "jira.set-workflow-scheme-default", args: { ...REVIEW, workflowName: "Next" }, path: "workflowscheme/37/default", method: "PUT", body: { workflow: "Next", updateDraftIfNeeded: false },
    receipt: { ...BASE_RECEIPT, workflowName: "Next", mappingPresent: true }, confirmed: false, draft: false },
  { name: "jira.delete-workflow-scheme-default", args: REVIEW, path: "workflowscheme/37/default?updateDraftIfNeeded=false", method: "DELETE", body: undefined,
    receipt: { ...BASE_RECEIPT, mappingPresent: false }, confirmed: false, draft: false },
  { name: "jira.set-workflow-scheme-draft-default", args: { ...DRAFT_REVIEW, workflowName: "Next" }, path: "workflowscheme/37/draft/default", method: "PUT", body: { workflow: "Next" },
    receipt: { ...DRAFT_RECEIPT, workflowName: "Next", mappingPresent: true }, confirmed: true, draft: true },
  { name: "jira.delete-workflow-scheme-draft-default", args: DRAFT_REVIEW, path: "workflowscheme/37/draft/default", method: "DELETE", body: undefined,
    receipt: { ...DRAFT_RECEIPT, mappingPresent: false }, confirmed: true, draft: true },
  { name: "jira.set-workflow-scheme-issue-type", args: { ...REVIEW, issueTypeId: "1", workflowName: "Next" }, path: "workflowscheme/37/issuetype/1", method: "PUT", body: { workflow: "Next", issueType: "1", updateDraftIfNeeded: false },
    receipt: { ...BASE_RECEIPT, issueTypeId: "1", workflowName: "Next", mappingPresent: true }, confirmed: false, draft: false },
  { name: "jira.delete-workflow-scheme-issue-type", args: { ...REVIEW, issueTypeId: "1" }, path: "workflowscheme/37/issuetype/1?updateDraftIfNeeded=false", method: "DELETE", body: undefined,
    receipt: { ...BASE_RECEIPT, issueTypeId: "1", mappingPresent: false }, confirmed: false, draft: false },
  { name: "jira.set-workflow-scheme-draft-issue-type", args: { ...DRAFT_REVIEW, issueTypeId: "1", workflowName: "Next" }, path: "workflowscheme/37/draft/issuetype/1", method: "PUT", body: { workflow: "Next", issueType: "1" },
    receipt: { ...DRAFT_RECEIPT, issueTypeId: "1", workflowName: "Next", mappingPresent: true }, confirmed: true, draft: true },
  { name: "jira.delete-workflow-scheme-draft-issue-type", args: { ...DRAFT_REVIEW, issueTypeId: "1" }, path: "workflowscheme/37/draft/issuetype/1", method: "DELETE", body: undefined,
    receipt: { ...DRAFT_RECEIPT, issueTypeId: "1", mappingPresent: false }, confirmed: true, draft: true },
  { name: "jira.set-workflow-scheme-workflow", args: { ...REVIEW, workflowName: "Flow", issueTypeIds: ["2"], defaultMapping: true }, path: "workflowscheme/37/workflow?workflowName=Flow", method: "PUT", body: { workflow: "Flow", issueTypes: ["2"], defaultMapping: true, updateDraftIfNeeded: false },
    receipt: { ...BASE_RECEIPT, workflowName: "Flow", mappingPresent: true }, confirmed: false, draft: false },
  { name: "jira.delete-workflow-scheme-workflow", args: { ...REVIEW, workflowName: "Flow" }, path: "workflowscheme/37/workflow?workflowName=Flow&updateDraftIfNeeded=false", method: "DELETE", body: undefined,
    receipt: { ...BASE_RECEIPT, workflowName: "Flow", mappingPresent: false }, confirmed: false, draft: false },
  { name: "jira.set-workflow-scheme-draft-workflow", args: { ...DRAFT_REVIEW, workflowName: "Flow", issueTypeIds: ["2"], defaultMapping: true }, path: "workflowscheme/37/draft/workflow?workflowName=Flow", method: "PUT", body: { workflow: "Flow", issueTypes: ["2"], defaultMapping: true },
    receipt: { ...DRAFT_RECEIPT, workflowName: "Flow", mappingPresent: true }, confirmed: true, draft: true },
  { name: "jira.delete-workflow-scheme-draft-workflow", args: { ...DRAFT_REVIEW, workflowName: "Flow" }, path: "workflowscheme/37/draft/workflow?workflowName=Flow", method: "DELETE", body: undefined,
    receipt: { ...DRAFT_RECEIPT, workflowName: "Flow", mappingPresent: false }, confirmed: true, draft: true },
] as const;

interface NativeScheme {
  id: string; draft: boolean; name: string; description?: string | null; defaultWorkflow?: string | null;
  issueTypeMappings: Record<string, string>; originalDefaultWorkflow?: string | null; originalIssueTypeMappings?: Record<string, string>;
}
export function workflowSchemeMutationFixture(withDraft = false) {
  const actor = { key: ACTOR, name: "operator" };
  let base: NativeScheme | undefined = { id: "37", draft: false, name: "Delivery", description: "Reviewed", defaultWorkflow: "Default", issueTypeMappings: { "1": "Flow", "2": "Second" } };
  const copyDraft = (parent: NativeScheme): NativeScheme => ({ ...structuredClone(parent), id: "9007199254740993", draft: true,
    originalDefaultWorkflow: parent.defaultWorkflow ?? null, originalIssueTypeMappings: { ...parent.issueTypeMappings } });
  let draft = withDraft ? copyDraft(base) : undefined;
  const workflows = new Set(["Default", "Flow", "Second", "Next"]);
  const types = new Set(["1", "2", "3"]);
  let created: NativeScheme | undefined;
  let wrote = false;
  const controls = { lostAck: false, missingAckId: false, unsafeAckId: false, denyReadback: false, throwReadback: false,
    changeParentAfter: false, changeDraftIdAfter: false, omitDefaultAfter: false, missingDraftReadback: false,
    wrongWorkflow: false, wrongIssueType: false, malformedSelection: false, nativeReject: false, acknowledgementStatus: 200 };
  const calls: { path: string; method: string; body: unknown; expect: unknown }[] = [];
  const ok = (body: Readonly<Record<string, unknown>>): AtlassianWriteHttpOutcome => ({ ok: true, status: 200, body });
  const missing = (): AtlassianWriteHttpOutcome => ({ ok: false, reason: "not-found", httpStatus: 404 });
  function representation(value: NativeScheme | undefined): AtlassianWriteHttpOutcome {
    if (value === undefined) return missing();
    const raw = structuredClone(value);
    if (wrote && controls.omitDefaultAfter) delete raw.defaultWorkflow;
    if (wrote && controls.changeParentAfter && !raw.draft) raw.name = "Concurrent parent";
    if (wrote && controls.changeDraftIdAfter && raw.draft) raw.id = "99";
    return ok({ ...raw });
  }
  function read(url: URL): AtlassianWriteHttpOutcome {
    if (url.pathname === "/myself") return ok(actor);
    if (url.pathname === "/workflow") {
      const name = url.searchParams.get("workflowName");
      return name !== null && workflows.has(name) ? ok({ name: controls.wrongWorkflow ? "Other" : name }) : missing();
    }
    if (url.pathname.startsWith("/issuetype/")) {
      const id = url.pathname.slice(11);
      return types.has(id) ? ok({ id: controls.wrongIssueType ? "99" : id, name: "Task" }) : missing();
    }
    if (url.pathname === "/workflowscheme/9223372036854775807") return representation(created);
    if (url.pathname === "/workflowscheme/37/draft") return wrote && controls.missingDraftReadback ? missing() : representation(draft);
    if (url.pathname === "/workflowscheme/37") {
      if (controls.malformedSelection && url.searchParams.has("returnDraftIfExists")) return ok({ id: "37", draft: false });
      return representation(url.searchParams.get("returnDraftIfExists") === "true" ? draft ?? base : base);
    }
    throw new TypeError("Unexpected synthetic workflow scheme read");
  }
  function wholeUpdate(target: NativeScheme, raw: Record<string, unknown>): void {
    if (Object.hasOwn(raw, "name")) { assert.equal(typeof raw.name, "string"); target.name = String(raw.name); }
    if (Object.hasOwn(raw, "description")) { assert.equal(typeof raw.description, "string"); target.description = String(raw.description); }
    if (Object.hasOwn(raw, "defaultWorkflow")) { assert.ok(raw.defaultWorkflow === null || typeof raw.defaultWorkflow === "string"); target.defaultWorkflow = raw.defaultWorkflow; }
    if (Object.hasOwn(raw, "issueTypeMappings")) {
      const map = asRecord(raw.issueTypeMappings); assert.ok(map);
      target.issueTypeMappings = {};
      for (const [id, workflow] of Object.entries(map)) { assert.equal(typeof workflow, "string"); target.issueTypeMappings[id] = String(workflow); }
    }
  }
  function mappingEffect(target: NativeScheme, url: URL, method: string, raw: Record<string, unknown> | undefined): void {
    const remove = method === "DELETE";
    if (url.pathname.endsWith("/default")) { assert.ok(remove || typeof raw?.workflow === "string"); target.defaultWorkflow = remove ? null : String(raw?.workflow); return; }
    const issue = /\/issuetype\/(\d+)$/u.exec(url.pathname)?.[1];
    if (issue !== undefined) { if (remove) delete target.issueTypeMappings[issue]; else { assert.equal(raw?.issueType, issue); target.issueTypeMappings[issue] = String(raw?.workflow); } return; }
    const workflow = url.searchParams.get("workflowName"); assert.ok(workflow);
    for (const [id, mapped] of Object.entries(target.issueTypeMappings)) if (mapped === workflow) delete target.issueTypeMappings[id];
    if (target.defaultWorkflow === workflow) target.defaultWorkflow = null;
    if (remove) return;
    assert.ok(raw); assert.equal(raw.workflow, workflow); assert.ok(Array.isArray(raw.issueTypes));
    for (const id of raw.issueTypes) { assert.equal(typeof id, "string"); target.issueTypeMappings[String(id)] = workflow; }
    if (raw.defaultMapping === true) target.defaultWorkflow = workflow;
  }
  function effect(url: URL, method: string, body: Parameters<JiraMutationRequest>[2]): AtlassianWriteHttpOutcome {
    const raw = asRecord(body);
    if (controls.nativeReject) return { ok: false, reason: "field-validation", httpStatus: 400 };
    if (url.pathname === "/workflowscheme") {
      assert.equal(method, "POST"); assert.ok(raw);
      created = { id: "9223372036854775807", draft: false, name: "", description: "", defaultWorkflow: null, issueTypeMappings: {} };
      wholeUpdate(created, raw);
    } else if (url.pathname.endsWith("/createdraft")) { assert.equal(method, "POST"); assert.ok(base); assert.equal(draft, undefined); draft = copyDraft(base); }
    else if (method === "DELETE" && url.pathname === "/workflowscheme/37") base = undefined;
    else if (method === "DELETE" && url.pathname === "/workflowscheme/37/draft") draft = undefined;
    else {
      const isDraft = url.pathname.includes("/draft"); const target = isDraft ? draft : base; assert.ok(target);
      if (!isDraft) assert.equal(method === "DELETE" ? url.searchParams.get("updateDraftIfNeeded") : raw?.updateDraftIfNeeded, method === "DELETE" ? "false" : false);
      if (/\/workflowscheme\/37(?:\/draft)?$/u.test(url.pathname)) { assert.ok(raw); wholeUpdate(target, raw); }
      else mappingEffect(target, url, method, raw);
    }
    wrote = true;
    if (controls.lostAck) return { ok: false, reason: "timeout" };
    const id = url.pathname === "/workflowscheme" ? "9223372036854775807" : "9007199254740993";
    return { ok: true, status: controls.acknowledgementStatus, body: method === "POST" && !controls.missingAckId ? { id: controls.unsafeAckId ? 9007199254740992 : id } : undefined };
  }
  const request: JiraMutationRequest = async (path, method = "GET", body, expect) => {
    calls.push({ path, method, body: structuredClone(body), expect });
    if (wrote && controls.throwReadback) throw new Error("Synthetic workflow readback defect");
    if (wrote && controls.denyReadback) return { ok: false, reason: "permission-denied", httpStatus: 403 };
    const url = new URL(path, "https://synthetic.invalid/");
    return method === "GET" ? read(url) : effect(url, method, body);
  };
  return { request, calls, controls, actor, workflows, types,
    setBase: (value: NativeScheme): void => { base = value; },
    setDraft: (value: NativeScheme | undefined): void => { draft = value; },
    snapshot: (): CatalogJsonObject => ({ schemePresent: base !== undefined, draftPresent: draft !== undefined,
      ...(base === undefined ? {} : { schemeName: base.name }), ...(draft === undefined ? {} : { draftId: draft.id, draftName: draft.name }),
      created: created !== undefined }) };
}
