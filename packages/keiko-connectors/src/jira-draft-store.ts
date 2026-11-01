import { randomUUID } from "node:crypto";
import {
  JIRA_DRAFT_ITEMS_MAX,
  JIRA_DRAFT_STAGE_BYTES_MAX,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security";
import { trimOwnedBytes } from "./jira-store-bounds.js";

/** One validated item as the model sent it; relations are resolved only when the draft is run. */
export type StagedJiraDraftItem = Readonly<Record<string, unknown>>;

/**
 * A backlog draft being assembled in pages (#4178). It lives in memory only: the model appends
 * validated pages, then asks for one approval of the whole draft by naming it and the digest of
 * its exact item list. Idle drafts expire, one owner holds a bounded number (its oldest go first)
 * and beyond the shared byte budget the owner holding the most is trimmed first.
 */
export interface StagedJiraDraft {
  readonly id: string;
  readonly owner: string;
  /** The Jira instance and credential the draft was started with; never the credential. */
  readonly fingerprint: string;
  readonly items: readonly StagedJiraDraftItem[];
  /** Canonical JSON bytes of the items; the resource bound is measured on this. */
  readonly bytes: number;
  readonly pageCount: number;
  /** Commits to the exact item list and its order. */
  readonly digest: string;
  readonly lastUsedAt: number;
}

export type JiraDraftAppend =
  | { readonly ok: true; readonly draft: StagedJiraDraft }
  | {
      readonly ok: false;
      readonly refusal:
        "draft-not-found" | "connection-changed" | "duplicate-ref" | "too-many-items" | "too-large";
    };

export interface JiraDraftStore {
  /** Appends one validated page; a refused page changes nothing. */
  readonly append: (
    owner: string,
    draftId: string | undefined,
    fingerprint: string,
    page: readonly StagedJiraDraftItem[],
  ) => JiraDraftAppend;
  /** The draft only for the owner that started it; anything else is indistinguishable from absent. */
  readonly get: (id: string, owner: string) => StagedJiraDraft | undefined;
  /** The same lookup without renewing the expiry: reading a draft is not use of it. */
  readonly peek: (id: string, owner: string) => StagedJiraDraft | undefined;
  readonly size: () => number;
}

export interface JiraDraftStoreOptions {
  readonly now?: () => number;
  readonly newId?: () => string;
  readonly idleTtlMs?: number;
  readonly maxTotalBytes?: number;
  readonly maxDraftsPerOwner?: number;
}

export const JIRA_DRAFT_IDLE_TTL_MS = 4 * 60 * 60 * 1000;
/** Retained size of all staged drafts together; a memory safety bound, never a draft limit. */
export const JIRA_DRAFT_STORE_MAX_BYTES = 64 * 1024 * 1024;
export const JIRA_DRAFT_OWNER_DRAFTS_MAX = 8;

type Drafts = Map<string, StagedJiraDraft>;

/** The digest an approval commits to: the items in the order they were staged. */
export function jiraDraftDigest(items: readonly StagedJiraDraftItem[]): string {
  return sha256Hex(canonicalise({ items }));
}
function itemBytes(item: StagedJiraDraftItem): number {
  return Buffer.byteLength(canonicalise(item));
}
function oldestFirst(drafts: Drafts, owner?: string): StagedJiraDraft[] {
  return [...drafts.values()]
    .filter((draft) => owner === undefined || draft.owner === owner)
    .sort((left, right) => left.lastUsedAt - right.lastUsedAt);
}
function trimOwner(drafts: Drafts, owner: string, limit: number): void {
  const held = oldestFirst(drafts, owner);
  for (const draft of held.slice(0, Math.max(0, held.length - limit))) drafts.delete(draft.id);
}
function trimBytes(drafts: Drafts, limit: number): void {
  trimOwnedBytes(drafts, limit, (owner) => oldestFirst(drafts, owner)[0]);
}
function refsOf(items: readonly StagedJiraDraftItem[]): ReadonlySet<string> {
  return new Set(items.map((item) => item.ref).filter((ref) => typeof ref === "string"));
}

type AppendRefusal = Extract<JiraDraftAppend, { readonly ok: false }>["refusal"];

/** Why a page cannot be appended to the draft it names (or to a new one), or undefined. */
function appendRefusal(
  current: StagedJiraDraft | undefined,
  fingerprint: string,
  page: readonly StagedJiraDraftItem[],
  bytes: number,
): AppendRefusal | undefined {
  if (current !== undefined && current.fingerprint !== fingerprint) return "connection-changed";
  const held = current?.items ?? [];
  const refs = refsOf(held);
  if (page.some((item) => refs.has(String(item.ref)))) return "duplicate-ref";
  if (held.length + page.length > JIRA_DRAFT_ITEMS_MAX) return "too-many-items";
  return bytes > JIRA_DRAFT_STAGE_BYTES_MAX ? "too-large" : undefined;
}
function extendedDraft(
  current: StagedJiraDraft | undefined,
  page: readonly StagedJiraDraftItem[],
  base: Pick<StagedJiraDraft, "id" | "owner" | "fingerprint" | "bytes" | "lastUsedAt">,
): StagedJiraDraft {
  const items = [...(current?.items ?? []), ...page];
  return Object.freeze({
    ...base,
    items: Object.freeze(items),
    pageCount: (current?.pageCount ?? 0) + 1,
    digest: jiraDraftDigest(items),
  });
}
function pageBytes(page: readonly StagedJiraDraftItem[]): number {
  return page.reduce((sum, item) => sum + itemBytes(item), 0);
}

export function createJiraDraftStore(options: JiraDraftStoreOptions = {}): JiraDraftStore {
  const now = options.now ?? Date.now;
  const newId = options.newId ?? randomUUID;
  const idleTtlMs = options.idleTtlMs ?? JIRA_DRAFT_IDLE_TTL_MS;
  const maxTotalBytes = options.maxTotalBytes ?? JIRA_DRAFT_STORE_MAX_BYTES;
  const perOwner = options.maxDraftsPerOwner ?? JIRA_DRAFT_OWNER_DRAFTS_MAX;
  const drafts: Drafts = new Map();
  const sweep = (): void => {
    const cutoff = now() - idleTtlMs;
    for (const [id, draft] of drafts) if (draft.lastUsedAt < cutoff) drafts.delete(id);
    trimBytes(drafts, maxTotalBytes);
  };
  const peek = (id: string, owner: string): StagedJiraDraft | undefined => {
    sweep();
    const draft = drafts.get(id);
    return draft?.owner === owner ? draft : undefined;
  };
  return {
    append: (owner, draftId, fingerprint, page): JiraDraftAppend => {
      const current = draftId === undefined ? undefined : peek(draftId, owner);
      if (draftId !== undefined && current === undefined)
        return { ok: false, refusal: "draft-not-found" };
      const bytes = (current?.bytes ?? 0) + pageBytes(page);
      const refusal = appendRefusal(current, fingerprint, page, bytes);
      if (refusal !== undefined) return { ok: false, refusal };
      const draft = extendedDraft(current, page, {
        id: current?.id ?? newId(),
        owner,
        fingerprint,
        bytes,
        lastUsedAt: now(),
      });
      drafts.set(draft.id, draft);
      trimOwner(drafts, owner, perOwner);
      trimBytes(drafts, maxTotalBytes);
      return { ok: true, draft };
    },
    get: (id, owner): StagedJiraDraft | undefined => {
      const draft = peek(id, owner);
      if (draft === undefined) return undefined;
      const renewed: StagedJiraDraft = Object.freeze({ ...draft, lastUsedAt: now() });
      drafts.set(id, renewed);
      return renewed;
    },
    peek,
    size: () => drafts.size,
  };
}
