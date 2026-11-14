import {
  JIRA_DRAFT_DIGEST_PATTERN,
  JIRA_DRAFT_ID_PATTERN,
  JIRA_DRAFT_PAGE_ITEMS_MAX,
  countJiraTemplateViolations,
  type JiraTemplateRuleId,
  type JiraTemplateViolation,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { withJiraDraftReadMemo, type JiraDraftReadCounts } from "./jira-draft-read-memo.js";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { deepFreeze } from "@oscharko-dev/keiko-contracts/runtime/deep-freeze";
import type {
  ManagedMcpInvocationContext,
  ManagedMcpToolResult,
} from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import {
  isJiraDraftItem,
  JIRA_DRAFT_STAND_IN_KEY,
  jiraDraftStagedItem,
  unresolvedJiraDraftRefs,
  type JiraDraftItem,
} from "./jira-draft.js";
import {
  jiraDraftDigest,
  validJiraDraftSourceBindings,
  type JiraDraftSourceBinding,
  type JiraDraftStore,
  type StagedJiraDraft,
  type StagedJiraDraftItem,
} from "./jira-draft-store.js";
import type { JiraManagedConnection } from "./jira-managed-connection.js";
import { jiraReadFailure } from "./jira-managed-metadata.js";
import { jiraTemplateViolationGuidance } from "./jira-issue-template-check.js";
import {
  checkJiraManagedMutationTemplates,
  jiraDraftFieldRefusals,
  type JiraDraftFieldRefusal,
} from "./jira-managed-mutations.js";
import { connectionFingerprint } from "./jira-report-tool.js";

export type JiraDraftRefusal =
  | "invalid-input"
  | "unsupported-deployment"
  | "draft-not-found"
  | "connection-changed"
  | "duplicate-ref"
  | "too-large"
  | "template-violation"
  | "invalid-fields";

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
  readonly violationRuleCounts?: Partial<Readonly<Record<JiraTemplateRuleId, number>>>;
  readonly durationMs: number;
  /** A run only: items created, reconciled or deselected so far, and items not yet started. */
  readonly settledCount?: number;
  readonly pendingCount?: number;
  /** A staging call or a create run: Jira reads it sent, and reads answered from the invocation's own memo. */
  readonly readCount?: number;
  readonly readReusedCount?: number;
}

export interface JiraDraftToolDeps<Context extends ManagedMcpInvocationContext> {
  readonly store: JiraDraftStore;
  /** Binds a draft to the Chat that started it. */
  readonly owner: (context: Context) => string;
  readonly activity?: ((activity: JiraDraftActivity, context: Context) => void) | undefined;
  /** Prepares the exact reviewed fields and privately binds their source revisions before staging. */
  readonly prepareRequirements?:
    ((items: readonly StagedJiraDraftItem[], context: Context) => JiraDraftPreparation) | undefined;
  /** Source-bound criterion checks supplied by the composing Chat before a draft digest is minted. */
  readonly checkRequirements?:
    | ((
        items: readonly StagedJiraDraftItem[],
        context: Context,
      ) => { readonly data: CatalogJsonObject; readonly violationCount: number } | undefined)
    | undefined;
  /**
   * Rewrites a well-formed page before anything reads it: the checks, the store and the draft digest
   * all see the projected items, so preview, approval, replay and Jira hold the same text.
   */
  readonly projectItems?:
    | ((items: readonly StagedJiraDraftItem[], context: Context) => readonly StagedJiraDraftItem[])
    | undefined;
  readonly now?: (() => number) | undefined;
}

export type JiraDraftPreparation =
  | {
      readonly ok: true;
      readonly items: readonly StagedJiraDraftItem[];
      readonly sourceBindings: readonly JiraDraftSourceBinding[];
    }
  | { readonly ok: false; readonly data: CatalogJsonObject; readonly violationCount: number };

const DRAFT_ID = new RegExp(JIRA_DRAFT_ID_PATTERN, "u");
const DRAFT_DIGEST = new RegExp(JIRA_DRAFT_DIGEST_PATTERN, "u");
const UNRESOLVED_LISTED_MAX = 32;
const STAGE_KEYS: ReadonlySet<string> = new Set(["draftId", "items"]);

interface StageArgs {
  readonly draftId: string | undefined;
  readonly items: readonly StagedJiraDraftItem[];
}
/**
 * What to correct in a page that is not well formed. The catalog declares the shared draft item
 * form; this handler revalidates it and names the first item that does not match (counting from 1).
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

/** The key a relation to another draft item stands for until that item exists. */
function standInLinks(item: StagedJiraDraftItem): readonly CatalogJsonObject[] {
  const links: unknown = item.links;
  if (!Array.isArray(links)) return [];
  return (links as readonly Record<string, unknown>[]).map(
    (link) =>
      ({
        type: link.type,
        direction: link.direction,
        issueKey: typeof link.issueKey === "string" ? link.issueKey : JIRA_DRAFT_STAND_IN_KEY,
      }) as CatalogJsonObject,
  );
}
/**
 * The create the item stands for. A parent or link target held by another draft item gets a
 * stand-in key; the relations themselves are kept, because a template may require one (a
 * `parentLink`) and the item that will be created carries exactly these.
 */
