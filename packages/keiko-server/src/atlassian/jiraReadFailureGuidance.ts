import { isJiraReleaseScopeRefusal } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type {
  CatalogJsonObject,
  CatalogJsonValue,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpToolResult } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import type { JiraOperationContract } from "./jiraOperationRegistry.js";

// #4357: the one rule that turns a failed Jira read into text a model can act on. A native error
// reaches the model as its closed `reason` (from the HTTP status), Jira's own sanitized `messages`
// when Jira wrote any, and one `guidance` sentence naming the class and what to change. The
// sentences are fixed English built from closed facts: the closed reason, the NAMES of the arguments
// the tool declares and the call carried, and the registry's administration fact. They never hold a
// body, a URL, a secret or a value the model supplied.

/** The model-visible classes; the activity log records the same closed word. */
export type JiraReadFailureClass =
  | "permission"
  | "administration"
  | "argument"
  | "not-found"
  | "conflict"
  | "unavailable"
  | "unauthenticated"
  | "unsupported"
  | "unreadable";

export interface JiraReadFailureFacts {
  readonly tool: string;
  readonly reason: string;
  /** Names of declared arguments the call carried; anything else is dropped. */
  readonly argumentNames: readonly string[];
  /** The registry's explicit fact that a normal Jira user cannot read this operation. */
  readonly administration: boolean;
  /** Whether the result carries `messages`: only then may a sentence refer to them. */
  readonly explained: boolean;
}
export interface JiraReadFailureGuidance {
  readonly class: JiraReadFailureClass;
  readonly text: string;
}

/** One guidance sentence stays far below every result schema bound of a Jira read. */
export const JIRA_READ_FAILURE_GUIDANCE_MAX_BYTES = 380;

const ARGUMENT_NAME = /^[A-Za-z][A-Za-z0-9]{0,39}$/u;
const MAX_NAMES = 6;
/**
 * The identifier arguments a model fills from another read, each with the registered tool that
 * lists valid values. A closed table: a new entry names an existing tool or the scan test fails.
 */
export const JIRA_READ_FAILURE_READERS: Readonly<Record<string, string>> = {
  projectKey: "jira.projects",
  projectKeys: "jira.projects",
  projectIdOrKey: "jira.projects",
  issueTypeId: "jira.issue-types",
  issueKey: "jira.search",
  fieldId: "jira.fields",
};
const CLASSES: Readonly<Record<string, JiraReadFailureClass>> = {
  "permission-denied": "permission",
  "field-validation": "argument",
  "invalid-input": "argument",
  "not-found": "not-found",
  conflict: "conflict",
  "rate-limited": "unavailable",
  timeout: "unavailable",
  unavailable: "unavailable",
  "auth-failed": "unauthenticated",
  "auth-unverified": "unauthenticated",
  "unsupported-deployment": "unsupported",
  "bounds-exceeded": "unreadable",
  "malformed-payload": "unreadable",
};

/** The closed reason words this rule answers, for tests and the log vocabulary check. */
export const JIRA_READ_FAILURE_REASONS: readonly string[] = Object.keys(CLASSES);

const FIXED: Readonly<Record<Exclude<JiraReadFailureClass, "argument" | "not-found">, string>> = {
  permission:
    "This read was not permitted for this Jira account or connection. Do not retry it. Tell the user in plain language that this account may not read this.",
  administration:
    "This Jira operation needs Jira administration permission, which this account does not have. Do not retry it. Tell the user in plain language that a Jira administrator has to read or share this.",
  conflict:
    "Jira reported a conflict with the current state. Read the current state again, then call this tool once more. If it persists, tell the user in plain language.",
  unavailable:
    "Jira could not answer now: it is busy, slow or unavailable. Wait, then call this tool once more. If it fails again, tell the user in plain language that Jira did not answer.",
  unauthenticated:
    "Jira did not accept the sign-in of this connection. Do not retry it. Tell the user in plain language to check the Jira connection.",
  unsupported:
    "This operation is not available for this Jira deployment. Do not retry it. Use another tool or tell the user in plain language.",
  unreadable:
    "Jira answered, but Keiko could not read or fit the answer. Narrow the request, for example a smaller maxResults or fewer fields, then call this tool once more. If it fails again, tell the user in plain language.",
};

