import { randomUUID } from "node:crypto";
import { JIRA_DRAFT_STAGE_BYTES_MAX } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { deepFreeze } from "@oscharko-dev/keiko-contracts/runtime/deep-freeze";
import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security";
import { trimOwnedBytes } from "./jira-store-bounds.js";

/** One validated, source-prepared item; relations are resolved only when the draft is run. */
export type StagedJiraDraftItem = Readonly<Record<string, unknown>>;

/** Server-owned commitment to the full source revision and prepared payload for one item. */
export interface JiraDraftSourceBinding {
  readonly ref: string;
  readonly sourceDigest: string;
}

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
  /** Private source revisions; never accepted from model arguments or emitted as tool data. */
  readonly sourceBindings?: readonly JiraDraftSourceBinding[];
  /** Canonical JSON bytes retained for items and source bindings. */
  readonly bytes: number;
  readonly pageCount: number;
  /** Commits to the exact item list, its order and any private source revisions. */
  readonly digest: string;
  readonly lastUsedAt: number;
}

export type JiraDraftAppend =
  | { readonly ok: true; readonly draft: StagedJiraDraft }
  | {
      readonly ok: false;
      readonly refusal:
        "draft-not-found" | "connection-changed" | "duplicate-ref" | "too-large" | "invalid-input";
    };

export interface JiraDraftStore {
  /** Appends one validated page; a refused page changes nothing. */
  readonly append: (
    owner: string,
    draftId: string | undefined,
    fingerprint: string,
    page: readonly StagedJiraDraftItem[],
    sourceBindings?: readonly JiraDraftSourceBinding[],
  ) => JiraDraftAppend;
  /** The draft only for the owner that started it; anything else is indistinguishable from absent. */
  readonly get: (id: string, owner: string) => StagedJiraDraft | undefined;
  /** The same lookup without renewing the expiry: reading a draft is not use of it. */
  readonly peek: (id: string, owner: string) => StagedJiraDraft | undefined;
  /**
   * The owner's most recently used draft that is still open, without renewing it; none once every
   * one expired or was completed.
   */
  readonly latest: (owner: string) => StagedJiraDraft | undefined;
  /**
   * Records that every item of this exact draft revision is settled in Jira. The draft stays
   * readable, so a retry still reconciles it, but it is no longer the owner's open draft; a page
   * appended later makes a new revision that is open again.
   */
  readonly complete: (id: string, owner: string, digest: string) => void;
  readonly size: () => number;
}

export interface JiraDraftStoreOptions {
  /** Retained bytes one draft may hold; defaults to the contract's resource bound. */
  readonly maxDraftBytes?: number;
  readonly now?: () => number;
  readonly newId?: () => string;
  readonly idleTtlMs?: number;
  readonly maxTotalBytes?: number;
  readonly maxDraftsPerOwner?: number;
}

export const JIRA_DRAFT_IDLE_TTL_MS = 4 * 60 * 60 * 1000;
/** Retained size of all staged drafts together; a memory safety bound, never a draft limit. */
export const JIRA_DRAFT_STORE_MAX_BYTES = 96 * 1024 * 1024;
export const JIRA_DRAFT_OWNER_DRAFTS_MAX = 8;

type Drafts = Map<string, StagedJiraDraft>;

/** The exact staged payload and private revisions the approval commits to. */
export function jiraDraftDigest(
  items: readonly StagedJiraDraftItem[],
  sourceBindings: readonly JiraDraftSourceBinding[] = [],
): string {
  return sha256Hex(
    canonicalise({ items, ...(sourceBindings.length === 0 ? {} : { sourceBindings }) }),
  );
}

function isSourceBinding(value: unknown): value is JiraDraftSourceBinding {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const binding = value as Record<string, unknown>;
  return (
    Object.keys(binding).length === 2 &&
    typeof binding.ref === "string" &&
    typeof binding.sourceDigest === "string" &&
    /^[a-f0-9]{64}$/u.test(binding.sourceDigest)
  );
}

