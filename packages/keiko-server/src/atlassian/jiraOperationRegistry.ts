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
        readonly method: "GET" | "POST" | "PUT";
        readonly apiRoot: "/rest/api/2";
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

const NATIVE: Readonly<
  Record<
    NativeTool,
    readonly ["GET" | "POST" | "PUT", "read" | "write", string, JiraPermissionPolicy]
  >
> = {
  "jira.projects": ["GET", "read", "/project", "visible-projects"],
  "jira.issue-types": [
    "GET",
    "read",
    "/issue/createmeta/{projectIdOrKey}/issuetypes",
    "current-create-metadata",
  ],
  "jira.create-fields": [
    "GET",
    "read",
    "/issue/createmeta/{projectIdOrKey}/issuetypes/{issueTypeId}",
    "current-create-metadata",
  ],
  "jira.edit-fields": ["GET", "read", "/issue/{issueIdOrKey}/editmeta", "current-edit-metadata"],
  "jira.search": ["GET", "read", "/search", "visible-issues"],
  "jira.issue": ["GET", "read", "/issue/{issueIdOrKey}", "visible-issues"],
  "jira.comments": ["GET", "read", "/issue/{issueIdOrKey}/comment", "visible-issues"],
  "jira.transitions": ["GET", "read", "/issue/{issueIdOrKey}/transitions", "current-transitions"],
  "jira.assignable-users": ["GET", "read", "/user/assignable/search", "current-assignable-users"],
  "jira.create": ["POST", "write", "/issue", "current-create-metadata"],
  "jira.edit": ["PUT", "write", "/issue/{issueIdOrKey}", "current-edit-metadata"],
  "jira.assign": ["PUT", "write", "/issue/{issueIdOrKey}/assignee", "current-assignable-users"],
  "jira.comment": ["POST", "write", "/issue/{issueIdOrKey}/comment", "comment-create-and-readback"],
  "jira.transition": ["POST", "write", "/issue/{issueIdOrKey}/transitions", "current-transitions"],
  "jira.attach": [
    "POST",
    "write",
    "/issue/{issueIdOrKey}/attachments",
    "attachment-create-and-readback",
  ],
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
    const [method, effect, pathTemplate, permissionPolicy] = NATIVE[name];
    return {
      tool: name,
      kind: "native",
      deployment: "data-center",
      identity: `${method} /rest/api/2${pathTemplate}`,
      method,
      apiRoot: "/rest/api/2",
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
