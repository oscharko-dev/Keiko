import {
  JIRA_MANAGED_ACTION_TYPES,
  type JiraManagedReadToolName,
  type JiraMutationOperation,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { deepFreeze } from "@oscharko-dev/keiko-contracts/runtime/deep-freeze";
import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
  type CatalogJsonValue,
  type ToolDescriptor,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpToolDeclaration } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security/hashing";
import { createToolDescriptor, createToolRef } from "@oscharko-dev/keiko-tool-catalog";

export type JiraOperationTool = JiraManagedReadToolName | JiraMutationOperation;
type CompositeTool = "jira.report" | "jira.draft-stage" | "jira.draft";
type NativeTool = Exclude<JiraOperationTool, CompositeTool>;
type JiraOperationEffect = "remote-read" | "remote-write" | "local-report" | "local-draft";
type JiraPermissionPolicy =
  | "visible-projects"
  | "admin-workflow-schemes"
  | "admin-issue-type-schemes"
  | "visible-screen-configuration"
  | "current-project-metadata"
  | "native-project-key-validation"
  | "explicit-project-permissions"
  | "accessible-project-type"
  | "project-create-and-readback"
  | "project-update-and-readback"
  | "visible-boards"
  | "visible-sprints"
  | "visible-epics"
  | "visible-filters"
  | "board-create-and-readback"
  | "sprint-create-and-readback"
  | "sprint-update-and-readback"
  | "issue-membership-and-readback"
  | "epic-update-and-readback"
  | "visible-components"
  | "attachment-availability"
  | "visible-attachments"
  | "visible-avatars"
  | "visible-dashboards"
  | "visible-filter-permissions"
  | "authenticated-user-preferences"
  | "visible-comments"
  | "visible-link-types"
  | "visible-issue-links"
  | "visible-worklogs"
  | "visible-watchers"
  | "visible-voters"
  | "current-user-watch-and-readback"
  | "current-user-vote-and-readback"
  | "worklog-create-and-readback"
  | "worklog-update-and-readback"
  | "comment-update-and-readback"
  | "comment-delete-and-absence"
  | "attachment-delete-and-absence"
  | "worklog-delete-and-absence"
  | "visible-versions"
  | "component-create-and-readback"
  | "component-update-and-readback"
  | "version-create-and-readback"
  | "version-update-and-readback"
  | "current-create-metadata"
  | "current-edit-metadata"
  | "visible-issues"
  | "current-transitions"
  | "current-assignable-users"
  | "comment-create-and-readback"
  | "attachment-create-and-readback"
  | "composed-current-metadata";

interface OperationDefinitionBase {
  readonly tool: JiraOperationTool;
  readonly deployment: "data-center";
  readonly identity: string;
  readonly effects: readonly JiraOperationEffect[];
  /** Existing Keiko policy owner; the registry never grants permissions. */
  readonly authorityAction: (typeof JIRA_MANAGED_ACTION_TYPES)[JiraOperationTool];
  /** Existing handler metadata plus Jira's response remain the permission decision. */
  readonly permissionPolicy: JiraPermissionPolicy;
}
export type JiraOperationDefinition = OperationDefinitionBase &
  (
    | {
        readonly kind: "native";
        readonly method: "GET" | "POST" | "PUT" | "DELETE";
        readonly apiRoot: "/rest/api/2" | "/rest/agile/1.0";
        readonly pathTemplate: string;
        /** Create/edit may add the already-approved bounded issue links through their owner. */
        readonly continuationPolicy: "none" | "approved-issue-links";
      }
    | { readonly kind: "composite"; readonly members: readonly JiraOperationTool[] }
  );
export interface JiraOperationBinding extends CatalogJsonObject {
  readonly identity: string;
  readonly contractDigest: string;
}
export interface JiraOperationContract {
  readonly definition: JiraOperationDefinition;
  readonly declaration: ManagedMcpToolDeclaration;
  readonly binding: JiraOperationBinding;
}