export function jiraDraftTemplateSource(item: StagedJiraDraftItem): CatalogJsonObject {
  const fields = (item.fields ?? {}) as Record<string, unknown>;
  const parent = draftParentOf(item);
  const links = standInLinks(item);
  return {
    projectId: item.projectId,
    issueTypeId: item.issueTypeId,
    fields: {
      ...fields,
      ...(parent === undefined
        ? {}
        : { [parent.fieldId]: parent.issueKey ?? JIRA_DRAFT_STAND_IN_KEY }),
    },
    ...(links.length === 0 ? {} : { links }),
  } as CatalogJsonObject;
}
/** The field and, for an issue that already exists in Jira, the key the item's parent has. */
function draftParentOf(
  item: StagedJiraDraftItem,
): { readonly fieldId: string; readonly issueKey?: string } | undefined {
  const parent = item.parent as
    { readonly fieldId?: unknown; readonly issueKey?: unknown } | undefined;
  if (typeof parent?.fieldId !== "string") return undefined;
  return typeof parent.issueKey === "string"
    ? { fieldId: parent.fieldId, issueKey: parent.issueKey }
    : { fieldId: parent.fieldId };
}
/**
 * A parent that is another item of the draft does not exist yet, so its issue type cannot be read
 * now. That one check stays with the create gate, which reads the created parent before the write;
 * every other violation, and every violation of an item whose parent already exists, refuses here.
 */
function decidableNow(
  item: StagedJiraDraftItem,
  violations: readonly JiraTemplateViolation[],
): readonly JiraTemplateViolation[] {
  const parent = draftParentOf(item);
  if (parent === undefined || parent.issueKey !== undefined) return violations;
  return violations.filter(
    (violation) =>
      !(violation.ruleId === "template-unreadable" && violation.subject === parent.fieldId),
  );
}

export interface JiraDraftTemplateRefusal {
  readonly ref: string;
  readonly violations: readonly JiraTemplateViolation[];
}
/** The answer of the template dry run when Jira could not be read, so nothing more is read. */
export const JIRA_DRAFT_TEMPLATE_UNREADABLE = "jira-unreadable" as const;
/**
 * Every item passes the template check a create passes, now, so the model corrects an item while it
 * is being written instead of after the human has been asked. Items are read one after another
 * because each check reads Jira's metadata through the same bounded connection.
 */
export async function firstJiraDraftTemplateRefusal(
  items: readonly StagedJiraDraftItem[],
  context: ManagedMcpInvocationContext,
  connection: JiraManagedConnection,
  index = 0,
): Promise<JiraDraftTemplateRefusal | typeof JIRA_DRAFT_TEMPLATE_UNREADABLE | undefined> {
  const item = items[index];
  if (item === undefined) return undefined;
  const result = await checkJiraManagedMutationTemplates(
    "jira.create",
    jiraDraftTemplateSource(item),
    context,
    connection,
  );
  // Jira could not be read: every later item reads the same metadata and would wait the same.
  if (!result.ok && result.violations === undefined && result.reason === "unavailable")
    return JIRA_DRAFT_TEMPLATE_UNREADABLE;
  const violations =
    result.ok || result.violations === undefined ? [] : decidableNow(item, result.violations);
  if (violations.length > 0) return { ref: String(item.ref), violations };
  return firstJiraDraftTemplateRefusal(items, context, connection, index + 1);
}

/**
 * The next step of a complete draft. A model that read "reviewable" asked the person to confirm a
 * creation they had already requested, twice in one live rehearsal (#4287); approval belongs to
 * jira.draft, which applies the Chat's access mode itself.
 */
export const JIRA_DRAFT_READY_GUIDANCE =
  "The draft is complete. If the user asked to create these issues, call jira.draft now with only " +
  "draftId and draftDigest. Keiko asks for any approval this Chat's access mode requires; do not ask " +
  "the user to confirm again.";

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
      ...(unresolved.length === 0 ? { guidance: JIRA_DRAFT_READY_GUIDANCE } : {}),
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
/**
 * One fixed sentence for each refusal that says what to do next (#4357 AC3). A code alone left a model
 * to guess whether to stage again, give up or ask. `invalid-fields` and `template-violation` carry
 * their own results.
 */
