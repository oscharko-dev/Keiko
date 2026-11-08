import assert from "node:assert/strict";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { AtlassianWriteHttpOutcome } from "../../packages/keiko-connectors/src/atlassian-write-http.js";
import type { JiraMutationRequest } from "../../packages/keiko-connectors/src/jira-managed-mutation-metadata.js";
import { settleSync } from "./jira-fixture-settle.js";
import { asRecord } from "../../packages/keiko-connectors/src/atlassian-sync-classify.js";

const ACTOR = "synthetic-actor";
export const WORKFLOW_SCHEME_REVIEW = {
  id: "37",
  draft: false,
  name: "Delivery",
  description: "Reviewed",
  defaultWorkflow: "Default",
  mappings: [
    { issueTypeId: "1", workflow: "Flow" },
    { issueTypeId: "2", workflow: "Second" },
  ],
} as const;
export const WORKFLOW_DRAFT_REVIEW = {
  ...WORKFLOW_SCHEME_REVIEW,
  id: "9007199254740993",
  draft: true,
  originalDefaultWorkflow: "Default",
  originalMappings: WORKFLOW_SCHEME_REVIEW.mappings,
} as const;
const REVIEW = { expectedActorKey: ACTOR, expectedScheme: WORKFLOW_SCHEME_REVIEW };
const DRAFT_REVIEW = { ...REVIEW, expectedDraft: WORKFLOW_DRAFT_REVIEW };
const BASE_RECEIPT = {
  userKey: ACTOR,
  schemeId: "37",
  workflowSchemeScope: "scheme",
  schemePresent: true,
} as const;
const DRAFT_RECEIPT = {
  ...BASE_RECEIPT,
  workflowSchemeScope: "draft",
  draftSchemeId: "9007199254740993",
} as const;
export const WORKFLOW_SCHEME_MUTATION_FIXTURE_CASES = [
  {
    name: "jira.create-workflow-scheme",
    args: {
      expectedActorKey: ACTOR,
      name: "New",
      description: "",
      defaultWorkflow: "Default",
      mappings: [],
    },
    path: "workflowscheme",
    method: "POST",
    body: { name: "New", description: "", defaultWorkflow: "Default", issueTypeMappings: {} },
    receipt: { ...BASE_RECEIPT, schemeId: "9223372036854775807" },
    confirmed: true,
    draft: false,
  },
  {
    name: "jira.update-workflow-scheme",
    args: { ...REVIEW, name: "Renamed" },
    path: "workflowscheme/37",
    method: "PUT",
    body: { name: "Renamed", updateDraftIfNeeded: false },
    receipt: { ...BASE_RECEIPT, workflowMappingChanged: false },
    confirmed: true,
    draft: false,
  },
  {
    name: "jira.delete-workflow-scheme",
    args: { ...REVIEW, confirmUnverifiedDeletion: true },
    path: "workflowscheme/37",
    method: "DELETE",
    body: undefined,
    receipt: { ...BASE_RECEIPT, schemePresent: false },
    confirmed: false,
    draft: false,
  },
  {
    name: "jira.create-workflow-scheme-draft",
    args: REVIEW,
    path: "workflowscheme/37/createdraft",
    method: "POST",
    body: undefined,
    receipt: DRAFT_RECEIPT,
    confirmed: true,
    draft: false,
  },
  {
    name: "jira.update-workflow-scheme-draft",
    args: { ...DRAFT_REVIEW, description: "" },
    path: "workflowscheme/37/draft",
    method: "PUT",
    body: { description: "" },
    receipt: DRAFT_RECEIPT,
    confirmed: true,
    draft: true,
  },
  {
    name: "jira.delete-workflow-scheme-draft",
    args: { ...DRAFT_REVIEW, confirmUnverifiedDeletion: true },
    path: "workflowscheme/37/draft",
    method: "DELETE",
    body: undefined,
    receipt: { ...DRAFT_RECEIPT, schemePresent: false },
    confirmed: true,
    draft: true,
  },
  {
    name: "jira.set-workflow-scheme-default",
    args: { ...REVIEW, workflowName: "Next" },
    path: "workflowscheme/37/default",
    method: "PUT",
    body: { workflow: "Next", updateDraftIfNeeded: false },
    receipt: { ...BASE_RECEIPT, workflowName: "Next", mappingPresent: true },
    confirmed: false,
    draft: false,
  },
  {
    name: "jira.delete-workflow-scheme-default",
    args: REVIEW,
    path: "workflowscheme/37/default?updateDraftIfNeeded=false",
    method: "DELETE",
    body: undefined,
    receipt: { ...BASE_RECEIPT, mappingPresent: false },
    confirmed: false,
    draft: false,
  },
  {
    name: "jira.set-workflow-scheme-draft-default",
    args: { ...DRAFT_REVIEW, workflowName: "Next" },
    path: "workflowscheme/37/draft/default",
    method: "PUT",
    body: { workflow: "Next" },
    receipt: { ...DRAFT_RECEIPT, workflowName: "Next", mappingPresent: true },
    confirmed: true,
    draft: true,
  },
  {
    name: "jira.delete-workflow-scheme-draft-default",
    args: DRAFT_REVIEW,
    path: "workflowscheme/37/draft/default",
    method: "DELETE",
    body: undefined,
    receipt: { ...DRAFT_RECEIPT, mappingPresent: false },
    confirmed: true,
    draft: true,
  },
  {
    name: "jira.set-workflow-scheme-issue-type",
    args: { ...REVIEW, issueTypeId: "1", workflowName: "Next" },
    path: "workflowscheme/37/issuetype/1",
    method: "PUT",
    body: { workflow: "Next", issueType: "1", updateDraftIfNeeded: false },
    receipt: { ...BASE_RECEIPT, issueTypeId: "1", workflowName: "Next", mappingPresent: true },
    confirmed: false,
    draft: false,
  },
  {
    name: "jira.delete-workflow-scheme-issue-type",
    args: { ...REVIEW, issueTypeId: "1" },
    path: "workflowscheme/37/issuetype/1?updateDraftIfNeeded=false",
    method: "DELETE",
    body: undefined,
    receipt: { ...BASE_RECEIPT, issueTypeId: "1", mappingPresent: false },
    confirmed: false,
    draft: false,
  },
  {
    name: "jira.set-workflow-scheme-draft-issue-type",
    args: { ...DRAFT_REVIEW, issueTypeId: "1", workflowName: "Next" },
    path: "workflowscheme/37/draft/issuetype/1",
    method: "PUT",
    body: { workflow: "Next", issueType: "1" },
    receipt: { ...DRAFT_RECEIPT, issueTypeId: "1", workflowName: "Next", mappingPresent: true },
    confirmed: true,
    draft: true,
  },
  {
    name: "jira.delete-workflow-scheme-draft-issue-type",
    args: { ...DRAFT_REVIEW, issueTypeId: "1" },
    path: "workflowscheme/37/draft/issuetype/1",
    method: "DELETE",
    body: undefined,
    receipt: { ...DRAFT_RECEIPT, issueTypeId: "1", mappingPresent: false },
    confirmed: true,
    draft: true,
  },
  {
    name: "jira.set-workflow-scheme-workflow",
    args: { ...REVIEW, workflowName: "Flow", issueTypeIds: ["2"], defaultMapping: true },
    path: "workflowscheme/37/workflow?workflowName=Flow",
    method: "PUT",
    body: { workflow: "Flow", issueTypes: ["2"], defaultMapping: true, updateDraftIfNeeded: false },
    receipt: { ...BASE_RECEIPT, workflowName: "Flow", mappingPresent: true },
    confirmed: false,
    draft: false,
  },
  {
    name: "jira.delete-workflow-scheme-workflow",
    args: { ...REVIEW, workflowName: "Flow" },
    path: "workflowscheme/37/workflow?workflowName=Flow&updateDraftIfNeeded=false",
    method: "DELETE",
    body: undefined,
    receipt: { ...BASE_RECEIPT, workflowName: "Flow", mappingPresent: false },
    confirmed: false,
    draft: false,
  },
  {
    name: "jira.set-workflow-scheme-draft-workflow",
    args: { ...DRAFT_REVIEW, workflowName: "Flow", issueTypeIds: ["2"], defaultMapping: true },
    path: "workflowscheme/37/draft/workflow?workflowName=Flow",
    method: "PUT",
    body: { workflow: "Flow", issueTypes: ["2"], defaultMapping: true },
    receipt: { ...DRAFT_RECEIPT, workflowName: "Flow", mappingPresent: true },
    confirmed: true,
    draft: true,
  },
  {
    name: "jira.delete-workflow-scheme-draft-workflow",
    args: { ...DRAFT_REVIEW, workflowName: "Flow" },
    path: "workflowscheme/37/draft/workflow?workflowName=Flow",
    method: "DELETE",
    body: undefined,
    receipt: { ...DRAFT_RECEIPT, workflowName: "Flow", mappingPresent: false },
    confirmed: true,
    draft: true,
  },
] as const;