type JiraApiRoot = "/rest/api/2" | "/rest/agile/1.0";
type NativeSpecification = readonly [
  "GET" | "POST" | "PUT" | "DELETE",
  "read" | "write",
  string,
  JiraPermissionPolicy,
  JiraApiRoot?,
];
function read(
  path: string,
  permissionPolicy: JiraPermissionPolicy,
  root: JiraApiRoot = "/rest/api/2",
): NativeSpecification {
  return ["GET", "read", path, permissionPolicy, root];
}
function write(
  method: "POST" | "PUT" | "DELETE",
  path: string,
  permissionPolicy: JiraPermissionPolicy,
  root: JiraApiRoot = "/rest/api/2",
): NativeSpecification {
  return [method, "write", path, permissionPolicy, root];
}
function issueRead(path: string, root: JiraApiRoot = "/rest/api/2"): NativeSpecification {
  return ["GET", "read", path, "visible-issues", root];
}
const NATIVE: Readonly<Record<NativeTool, NativeSpecification>> = {
  "jira.issue-type-schemes": read("/issuetypescheme", "admin-issue-type-schemes"),
  "jira.issue-type-scheme": read("/issuetypescheme/{schemeId}", "admin-issue-type-schemes"),
  "jira.issue-type-scheme-projects": read(
    "/issuetypescheme/{schemeId}/associations",
    "admin-issue-type-schemes",
  ),
  "jira.workflow-scheme": read("/workflowscheme/{id}", "admin-workflow-schemes"),
  "jira.workflow-scheme-default": read("/workflowscheme/{id}/default", "admin-workflow-schemes"),
  "jira.workflow-scheme-draft": read("/workflowscheme/{id}/draft", "admin-workflow-schemes"),
  "jira.workflow-scheme-draft-default": read(
    "/workflowscheme/{id}/draft/default",
    "admin-workflow-schemes",
  ),
  "jira.workflow-scheme-issue-type": read(
    "/workflowscheme/{id}/issuetype/{issueType}",
    "admin-workflow-schemes",
  ),
  "jira.workflow-scheme-draft-issue-type": read(
    "/workflowscheme/{id}/draft/issuetype/{issueType}",
    "admin-workflow-schemes",
  ),
  "jira.workflow-scheme-workflows": read("/workflowscheme/{id}/workflow", "admin-workflow-schemes"),
  "jira.workflow-scheme-draft-workflows": read(
    "/workflowscheme/{id}/draft/workflow",
    "admin-workflow-schemes",
  ),
  "jira.screen-tabs": read("/screens/{screenId}/tabs", "visible-screen-configuration"),
  "jira.screen-tab-fields": read(
    "/screens/{screenId}/tabs/{tabId}/fields",
    "visible-screen-configuration",
  ),
  "jira.screen-available-fields": read(
    "/screens/{screenId}/availableFields",
    "visible-screen-configuration",
  ),
  "jira.watchers": read("/issue/{issueIdOrKey}/watchers", "visible-watchers"),
  "jira.votes": read("/issue/{issueIdOrKey}/votes", "visible-voters"),
  "jira.watch": write("POST", "/issue/{issueIdOrKey}/watchers", "current-user-watch-and-readback"),
  "jira.unwatch": write(
    "DELETE",
    "/issue/{issueIdOrKey}/watchers",
    "current-user-watch-and-readback",
  ),
  "jira.vote": write("POST", "/issue/{issueIdOrKey}/votes", "current-user-vote-and-readback"),
  "jira.unvote": write("DELETE", "/issue/{issueIdOrKey}/votes", "current-user-vote-and-readback"),
  "jira.create-worklog": write(
    "POST",
    "/issue/{issueIdOrKey}/worklog",
    "worklog-create-and-readback",
  ),
  "jira.update-worklog": write(
    "PUT",
    "/issue/{issueIdOrKey}/worklog/{id}",
    "worklog-update-and-readback",
  ),
  "jira.delete-worklog": write(
    "DELETE",
    "/issue/{issueIdOrKey}/worklog/{id}",
    "worklog-delete-and-absence",
  ),
  "jira.delete-attachment": write("DELETE", "/attachment/{id}", "attachment-delete-and-absence"),
  "jira.attachment-settings": read("/attachment/meta", "attachment-availability"),
  "jira.attachment": read("/attachment/{id}", "visible-attachments"),
  "jira.attachment-archive": read("/attachment/{id}/expand/raw", "visible-attachments"),
  "jira.attachment-archive-summary": read("/attachment/{id}/expand/human", "visible-attachments"),
  "jira.system-avatars": read("/avatar/{type}/system", "visible-avatars"),
  "jira.project-avatars": read("/project/{projectIdOrKey}/avatars", "visible-avatars"),
  "jira.user-avatars": read("/user/avatars", "visible-avatars"),
  "jira.avatars": read("/universal_avatar/type/{type}/owner/{owningObjectId}", "visible-avatars"),
  "jira.dashboards": read("/dashboard", "visible-dashboards"),
  "jira.dashboard": read("/dashboard/{id}", "visible-dashboards"),
  "jira.filter-share-scope": read("/filter/defaultShareScope", "authenticated-user-preferences"),
  "jira.filter-permissions": read("/filter/{id}/permission", "visible-filter-permissions"),
  "jira.filter-permission": read(
    "/filter/{id}/permission/{permissionId}",
    "visible-filter-permissions",
  ),
  "jira.get-comment": read("/issue/{issueIdOrKey}/comment/{id}", "visible-comments"),
  "jira.update-comment": write(
    "PUT",
    "/issue/{issueIdOrKey}/comment/{id}",
    "comment-update-and-readback",
  ),
  "jira.delete-comment": write(
    "DELETE",
    "/issue/{issueIdOrKey}/comment/{id}",
    "comment-delete-and-absence",
  ),
  "jira.link-types": read("/issueLinkType", "visible-link-types"),
  "jira.issue-link": read("/issueLink/{linkId}", "visible-issue-links"),
  "jira.worklogs": read("/issue/{issueIdOrKey}/worklog", "visible-worklogs"),
  "jira.worklog": read("/issue/{issueIdOrKey}/worklog/{id}", "visible-worklogs"),
  "jira.components": read("/project/{projectIdOrKey}/components", "visible-components"),
  "jira.component": read("/component/{id}", "visible-components"),
  "jira.versions": read("/project/{projectIdOrKey}/versions", "visible-versions"),
  "jira.version": read("/version/{id}", "visible-versions"),
  "jira.create-component": write("POST", "/component", "component-create-and-readback"),
  "jira.update-component": write("PUT", "/component/{id}", "component-update-and-readback"),
  "jira.create-version": write("POST", "/version", "version-create-and-readback"),
  "jira.update-version": write("PUT", "/version/{id}", "version-update-and-readback"),
  "jira.boards": read("/board", "visible-boards", "/rest/agile/1.0"),
  "jira.board": read("/board/{boardId}", "visible-boards", "/rest/agile/1.0"),
  "jira.board-configuration": read(
    "/board/{boardId}/configuration",
    "visible-boards",
    "/rest/agile/1.0",
  ),
  "jira.board-backlog": issueRead("/board/{boardId}/backlog", "/rest/agile/1.0"),
  "jira.board-issues": issueRead("/board/{boardId}/issue", "/rest/agile/1.0"),
  "jira.board-epics": read("/board/{boardId}/epic", "visible-epics", "/rest/agile/1.0"),
  "jira.epic": read("/epic/{epicIdOrKey}", "visible-epics", "/rest/agile/1.0"),
  "jira.epic-issues": issueRead("/epic/{epicIdOrKey}/issue", "/rest/agile/1.0"),
  "jira.sprints": read("/board/{boardId}/sprint", "visible-sprints", "/rest/agile/1.0"),
  "jira.sprint": read("/sprint/{sprintId}", "visible-sprints", "/rest/agile/1.0"),
  "jira.sprint-issues": issueRead("/sprint/{sprintId}/issue", "/rest/agile/1.0"),
  "jira.filter": read("/filter/{id}", "visible-filters"),
  "jira.favourite-filters": read("/filter/favourite", "visible-filters"),
  "jira.board-create": write("POST", "/board", "board-create-and-readback", "/rest/agile/1.0"),
  "jira.sprint-create": write("POST", "/sprint", "sprint-create-and-readback", "/rest/agile/1.0"),
  "jira.sprint-update": write(
    "POST",
    "/sprint/{sprintId}",
    "sprint-update-and-readback",
    "/rest/agile/1.0",
  ),
  "jira.sprint-move-issues": write(
    "POST",
    "/sprint/{sprintId}/issue",
    "issue-membership-and-readback",
    "/rest/agile/1.0",
  ),
  "jira.backlog-move-issues": write(
    "POST",
    "/backlog/issue",
    "issue-membership-and-readback",
    "/rest/agile/1.0",
  ),
  "jira.epic-update": write(
    "POST",
    "/epic/{epicIdOrKey}",
    "epic-update-and-readback",
    "/rest/agile/1.0",
  ),
  "jira.epic-move-issues": write(
    "POST",
    "/epic/{epicIdOrKey}/issue",
    "issue-membership-and-readback",
    "/rest/agile/1.0",
  ),
  "jira.projects": read("/project", "visible-projects"),
  "jira.project": read("/project/{projectIdOrKey}", "current-project-metadata"),
  "jira.validate-project-key": read("/projectvalidate/key", "native-project-key-validation"),
  "jira.project-permissions": read("/mypermissions", "explicit-project-permissions"),
  "jira.project-type": read("/project/type/{projectTypeKey}/accessible", "accessible-project-type"),
  "jira.create-project": write("POST", "/project", "project-create-and-readback"),
  "jira.update-project": write("PUT", "/project/{projectIdOrKey}", "project-update-and-readback"),
  "jira.issue-types": read(
    "/issue/createmeta/{projectIdOrKey}/issuetypes",
    "current-create-metadata",
  ),
  "jira.create-fields": read(
    "/issue/createmeta/{projectIdOrKey}/issuetypes/{issueTypeId}",
    "current-create-metadata",
  ),
  "jira.edit-fields": read("/issue/{issueIdOrKey}/editmeta", "current-edit-metadata"),
  "jira.search": issueRead("/search"),
  "jira.issue": issueRead("/issue/{issueIdOrKey}"),
  "jira.comments": issueRead("/issue/{issueIdOrKey}/comment"),
  "jira.transitions": read("/issue/{issueIdOrKey}/transitions", "current-transitions"),
  "jira.assignable-users": read("/user/assignable/search", "current-assignable-users"),
  "jira.create": write("POST", "/issue", "current-create-metadata"),
  "jira.edit": write("PUT", "/issue/{issueIdOrKey}", "current-edit-metadata"),
  "jira.assign": write("PUT", "/issue/{issueIdOrKey}/assignee", "current-assignable-users"),
  "jira.comment": write("POST", "/issue/{issueIdOrKey}/comment", "comment-create-and-readback"),
  "jira.transition": write("POST", "/issue/{issueIdOrKey}/transitions", "current-transitions"),
  "jira.attach": write(
    "POST",
    "/issue/{issueIdOrKey}/attachments",
    "attachment-create-and-readback",
  ),
};
const COMPOSITES: Readonly<
  Record<
    CompositeTool,
    { readonly members: readonly JiraOperationTool[]; readonly local: JiraOperationEffect }
  >
