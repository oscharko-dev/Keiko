// The explicit state of a repository's HEAD for the verified-commit lane (#4491). A fresh
// `git init` leaves HEAD symbolic on a branch whose ref does not exist yet: that is a real,
// committable state (the next commit is a root commit), never "unknown". It is therefore a closed
// discriminated union, not an empty string or an optional sha, so no caller can confuse "unborn"
// with "not read".

/** The length of a Git object id in hex: SHA-1 (40) or SHA-256 (64) object format. */
export type GitObjectIdLength = 40 | 64;

export type GitHeadState =
  | { readonly kind: "born"; readonly sha: string }
  | {
      readonly kind: "unborn";
      /** The branch HEAD names; its ref does not exist yet. */
      readonly branch: string;
      readonly objectIdLength: GitObjectIdLength;
    };

export function gitHeadObjectIdLength(state: GitHeadState): GitObjectIdLength {
  if (state.kind === "unborn") return state.objectIdLength;
  return state.sha.length === 64 ? 64 : 40;
}

/** Git's own notation for "no object": the old value of a ref that must not exist yet. */
export function gitZeroObjectId(length: GitObjectIdLength): string {
  return "0".repeat(length);
}

/**
 * The object id a persisted binding records for this state: the sha of a born head, the all-zero
 * object id (the value `update-ref` takes for "must not exist") of an unborn one.
 */
export function gitHeadStateObjectId(state: GitHeadState): string {
  return state.kind === "born" ? state.sha : gitZeroObjectId(state.objectIdLength);
}

/** True for the all-zero object id of either object format. */
export function isGitZeroObjectId(objectId: string): boolean {
  return /^(?:0{40}|0{64})$/u.test(objectId);
}

export function sameGitHeadState(a: GitHeadState, b: GitHeadState): boolean {
  if (a.kind === "born") return b.kind === "born" && a.sha === b.sha;
  return b.kind === "unborn" && a.branch === b.branch && a.objectIdLength === b.objectIdLength;
}