const REFUSAL_GUIDANCE: Readonly<Partial<Record<JiraDraftRefusal, string>>> = {
  "too-large": JIRA_DRAFT_TOO_LARGE_GUIDANCE,
  "draft-not-found":
    "No draft with this draftId is held for this Chat, so nothing was staged. Stage the items again with jira.draft-stage and use the draftId it returns; do not invent one.",
  "connection-changed":
    "The Jira connection changed since this draft was staged, so it cannot be extended. Stage the items again with jira.draft-stage. Nothing was staged.",
  "duplicate-ref":
    "Two items of the draft use the same ref. Give every item its own ref and stage the page again; nothing was staged.",
  "unsupported-deployment":
    "Drafts work with Jira Data Center only, and this connection is not one. Tell the user a draft cannot be staged here. Nothing was staged.",
  "invalid-input":
    "An item of this page did not pass Keiko's check of its fields, links or requirement references. Send the page again with every item in the jira.draft item form; nothing was staged.",
};
function guidanceOf(refusal: JiraDraftRefusal): Record<string, string> {
  const guidance = REFUSAL_GUIDANCE[refusal];
  return guidance === undefined ? {} : { guidance };
}

interface StageRun<Context extends ManagedMcpInvocationContext> {
  readonly deps: JiraDraftToolDeps<Context>;
  readonly context: Context;
  readonly args: StageArgs | undefined;
  readonly startedAt: number;
  readonly reads: JiraDraftReadCounts;
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
      { refusal, ...readActivity(run.reads), ...extra },
    ),
    context,
  );
  const failure = jiraReadFailure(refusal);
  return { ...failure, data: { ...failure.data, ...guidanceOf(refusal) } };
}
function readActivity(
  reads: JiraDraftReadCounts,
): Pick<JiraDraftActivity, "readCount" | "readReusedCount"> {
  return { readCount: reads.made, readReusedCount: reads.reused };
}
function templateRefusalResult<Context extends ManagedMcpInvocationContext>(
  refusal: JiraDraftTemplateRefusal,
  run: StageRun<Context>,
  pageItemCount: number,
): ManagedMcpToolResult {
  refuseStage(run, "template-violation", pageItemCount, {
    violationCount: refusal.violations.length,
    violationRuleCounts: countJiraTemplateViolations(refusal.violations),
  });
  const guidance = jiraTemplateViolationGuidance(refusal.violations);
  return {
    isError: true,
    data: {
      outcome: "rejected",
      reason: "field-validation",
      ref: refusal.ref,
      ...(guidance === undefined ? {} : { guidance }),
      violations: refusal.violations.map((violation) => ({ ...violation })),
    },
  };
}

function fieldRefusalResult(refusal: JiraDraftFieldRefusal): ManagedMcpToolResult {
  return {
    isError: true,
    data: {
      outcome: "rejected",
      reason: "field-validation",
      ref: refusal.ref,
      ...(refusal.detail.fieldId === undefined ? {} : { fieldId: refusal.detail.fieldId }),
      ...(refusal.detail.validation === undefined ? {} : { validation: refusal.detail.validation }),
      ...(refusal.detail.messages === undefined ? {} : { messages: [...refusal.detail.messages] }),
    },
  };
}
/**
 * The field check a create passes, while the item is being written: a large draft that a later
 * approval would refuse would have to be staged again. An item's identity needs the whole draft, so
 * a staged item is not looked up; one that exists already corrects its fields and still reconciles.
 */
function pageFieldRefusals(
  items: readonly StagedJiraDraftItem[],
  context: ManagedMcpInvocationContext,
  connection: JiraManagedConnection,
): ReturnType<typeof jiraDraftFieldRefusals> {
  const parsed = items
    .map((item) => jiraDraftStagedItem(item))
    .filter((item): item is JiraDraftItem => item !== undefined);
  return jiraDraftFieldRefusals(parsed, context, connection, { reconcile: false });
}

function preparePageRequirements<Context extends ManagedMcpInvocationContext>(
  run: StageRun<Context>,
  items: readonly StagedJiraDraftItem[],
): JiraDraftPreparation {
  if (run.deps.prepareRequirements !== undefined)
    return run.deps.prepareRequirements(items, run.context);
  const requirements = run.deps.checkRequirements?.(items, run.context);
  return requirements === undefined
    ? { ok: true, items, sourceBindings: [] }
    : { ok: false, ...requirements };
}

function validPreparedPage(
  original: readonly StagedJiraDraftItem[],
  prepared: Extract<JiraDraftPreparation, { readonly ok: true }>,
): boolean {
  return (
    prepared.items.length === original.length &&
    prepared.items.every(
      (item, index) => isJiraDraftItem(item) && item.ref === original[index]?.ref,
    ) &&
    validJiraDraftSourceBindings(prepared.items, prepared.sourceBindings)
  );
}