> = {
  "jira.report": {
    members: ["jira.search", "jira.issue-types", "jira.create-fields"],
    local: "local-report",
  },
  "jira.draft-stage": { members: ["jira.create-fields"], local: "local-draft" },
  "jira.draft": { members: ["jira.create", "jira.edit"], local: "local-draft" },
};

function definitionFor(tool: string): JiraOperationDefinition {
  if (Object.hasOwn(NATIVE, tool)) {
    const name = tool as NativeTool;
    const [method, effect, pathTemplate, permissionPolicy, apiRoot = "/rest/api/2"] = NATIVE[name];
    return {
      tool: name,
      kind: "native",
      deployment: "data-center",
      identity: `${method} ${apiRoot}${pathTemplate}`,
      method,
      apiRoot,
      pathTemplate,
      effects: effect === "read" ? ["remote-read"] : ["remote-read", "remote-write"],
      authorityAction: JIRA_MANAGED_ACTION_TYPES[name],
      permissionPolicy,
      continuationPolicy:
        name === "jira.create" || name === "jira.edit" ? "approved-issue-links" : "none",
    };
  }
  if (!Object.hasOwn(COMPOSITES, tool)) throw new TypeError("Unknown Jira operation");
  const name = tool as CompositeTool;
  const composite = COMPOSITES[name];
  return {
    tool: name,
    kind: "composite",
    deployment: "data-center",
    identity: `composite:${name}`,
    members: composite.members,
    effects:
      name === "jira.draft"
        ? ["remote-read", "remote-write", composite.local]
        : ["remote-read", composite.local],
    authorityAction: JIRA_MANAGED_ACTION_TYPES[name],
    permissionPolicy: "composed-current-metadata",
  };
}

