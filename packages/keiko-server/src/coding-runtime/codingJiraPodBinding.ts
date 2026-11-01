import type { ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import {
  JIRA_MANAGED_READ_TOOLS,
  JIRA_MUTATION_OPERATIONS,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type {
  McpServerDefinition,
  McpToolRisk,
} from "@oscharko-dev/keiko-contracts/runtime/mcp-servers";
import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";

import {
  findOwnedJiraPod,
  isReadyJiraPod,
  type JiraLivePodCredential,
  type JiraPodAccessDeps,
} from "../atlassian/jiraPodAccess.js";
import {
  activityErrorFields,
  activityStateLevel,
  definedActivityFields,
  type ActivityActionLine,
} from "../activity-line-fields.js";

/**
 * The Jira Pod a Coding run was started with (owner decision 2026-10-30). The human's explicit
 * choice of a Pod in the composer is the run's Jira read grant; this module owns what that choice
 * means on the server: which Pods can be chosen, the identity a run is bound to, and the one MCP
 * server definition that identity becomes. It reuses the Pod custody Chat already uses and adds no
 * second connector, host or policy layer.
 */

/** The server name the run's Jira tools reach the native policy under: `jira_<tool>`. */
export const CODING_JIRA_SERVER_NAME = "jira";

export type CodingJiraTool =
  (typeof JIRA_MANAGED_READ_TOOLS)[number] | (typeof JIRA_MUTATION_OPERATIONS)[number];
/**
 * A backlog draft (#4178) is reviewed as a tree in Chat; Coding runs create issues one by one. An
 * attachment (#4176) reads a file the Chat's connected folders govern; a Coding run's files are
 * governed by its own workspace authority, which that source does not (yet) consult.
 */
const CODING_JIRA_MUTATIONS = JIRA_MUTATION_OPERATIONS.filter(
  (operation) => operation !== "jira.draft" && operation !== "jira.attach",
);

/** Reads are the human's grant; writes keep following the run's autonomy mode. */
export const CODING_JIRA_TOOL_RISKS: Readonly<Record<string, McpToolRisk>> = Object.freeze(
  Object.fromEntries([
    ...JIRA_MANAGED_READ_TOOLS.map((tool): [string, McpToolRisk] => [tool, "read"]),
    ...CODING_JIRA_MUTATIONS.map((tool): [string, McpToolRisk] => [tool, "write"]),
  ]),
);

/** Identity of the Pod credential the human chose; any change of it revokes the run's binding. */
export interface CodingJiraPodBinding {
  readonly podId: string;
  readonly authenticationGeneration: number;
  readonly verificationRevision: number;
}

export type CodingJiraPodRefusal =
  "unavailable" | "pod-not-found" | "pod-not-ready" | "pod-changed" | "unsupported-runtime";

export type CodingJiraPodResolution =
  | { readonly ok: true; readonly binding: CodingJiraPodBinding }
  | { readonly ok: false; readonly reason: CodingJiraPodRefusal };

export function sameCodingJiraPodBinding(
  left: CodingJiraPodBinding,
  right: CodingJiraPodBinding,
): boolean {
  return (
    left.podId === right.podId &&
    left.authenticationGeneration === right.authenticationGeneration &&
    left.verificationRevision === right.verificationRevision
  );
}

export function bindingOfCredential(credential: JiraLivePodCredential): CodingJiraPodBinding {
  return {
    podId: credential.livePod.podId,
    authenticationGeneration: credential.generation,
    verificationRevision: credential.livePod.verificationRevision,
  };
}

/** The caller's own, ready Pod, or why there is none. Ownership comes from the server principal. */
export function currentCodingJiraPod(
  deps: JiraPodAccessDeps,
  podId: string,
): { readonly ok: true; readonly credential: JiraLivePodCredential } | CodingJiraPodResolutionFail {
  const credential = findOwnedJiraPod(deps, podId);
  if (credential === undefined) return { ok: false, reason: "pod-not-found" };
  return isReadyJiraPod(credential)
    ? { ok: true, credential }
    : { ok: false, reason: "pod-not-ready" };
}
type CodingJiraPodResolutionFail = Extract<CodingJiraPodResolution, { readonly ok: false }>;

/**
 * Whether the Pod is still exactly the one the run was bound to. A replaced token, a re-verification
 * or a deleted Pod changes the identity and ends the binding; nothing re-binds silently.
 */
export function currentBoundCodingJiraPod(
  deps: JiraPodAccessDeps,
  binding: CodingJiraPodBinding,
): { readonly ok: true; readonly credential: JiraLivePodCredential } | CodingJiraPodResolutionFail {
  const current = currentCodingJiraPod(deps, binding.podId);
  if (!current.ok) return current;
  return sameCodingJiraPodBinding(bindingOfCredential(current.credential), binding)
    ? current
    : { ok: false, reason: "pod-changed" };
}

/**
 * The synthetic registry entry the relay and the native policy see for a bound run. It is never
 * written to the operator's registry and never reachable: the placeholder URL only gives the
 * definition a stable identity (its digest names the Pod and its credential generation), while the
 * relay serves the tools from Keiko's managed Jira provider.
 */
export function codingJiraServerDefinition(binding: CodingJiraPodBinding): McpServerDefinition {
  return {
    name: CODING_JIRA_SERVER_NAME,
    description: undefined,
    enabled: true,
    credentialGeneration: `${String(binding.authenticationGeneration)}.${String(binding.verificationRevision)}`,
    transport: { kind: "remote", url: `https://jira-pod.invalid/pods/${binding.podId}` },
    tools: CODING_JIRA_TOOL_RISKS,
  };
}

/** The registry servers a bound run admits: the Pod's tools replace any server of the same name. */
export function withCodingJiraServer(
  servers: readonly McpServerDefinition[],
  binding: CodingJiraPodBinding | undefined,
): readonly McpServerDefinition[] {
  if (binding === undefined) return servers;
  return [
    ...servers.filter((server) => server.name !== CODING_JIRA_SERVER_NAME),
    codingJiraServerDefinition(binding),
  ];
}

type McpServerRegistry = (correlationId: string) => readonly McpServerDefinition[];

/**
 * A run's MCP servers: the operator's registry as it is, and for a run bound to a Pod the Pod's
 * tools, whose reads the human's choice grants. A bound Pod is never dropped, not even when the
 * operator has no registry: the run then has exactly the Pod's server.
 */
export function codingRunMcpServers(
  registry: McpServerRegistry | undefined,
  binding: CodingJiraPodBinding | undefined,
): {
  readonly mcpServers?: McpServerRegistry;
  readonly mcpGrantedServers?: ReadonlySet<string>;
} {
  if (binding === undefined) return registry === undefined ? {} : { mcpServers: registry };
  return {
    mcpServers: (correlationId) => withCodingJiraServer(registry?.(correlationId) ?? [], binding),
    mcpGrantedServers: new Set([CODING_JIRA_SERVER_NAME]),
  };
}

// ─── Activity Log ───────────────────────────────────────────────────────────────────────────────

const JIRA_POD_ACTIONS = ["bind", "call"] as const;
const JIRA_POD_OUTCOMES = ["bound", "refused", "completed", "failed"] as const;
const JIRA_POD_REASONS = [
  "unavailable",
  "pod-not-found",
  "pod-not-ready",
  "pod-changed",
  "unsupported-runtime",
  "tool-failed",
  "internal",
] as const;

const CODING_JIRA_POD_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "coding-runtime.jira-pod",
  category: "security",
  owner: "keiko-server",
  emitter: "coding-runtime.codingJiraPodBinding.recordCodingJiraPod",
  fields: {
    action: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: [...JIRA_POD_ACTIONS],
    },
    outcome: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: [...JIRA_POD_OUTCOMES],
    },
    reason: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: [...JIRA_POD_REASONS],
    },
    // The Jira tool a call reached and its declared risk: closed names, never arguments or results.
    tool: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: [
        "jira.projects",
        "jira.issue-types",
        "jira.create-fields",
        "jira.edit-fields",
        "jira.search",
        "jira.issue",
        "jira.comments",
        "jira.transitions",
        "jira.assignable-users",
        "jira.report",
        "jira.draft-stage",
        "jira.create",
        "jira.edit",
        "jira.assign",
        "jira.comment",
        "jira.transition",
      ],
    },
    risk: { type: "string", dataClass: "closed-enum", required: false, values: ["read", "write"] },
    toolCount: { type: "integer", dataClass: "count", required: false },
    // Issue links a Jira write asked for (#4176): counts of requested, present and missing links.
    linkRequestedCount: { type: "integer", dataClass: "count", required: false },
    linkCreatedCount: { type: "integer", dataClass: "count", required: false },
    linkFailedCount: { type: "integer", dataClass: "count", required: false },
    durationMs: { type: "integer", dataClass: "duration", required: false },
    frames: {
      type: "string-array",
      dataClass: "opaque-id",
      required: false,
      maxLength: 512,
      maxItems: 8,
    },
    causeChain: {
      type: "string-array",
      dataClass: "error-kind",
      required: false,
      maxLength: 128,
      maxItems: 5,
    },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  diagnosticWhen: [
    { field: "outcome", values: ["refused", "failed"] },
    { field: "linkFailedCount", positive: true },
  ],
  failureClasses: ["coding-runtime-jira-pod"],
  proofIds: ["coding-runtime.jira-pod.emitted-line"],
  releaseImpact: "minor",
});

