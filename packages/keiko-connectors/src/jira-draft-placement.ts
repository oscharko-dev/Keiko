import type { ManagedMcpInvocationContext } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { asArray, asRecord } from "./atlassian-sync-classify.js";
import type { JiraManagedConnection } from "./jira-managed-connection.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { requestFor } from "./jira-managed-mutations.js";

/** Issue type names a refusal offers the model for a retry. */
export const JIRA_PLACEMENT_TYPE_NAMES_MAX = 20;

const NUMERIC_ID = /^\d{1,32}$/u;
/**
 * One rule for the tool schema and the parser. A key Jira does not know ("1AB", "_AB") is then
 * answered as an unknown project, with the retry hint, instead of as malformed input.
 */
export const JIRA_PROJECT_REFERENCE_PATTERN = String.raw`^\w{1,32}$`;
const PROJECT_REFERENCE = new RegExp(JIRA_PROJECT_REFERENCE_PATTERN, "u");
const TYPE_NAME_CHARS_MAX = 120;
const TYPES_SCANNED_MAX = 200;

/** A project is a numeric id or a project key; the model never needs a prior read for either. */
export function isJiraProjectReference(value: unknown): value is string {
  return typeof value === "string" && PROJECT_REFERENCE.test(value);
}

/** An issue type is a numeric id or a name. */
export function isJiraIssueTypeReference(value: unknown): value is string {
  return (
    typeof value === "string" && value.trim().length > 0 && value.length <= TYPE_NAME_CHARS_MAX
  );
}

export interface JiraDraftPlacement {
  readonly projectId: string;
  readonly projectKey: string;
  readonly issueTypeId: string;
  readonly issueTypeName: string;
}

export type JiraDraftPlacementResult =
  | ({ readonly ok: true } & JiraDraftPlacement)
  | {
      readonly ok: false;
      readonly reason:
        | "project-not-found"
        | "issue-type-not-found"
        /** The project offers only subtask types, or none. */
        | "no-usable-issue-type"
        | "unavailable"
        | "malformed-payload";
      /** The project's usable issue type names, bounded, for a retry with one of them. */
      readonly issueTypeNames?: readonly string[];
    };

interface ProjectType {
  readonly id: string;
  readonly name: string;
}

function projectTypes(body: Readonly<Record<string, unknown>>): readonly ProjectType[] | undefined {
  const raw = asArray(body.issueTypes);
  if (raw === undefined) return undefined;
  const types: ProjectType[] = [];
  for (const entry of raw.slice(0, TYPES_SCANNED_MAX)) {
    const record = asRecord(entry);
    const { id, name, subtask } = record ?? {};
    if (typeof id !== "string" || typeof name !== "string" || !NUMERIC_ID.test(id)) continue;
    if (subtask === true) continue;
    types.push({ id, name });
  }
  return types;
}

function projectOf(
  body: Readonly<Record<string, unknown>> | undefined,
): { id: string; key: string; types: readonly ProjectType[] } | undefined {
  const types = body === undefined ? undefined : projectTypes(body);
  const id = body?.id;
  const key = body?.key;
  if (types === undefined || typeof id !== "string" || !NUMERIC_ID.test(id)) return undefined;
  return typeof key === "string" && key.length > 0 ? { id, key, types } : undefined;
}

function byName(types: readonly ProjectType[], wanted: string): ProjectType | undefined {
  const lower = wanted.trim().toLowerCase();
  return types.find((type) => type.name.toLowerCase() === lower);
}

/** Story, then Task, then Jira's first type that is not an Epic. */
function defaultType(types: readonly ProjectType[]): ProjectType | undefined {
  return (
    byName(types, "story") ??
    byName(types, "task") ??
    types.find((type) => type.name.toLowerCase() !== "epic")
  );
}

function chooseType(
  types: readonly ProjectType[],
  issueType: string | undefined,
): ProjectType | undefined {
  if (issueType === undefined) return defaultType(types);
  const trimmed = issueType.trim();
  return (
    (NUMERIC_ID.test(trimmed) ? types.find((type) => type.id === trimmed) : undefined) ??
    byName(types, trimmed)
  );
}

/**
 * The numeric placement of a draft from one `project/{idOrKey}` read: the project by id or key,
 * the issue type by id or name, or a deterministic default. Subtask types are never chosen.
 */
export async function resolveJiraDraftPlacementWith(
  request: JiraMutationRequest,
  project: string,
  issueType: string | undefined,
): Promise<JiraDraftPlacementResult> {
  // Jira project keys are upper case; a numeric id is passed through unchanged.
  const reference = NUMERIC_ID.test(project) ? project : project.toUpperCase();
  const read = await request(`project/${encodeURIComponent(reference)}`);
  if (!read.ok) {
    return { ok: false, reason: read.reason === "not-found" ? "project-not-found" : "unavailable" };
  }
  const found = projectOf(read.body);
  if (found === undefined) return { ok: false, reason: "malformed-payload" };
  const { id, key, types } = found;
  if (types.length === 0) return { ok: false, reason: "no-usable-issue-type" };
  const chosen = chooseType(types, issueType);
  if (chosen === undefined) {
    return {
      ok: false,
      reason: "issue-type-not-found",
      issueTypeNames: types.slice(0, JIRA_PLACEMENT_TYPE_NAMES_MAX).map((type) => type.name),
    };
  }
  return {
    ok: true,
    projectId: id,
    projectKey: key,
    issueTypeId: chosen.id,
    issueTypeName: chosen.name,
  };
}

/** The same resolution over the connection's credential-bound request. */
export function resolveJiraDraftPlacement(
  context: ManagedMcpInvocationContext,
  connection: JiraManagedConnection,
  project: string,
  issueType: string | undefined,
): Promise<JiraDraftPlacementResult> {
  return resolveJiraDraftPlacementWith(requestFor(connection, context), project, issueType);
}
