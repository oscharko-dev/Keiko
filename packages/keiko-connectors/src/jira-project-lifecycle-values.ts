import {
  isSafeAtlassianIdentifier,
  type JiraProjectLifecycleMutation,
  type JiraMutationAttempt,
  type JiraMutationReceipt,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { jiraOptionSchemeInputSnapshot, type SchemeSnapshot } from "./jira-option-scheme-values.js";
import {
  jiraPermissionSchemeInputSnapshot,
  type PermissionSchemeSnapshot,
} from "./jira-permission-scheme-mutation-values.js";
import { jiraProjectReview, type JiraProjectReview } from "./jira-project-review.js";
import { savedExactKeys, savedText } from "./jira-saved-configuration-values.js";

export {
  JIRA_PROJECT_LIFECYCLE_MUTATIONS,
  type JiraProjectLifecycleMutation,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
export interface ProjectLifecycleReceipt extends JiraMutationReceipt {
  readonly userKey: string;
  readonly projectId: string;
  readonly projectKey: string;
  readonly projectPresent?: false;
  readonly projectArchivedRequested?: boolean;
  readonly projectTypeKey?: string;
  readonly previousSchemeId?: string;
  readonly projectSchemeAssigned?: boolean;
}
export type ProjectLifecycleFailure = Omit<
  Extract<JiraMutationAttempt, { ok: false }>,
  "receipt"
> & { readonly receipt?: ProjectLifecycleReceipt };
export type ProjectLifecycleAttempt =
  ProjectLifecycleFailure | { readonly ok: true; readonly receipt: Record<string, never> };
export type ProjectLifecycleObservation<T> =
  ProjectLifecycleFailure | { readonly ok: true; readonly value: T };
interface Common {
  readonly project: JiraProjectReview;
  readonly actor: string;
}
export type ProjectLifecycleInput = Common &
  (
    | { readonly kind: "delete" | "archive" | "restore" }
    | { readonly kind: "type"; readonly type: string }
    | {
        readonly kind: "permission";
        readonly expected: PermissionSchemeSnapshot;
        readonly target: PermissionSchemeSnapshot;
      }
    | {
        readonly kind: "priority";
        readonly expected: SchemeSnapshot;
        readonly target: SchemeSnapshot;
      }
    | { readonly kind: "priority-remove"; readonly expected: SchemeSnapshot }
  );
export function projectLifecycleFailure(
  value: Extract<JiraMutationAttempt, { ok: false }>,
): ProjectLifecycleFailure {
  return {
    ok: false,
    reason: value.reason,
    ...(value.detail === undefined ? {} : { detail: value.detail }),
    ...(value.violations === undefined ? {} : { violations: value.violations }),
  };
}
export function projectLifecycleRefusal(
  message: string,
  reason: "field-validation" | "conflict" | "unavailable" = "field-validation",
): ProjectLifecycleFailure {
  return { ok: false, reason, detail: { messages: [message] } };
}
const COMMON = ["expectedActorKey", "expectedProject", "confirmUnverifiedConsequences"];
const KEYS: Readonly<Record<JiraProjectLifecycleMutation, ReadonlySet<string>>> = {
  "jira.delete-project": new Set(COMMON),
  "jira.archive-project": new Set(COMMON),
  "jira.restore-project": new Set(COMMON),
  "jira.update-project-type": new Set([...COMMON, "projectTypeKey"]),
  "jira.set-project-permission-scheme": new Set([...COMMON, "expectedScheme", "scheme"]),
  "jira.set-project-priority-scheme": new Set([...COMMON, "expectedScheme", "scheme"]),
  "jira.remove-project-priority-scheme": new Set([...COMMON, "expectedScheme"]),
};
export function isJiraProjectLifecycleMutation(name: string): name is JiraProjectLifecycleMutation {
  return Object.hasOwn(KEYS, name);
}
export function safeSchemeBodyId(id: string, permissionScheme = false): number | undefined {
  const value = Number(id);
  return Number.isSafeInteger(value) &&
    (value > 0 || (permissionScheme && value === 0)) &&
    String(value) === id
    ? value
    : undefined;
}
function schemeInput(
  operation: JiraProjectLifecycleMutation,
  args: CatalogJsonObject,
  common: Common,
): ProjectLifecycleInput | undefined {
  if (operation === "jira.set-project-permission-scheme") {
    const expected = jiraPermissionSchemeInputSnapshot(args.expectedScheme);
    const target = jiraPermissionSchemeInputSnapshot(args.scheme);
    return expected === undefined ||
      target === undefined ||
      safeSchemeBodyId(target.id, true) === undefined
      ? undefined
      : { ...common, kind: "permission", expected, target };
  }
  const expected = jiraOptionSchemeInputSnapshot(args.expectedScheme, "priority");
  if (expected === undefined) return undefined;
  if (operation === "jira.remove-project-priority-scheme")
    return { ...common, kind: "priority-remove", expected };
  const target = jiraOptionSchemeInputSnapshot(args.scheme, "priority");
  return target === undefined || safeSchemeBodyId(target.id) === undefined
    ? undefined
    : { ...common, kind: "priority", expected, target };
}
function commonInput(
  operation: JiraProjectLifecycleMutation,
  args: CatalogJsonObject,
): Common | undefined {
  if (
    !savedExactKeys(args, KEYS[operation]) ||
    !savedText(args.expectedActorKey, 255) ||
    args.confirmUnverifiedConsequences !== true
  )
    return undefined;
  if (
    new TextEncoder().encode(JSON.stringify(args)).byteLength > TOOL_CATALOG_LIMITS.maxArgumentBytes
  )
    return undefined;
  const project = jiraProjectReview(args.expectedProject, true);
  if (project === undefined) return undefined;
  return { project, actor: args.expectedActorKey };
}
export function parseProjectLifecycleInput(
  operation: JiraProjectLifecycleMutation,
  args: CatalogJsonObject,
): ProjectLifecycleInput | undefined {
  const common = commonInput(operation, args);
  if (common === undefined) return undefined;
  switch (operation) {
    case "jira.delete-project":
      return { ...common, kind: "delete" };
    case "jira.archive-project":
      return { ...common, kind: "archive" };
    case "jira.restore-project":
      return { ...common, kind: "restore" };
    case "jira.update-project-type":
      return common.project.projectTypeKey !== undefined &&
        isSafeAtlassianIdentifier(args.projectTypeKey)
        ? { ...common, kind: "type", type: args.projectTypeKey }
        : undefined;
    default:
      return schemeInput(operation, args, common);
  }
}
export function projectLifecycleReceipt(input: ProjectLifecycleInput): ProjectLifecycleReceipt {
  const base = { userKey: input.actor, projectId: input.project.id, projectKey: input.project.key };
  switch (input.kind) {
    case "delete":
      return Object.freeze({ ...base, projectPresent: false });
    case "archive":
    case "restore":
      return Object.freeze({ ...base, projectArchivedRequested: input.kind === "archive" });
    case "type":
      return Object.freeze({ ...base, projectTypeKey: input.type });
    case "priority-remove":
      return Object.freeze({ ...base, schemeId: input.expected.id, projectSchemeAssigned: false });
    default:
      return Object.freeze({
        ...base,
        schemeId: input.target.id,
        previousSchemeId: input.expected.id,
        projectSchemeAssigned: true,
      });
  }
}
