import {
  isSafeAtlassianIdentifier,
  isSafeAtlassianConnectorBaseUrl,
  type JiraMutationAttempt,
  type JiraMutationReceipt,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpToolResult } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { asRecord } from "./atlassian-sync-classify.js";
import { boundJiraReadResult } from "./jira-managed-issue-reads.js";
import { jiraReadFailure, localJiraPage, projectJiraCollection } from "./jira-managed-metadata.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { readJiraMutationIssue } from "./jira-mutation-confirmation.js";
import { dispatchFailure, JiraAcknowledgedMutationError } from "./jira-mutation-failure.js";
import { jiraNativeId, jiraNativeText } from "./jira-native-values.js";
import { jiraResourceSelfMatches } from "./jira-resource-self.js";

export const JIRA_PARTICIPATION_READS = ["jira.watchers", "jira.votes"] as const;
export const JIRA_PARTICIPATION_WRITES = [
  "jira.watch",
  "jira.unwatch",
  "jira.vote",
  "jira.unvote",
] as const;
type Read = (typeof JIRA_PARTICIPATION_READS)[number];
type Write = (typeof JIRA_PARTICIPATION_WRITES)[number];
const WRITE_STATE: Readonly<Record<Write, { readonly watch: boolean; readonly desired: boolean }>> =
  {
    "jira.watch": { watch: true, desired: true },
    "jira.unwatch": { watch: true, desired: false },
    "jira.vote": { watch: false, desired: true },
    "jira.unvote": { watch: false, desired: false },
  };
type Failure = Extract<JiraMutationAttempt, { ok: false }>;
interface Selection {
  readonly issueKey: string;
  readonly startAt: number;
  readonly maxResults: number;
}
interface View {
  readonly count: number;
  readonly state: boolean | undefined;
  readonly items: readonly CatalogJsonObject[];
  readonly complete: boolean;
}
interface Binding {
  readonly ok: true;
  readonly issueId: string;
  readonly issueKey: string;
}
const MALFORMED: Failure = { ok: false, reason: "malformed-payload" };
const CONFLICT: Failure = { ok: false, reason: "conflict" };
export function isJiraParticipationRead(name: string): name is Read {
  return JIRA_PARTICIPATION_READS.some((value) => value === name);
}
export function isJiraParticipationMutation(name: string): name is Write {
  return JIRA_PARTICIPATION_WRITES.some((value) => value === name);
}
function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}
function selection(args: CatalogJsonObject, write: boolean): Selection | undefined {
  const allowed = new Set(write ? ["issueKey"] : ["issueKey", "startAt", "maxResults"]);
  if (
    !isSafeAtlassianIdentifier(args.issueKey) ||
    Object.keys(args).some((key) => !allowed.has(key))
  )
    return undefined;
  const startAt = args.startAt === undefined ? 0 : args.startAt;
  const maxResults = args.maxResults === undefined ? 25 : args.maxResults;
  if (!integer(startAt, 0, 1_000_000) || !integer(maxResults, 1, 100)) return undefined;
  return { issueKey: args.issueKey, startAt, maxResults };
}
function person(value: unknown): CatalogJsonObject | undefined {
  const raw = asRecord(value);
  if (!jiraNativeText(raw?.name, 255)) return undefined;
  const result: Record<string, string | boolean> = { name: raw.name };
  if (raw.displayName !== undefined && raw.displayName !== null) {
    if (!jiraNativeText(raw.displayName, 255, true)) return undefined;
    result.displayName = raw.displayName;
  }
  if (raw.active !== undefined && raw.active !== null) {
    if (typeof raw.active !== "boolean") return undefined;
    result.active = raw.active;
  }
  return result;
}
function facts(
  raw: Record<string, unknown>,
  watch: boolean,
): Pick<View, "count" | "state"> | undefined {
  const count = watch ? raw.watchCount : raw.votes;
  const state = (watch ? raw.isWatching : raw.hasVoted) ?? undefined;
  if (
    !integer(count, 0, Number.MAX_SAFE_INTEGER) ||
    (state !== undefined && typeof state !== "boolean")
  )
    return undefined;
  return { count, state };
}
function people(raw: Record<string, unknown>, watch: boolean): unknown {
  return (watch ? raw.watchers : raw.voters) ?? undefined;
}
function view(raw: Record<string, unknown> | undefined, watch: boolean): View | undefined {
  if (raw === undefined) return undefined;
  const current = facts(raw, watch);
  if (current === undefined) return undefined;
  const source = people(raw, watch);
  if (source !== undefined && !Array.isArray(source)) return undefined;
  const items = projectJiraCollection(
    source ?? [],
    TOOL_CATALOG_LIMITS.maxArrayItems,
    person,
    "name",
  );
  if (items === undefined || items.length > current.count) return undefined;
  return { ...current, items, complete: source !== undefined && items.length === current.count };
}
async function bind(
  request: JiraMutationRequest,
  issueKey: string,
  baseUrl: string | undefined,
): Promise<Failure | Binding> {
  if (baseUrl === undefined || !isSafeAtlassianConnectorBaseUrl(baseUrl)) return MALFORMED;
  const current = await readJiraMutationIssue(request, issueKey, ["summary"]);
  if (!current.ok) return current;
  return jiraNativeId(current.id) && isSafeAtlassianIdentifier(current.key)
    ? { ok: true, issueId: current.id, issueKey: current.key }
    : MALFORMED;
}
function resource(issueId: string, watch: boolean): string {
  return `issue/${issueId}/${watch ? "watchers" : "votes"}`;
}
async function inspect(
  request: JiraMutationRequest,
  binding: Binding,
  watch: boolean,
): Promise<Failure | { readonly ok: true; readonly view: View }> {
  const response = await request(resource(binding.issueId, watch));
  if (!response.ok) return dispatchFailure(response);
  if (!selfMatches(response.body?.self, binding, watch)) return CONFLICT;
  const parsed = response.status === 200 ? view(response.body, watch) : undefined;
  return parsed === undefined ? MALFORMED : { ok: true, view: parsed };
}
function selfMatches(value: unknown, binding: Binding, watch: boolean): boolean {
  // These singleton subresources have no global resource ID beyond the resolved issue. Their
  // published WatchersBean/VoteBean schemas do not require self: retain native route binding
  // when absent and check any supplied identity. A comment's independent global ID needs the
  // stronger positive issue-membership proof in jiraCommentSelfMatches.
  if (value === undefined || value === null) return true;
  return [binding.issueId, binding.issueKey].some((id) =>
    jiraResourceSelfMatches(value, resource(id, watch)),
  );
}
function stateReceipt(
  watch: boolean,
  state: boolean,
): Pick<JiraMutationReceipt, "isWatching" | "hasVoted"> {
  return watch ? { isWatching: state } : { hasVoted: state };
}
export async function executeJiraParticipationRead(
  operation: Read,
  args: CatalogJsonObject,
  request: JiraMutationRequest,
  baseUrl: string,
): Promise<ManagedMcpToolResult> {
  const selected = selection(args, false);
  if (selected === undefined) return jiraReadFailure("invalid-input");
  const bound = await bind(request, selected.issueKey, baseUrl);
  if (!bound.ok) return jiraReadFailure(bound.reason, bound.detail);
  const watch = operation === "jira.watchers";
  const current = await inspect(request, bound, watch);
  if (!current.ok) return jiraReadFailure(current.reason, current.detail);
  const page = localJiraPage(current.view.items, selected.startAt, selected.maxResults);
  return boundJiraReadResult({
    data: {
      ...page.data,
      issueKey: bound.issueKey,
      ...(watch ? { watchCount: current.view.count } : { votes: current.view.count }),
      ...(current.view.state === undefined ? {} : stateReceipt(watch, current.view.state)),
      listComplete: current.view.complete,
    },
  });
}
async function writePath(
  operation: Write,
  path: string,
  request: JiraMutationRequest,
): Promise<Failure | { readonly ok: true; readonly path: string }> {
  if (operation !== "jira.unwatch") return { ok: true, path };
  const current = await request("myself");
  if (!current.ok) return dispatchFailure(current);
  const name = current.body?.name;
  if (current.status !== 200 || !jiraNativeText(name, 255) || /[\r\n\t]/u.test(name))
    return MALFORMED;
  return { ok: true, path: `${path}?${new URLSearchParams({ username: name }).toString()}` };
}
async function confirm(
  request: JiraMutationRequest,
  binding: Binding,
  watch: boolean,
  desired: boolean,
  receipt: JiraMutationReceipt,
): Promise<JiraMutationAttempt> {
  try {
    const current = await inspect(request, binding, watch);
    if (!current.ok) return { ...current, receipt };
    if (current.view.state !== desired) return { ...CONFLICT, receipt };
    return { ok: true, receipt: { ...receipt, ...stateReceipt(watch, desired) } };
  } catch (cause) {
    throw new JiraAcknowledgedMutationError(cause, receipt);
  }
}
async function prepare(
  request: JiraMutationRequest,
  selected: Selection,
  watch: boolean,
  desired: boolean,
  baseUrl: string | undefined,
): Promise<
  | Failure
  | {
      readonly ok: true;
      readonly path: string;
      readonly receipt: JiraMutationReceipt;
      readonly binding: Binding;
    }