/** Every binding belongs to exactly one item on this page and contains only its full digest. */
export function validJiraDraftSourceBindings(
  page: readonly StagedJiraDraftItem[],
  sourceBindings: unknown,
): sourceBindings is readonly JiraDraftSourceBinding[] {
  if (!Array.isArray(sourceBindings)) return false;
  const refs = refsOf(page);
  const seen = new Set<string>();
  return sourceBindings.every((binding: unknown) => {
    if (!isSourceBinding(binding) || !refs.has(binding.ref) || seen.has(binding.ref)) return false;
    seen.add(binding.ref);
    return true;
  });
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
/** A ref repeated within the page itself, or one the draft already holds. */
function repeatsRef(held: ReadonlySet<string>, page: readonly StagedJiraDraftItem[]): boolean {
  const seen = new Set(held);
  return page.some((item) => {
    const ref = String(item.ref);
    const repeated = seen.has(ref);
    seen.add(ref);
    return repeated;
  });
}

type AppendRefusal = Extract<JiraDraftAppend, { readonly ok: false }>["refusal"];

/** Why a page cannot be appended to the draft it names (or to a new one), or undefined. */
function appendRefusal(
  current: StagedJiraDraft | undefined,
  fingerprint: string,
  page: readonly StagedJiraDraftItem[],
  bytes: number,
  maxDraftBytes: number,
): AppendRefusal | undefined {
  if (current !== undefined && current.fingerprint !== fingerprint) return "connection-changed";
  if (repeatsRef(refsOf(current?.items ?? []), page)) return "duplicate-ref";
  return bytes > maxDraftBytes ? "too-large" : undefined;
}
function extendedDraft(
  current: StagedJiraDraft | undefined,
  page: readonly StagedJiraDraftItem[],
  pageBindings: readonly JiraDraftSourceBinding[],
  base: Pick<StagedJiraDraft, "id" | "owner" | "fingerprint" | "bytes" | "lastUsedAt">,
): StagedJiraDraft {
  const items = [...(current?.items ?? []), ...structuredClone(page)];
  const sourceBindings = [...(current?.sourceBindings ?? []), ...structuredClone(pageBindings)];
  return deepFreeze({
    ...base,
    items,
    ...(sourceBindings.length === 0 ? {} : { sourceBindings }),
    pageCount: (current?.pageCount ?? 0) + 1,
    digest: jiraDraftDigest(items, sourceBindings),
  });
}
function pageBytes(page: readonly StagedJiraDraftItem[]): number {
  return page.reduce((sum, item) => sum + itemBytes(item), 0);
}
function retainedDraftBytes(
  current: StagedJiraDraft | undefined,
  page: readonly StagedJiraDraftItem[],
  sourceBindings: readonly JiraDraftSourceBinding[],
): number | undefined {
  if (!validJiraDraftSourceBindings(page, sourceBindings)) return undefined;
  const bindingBytes = sourceBindings.reduce(
    (sum, binding) => sum + Buffer.byteLength(canonicalise(binding)),
    0,
  );
  return (current?.bytes ?? 0) + pageBytes(page) + bindingBytes;
}

function retainDraft(
  drafts: Drafts,
  draft: StagedJiraDraft,
  bounds: { readonly perOwner: number; readonly maxTotalBytes: number },
): void {
  drafts.set(draft.id, draft);
  trimOwner(drafts, draft.owner, bounds.perOwner);
  trimBytes(drafts, bounds.maxTotalBytes);
}

/** The drafts still held: idle ones expired and the shared byte bound kept. */
function sweeper(
  drafts: Drafts,
  bounds: {
    readonly now: () => number;
    readonly idleTtlMs: number;
    readonly maxTotalBytes: number;
  },
): () => Drafts {
  return (): Drafts => {
    const cutoff = bounds.now() - bounds.idleTtlMs;
    for (const [id, draft] of drafts) if (draft.lastUsedAt < cutoff) drafts.delete(id);
    trimBytes(drafts, bounds.maxTotalBytes);
    return drafts;
  };
}

/** Revisions by draft id whose items are all settled; a draft whose digest moved on is open again. */
function settledRevisions(drafts: Drafts): {
  readonly isOpen: (draft: StagedJiraDraft) => boolean;
  readonly settle: (id: string, digest: string) => void;
} {
  const completed = new Map<string, string>();
  return {
    isOpen: (draft): boolean => completed.get(draft.id) !== draft.digest,
    settle: (id, digest): void => {
      completed.set(id, digest);
      for (const known of completed.keys()) if (!drafts.has(known)) completed.delete(known);
    },
  };
}

export function createJiraDraftStore(options: JiraDraftStoreOptions = {}): JiraDraftStore {
  const now = options.now ?? Date.now;
  const newId = options.newId ?? randomUUID;
  const idleTtlMs = options.idleTtlMs ?? JIRA_DRAFT_IDLE_TTL_MS;
  const maxTotalBytes = options.maxTotalBytes ?? JIRA_DRAFT_STORE_MAX_BYTES;
  const maxDraftBytes = options.maxDraftBytes ?? JIRA_DRAFT_STAGE_BYTES_MAX;
  const perOwner = options.maxDraftsPerOwner ?? JIRA_DRAFT_OWNER_DRAFTS_MAX;
  const drafts: Drafts = new Map();
  const swept = sweeper(drafts, { now, idleTtlMs, maxTotalBytes });
  const peek = (id: string, owner: string): StagedJiraDraft | undefined => {
    const draft = swept().get(id);
    return draft?.owner === owner ? draft : undefined;
  };
  const settled = settledRevisions(drafts);
  return {
    append: (owner, draftId, fingerprint, page, sourceBindings = []): JiraDraftAppend => {
      const current = draftId === undefined ? undefined : peek(draftId, owner);
      if (draftId !== undefined && current === undefined)
        return { ok: false, refusal: "draft-not-found" };
      const bytes = retainedDraftBytes(current, page, sourceBindings);
      if (bytes === undefined) return { ok: false, refusal: "invalid-input" };
      const refusal = appendRefusal(current, fingerprint, page, bytes, maxDraftBytes);
      if (refusal !== undefined) return { ok: false, refusal };
      const draft = extendedDraft(current, page, sourceBindings, {
        id: current?.id ?? newId(),
        owner,
        fingerprint,
        bytes,
        lastUsedAt: now(),
      });
      retainDraft(drafts, draft, { perOwner, maxTotalBytes });
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
    latest: (owner): StagedJiraDraft | undefined =>
      oldestFirst(swept(), owner).filter(settled.isOpen).at(-1),
    complete: (id, owner, digest): void => {
      if (peek(id, owner)?.digest === digest) settled.settle(id, digest);
    },
    size: () => drafts.size,
  };
}