export interface CodingJiraPodLine extends ActivityActionLine<
  (typeof JIRA_POD_ACTIONS)[number],
  (typeof JIRA_POD_OUTCOMES)[number],
  (typeof JIRA_POD_REASONS)[number]
> {
  readonly tool?: CodingJiraTool | undefined;
  readonly risk?: McpToolRisk | undefined;
  readonly toolCount?: number | undefined;
  readonly linkRequestedCount?: number | undefined;
  readonly linkCreatedCount?: number | undefined;
  readonly linkFailedCount?: number | undefined;
}

/** Closed values and counts only: never a Pod id or name, a URL, an issue key or any text. */
export function recordCodingJiraPod(
  activityLog: ServerLogSink | undefined,
  correlationId: string,
  line: CodingJiraPodLine,
): void {
  activityLog?.write(
    activityLogEvent(
      CODING_JIRA_POD_OPERATION,
      {
        correlationId,
        ...activityStateLevel(line.outcome),
      },
      {
        action: line.action,
        outcome: line.outcome,
        ...definedActivityFields(line, [
          "reason",
          "tool",
          "risk",
          "toolCount",
          "linkRequestedCount",
          "linkCreatedCount",
          "linkFailedCount",
          "durationMs",
        ] as const),
        ...activityErrorFields(line),
      },
    ),
  );
}
