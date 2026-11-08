import {
  JIRA_MANAGED_ACTION_TYPES,
  JIRA_MANAGED_READ_TOOLS,
  JIRA_MUTATION_OPERATIONS,
  type AtlassianConnectorActionType,
  type JiraManagedReadToolName,
  type JiraMutationOperation,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { sha256Hex } from "@oscharko-dev/keiko-security";

const READS: ReadonlySet<string> = new Set(JIRA_MANAGED_READ_TOOLS);
const WRITES: ReadonlySet<string> = new Set(JIRA_MUTATION_OPERATIONS);
const ACTIONS: ReadonlySet<string> = new Set(Object.values(JIRA_MANAGED_ACTION_TYPES));
const TOOLS = [...JIRA_MANAGED_READ_TOOLS, ...JIRA_MUTATION_OPERATIONS];
const OTHER_ACTIONS = [
  "sync-space",
  "sync-project",
  "search-issues-live",
  "create-page",
  "update-page",
  "add-page-comment",
] as const;
type ActionClass = "jira-read" | "jira-write" | (typeof OTHER_ACTIONS)[number];

/** A legacy action cannot identify a tool when multiple canonical tools share its policy row. */
export function jiraToolForAction(
  actionType: AtlassianConnectorActionType,
): JiraManagedReadToolName | JiraMutationOperation | undefined {
  const matches = TOOLS.filter((tool) => JIRA_MANAGED_ACTION_TYPES[tool] === actionType);
  return matches.length === 1 ? matches[0] : undefined;
}

function actionClassFor(actionType: AtlassianConnectorActionType): ActionClass | undefined {
  if (ACTIONS.has(actionType)) return READS.has(actionType) ? "jira-read" : "jira-write";
  return OTHER_ACTIONS.find((action) => action === actionType);
}

/** A bounded log taxonomy only; the policy and executor retain the original action identity. */
export function jiraActionLogFields(actionType: AtlassianConnectorActionType): {
  readonly actionType: ActionClass;
  readonly actionTypeDigest: string;
} {
  const kind = actionClassFor(actionType);
  if (kind === undefined) throw new TypeError("Unsupported connector action log identity");
  return { actionType: kind, actionTypeDigest: sha256Hex(actionType) };
}

/** Canonical managed tool identity remains joinable without an unbounded log-name vocabulary. */
export function jiraToolLogFields(tool: JiraManagedReadToolName | JiraMutationOperation): {
  readonly toolClass: "jira-read" | "jira-write";
  readonly toolDigest: string;
} {
  if (!READS.has(tool) && !WRITES.has(tool))
    throw new TypeError("Unsupported Jira tool log identity");
  return { toolClass: READS.has(tool) ? "jira-read" : "jira-write", toolDigest: sha256Hex(tool) };
}
