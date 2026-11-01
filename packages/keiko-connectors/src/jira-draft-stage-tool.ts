import {
  JIRA_DRAFT_DIGEST_PATTERN,
  JIRA_DRAFT_ID_PATTERN,
  JIRA_DRAFT_PAGE_ITEMS_MAX,
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
  | "too-large"
  | "template-violation";

/** Body-free facts about one staging call; the composing server maps them to its log. */
export interface JiraDraftActivity {
  /** staged/refused: one staging call; progress/executed: the approved draft's run (#4178). */
  readonly phase: "staged" | "refused" | "progress" | "executed";
  readonly refusal?: JiraDraftRefusal;
  readonly newDraft: boolean;
  readonly pageItemCount: number;
  readonly itemCount: number;
  readonly pageCount: number;
  readonly byteCount: number;
  readonly unresolvedRefCount: number;
  readonly violationCount: number;
  readonly durationMs: number;
  /** A run only: items created, reconciled or deselected so far, and items not yet started. */
  readonly settledCount?: number;
  readonly pendingCount?: number;
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
/**
 * What to correct in a page that is not well formed. The declaration leaves the item form to
 * jira.draft's, so this names the first item that does not match it (counting from 1).
 */
function invalidPageGuidance(raw: CatalogJsonObject): string {
  const { items } = raw;
  const page: readonly unknown[] = Array.isArray(items) ? items : [];
  const index = page.findIndex((item) => !isJiraDraftItem(item));
  const subject =
    index < 0
      ? `Send draftId (when appending) and 1 to ${String(JIRA_DRAFT_PAGE_ITEMS_MAX)} items.`
      : `Item ${String(index + 1)} is not in the jira.draft item form: ref, projectId, issueTypeId and fields with summary; optionally parent, links and requirementIds.`;
  return `${subject} Correct the page and send it again; nothing was staged.`;
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
  index = 0,
): Promise<TemplateRefusal | undefined> {
  const item = page[index];
  if (item === undefined) return undefined;
  const result = await checkJiraManagedMutationTemplates(
    "jira.create",
    createSource(item),
    context,
    connection,
  );
  if (!result.ok && result.violations !== undefined)
    return { ref: String(item.ref), violations: result.violations };
  return firstTemplateRefusal(page, context, connection, index + 1);
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
/**
 * The fixed instruction for the one bound a draft has: its size in bytes. It is plain language for
 * a person who is not a developer, and it always leaves a way forward - several smaller drafts.
 */
export const JIRA_DRAFT_TOO_LARGE_GUIDANCE =
  "This backlog is larger than a single draft can hold, so nothing more was added to it. " +
  "Tell the user in plain language that the backlog is too big to approve in one piece, that the items already written are still saved, " +
  "and offer to split the rest into several smaller drafts, for example one per epic or theme, each approved on its own. " +
  "Do not show this message, an error code or any numbers.";
function guidanceOf(refusal: JiraDraftRefusal): Record<string, string> {
  return refusal === "too-large" ? { guidance: JIRA_DRAFT_TOO_LARGE_GUIDANCE } : {};
}

interface StageRun<Context extends ManagedMcpInvocationContext> {
  readonly deps: JiraDraftToolDeps<Context>;
  readonly context: Context;
  readonly args: StageArgs | undefined;
  readonly startedAt: number;
}
function refuseStage<Context extends ManagedMcpInvocationContext>(
  run: StageRun<Context>,
  refusal: JiraDraftRefusal,
  pageItemCount: number,
  extra: Partial<JiraDraftActivity> = {},
): ManagedMcpToolResult {
  const { deps, context, args, startedAt } = run;
  deps.activity?.(
    activityOf(
      {
        phase: "refused",
        newDraft: args?.draftId === undefined,
        pageItemCount,
        durationMs: (deps.now ?? Date.now)() - startedAt,
      },
      undefined,
      { refusal, ...extra },
    ),
    context,
  );
  const failure = jiraReadFailure(refusal);
  return { ...failure, data: { ...failure.data, ...guidanceOf(refusal) } };
}
function templateRefusalResult(refusal: TemplateRefusal): ManagedMcpToolResult {
  return {
    isError: true,
    data: {
      outcome: "rejected",
      reason: "field-validation",
      ref: refusal.ref,
      violations: refusal.violations.map((violation) => ({ ...violation })),
    },
  };
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
  const run: StageRun<Context> = { deps, context, args, startedAt };
  if (args === undefined) {
    const refused = refuseStage(run, "invalid-input", 0);
    return { ...refused, data: { ...refused.data, guidance: invalidPageGuidance(rawArgs) } };
  }
  if (connection.deployment !== "data-center") return refuseStage(run, "unsupported-deployment", 0);
  const template = await firstTemplateRefusal(args.items, context, connection);
  if (template !== undefined) {
    refuseStage(run, "template-violation", args.items.length, {
      violationCount: template.violations.length,
    });
    return templateRefusalResult(template);
  }
  const appended = deps.store.append(
    deps.owner(context),
    args.draftId,
    connectionFingerprint(connection),
    args.items,
  );
  if (!appended.ok) return refuseStage(run, appended.refusal, args.items.length);
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