const BINDING_SCHEMA = {
  type: "object",
  properties: {
    identity: { type: "string", maxLength: 192 },
    contractDigest: { type: "string", pattern: "^[a-f0-9]{64}$", maxLength: 64 },
  },
  required: ["identity", "contractDigest"],
  additionalProperties: false,
};
// Native identities contain ASCII only. Existing ceiling-sized producers already reserve 4 KiB.
const BINDING_RESULT_BYTES = 384;

function schemaObject(value: CatalogJsonValue | undefined): value is CatalogJsonObject {
  return (
    value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value)
  );
}
function schemaRequired(value: CatalogJsonValue | undefined): value is readonly string[] {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === "string");
}

function resultDescriptor(descriptor: ToolDescriptor): ToolDescriptor {
  const { descriptorDigest: _digest, ...original } = descriptor;
  const properties = descriptor.resultSchema.properties;
  const required = descriptor.resultSchema.required;
  if (!schemaObject(properties) || !schemaRequired(required))
    throw new TypeError("Jira result must have an explicit object schema");
  return createToolDescriptor({
    ...original,
    toolRef: createToolRef(descriptor.toolRef.canonicalId, descriptor.toolRef.contractVersion + 1),
    resultSchema: {
      ...descriptor.resultSchema,
      properties: { ...properties, operationBinding: BINDING_SCHEMA },
      required: [...required, "operationBinding"],
    },
    bounds: {
      ...descriptor.bounds,
      maxResultBytes: Math.min(
        TOOL_CATALOG_LIMITS.maxResultBytes,
        descriptor.bounds.maxResultBytes + BINDING_RESULT_BYTES,
      ),
    },
  });
}

