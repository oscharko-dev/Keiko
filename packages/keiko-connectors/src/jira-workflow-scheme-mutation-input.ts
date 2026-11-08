import {
  type JiraWorkflowSchemeMutation,
  type JiraMutationAttempt,
  type JiraMutationReceipt,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { jiraNativeId } from "./jira-native-values.js";
import { savedExactKeys, savedName, savedText } from "./jira-saved-configuration-values.js";
import {
  workflowSchemeInputMappings,
  workflowSchemeInputSnapshot,
  type WorkflowSchemeMapping,
  type WorkflowSchemeSnapshot,
} from "./jira-workflow-scheme-values.js";

export {
  JIRA_WORKFLOW_SCHEME_MUTATIONS,
  type JiraWorkflowSchemeMutation,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
export type WorkflowSchemeMutationKind =
  "create" | "update" | "delete" | "create-draft" | "default" | "issue-type" | "workflow";
interface Definition {
  readonly kind: WorkflowSchemeMutationKind;
  readonly draft: boolean;
  readonly remove: boolean;
}
export const WORKFLOW_SCHEME_MUTATIONS: Readonly<Record<JiraWorkflowSchemeMutation, Definition>> = {
  "jira.create-workflow-scheme": { kind: "create", draft: false, remove: false },
  "jira.update-workflow-scheme": { kind: "update", draft: false, remove: false },
  "jira.delete-workflow-scheme": { kind: "delete", draft: false, remove: true },
  "jira.create-workflow-scheme-draft": { kind: "create-draft", draft: true, remove: false },
  "jira.update-workflow-scheme-draft": { kind: "update", draft: true, remove: false },
  "jira.delete-workflow-scheme-draft": { kind: "delete", draft: true, remove: true },
  "jira.set-workflow-scheme-default": { kind: "default", draft: false, remove: false },
  "jira.delete-workflow-scheme-default": { kind: "default", draft: false, remove: true },
  "jira.set-workflow-scheme-draft-default": { kind: "default", draft: true, remove: false },
  "jira.delete-workflow-scheme-draft-default": { kind: "default", draft: true, remove: true },
  "jira.set-workflow-scheme-issue-type": { kind: "issue-type", draft: false, remove: false },
  "jira.delete-workflow-scheme-issue-type": { kind: "issue-type", draft: false, remove: true },
  "jira.set-workflow-scheme-draft-issue-type": { kind: "issue-type", draft: true, remove: false },
  "jira.delete-workflow-scheme-draft-issue-type": { kind: "issue-type", draft: true, remove: true },
  "jira.set-workflow-scheme-workflow": { kind: "workflow", draft: false, remove: false },
  "jira.delete-workflow-scheme-workflow": { kind: "workflow", draft: false, remove: true },
  "jira.set-workflow-scheme-draft-workflow": { kind: "workflow", draft: true, remove: false },
  "jira.delete-workflow-scheme-draft-workflow": { kind: "workflow", draft: true, remove: true },
};
export function isJiraWorkflowSchemeMutation(name: string): name is JiraWorkflowSchemeMutation {
  return Object.hasOwn(WORKFLOW_SCHEME_MUTATIONS, name);
}
export interface WorkflowSchemeMutationReceipt extends JiraMutationReceipt {
  readonly schemeId?: string;
  readonly draftSchemeId?: string;
  readonly workflowSchemeScope?: "scheme" | "draft";
  readonly schemePresent?: boolean;
  readonly workflowName?: string;
  readonly mappingPresent?: boolean;
}
export type WorkflowSchemeFailure = Omit<Extract<JiraMutationAttempt, { ok: false }>, "receipt"> & {
  readonly receipt?: WorkflowSchemeMutationReceipt;
};
export type WorkflowSchemeAttempt =
  WorkflowSchemeFailure | { readonly ok: true; readonly receipt: WorkflowSchemeMutationReceipt };
export type WorkflowSchemeObservation<T> =
  WorkflowSchemeFailure | { readonly ok: true; readonly value: T };
export interface WorkflowSchemeTarget {
  readonly name?: string;
  readonly description?: string;
  readonly defaultWorkflow?: string | null;
  readonly mappings?: readonly WorkflowSchemeMapping[];
}
export interface WorkflowSchemeInput extends Definition {
  readonly operation: JiraWorkflowSchemeMutation;
  readonly actor: string;
  readonly expectedScheme?: WorkflowSchemeSnapshot;
  readonly expectedDraft?: WorkflowSchemeSnapshot;
  readonly target?: WorkflowSchemeTarget;
  readonly issueTypeId?: string;
  readonly workflowName?: string;
  readonly issueTypeIds?: readonly string[];
  readonly defaultMapping?: boolean;
}
export const WORKFLOW_SCHEME_MALFORMED: WorkflowSchemeFailure = {
  ok: false,
  reason: "malformed-payload",
};
export function workflowSchemeRefusal(
  message: string,
  reason: "field-validation" | "conflict" | "unavailable" = "field-validation",
  receipt?: WorkflowSchemeMutationReceipt,
): WorkflowSchemeFailure {
  return {
    ok: false,
    reason,
    detail: { messages: [message] },
    ...(receipt === undefined ? {} : { receipt }),
  };
}
function fields(definition: Definition): ReadonlySet<string> {
  const byKind: Readonly<Record<WorkflowSchemeMutationKind, readonly string[]>> = {
    create: ["name", "description", "defaultWorkflow", "mappings"],
    update: ["name", "description", "defaultWorkflow", "mappings"],
    delete: ["confirmUnverifiedDeletion"],
    "create-draft": [],
    default: [],
    "issue-type": ["issueTypeId"],
    workflow: ["workflowName"],
  };
  const result = new Set(["expectedActorKey", ...byKind[definition.kind]]);
  if (definition.kind !== "create") result.add("expectedScheme");
  if (definition.draft && definition.kind !== "create-draft") result.add("expectedDraft");
  if (!definition.remove && (definition.kind === "default" || definition.kind === "issue-type"))
    result.add("workflowName");
  if (definition.kind === "workflow" && !definition.remove) {
    result.add("issueTypeIds");
    result.add("defaultMapping");
  }
  return result;
}
function targetText(
  args: CatalogJsonObject,
  create: boolean,
): Pick<WorkflowSchemeTarget, "name" | "description"> | undefined {
  const target: { name?: string; description?: string } = {};
  if (create || Object.hasOwn(args, "name")) {
    if (!savedName(args.name)) return undefined;
    target.name = args.name;
  }
  if (create || Object.hasOwn(args, "description")) {
    if (!savedText(args.description, 32768, true)) return undefined;
    target.description = args.description;
  }
  return target;
}
function targetMapping(
  args: CatalogJsonObject,
  create: boolean,
): Pick<WorkflowSchemeTarget, "defaultWorkflow" | "mappings"> | undefined {
  const target: { defaultWorkflow?: string | null; mappings?: readonly WorkflowSchemeMapping[] } =
    {};
  if (create || Object.hasOwn(args, "defaultWorkflow")) {
    if (args.defaultWorkflow !== null && !savedText(args.defaultWorkflow, 255)) return undefined;
    target.defaultWorkflow = args.defaultWorkflow;
  }
  if (create || Object.hasOwn(args, "mappings")) {
    const mappings = workflowSchemeInputMappings(args.mappings);
    if (mappings === undefined) return undefined;
    target.mappings = mappings;
  }
  return target;
}
function metadataTarget(
  args: CatalogJsonObject,
  create: boolean,
): WorkflowSchemeTarget | undefined {
  const text = targetText(args, create);
  const mapping = targetMapping(args, create);
  if (text === undefined || mapping === undefined) return undefined;
  const target = { ...text, ...mapping };
  return Object.keys(target).length === 0 ? undefined : Object.freeze(target);
}
function mappingInput(
  base: WorkflowSchemeInput,
  args: CatalogJsonObject,
): WorkflowSchemeInput | undefined {
  if (base.kind === "issue-type" && !jiraNativeId(args.issueTypeId)) return undefined;
  const needName = base.kind === "workflow" || !base.remove;
  if (needName && !savedText(args.workflowName, 255)) return undefined;
  const selected = {
    ...base,
    ...(jiraNativeId(args.issueTypeId) ? { issueTypeId: args.issueTypeId } : {}),
    ...(savedText(args.workflowName, 255) ? { workflowName: args.workflowName } : {}),
  };
  if (base.kind !== "workflow" || base.remove) return selected;
  const ids = args.issueTypeIds;
  if (
    !Array.isArray(ids) ||
    ids.length > TOOL_CATALOG_LIMITS.maxArrayItems ||
    !ids.every(jiraNativeId) ||
    new Set(ids).size !== ids.length ||
    typeof args.defaultMapping !== "boolean"
  )
    return undefined;
  return {
    ...selected,
    issueTypeIds: Object.freeze([...ids]),
    defaultMapping: args.defaultMapping,
  };
}
function operationInput(
  base: WorkflowSchemeInput,
  args: CatalogJsonObject,
): WorkflowSchemeInput | undefined {
  if (base.kind === "create" || base.kind === "update") {
    const target = metadataTarget(args, base.kind === "create");
    return target === undefined ? undefined : { ...base, target };
  }
  if (base.kind === "delete") return args.confirmUnverifiedDeletion === true ? base : undefined;
  if (base.kind === "create-draft") return base;
  return mappingInput(base, args);
}
export function parseWorkflowSchemeInput(
  operation: JiraWorkflowSchemeMutation,
  args: CatalogJsonObject,
): WorkflowSchemeInput | undefined {
  const definition = WORKFLOW_SCHEME_MUTATIONS[operation];
  if (!savedExactKeys(args, fields(definition)) || !savedText(args.expectedActorKey, 255))
    return undefined;
  if (
    new TextEncoder().encode(JSON.stringify(args)).byteLength > TOOL_CATALOG_LIMITS.maxArgumentBytes
  )
    return undefined;
  const expectedScheme =
    definition.kind === "create"
      ? undefined
      : workflowSchemeInputSnapshot(args.expectedScheme, false);
  const needsDraft = definition.draft && definition.kind !== "create-draft";
  const expectedDraft = needsDraft
    ? workflowSchemeInputSnapshot(args.expectedDraft, true)
    : undefined;
  if (
    (definition.kind !== "create" && expectedScheme === undefined) ||
    (needsDraft && expectedDraft === undefined)
  )
    return undefined;
  return operationInput(
    {
      operation,
      ...definition,
      actor: args.expectedActorKey,
      ...(expectedScheme === undefined ? {} : { expectedScheme }),
      ...(expectedDraft === undefined ? {} : { expectedDraft }),
    },
    args,
  );
}