> {
  const bound = await bind(request, selected.issueKey, baseUrl);
  if (!bound.ok) return bound;
  const path = resource(bound.issueId, watch);
  const prior = await inspect(request, bound, watch);
  if (!prior.ok) return prior;
  if (prior.view.state === undefined) return MALFORMED;
  const receipt = { issueKey: bound.issueKey, issueId: bound.issueId };
  if (prior.view.state === desired)
    return {
      ...CONFLICT,
      receipt: { ...receipt, ...stateReceipt(watch, desired) },
      detail: {
        unchanged: true,
        messages: [
          "The connected user's participation already matches the request. Nothing was written.",
        ],
      },
    };
  return { ok: true, path, receipt, binding: bound };
}
/** Changes only the connected user's participation; caller owns approval and durable no-replay. */
export async function executeJiraParticipationMutation(
  operation: Write,
  args: CatalogJsonObject,
  request: JiraMutationRequest,
  check = false,
  baseUrl?: string,
): Promise<JiraMutationAttempt> {
  const selected = selection(args, true);
  if (selected === undefined)
    return { ok: false, reason: "field-validation", detail: { validation: "invalid-field" } };
  const { watch, desired } = WRITE_STATE[operation];
  const prepared = await prepare(request, selected, watch, desired, baseUrl);
  if (!prepared.ok) return prepared;
  const { path, receipt } = prepared;
  const target = await writePath(operation, path, request);
  if (!target.ok) return target;
  if (check) return { ok: true, receipt: {} };
  const response = await request(target.path, desired ? "POST" : "DELETE", undefined, "none");
  if (!response.ok) return { ...dispatchFailure(response), receipt };
  if (response.status < 200 || response.status >= 300) return { ...MALFORMED, receipt };
  return confirm(request, prepared.binding, watch, desired, receipt);
}