/** Pure authoring: existing typed schemas, effects and bounds remain owned by their declarations. */
export function createJiraOperationContract(
  declaration: ManagedMcpToolDeclaration,
  memberContract?: (tool: JiraOperationTool) => JiraOperationContract | undefined,
): JiraOperationContract {
  const definition = definitionFor(declaration.name);
  if (declaration.risk !== (definition.effects.includes("remote-write") ? "write" : "read"))
    throw new TypeError("Jira operation effect disagrees with its declaration");
  const projection = resultDescriptor(declaration.descriptor);
  const members =
    definition.kind === "native"
      ? []
      : definition.members.map((tool) => {
          const member = memberContract?.(tool);
          if (member?.definition.tool !== tool)
            throw new TypeError("Missing Jira composite member");
          return member.binding;
        });
  const binding = {
    identity: definition.identity,
    contractDigest: sha256Hex(
      canonicalise({
        domain: "keiko.jira-operation-contract.v1",
        definition,
        members,
        descriptorDigest: projection.descriptorDigest,
      }),
    ),
  };
  const { descriptorDigest: _digest, ...projected } = projection;
  const descriptor = createToolDescriptor({
    ...projected,
    policyReferences: [
      ...projection.policyReferences,
      `jira-operation-contract.${binding.contractDigest}`,
    ],
  });
  return deepFreeze({ definition, binding, declaration: { ...declaration, descriptor } });
}

/** Native contracts are bound first so a composite also pins its constituents' typed contracts. */
export function createJiraOperationContracts(
  declarations: readonly ManagedMcpToolDeclaration[],
): readonly JiraOperationContract[] {
  if (new Set(declarations.map((item) => item.name)).size !== declarations.length)
    throw new TypeError("Duplicate Jira operation declaration");
  const entries = new Map<string, JiraOperationContract>();
  for (const declaration of declarations) {
    if (definitionFor(declaration.name).kind === "native")
      entries.set(declaration.name, createJiraOperationContract(declaration));
  }
  for (const declaration of declarations) {
    if (definitionFor(declaration.name).kind === "composite")
      entries.set(
        declaration.name,
        createJiraOperationContract(declaration, (tool) => entries.get(tool)),
      );
  }
  return Object.freeze(
    declarations.map((declaration) => {
      const entry = entries.get(declaration.name);
      if (entry === undefined) throw new TypeError("Missing Jira operation contract");
      return entry;
    }),
  );
}

function bindingObject(value: unknown): value is object {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length === 2 && keys.every((key) => key === "identity" || key === "contractDigest");
}

/** Closed persisted snapshot shape; this does not admit execution against the current contract. */
export function isJiraOperationBinding(value: unknown): value is JiraOperationBinding {
  if (!bindingObject(value)) return false;
  const identity: unknown = Object.getOwnPropertyDescriptor(value, "identity")?.value;
  const digest: unknown = Object.getOwnPropertyDescriptor(value, "contractDigest")?.value;
  return (
    typeof identity === "string" &&
    /^[\u0020-\u007e]{1,192}$/u.test(identity) &&
    typeof digest === "string" &&
    /^[a-f0-9]{64}$/u.test(digest)
  );
}

/** The optional snapshot preserves historical transcript hashes; it never grants execution. */
export function jiraOperationActionDigest(
  operation: JiraMutationOperation,
  argumentsDigest: string,
  operationBinding?: JiraOperationBinding,
  sourceDigest?: string,
): string {
  return sha256Hex(
    canonicalise({
      operation,
      argumentsDigest,
      ...(operationBinding === undefined ? {} : { operationBinding }),
      ...(sourceDigest === undefined ? {} : { sourceDigest }),
    }),
  );
}

/** Exact server snapshot; callers cannot supply URLs, extra authority fields or an old digest. */
export function matchesJiraOperationBinding(
  contract: JiraOperationContract,
  value: unknown,
): value is JiraOperationBinding {
  return (
    isJiraOperationBinding(value) &&
    value.identity === contract.binding.identity &&
    value.contractDigest === contract.binding.contractDigest
  );
}
