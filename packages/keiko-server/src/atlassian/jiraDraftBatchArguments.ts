import { JIRA_DRAFT_ID_PATTERN } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { RequirementFilter } from "../requirement-inventory.js";
import {
  JIRA_DRAFT_BATCH_GROUPING_CHARS_MAX,
  JIRA_DRAFT_BATCH_GUIDANCE_CHARS_MAX,
} from "./jiraDraftBatchDescriptor.js";

export interface JiraDraftBatchArguments {
  readonly projectId: string;
  readonly issueTypeId: string;
  readonly granularity: "per-requirement" | "grouped";
  readonly grouping?: string | undefined;
  readonly guidance?: string | undefined;
  readonly filter: RequirementFilter;
  /** A subset was asked for; a Knowledge Pod larger than Keiko can list then still serves it. */
  readonly filtered: boolean;
  readonly parent?: CatalogJsonObject | undefined;
  readonly draftId?: string | undefined;
  readonly create: boolean;
}

const NUMERIC_ID = /^[0-9]{1,32}$/u;
const DRAFT_ID = new RegExp(JIRA_DRAFT_ID_PATTERN, "u");

/** An empty list names nothing to filter by, so it reads like an omitted one. */
function strings(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry): entry is string => typeof entry === "string")
    ? value
    : undefined;
}

function optionalText(value: unknown, max: number): string | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > max) return null;
  return value.trim().length === 0 ? undefined : value.trim();
}

function isRecord(value: unknown): value is CatalogJsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requirementFilter(value: unknown): RequirementFilter {
  const raw = isRecord(value) ? value : {};
  return {
    documents: strings(raw.documents),
    ids: strings(raw.ids),
    priorities: strings(raw.priorities),
    query: typeof raw.query === "string" && raw.query.trim().length > 0 ? raw.query : undefined,
  };
}

function isNumericId(value: unknown): value is string {
  return typeof value === "string" && NUMERIC_ID.test(value);
}

function isGranularity(value: unknown): value is JiraDraftBatchArguments["granularity"] {
  return value === "per-requirement" || value === "grouped";
}

function isOptionalDraftId(value: unknown): value is string | undefined {
  return value === undefined || (typeof value === "string" && DRAFT_ID.test(value));
}

/** The checked arguments of one call, or undefined when they are not in the declared form. */
export function parseJiraDraftBatchArguments(
  args: CatalogJsonObject,
): JiraDraftBatchArguments | undefined {
  const { projectId, issueTypeId, granularity, create, draftId, parent } = args;
  const grouping = optionalText(args.grouping, JIRA_DRAFT_BATCH_GROUPING_CHARS_MAX);
  const guidance = optionalText(args.guidance, JIRA_DRAFT_BATCH_GUIDANCE_CHARS_MAX);
  if (!isNumericId(projectId) || !isNumericId(issueTypeId)) return undefined;
  if (typeof create !== "boolean") return undefined;
  if (!isGranularity(granularity)) return undefined;
  if (grouping === null || guidance === null) return undefined;
  if (!isOptionalDraftId(draftId) || !(parent === undefined || isRecord(parent))) return undefined;
  const filter = requirementFilter(args.requirements);
  return {
    projectId,
    issueTypeId,
    granularity,
    grouping,
    guidance,
    filter,
    filtered: Object.values(filter).some((value) => value !== undefined),
    parent,
    draftId,
    create,
  };
}
