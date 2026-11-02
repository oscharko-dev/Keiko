import {
  checkJiraDraft,
  resolveJiraDraftArguments,
  type JiraDraftProblem,
  type JiraDraftStore,
} from "@oscharko-dev/keiko-connectors";
import type { JiraDraftRefusalReason } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";

/**
 * The `{ items }` arguments of a `jira.draft` call: the call's own when it carries them, or the
 * staged draft it names (owned by the Chat, with the digest it was approved against). Every consumer
 * of a draft's items reads them through here, so a draft is judged on exactly one item list.
 */
export type ChatDraftArguments =
  | { readonly ok: true; readonly arguments: CatalogJsonObject; readonly staged: boolean }
  | {
      readonly ok: false;
      readonly reason: JiraDraftRefusalReason;
      /** Why a resolved draft is invalid, and the 1-based item it concerns. */
      readonly problem?: JiraDraftProblem;
      readonly item?: number;
    };

export function chatDraftArguments(
  store: JiraDraftStore | undefined,
  chatId: string,
  args: Readonly<Record<string, unknown>>,
): ChatDraftArguments {
  const resolved = resolveJiraDraftArguments(args, (draftId) => store?.get(draftId, chatId));
  if (resolved === undefined)
    return { ok: true, arguments: args as CatalogJsonObject, staged: false };
  return resolved.ok
    ? { ok: true, arguments: resolved.arguments, staged: true }
    : { ok: false, reason: resolved.reason };
}

/** A draft that resolves but cannot be run (an unknown relation, a cycle, a bound) is invalid. */
export function readableChatDraft(
  store: JiraDraftStore | undefined,
  chatId: string,
  args: Readonly<Record<string, unknown>>,
): ChatDraftArguments {
  const resolved = chatDraftArguments(store, chatId, args);
  if (!resolved.ok) return resolved;
  const checked = checkJiraDraft(resolved.arguments);
  if (checked.ok) return resolved;
  return {
    ok: false,
    reason: "draft-invalid",
    problem: checked.problem,
    ...(checked.item === undefined ? {} : { item: checked.item }),
  };
}

/**
 * What the model is told when a draft is refused before anything is sent: fixed sentences from a
 * closed vocabulary, never the model's own text. An item-level sentence continues "Item N ".
 */
const PROBLEM_GUIDANCE: Readonly<Record<JiraDraftProblem, string>> = {
  "draft-shape":
    "The draft takes an items array, or the draftId and draftDigest of a staged draft.",
  "items-missing": "The draft needs items: a non-empty array of draft items.",
  "item-shape":
    "is not an object with only ref, projectId, issueTypeId, fields, parent, links and requirementIds.",
  "item-ref":
    "needs a ref: a short name that starts with a letter and holds only letters, digits, - or _. Other items name this item by it.",
  "item-ids":
    "needs projectId and issueTypeId as numeric id strings from the project and issue-type reads, not keys or names.",
  "item-fields":
    "needs fields with a non-empty summary, without the field its parent relation writes, and without project or issuetype naming another project or issue type than its projectId and issueTypeId. A parent goes only in the item's parent.",
  "item-parent":
    "has a malformed parent. Nest an item by giving it parent { fieldId, ref } for an item of this draft, or { fieldId, issueKey } for an existing issue, with fieldId the relation field named in the child's create fields.",
  "item-links":
    "has a malformed link. A link needs type, direction and exactly one of ref (an item of this draft) or issueKey (an existing issue).",
  "item-requirements":
    "has malformed requirementIds: a short non-empty list of plain requirement references.",
  "ref-duplicate": "Two items share a ref. Give every item its own ref.",
  "ref-self": "names itself as its parent or link target.",
  "ref-unknown":
    "names a ref that no item of this draft has. Add that item to this draft, or name an existing issue with issueKey.",
  "ref-cycle":
    "The parent and link relations form a cycle. A parent must be an item that does not depend on its child.",
};
const DRAFT_REFUSED = "Nothing was changed. Correct the draft and send it once.";
export function jiraDraftProblemGuidance(
  problem: JiraDraftProblem,
  item: number | undefined,
): string {
  const sentence = PROBLEM_GUIDANCE[problem];
  const named = item === undefined ? sentence : `Item ${String(item)} ${sentence}`;
  return `${named} ${DRAFT_REFUSED}`;
}

/**
 * The structured refusal the model corrects. An invalid draft carries the fixed sentence for its
 * closed problem and item number, so the model learns what to correct; it never echoes a field
 * value, key or text of the draft.
 */
export function draftRefusalData(
  refusal: Extract<ChatDraftArguments, { ok: false }>,
): CatalogJsonObject {
  return {
    outcome: "rejected",
    reason: "field-validation",
    draftRefusal: refusal.reason,
    ...(refusal.problem === undefined
      ? {}
      : { guidance: jiraDraftProblemGuidance(refusal.problem, refusal.item) }),
    items: [],
  };
}
