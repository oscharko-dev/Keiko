import { AsyncLocalStorage } from "node:async_hooks";
import type { ManagedMcpInvocationContext } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { asRecord } from "./atlassian-sync-classify.js";
import { jiraAgileRequest } from "./jira-agile-request.js";
import { JIRA_DRAFT_STAND_IN_KEY } from "./jira-draft.js";
import type { JiraManagedConnection } from "./jira-managed-connection.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import type { JiraMutationAttempt } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";

/**
 * An Epic Link that points to an issue that is not an Epic passed the preflight and was then
 * rejected by Jira for every item (`gh.epic.error.not.found`, #4354 AC2). The instance's own epic
 * endpoint is the authority on what an Epic is (no type name, which an instance may localize or
 * rename), so a write that sets the Epic Link asks it before anything is sent. The agile request
 * rides on the invocation, like the template notices, so every path that creates or edits an issue
 * (single write, bulk create, draft dry run) is checked by the same owner.
 */
const EPIC_LINK_FIELD_TYPE = "com.pyxis.greenhopper.jira:gh-epic-link";
const ISSUE_KEY = /^[A-Za-z][A-Za-z0-9_]*-\d{1,10}$/u;
const CUSTOM_FIELD = /^customfield_\d{1,32}$/u;
// The agile request is built on first use: building it opens a bounded timeout phase, and a write
// that never sets an Epic Link must not open one.
interface EpicCheck {
  readonly agile: () => JiraMutationRequest;
  /** One field-list read and one read per target for the invocation, even when asked concurrently. */
  fieldId: Promise<string | undefined> | undefined;
  readonly targets: Map<string, Promise<boolean>>;
}
const AGILE = new AsyncLocalStorage<EpicCheck>();

/** Runs one admission or write with the invocation's agile request available to its checks. */
export function withJiraEpicLinkTargetCheck<T>(
  connection: JiraManagedConnection,
  context: ManagedMcpInvocationContext,
  run: () => Promise<T>,
): Promise<T> {
  let built: JiraMutationRequest | undefined;
  const check: EpicCheck = {
    agile: (): JiraMutationRequest => (built ??= jiraAgileRequest(connection, context)),
    fieldId: undefined,
    targets: new Map(),
  };
  return AGILE.run(check, run);
}

type Refusal = Extract<JiraMutationAttempt, { ok: false }>;

async function epicLinkFieldId(request: JiraMutationRequest): Promise<string | undefined> {
  const response = await request("field", "GET", undefined, "json-array");
  if (!response.ok || response.items === undefined) return undefined;
  const matches = response.items
    .map(asRecord)
    .filter((item) => asRecord(item?.schema)?.custom === EPIC_LINK_FIELD_TYPE);
  const id = matches.length === 1 ? matches[0]?.id : undefined;
  return typeof id === "string" && CUSTOM_FIELD.test(id) ? id : undefined;
}

function candidateKeys(fields: Readonly<Record<string, unknown>>): boolean {
  return Object.entries(fields).some(
    ([id, value]) => CUSTOM_FIELD.test(id) && typeof value === "string" && ISSUE_KEY.test(value),
  );
}

/**
 * The refusal for an Epic Link whose target the instance does not know as an Epic, or undefined:
 * no Epic Link among the fields, no agile request on this invocation, or an epic endpoint that
 * cannot be read (an unreadable check proves nothing, so Jira decides). Reads only.
 */
export async function epicLinkTargetRefusal(
  request: JiraMutationRequest,
  fields: Readonly<Record<string, unknown>>,
): Promise<Refusal | undefined> {
  const check = AGILE.getStore();
  if (check === undefined || !candidateKeys(fields)) return undefined;
  check.fieldId ??= epicLinkFieldId(request);
  const fieldId = await check.fieldId;
  const target = fieldId === undefined ? undefined : fields[fieldId];
  if (fieldId === undefined || typeof target !== "string" || target === JIRA_DRAFT_STAND_IN_KEY)
    return undefined;
  if (!(await isUnknownEpic(check, target))) return undefined;
  return {
    ok: false,
    reason: "field-validation",
    detail: {
      fieldId,
      validation: "invalid-field",
      messages: [
        `${target} is not an Epic, or this account cannot see it, so it cannot be the Epic Link. Link to the key of an existing Epic of this project that you can see, or create the Epic first. Nothing was changed.`,
      ],
    },
  };
}
/** Only the instance's own "no such epic" answer refuses; any other failure proves nothing. */
function isUnknownEpic(check: EpicCheck, target: string): Promise<boolean> {
  let known = check.targets.get(target);
  if (known === undefined) {
    known = check
      .agile()(`epic/${encodeURIComponent(target)}`)
      .then((response) => !response.ok && response.reason === "not-found");
    check.targets.set(target, known);
  }
  return known;
}