function carried(names: readonly string[]): readonly string[] {
  return [...new Set(names.filter((name) => ARGUMENT_NAME.test(name)))].slice(0, MAX_NAMES);
}
function readerHints(names: readonly string[]): string {
  const byReader = new Map<string, string[]>();
  for (const name of names) {
    const reader = JIRA_READ_FAILURE_READERS[name];
    if (reader !== undefined) byReader.set(reader, [...(byReader.get(reader) ?? []), name]);
  }
  if (byReader.size === 0) return "Check the arguments you passed and use values Jira lists.";
  const hints = [...byReader].map(([reader, forNames]) => `${reader} for ${forNames.join(", ")}`);
  return `Check each identifier against what Jira lists: ${hints.join("; ")}.`;
}
function argumentHead(facts: JiraReadFailureFacts, names: readonly string[], list: string): string {
  const { reason } = facts;
  if (reason === "invalid-input") {
    const repair = facts.explained
      ? "Fix it as messages say."
      : "Check the input schema of this tool.";
    return `Keiko refused this read before sending it to Jira: an argument is missing, unknown or malformed${list}. ${repair}`;
  }
  if (reason === "not-found")
    return `Jira did not find something this call named${list}. ${readerHints(names)}`;
  return `Jira rejected an argument of this call${list}. ${readerHints(names)}`;
}
function argumentSentence(
  facts: JiraReadFailureFacts,
  names: readonly string[],
  withList: boolean,
): string {
  const list = withList && names.length > 0 ? ` (arguments: ${names.join(", ")})` : "";
  return `${argumentHead(facts, names, list)} Then call this tool once more. If it is refused again, tell the user in plain language what is wrong.`;
}
function bounded(build: (withList: boolean) => string): string {
  const full = build(true);
  return Buffer.byteLength(full) <= JIRA_READ_FAILURE_GUIDANCE_MAX_BYTES ? full : build(false);
}

/** The one sentence for a closed failure reason, or nothing for a word this rule does not know. */
export function jiraReadFailureGuidance(
  facts: JiraReadFailureFacts,
): JiraReadFailureGuidance | undefined {
  const base = CLASSES[facts.reason];
  if (base === undefined) return undefined;
  const failureClass = base === "permission" && facts.administration ? "administration" : base;
  if (failureClass === "argument" || failureClass === "not-found") {
    const names = carried(facts.argumentNames);
    return {
      class: failureClass,
      text: bounded((withList) => argumentSentence(facts, names, withList)),
    };
  }
  return { class: failureClass, text: FIXED[failureClass] };
}

function isObject(value: CatalogJsonValue | undefined): value is CatalogJsonObject {
  return (
    value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value)
  );
}
function propertyNames(schema: CatalogJsonValue | undefined): readonly string[] {
  if (!isObject(schema)) return [];
  const { properties } = schema;
  return isObject(properties) ? Object.keys(properties) : [];
}

/** A failed native read that has not been explained yet: the only result this rule may extend. */
function isUnexplainedReadFailure(
  contract: JiraOperationContract | undefined,
  result: ManagedMcpToolResult,
): contract is JiraOperationContract {
  const { data } = result;
  return (
    contract?.definition.kind === "native" &&
    !contract.definition.effects.includes("remote-write") &&
    result.isError === true &&
    data.outcome === "failed" &&
    typeof data.reason === "string" &&
    data.guidance === undefined &&
    // The release switch's own refusal has its sentence; no class of Jira refusal describes it.
    !isJiraReleaseScopeRefusal(contract.definition.tool, data.messages)
  );
}

/**
 * A failed native read gains its guidance; every other result, and a result that already carries
 * its own guidance, is returned unchanged. The tool's own contract decides whether it is a read, so
 * Jira response content can never choose the class or the sentence.
 */
export function withJiraReadFailureGuidance(
  contract: JiraOperationContract | undefined,
  args: CatalogJsonObject,
  result: ManagedMcpToolResult,
): { readonly result: ManagedMcpToolResult; readonly class?: JiraReadFailureClass } {
  const { data } = result;
  if (!isUnexplainedReadFailure(contract, result) || typeof data.reason !== "string")
    return { result };
  const declared = new Set(propertyNames(contract.declaration.descriptor.inputSchema));
  const guidance = jiraReadFailureGuidance({
    tool: contract.definition.tool,
    reason: data.reason,
    argumentNames: Object.keys(args).filter((name) => declared.has(name)),
    administration: "administration" in contract.definition,
    explained: Array.isArray(data.messages) && data.messages.length > 0,
  });
  return guidance === undefined
    ? { result }
    : { result: { ...result, data: { ...data, guidance: guidance.text } }, class: guidance.class };
}