interface NativeScheme {
  id: string;
  draft: boolean;
  name: string;
  description?: string | null;
  defaultWorkflow?: string | null;
  issueTypeMappings: Record<string, string>;
  originalDefaultWorkflow?: string | null;
  originalIssueTypeMappings?: Record<string, string>;
}
interface WorkflowControls {
  lostAck: boolean;
  missingAckId: boolean;
  unsafeAckId: boolean;
  denyReadback: boolean;
  throwReadback: boolean;
  changeParentAfter: boolean;
  changeDraftIdAfter: boolean;
  omitDefaultAfter: boolean;
  missingDraftReadback: boolean;
  wrongWorkflow: boolean;
  wrongIssueType: boolean;
  malformedSelection: boolean;
  nativeReject: boolean;
  acknowledgementStatus: number;
}
interface WorkflowCall {
  path: string;
  method: string;
  body: Parameters<JiraMutationRequest>[2];
  expect: unknown;
}
interface WorkflowState {
  readonly actor: { key: string; name: string };
  readonly workflows: Set<string>;
  readonly types: Set<string>;
  readonly controls: WorkflowControls;
  readonly calls: WorkflowCall[];
  base: NativeScheme | undefined;
  draft: NativeScheme | undefined;
  created: NativeScheme | undefined;
  wrote: boolean;
}
function workflowOk(body: Readonly<Record<string, unknown>>): AtlassianWriteHttpOutcome {
  return { ok: true, status: 200, body };
}
function workflowMissing(): AtlassianWriteHttpOutcome {
  return { ok: false, reason: "not-found", httpStatus: 404 };
}
function workflowCopyDraft(parent: NativeScheme): NativeScheme {
  return {
    ...structuredClone(parent),
    id: "9007199254740993",
    draft: true,
    originalDefaultWorkflow: parent.defaultWorkflow ?? null,
    originalIssueTypeMappings: { ...parent.issueTypeMappings },
  };
}
function workflowState(withDraft: boolean): WorkflowState {
  const base: NativeScheme = {
    id: "37",
    draft: false,
    name: "Delivery",
    description: "Reviewed",
    defaultWorkflow: "Default",
    issueTypeMappings: { "1": "Flow", "2": "Second" },
  };
  return {
    actor: { key: ACTOR, name: "operator" },
    workflows: new Set(["Default", "Flow", "Second", "Next"]),
    types: new Set(["1", "2", "3"]),
    controls: {
      lostAck: false,
      missingAckId: false,
      unsafeAckId: false,
      denyReadback: false,
      throwReadback: false,
      changeParentAfter: false,
      changeDraftIdAfter: false,
      omitDefaultAfter: false,
      missingDraftReadback: false,
      wrongWorkflow: false,
      wrongIssueType: false,
      malformedSelection: false,
      nativeReject: false,
      acknowledgementStatus: 200,
    },
    calls: [],
    base,
    draft: withDraft ? workflowCopyDraft(base) : undefined,
    created: undefined,
    wrote: false,
  };
}
function workflowRepresentation(
  state: WorkflowState,
  value: NativeScheme | undefined,
): AtlassianWriteHttpOutcome {
  const { controls } = state;
  if (value === undefined) return workflowMissing();
  const raw = structuredClone(value);
  if (state.wrote && controls.omitDefaultAfter) delete raw.defaultWorkflow;
  if (state.wrote && controls.changeParentAfter && !raw.draft) raw.name = "Concurrent parent";
  if (state.wrote && controls.changeDraftIdAfter && raw.draft) raw.id = "99";
  return workflowOk({ ...raw });
}
function workflowCatalogRead(
  state: WorkflowState,
  url: URL,
): AtlassianWriteHttpOutcome | undefined {
  const { controls } = state;
  if (url.pathname === "/workflow") {
    const name = url.searchParams.get("workflowName");
    return name !== null && state.workflows.has(name)
      ? workflowOk({ name: controls.wrongWorkflow ? "Other" : name })
      : workflowMissing();
  }
  if (url.pathname.startsWith("/issuetype/")) {
    const id = url.pathname.slice(11);
    return state.types.has(id)
      ? workflowOk({ id: controls.wrongIssueType ? "99" : id, name: "Task" })
      : workflowMissing();
  }
  return undefined;
}
function workflowSchemeRead(state: WorkflowState, url: URL): AtlassianWriteHttpOutcome {
  const { controls } = state;
  if (url.pathname === "/workflowscheme/9223372036854775807")
    return workflowRepresentation(state, state.created);
  if (url.pathname === "/workflowscheme/37/draft")
    return state.wrote && controls.missingDraftReadback
      ? workflowMissing()
      : workflowRepresentation(state, state.draft);
  if (url.pathname === "/workflowscheme/37") {
    if (controls.malformedSelection && url.searchParams.has("returnDraftIfExists"))
      return workflowOk({ id: "37", draft: false });
    return workflowRepresentation(
      state,
      url.searchParams.get("returnDraftIfExists") === "true"
        ? (state.draft ?? state.base)
        : state.base,
    );
  }
  throw new TypeError("Unexpected synthetic workflow scheme read");
}
function workflowRead(state: WorkflowState, url: URL): AtlassianWriteHttpOutcome {
  if (url.pathname === "/myself") return workflowOk(state.actor);
  return workflowCatalogRead(state, url) ?? workflowSchemeRead(state, url);
}
function workflowWholeUpdate(target: NativeScheme, raw: Record<string, unknown>): void {
  if (Object.hasOwn(raw, "name")) {
    assert.equal(typeof raw.name, "string");
    target.name = String(raw.name);
  }
  if (Object.hasOwn(raw, "description")) {
    assert.equal(typeof raw.description, "string");
    target.description = String(raw.description);
  }
  if (Object.hasOwn(raw, "defaultWorkflow")) {
    assert.ok(raw.defaultWorkflow === null || typeof raw.defaultWorkflow === "string");
    target.defaultWorkflow = raw.defaultWorkflow;
  }
  if (Object.hasOwn(raw, "issueTypeMappings")) {
    const map = asRecord(raw.issueTypeMappings);
    assert.ok(map);
    target.issueTypeMappings = {};
    for (const [id, workflow] of Object.entries(map)) {
      assert.equal(typeof workflow, "string");
      target.issueTypeMappings[id] = String(workflow);
    }
  }
}
function workflowIssueTypeMapping(
  target: NativeScheme,
  issue: string,
  remove: boolean,
  raw: Record<string, unknown> | undefined,
): void {
  if (remove) Reflect.deleteProperty(target.issueTypeMappings, issue);
  else {
    assert.equal(raw?.issueType, issue);
    target.issueTypeMappings[issue] = String(raw.workflow);
  }
}
function workflowNamedMapping(
  target: NativeScheme,
  url: URL,
  remove: boolean,
  raw: Record<string, unknown> | undefined,
): void {
  const workflow = url.searchParams.get("workflowName");
  assert.ok(workflow);
  for (const [id, mapped] of Object.entries(target.issueTypeMappings))
    if (mapped === workflow) Reflect.deleteProperty(target.issueTypeMappings, id);
  if (target.defaultWorkflow === workflow) target.defaultWorkflow = null;
  if (remove) return;
  assert.ok(raw);
  assert.equal(raw.workflow, workflow);
  assert.ok(Array.isArray(raw.issueTypes));
  for (const id of raw.issueTypes) {
    assert.equal(typeof id, "string");
    target.issueTypeMappings[String(id)] = workflow;
  }
  if (raw.defaultMapping === true) target.defaultWorkflow = workflow;
}
function workflowMappingEffect(
  target: NativeScheme,
  url: URL,
  method: string,
  raw: Record<string, unknown> | undefined,
): void {
  const remove = method === "DELETE";
  if (url.pathname.endsWith("/default")) {
    assert.ok(remove || typeof raw?.workflow === "string");
    target.defaultWorkflow = remove ? null : String(raw?.workflow);
    return;
  }
  const issue = /\/issuetype\/(\d+)$/u.exec(url.pathname)?.[1];
  if (issue === undefined) workflowNamedMapping(target, url, remove, raw);
  else workflowIssueTypeMapping(target, issue, remove, raw);
}
function workflowTargetEffect(
  state: WorkflowState,
  url: URL,
  method: string,
  raw: Record<string, unknown> | undefined,
): void {
  const isDraft = url.pathname.includes("/draft");
  const target = isDraft ? state.draft : state.base;
  assert.ok(target);
  if (!isDraft)
    assert.equal(
      method === "DELETE" ? url.searchParams.get("updateDraftIfNeeded") : raw?.updateDraftIfNeeded,
      method === "DELETE" ? "false" : false,
    );
  if (/\/workflowscheme\/37(?:\/draft)?$/u.test(url.pathname)) {
    assert.ok(raw);
    workflowWholeUpdate(target, raw);
  } else workflowMappingEffect(target, url, method, raw);
}
function workflowApplyEffect(
  state: WorkflowState,
  url: URL,
  method: string,
  raw: Record<string, unknown> | undefined,
): void {
  if (url.pathname === "/workflowscheme") {
    assert.equal(method, "POST");
    assert.ok(raw);
    state.created = {
      id: "9223372036854775807",
      draft: false,
      name: "",
      description: "",
      defaultWorkflow: null,
      issueTypeMappings: {},
    };
    workflowWholeUpdate(state.created, raw);
  } else if (url.pathname.endsWith("/createdraft")) {
    assert.equal(method, "POST");
    assert.ok(state.base);
    assert.equal(state.draft, undefined);
    state.draft = workflowCopyDraft(state.base);
  } else if (method === "DELETE" && url.pathname === "/workflowscheme/37") state.base = undefined;
  else if (method === "DELETE" && url.pathname === "/workflowscheme/37/draft")
    state.draft = undefined;
  else workflowTargetEffect(state, url, method, raw);
}
function workflowEffect(
  state: WorkflowState,
  url: URL,
  method: string,
  body: Parameters<JiraMutationRequest>[2],
): AtlassianWriteHttpOutcome {
  const { controls } = state;
  const raw = asRecord(body);
  if (controls.nativeReject) return { ok: false, reason: "field-validation", httpStatus: 400 };
  workflowApplyEffect(state, url, method, raw);
  state.wrote = true;
  if (controls.lostAck) return { ok: false, reason: "timeout" };
  const id = url.pathname === "/workflowscheme" ? "9223372036854775807" : "9007199254740993";
  return {
    ok: true,
    status: controls.acknowledgementStatus,
    body:
      method === "POST" && !controls.missingAckId
        ? { id: controls.unsafeAckId ? 9007199254740992 : id }
        : undefined,
  };
}
function workflowDispatch(state: WorkflowState, call: WorkflowCall): AtlassianWriteHttpOutcome {
  const { controls } = state;
  if (state.wrote && controls.throwReadback) throw new Error("Synthetic workflow readback defect");
  if (state.wrote && controls.denyReadback)
    return { ok: false, reason: "permission-denied", httpStatus: 403 };
  const url = new URL(call.path, "https://synthetic.invalid/");
  return call.method === "GET"
    ? workflowRead(state, url)
    : workflowEffect(state, url, call.method, call.body);
}
export function workflowSchemeMutationFixture(withDraft = false): {
  readonly request: JiraMutationRequest;
  readonly calls: WorkflowCall[];
  readonly controls: WorkflowControls;
  readonly actor: { key: string; name: string };
  readonly workflows: Set<string>;
  readonly types: Set<string>;
  readonly setBase: (value: NativeScheme) => void;
  readonly setDraft: (value: NativeScheme | undefined) => void;
  readonly snapshot: () => CatalogJsonObject;
} {
  const state = workflowState(withDraft);
  const { actor, workflows, types, controls, calls } = state;
  const request: JiraMutationRequest = (path, method = "GET", body, expect) =>
    settleSync(() => {
      calls.push({ path, method, body: structuredClone(body), expect });
      return workflowDispatch(state, { path, method, body, expect });
    });
  return {
    request,
    calls,
    controls,
    actor,
    workflows,
    types,
    setBase: (value: NativeScheme): void => {
      state.base = value;
    },
    setDraft: (value: NativeScheme | undefined): void => {
      state.draft = value;
    },
    snapshot: (): CatalogJsonObject => ({
      schemePresent: state.base !== undefined,
      draftPresent: state.draft !== undefined,
      ...(state.base === undefined ? {} : { schemeName: state.base.name }),
      ...(state.draft === undefined
        ? {}
        : { draftId: state.draft.id, draftName: state.draft.name }),
      created: state.created !== undefined,
    }),
  };
}
