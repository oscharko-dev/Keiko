import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import {
  workflowSchemeNativeMappings,
  type WorkflowSchemeMapping,
  type WorkflowSchemeSnapshot,
} from "./jira-workflow-scheme-values.js";
import type {
  WorkflowSchemeInput,
  WorkflowSchemeMutationReceipt,
} from "./jira-workflow-scheme-mutation-input.js";

export function workflowSchemeReceipt(
  input: WorkflowSchemeInput,
  schemeId = input.expectedScheme?.id,
  draftId = input.expectedDraft?.id,
): WorkflowSchemeMutationReceipt {
  return Object.freeze({
    userKey: input.actor,
    workflowSchemeScope: input.draft ? "draft" : "scheme",
    schemePresent: input.kind !== "delete",
    ...(schemeId === undefined ? {} : { schemeId }),
    ...(draftId === undefined ? {} : { draftSchemeId: draftId }),
    ...mappingReceipt(input),
    ...(input.kind === "update" && !input.draft
      ? {
          workflowMappingChanged:
            input.target?.defaultWorkflow !== undefined || input.target?.mappings !== undefined,
        }
      : {}),
  });
}
function mappingPresent(input: WorkflowSchemeInput): boolean {
  if (input.remove) return false;
  if (input.kind !== "workflow") return true;
  return input.defaultMapping === true || (input.issueTypeIds?.length ?? 0) > 0;
}
function mappingReceipt(input: WorkflowSchemeInput): WorkflowSchemeMutationReceipt {
  const mappingKinds = new Set(["default", "issue-type", "workflow"]);
  return {
    ...(input.issueTypeId === undefined ? {} : { issueTypeId: input.issueTypeId }),
    ...(input.workflowName === undefined ? {} : { workflowName: input.workflowName }),
    ...(mappingKinds.has(input.kind) ? { mappingPresent: mappingPresent(input) } : {}),
  };
}
export function selectedWorkflowScheme(
  input: WorkflowSchemeInput,
): WorkflowSchemeSnapshot | undefined {
  return input.draft ? input.expectedDraft : input.expectedScheme;
}
function mappingTarget(
  input: WorkflowSchemeInput,
  before: WorkflowSchemeSnapshot,
): Pick<WorkflowSchemeSnapshot, "defaultWorkflow" | "mappings"> {
  if (input.kind === "default")
    return {
      mappings: before.mappings,
      defaultWorkflow: input.remove ? null : (input.workflowName ?? before.defaultWorkflow),
    };
  if (input.kind === "issue-type") {
    const remaining = before.mappings.filter(
      ({ issueTypeId }) => issueTypeId !== input.issueTypeId,
    );
    const added =
      !input.remove && input.issueTypeId !== undefined && input.workflowName !== undefined
        ? [{ issueTypeId: input.issueTypeId, workflow: input.workflowName }]
        : [];
    return { defaultWorkflow: before.defaultWorkflow, mappings: [...remaining, ...added] };
  }
  return workflowTarget(input, before);
}
function workflowTarget(
  input: WorkflowSchemeInput,
  before: WorkflowSchemeSnapshot,
): Pick<WorkflowSchemeSnapshot, "defaultWorkflow" | "mappings"> {
  const selectedIds = new Set(input.issueTypeIds ?? []);
  const remaining = before.mappings.filter(
    ({ workflow, issueTypeId }) => workflow !== input.workflowName && !selectedIds.has(issueTypeId),
  );
  const added: WorkflowSchemeMapping[] =
    input.remove || input.workflowName === undefined
      ? []
      : [...selectedIds].map((issueTypeId) => ({
          issueTypeId,
          workflow: input.workflowName ?? "",
        }));
  return {
    defaultWorkflow: workflowDefault(input, before.defaultWorkflow),
    mappings: [...remaining, ...added],
  };
}
function workflowDefault(input: WorkflowSchemeInput, prior: string | null): string | null {
  if (!input.remove && input.defaultMapping === true && input.workflowName !== undefined)
    return input.workflowName;
  return prior === input.workflowName ? null : prior;
}
export function desiredWorkflowScheme(
  input: WorkflowSchemeInput,
  id?: string,
): WorkflowSchemeSnapshot | undefined {
  const before = selectedWorkflowScheme(input);
  if (input.kind === "create") {
    const target = input.target;
    if (
      id === undefined ||
      target?.name === undefined ||
      target.description === undefined ||
      target.defaultWorkflow === undefined ||
      target.mappings === undefined
    )
      return undefined;
    return {
      id,
      draft: false,
      name: target.name,
      description: target.description,
      defaultWorkflow: target.defaultWorkflow,
      mappings: target.mappings,
    };
  }
  if (input.kind === "create-draft") {
    const parent = input.expectedScheme;
    return parent === undefined || id === undefined
      ? undefined
      : {
          ...parent,
          id,
          draft: true,
          originalDefaultWorkflow: parent.defaultWorkflow,
          originalMappings: parent.mappings,
        };
  }
  if (before === undefined || input.kind === "delete") return undefined;
  if (input.kind === "update") return { ...before, ...input.target };
  return { ...before, ...mappingTarget(input, before) };
}
export interface WorkflowSchemeEffect {
  readonly path: string;
  readonly method: "POST" | "PUT" | "DELETE";
  readonly body?: CatalogJsonObject;
  readonly expect: "json" | "none";
}
function targetBody(input: WorkflowSchemeInput): CatalogJsonObject | undefined {
  const target = input.target;
  if (target === undefined) return undefined;
  return {
    ...(target.name === undefined ? {} : { name: target.name }),
    ...(target.description === undefined ? {} : { description: target.description }),
    ...(target.defaultWorkflow === undefined ? {} : { defaultWorkflow: target.defaultWorkflow }),
    ...(target.mappings === undefined
      ? {}
      : { issueTypeMappings: workflowSchemeNativeMappings(target.mappings) }),
  };
}
function mappingBody(input: WorkflowSchemeInput): CatalogJsonObject | undefined {
  if (input.remove) return undefined;
  if (input.workflowName === undefined) return undefined;
  if (input.kind === "workflow")
    return {
      workflow: input.workflowName,
      issueTypes: input.issueTypeIds ?? [],
      defaultMapping: input.defaultMapping ?? false,
    };
  return {
    workflow: input.workflowName,
    ...(input.issueTypeId === undefined ? {} : { issueType: input.issueTypeId }),
  };
}
function relativePath(input: WorkflowSchemeInput, base: string): string {
  if (input.kind === "default") return `${base}/default`;
  if (input.kind === "issue-type") return `${base}/issuetype/${input.issueTypeId}`;
  return input.kind === "workflow" ? `${base}/workflow` : base;
}
export function workflowSchemeEffect(input: WorkflowSchemeInput): WorkflowSchemeEffect | undefined {
  if (input.kind === "create") {
    const body = targetBody(input);
    return body === undefined
      ? undefined
      : { path: "workflowscheme", method: "POST", body, expect: "json" };
  }
  if (input.expectedScheme === undefined) return undefined;
  const parent = `workflowscheme/${input.expectedScheme.id}`;
  if (input.kind === "create-draft")
    return { path: `${parent}/createdraft`, method: "POST", expect: "json" };
  const base = `${parent}${input.draft ? "/draft" : ""}`;
  if (input.kind === "delete") return { path: base, method: "DELETE", expect: "none" };
  return mappingEffect(input, base);
}
function mappingEffect(input: WorkflowSchemeInput, base: string): WorkflowSchemeEffect {
  const query = new URLSearchParams();
  if (input.workflowName !== undefined && input.kind === "workflow")
    query.set("workflowName", input.workflowName);
  if (input.remove && !input.draft) query.set("updateDraftIfNeeded", "false");
  const body = input.kind === "update" ? targetBody(input) : mappingBody(input);
  return {
    path: relativePath(input, base) + (query.size === 0 ? "" : `?${query.toString()}`),
    method: input.remove ? "DELETE" : "PUT",
    expect: "none",
    ...(body === undefined
      ? {}
      : { body: { ...body, ...(!input.draft ? { updateDraftIfNeeded: false } : {}) } }),
  };
}
/** Configuration may be visible without proving all project/deployment consequences. */
export function workflowSchemeCanConfirm(input: WorkflowSchemeInput): boolean {
  if (input.draft || input.kind === "create") return true;
  return (
    input.kind === "update" &&
    input.target?.defaultWorkflow === undefined &&
    input.target?.mappings === undefined
  );
}