function stagedActivity<Context extends ManagedMcpInvocationContext>(
  run: StageRun<Context>,
  draft: StagedJiraDraft,
  args: StageArgs,
  now: () => number,
): void {
  run.deps.activity?.(
    activityOf(
      {
        phase: "staged",
        newDraft: args.draftId === undefined,
        pageItemCount: args.items.length,
        durationMs: now() - run.startedAt,
      },
      draft,
      readActivity(run.reads),
    ),
    run.context,
  );
}

/** The page after the composing server's projection; later checks see only the projected items. */
function projectedStageArgs<Context extends ManagedMcpInvocationContext>(
  parsed: StageArgs | undefined,
  deps: JiraDraftToolDeps<Context>,
  context: Context,
): StageArgs | undefined {
  if (parsed === undefined || deps.projectItems === undefined) return parsed;
  return { ...parsed, items: deps.projectItems(parsed.items, context) };
}

function invalidArgsRefusal<Context extends ManagedMcpInvocationContext>(
  run: StageRun<Context>,
  rawArgs: CatalogJsonObject,
): ManagedMcpToolResult {
  const refused = refuseStage(run, "invalid-input", 0);
  return { ...refused, data: { ...refused.data, guidance: invalidPageGuidance(rawArgs) } };
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
  const parsed = parseStageArgs(rawArgs);
  const args = projectedStageArgs(parsed, deps, context);
  const run: StageRun<Context> = { deps, context, args, startedAt, reads: { made: 0, reused: 0 } };
  if (args === undefined) return invalidArgsRefusal(run, rawArgs);
  if (connection.deployment !== "data-center") return refuseStage(run, "unsupported-deployment", 0);
  const prepared = preparePageRequirements(run, args.items);
  if (!prepared.ok) {
    refuseStage(run, "invalid-fields", args.items.length, {
      violationCount: prepared.violationCount,
    });
    return { isError: true, data: prepared.data };
  }
  if (!validPreparedPage(args.items, prepared))
    return refuseStage(run, "invalid-input", args.items.length);
  const { items, sourceBindings } = deepFreeze(structuredClone(prepared));
  // The checks below read the same Jira metadata for every item of the page, and a batch stages
  // page after page in one invocation: identical reads are answered from the invocation's memo.
  const reads = withJiraDraftReadMemo(connection, context, run.reads, now);
  const template = await firstJiraDraftTemplateRefusal(items, context, reads);
  if (template !== undefined && template !== JIRA_DRAFT_TEMPLATE_UNREADABLE)
    return templateRefusalResult(template, run, args.items.length);
  const fields = await pageFieldRefusals(items, context, reads);
  const firstField = fields.refusals[0];
  if (firstField !== undefined) {
    refuseStage(run, "invalid-fields", args.items.length, { violationCount: fields.total });
    return fieldRefusalResult(firstField);
  }
  const appended = deps.store.append(
    deps.owner(context),
    args.draftId,
    connectionFingerprint(connection),
    items,
    sourceBindings,
  );
  if (!appended.ok) return refuseStage(run, appended.refusal, args.items.length);
  stagedActivity(run, appended.draft, args, now);
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
  | {
      readonly ok: false;
      readonly reason: "draft-not-found" | "draft-changed" | "connection-changed";
    };

/**
 * The staged draft a `jira.draft` call names, as the `{ items }` arguments every consumer parses.
 * `undefined` when the call does not name a staged draft. The digest the call carries must be the
 * digest of the items held now: a draft extended after the digest was read is a different draft.
 * A draft resolves only under the connection it was stored with: project and issue-type ids repeat
 * between Jira instances, so after a Pod switch the old draft must never run on the new Jira. No
 * current connection (`undefined`) resolves nothing.
 */
export function resolveJiraDraftArguments(
  args: Readonly<Record<string, unknown>>,
  lookup: (draftId: string) => StagedJiraDraft | undefined,
  currentFingerprint: string | undefined,
): JiraDraftResolution | undefined {
  if (!("draftId" in args) && !("draftDigest" in args)) return undefined;
  const reference = parseJiraDraftReference(args);
  const draft = reference === undefined ? undefined : lookup(reference.draftId);
  if (reference === undefined || draft === undefined)
    return { ok: false, reason: "draft-not-found" };
  if (draft.fingerprint !== currentFingerprint) return { ok: false, reason: "connection-changed" };
  return draft.digest === reference.draftDigest &&
    jiraDraftDigest(draft.items, draft.sourceBindings) === draft.digest
    ? { ok: true, arguments: { items: draft.items } as CatalogJsonObject }
    : { ok: false, reason: "draft-changed" };
}
