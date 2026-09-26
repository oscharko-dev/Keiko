import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security/hashing";
import { gitDeliveryObservationFailure } from "@oscharko-dev/keiko-contracts/runtime/git-delivery-provider";
import { readGitProviderValue } from "./git-provider-value.js";
import type { GitProviderReadRunner } from "./git-provider-observation.js";
import {
  assertJourneyTarget,
  buildGitJourneyReadArgv,
  type GitJourneyReadTarget,
} from "./git-journey-read-argv.js";
import {
  GitJourneyReadError,
  parseGitJourneyPage,
  journeyPageHeaderDigest,
} from "./git-journey-page.js";
import type {
  GitJourneyFactsResult,
  GitJourneyHeader,
  GitJourneyPage,
} from "./git-journey-facts-types.js";

export type {
  GitJourneyFacts,
  GitJourneyFactsResult,
  GitJourneyReader,
} from "./git-journey-facts-types.js";
export type { GitJourneyReadTarget } from "./git-journey-read-argv.js";
interface Input {
  readonly target: GitJourneyReadTarget;
  readonly run: GitProviderReadRunner;
  readonly stillAuthorized: () => boolean;
  readonly signal?: AbortSignal;
}
interface CompletePass {
  readonly header: GitJourneyHeader;
  readonly threads: GitJourneyPage["threads"];
  readonly digest: string;
}
function live(input: Input): void {
  if (input.signal?.aborted === true) throw new GitJourneyReadError("cancelled");
  if (!input.stillAuthorized()) throw new GitJourneyReadError("authority-denied");
}
async function page(input: Input, cursor: string | undefined): Promise<GitJourneyPage> {
  live(input);
  const result = await readGitProviderValue({
    run: input.run,
    argv: buildGitJourneyReadArgv(input.target, cursor),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  live(input);
  if (result.status === "unavailable") throw new GitJourneyReadError(result.failure.reason);
  return parseGitJourneyPage(result.value, input.target);
}
function addThreads(target: Map<string, boolean>, current: GitJourneyPage): void {
  for (const thread of current.threads) {
    if (target.has(thread.id)) throw new GitJourneyReadError("malformed-response");
    target.set(thread.id, thread.isResolved);
  }
  if (target.size > current.total) throw new GitJourneyReadError("malformed-response");
}
function complete(header: GitJourneyHeader, threads: Map<string, boolean>): CompletePass {
  const values = [...threads]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, isResolved]) => ({ id, isResolved }));
  return { header, threads: values, digest: sha256Hex(canonicalise({ header, threads: values })) };
}
async function readPass(input: Input): Promise<CompletePass> {
  const threads = new Map<string, boolean>();
  const cursors = new Set<string>();
  let initial: GitJourneyPage | undefined;
  let cursor: string | undefined;
  for (let index = 0; index < 5; index++) {
    const current = await page(input, cursor);
    initial ??= current;
    if (
      journeyPageHeaderDigest(initial.header) !== journeyPageHeaderDigest(current.header) ||
      initial.total !== current.total
    )
      throw new GitJourneyReadError("revision-changed");
    addThreads(threads, current);
    if (!current.hasNextPage) {
      if (threads.size !== current.total) throw new GitJourneyReadError("malformed-response");
      return complete(current.header, threads);
    }
    if (current.cursor === null || cursors.has(current.cursor) || current.threads.length !== 100)
      throw new GitJourneyReadError("malformed-response");
    cursor = current.cursor;
    cursors.add(cursor);
  }
  throw new GitJourneyReadError("pagination-exhausted");
}
/** Two complete bounded reads detect changing review/closure facts; this port has no mutation. */
export async function readGitJourneyFacts(request: Input): Promise<GitJourneyFactsResult> {
  const input = Object.freeze({ ...request, target: Object.freeze({ ...request.target }) });
  try {
    assertJourneyTarget(input.target);
  } catch {
    return { status: "unavailable", failure: gitDeliveryObservationFailure("invalid-binding") };
  }
  try {
    const before = await readPass(input);
    const after = await readPass(input);
    live(input);
    if (before.digest !== after.digest) throw new GitJourneyReadError("revision-changed");
    const unresolved = after.threads.filter((thread) => !thread.isResolved).length;
    return {
      status: "observed",
      ...after.header,
      factsDigest: after.digest,
      reviewConversations: {
        total: after.threads.length,
        unresolved,
        resolved: after.threads.length - unresolved,
      },
    };
  } catch (error) {
    return {
      status: "unavailable",
      failure:
        error instanceof GitJourneyReadError
          ? error.failure
          : gitDeliveryObservationFailure("malformed-response"),
    };
  }
}
