import {
  parseJiraDraft,
  resolveJiraDraftArguments,
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
  | { readonly ok: false; readonly reason: JiraDraftRefusalReason };

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
  return resolved.ok && parseJiraDraft(resolved.arguments) === undefined
    ? { ok: false, reason: "draft-invalid" }
    : resolved;
}

/** The structured refusal the model corrects; it names no item, field value or key. */
export function draftRefusalData(reason: JiraDraftRefusalReason): CatalogJsonObject {
  return { outcome: "rejected", reason: "field-validation", draftRefusal: reason, items: [] };
}
