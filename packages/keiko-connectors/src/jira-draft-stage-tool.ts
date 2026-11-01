import {
  JIRA_DRAFT_DIGEST_PATTERN,
  JIRA_DRAFT_ID_PATTERN,
  JIRA_DRAFT_ITEMS_MAX,
  JIRA_DRAFT_PAGE_ITEMS_MAX,
  JIRA_DRAFT_STAGE_BYTES_MAX,
  type JiraTemplateViolation,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type {
  ManagedMcpInvocationContext,
  ManagedMcpToolResult,
} from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { isJiraDraftItem, unresolvedJiraDraftRefs } from "./jira-draft.js";
import {
  jiraDraftDigest,
  type JiraDraftStore,
  type StagedJiraDraft,
  type StagedJiraDraftItem,
} from "./jira-draft-store.js";
import type { JiraManagedConnection } from "./jira-managed-connection.js";
import { jiraReadFailure } from "./jira-managed-metadata.js";
import { checkJiraManagedMutationTemplates } from "./jira-managed-mutations.js";
import { connectionFingerprint } from "./jira-report-tool.js";

export type JiraDraftRefusal =
  | "invalid-input"
  | "unsupported-deployment"
  | "draft-not-found"
  | "connection-changed"
  | "duplicate-ref"
  | "too-many-items"
  | "too-large"
  | "template-violation";

/** Body-free facts about one staging call; the composing server maps them to its log. */
export interface JiraDraftActivity {
  readonly phase: "staged" | "refused";
  readonly refusal?: JiraDraftRefusal;
  readonly newDraft: boolean;
  readonly pageItemCount: number;
  readonly itemCount: number;
  readonly pageCount: number;
  readonly byteCount: number;
  readonly unresolvedRefCount: number;
  readonly violationCount: number;
  readonly durationMs: number;
}

export interface JiraDraftToolDeps<Context extends ManagedMcpInvocationContext> {
  readonly store: JiraDraftStore;
  /** Binds a draft to the Chat that started it. */
  readonly owner: (context: Context) => string;
  readonly activity?: ((activity: JiraDraftActivity, context: Context) => void) | undefined;
  readonly now?: (() => number) | undefined;
}

const DRAFT_ID = new RegExp(JIRA_DRAFT_ID_PATTERN, "u");
const DRAFT_DIGEST = new RegExp(JIRA_DRAFT_DIGEST_PATTERN, "u");
const UNRESOLVED_LISTED_MAX = 32;
const STAGE_KEYS: ReadonlySet<string> = new Set(["draftId", "items"]);

interface StageArgs {
  readonly draftId: string | undefined;
  readonly items: readonly StagedJiraDraftItem[];
}
/** One page of well-formed items and, when it extends a draft, that draft's id. */
function parseStageArgs(raw: CatalogJsonObject): StageArgs | undefined {
  if (!Object.keys(raw).every((key) => STAGE_KEYS.has(key))) return undefined;
  const { draftId, items } = raw;
  if (draftId !== undefined && !(typeof draftId === "string" && DRAFT_ID.test(draftId)))
    return undefined;
  if (!Array.isArray(items) || items.length === 0 || items.length > JIRA_DRAFT_PAGE_ITEMS_MAX)
    return undefined;
  const page: readonly unknown[] = items;
  if (!page.every(isJiraDraftItem)) return undefined;
  return { draftId, items: page as readonly StagedJiraDraftItem[] };
}

/** The create the item stands for; a parent held by another draft item gets a stand-in key. */
function createSource(item: StagedJiraDraftItem): CatalogJsonObject {
  const fields = (item.fields ?? {}) as Record<string, unknown>;
  const parent = item.parent as { readonly fieldId?: unknown } | undefined;
  const parentFieldId = typeof parent?.fieldId === "string" ? parent.fieldId : undefined;
  return {
    projectId: item.projectId,
    issueTypeId: item.issueTypeId,
    fields: { ...fields, ...(parentFieldId === undefined ? {} : { [parentFieldId]: "DRAFT-1" }) },
  } as CatalogJsonObject;
}

interface TemplateRefusal {
  readonly ref: string;
  readonly violations: readonly JiraTemplateViolation[];
}
/**
 * Every appended item passes the template check a create passes, now, so the model corrects an
 * item while it is being written instead of after the human has been asked. A page with a
 * violating item is refused whole; nothing of it is staged. Items are read one after another
 * because each check reads Jira's metadata through the same bounded connection.
 */
async function firstTemplateRefusal(
  page: readonly StagedJiraDraftItem[],
  context: ManagedMcpInvocationContext,
  connection: JiraManagedConnection,
): Promise<TemplateRefusal | undefined> {
  for (const item of page) {
    const result = await checkJiraManagedMutationTemplates(
      // NOSONAR typescript:S9382 -- the first violation ends the page
      "jira.create",
      createSource(item),
      context,
      connection,
    );
    if (!result.ok && result.violations !== undefined)
      return { ref: String(item.ref), violations: result.violations };
  }
  return undefined;
}

function stagedView(draft: StagedJiraDraft, newDraft: boolean): ManagedMcpToolResult {
  const unresolved = unresolvedJiraDraftRefs(draft.items);
  return {
    data: {
      outcome: "succeeded",
      draftId: draft.id,
      draftDigest: draft.digest,
      newDraft,
      itemCount: draft.items.length,
      pageCount: draft.pageCount,
      itemLimit: JIRA_DRAFT_ITEMS_MAX,
      unresolvedRefCount: unresolved.length,
      unresolvedRefs: unresolved.slice(0, UNRESOLVED_LISTED_MAX),
    },
  };
}
function activityOf(
  base: Pick<JiraDraftActivity, "phase" | "newDraft" | "pageItemCount" | "durationMs">,
  draft: StagedJiraDraft | undefined,
  extra: Partial<JiraDraftActivity> = {},
): JiraDraftActivity {
  return {
    ...base,
    itemCount: draft?.items.length ?? 0,
    pageCount: draft?.pageCount ?? 0,
    byteCount: draft?.bytes ?? 0,
    unresolvedRefCount: draft === undefined ? 0 : unresolvedJiraDraftRefs(draft.items).length,
    violationCount: 0,
    ...extra,
  };
}
function limitsOf(refusal: JiraDraftRefusal): Record<string, number> {
  if (refusal === "too-many-items") return { itemLimit: JIRA_DRAFT_ITEMS_MAX };
  return refusal === "too-large" ? { byteLimit: JIRA_DRAFT_STAGE_BYTES_MAX } : {};
}

/** `jira.draft-stage`: append a page of validated items to a draft; it changes nothing in Jira. */
export async function executeJiraDraftStageTool<Context extends ManagedMcpInvocationContext>(
  rawArgs: CatalogJsonObject,
  context: Context,
  connection: JiraManagedConnection,
  deps: JiraDraftToolDeps<Context>,
): Promise<ManagedMcpToolResult> {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const args = parseStageArgs(rawArgs);
  const refuse = (
    refusal: JiraDraftRefusal,
    pageItemCount: number,
    extra: Partial<JiraDraftActivity> = {},
  ): ManagedMcpToolResult => {
    deps.activity?.(
      activityOf(
        {
          phase: "refused",
          newDraft: args?.draftId === undefined,
          pageItemCount,
          durationMs: now() - startedAt,
        },
        undefined,
        { refusal, ...extra },
      ),
      context,
    );
    const failure = jiraReadFailure(refusal);
    return { ...failure, data: { ...failure.data, ...limitsOf(refusal) } };
  };
  if (args === undefined) return refuse("invalid-input", 0);
  if (connection.deployment !== "data-center") return refuse("unsupported-deployment", 0);
  const template = await firstTemplateRefusal(args.items, context, connection);
  if (template !== undefined) {
    refuse("template-violation", args.items.length, {
      violationCount: template.violations.length,
    });
    return {
      isError: true,
      data: {
        outcome: "rejected",
        reason: "field-validation",
        ref: template.ref,
        violations: template.violations.map((violation) => ({ ...violation })),
      },
    };
  }
  const appended = deps.store.append(
    deps.owner(context),
    args.draftId,
    connectionFingerprint(connection),
    args.items,
  );
  if (!appended.ok) return refuse(appended.refusal, args.items.length);
  deps.activity?.(
    activityOf(
      {
        phase: "staged",
        newDraft: args.draftId === undefined,
        pageItemCount: args.items.length,
        durationMs: now() - startedAt,
      },
      appended.draft,
    ),
    context,
  );
  return stagedView(appended.draft, args.draftId === undefined);
}

/** `{draftId, draftDigest}`: the one form of a `jira.draft` call that names a staged draft. */
export interface JiraDraftReference {
  readonly draftId: string;
  readonly draftDigest: string;
}
export function parseJiraDraftReference(
  args: Readonly<Record<string, unknown>>,
): JiraDraftReference | undefined {
  const keys = Object.keys(args);
  const { draftId, draftDigest } = args;
  return keys.length === 2 &&
    typeof draftId === "string" &&
    DRAFT_ID.test(draftId) &&
    typeof draftDigest === "string" &&
    DRAFT_DIGEST.test(draftDigest)
    ? { draftId, draftDigest }
    : undefined;
}
export type JiraDraftResolution =
  | { readonly ok: true; readonly arguments: CatalogJsonObject }
  | { readonly ok: false; readonly reason: "draft-not-found" | "draft-changed" };

/**
 * The staged draft a `jira.draft` call names, as the `{ items }` arguments every consumer parses.
 * `undefined` when the call does not name a staged draft. The digest the call carries must be the
 * digest of the items held now: a draft extended after the digest was read is a different draft.
 */
export function resolveJiraDraftArguments(
  args: Readonly<Record<string, unknown>>,
  lookup: (draftId: string) => StagedJiraDraft | undefined,
): JiraDraftResolution | undefined {
  if (!("draftId" in args) && !("draftDigest" in args)) return undefined;
  const reference = parseJiraDraftReference(args);
  const draft = reference === undefined ? undefined : lookup(reference.draftId);
  if (reference === undefined || draft === undefined)
    return { ok: false, reason: "draft-not-found" };
  return draft.digest === reference.draftDigest && jiraDraftDigest(draft.items) === draft.digest
    ? { ok: true, arguments: { items: draft.items } as CatalogJsonObject }
    : { ok: false, reason: "draft-changed" };
}
