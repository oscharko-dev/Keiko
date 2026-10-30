// The reading half of the review harvest (Issue #4132): GraphQL pagination, rate-limit pacing,
// transient-error retry and resumable checkpoints. Read-only: the only GitHub call is
// `gh api graphql` with a query, and nothing here posts, resolves or edits anything.
//
// Every side effect is injected — the transport, the region probe, the checkpoint store, the clock
// and the sleep — so the fixture tests drive pagination, a primary rate-limit pause, a secondary
// rate-limit retry and a resumed run without a network or a wall clock.
//
// Cost design (GraphQL budget 5,000 points per hour): one page asks for `pageSize` pull requests
// with up to 40 threads of 20 comments and 50 review authors each, about 5 points for the default
// page of 10. A connection that overflows its first page is completed with node queries, so no
// thread is ever graded on a partial conversation.

import { spawnHostExecutable } from "./host-command.mjs";
import { addNoticeCounts, normalizePullRequest } from "./review-harvest-records.mjs";

const DEFAULT_PAGE_SIZE = 10;
export const RATE_LIMIT_RESERVE_POINTS = 100;
export const MAX_ATTEMPTS = 6;
export const SECONDARY_RATE_LIMIT_WAIT_MS = 60_000;
export const TRANSIENT_BACKOFF_MS = 5_000;
const CHECKPOINT_SCHEMA_VERSION = 1;

const COMMENT_FIELDS = "author{login __typename} body originalCommit{oid}";
const THREAD_FIELDS = `id isResolved isOutdated path diffSide subjectType originalLine originalStartLine
  comments(first:20){pageInfo{hasNextPage endCursor} nodes{${COMMENT_FIELDS}}}`;
const REVIEW_FIELDS = "author{login __typename}";

export const PULL_REQUEST_PAGE_QUERY = `query($owner:String!,$name:String!,$count:Int!,$after:String){
  rateLimit{cost remaining resetAt}
  repository(owner:$owner,name:$name){
    pullRequests(states:[MERGED,CLOSED],orderBy:{field:CREATED_AT,direction:ASC},first:$count,after:$after){
      pageInfo{hasNextPage endCursor}
      nodes{
        id number state headRefOid baseRefOid
        reviews(first:50){pageInfo{hasNextPage endCursor} nodes{${REVIEW_FIELDS}}}
        reviewThreads(first:40){pageInfo{hasNextPage endCursor} nodes{${THREAD_FIELDS}}}
      }
    }
  }
}`;

export const CONNECTION_QUERIES = Object.freeze({
  reviewThreads: `query($id:ID!,$after:String){rateLimit{cost remaining resetAt}
    node(id:$id){... on PullRequest{reviewThreads(first:50,after:$after){pageInfo{hasNextPage endCursor} nodes{${THREAD_FIELDS}}}}}}`,
  reviews: `query($id:ID!,$after:String){rateLimit{cost remaining resetAt}
    node(id:$id){... on PullRequest{reviews(first:100,after:$after){pageInfo{hasNextPage endCursor} nodes{${REVIEW_FIELDS}}}}}}`,
  comments: `query($id:ID!,$after:String){rateLimit{cost remaining resetAt}
    node(id:$id){... on PullRequestReviewThread{comments(first:100,after:$after){pageInfo{hasNextPage endCursor} nodes{${COMMENT_FIELDS}}}}}}`,
});

/** A transport failure, classified so the retry policy can decide without parsing text twice. */
export class HarvestTransportError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = "HarvestTransportError";
    this.kind = kind;
  }
}

const RATE_LIMITED = /rate limit|HTTP 429|abuse detection/iu;
const TRANSIENT =
  /HTTP 5\d\d|timed? ?out|ETIMEDOUT|ECONNRESET|EAI_AGAIN|stream error|something went wrong/iu;

/** Classifies one failed `gh` invocation by what it printed. */
export function classifyTransportFailure(text) {
  if (RATE_LIMITED.test(text)) return "rate-limited";
  return TRANSIENT.test(text) ? "transient" : "fatal";
}

function graphqlArguments(query, variables) {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [key, value] of Object.entries(variables)) {
    if (value === null || value === undefined) continue;
    args.push(typeof value === "number" ? "-F" : "-f", `${key}=${String(value)}`);
  }
  return args;
}

/** The production transport: `gh api graphql`, synchronous underneath, promise-shaped above. */
export function createGhTransport(run = (args) => spawnHostExecutable("gh", args)) {
  return (query, variables) => {
    const result = run(graphqlArguments(query, variables));
    const output = `${String(result.stderr ?? "")} ${result.error?.message ?? ""}`;
    if (result.error !== undefined && result.error !== null) {
      return Promise.reject(new HarvestTransportError(classifyTransportFailure(output), output));
    }
    if (result.status !== 0) {
      return Promise.reject(new HarvestTransportError(classifyTransportFailure(output), output));
    }
    return Promise.resolve(JSON.parse(String(result.stdout)));
  };
}

function waitAfterFailure(error, attempt, state, io) {
  if (error.kind === "rate-limited") {
    const untilReset = state.resetAt === undefined ? 0 : Date.parse(state.resetAt) - io.now();
    return Math.max(untilReset + 1_000, SECONDARY_RATE_LIMIT_WAIT_MS * attempt);
  }
  return TRANSIENT_BACKOFF_MS * attempt;
}

async function paceRateLimit(rateLimit, state, io) {
  if (rateLimit === undefined || rateLimit === null) return;
  state.resetAt = rateLimit.resetAt;
  state.pointsUsed += rateLimit.cost;
  if (rateLimit.remaining >= RATE_LIMIT_RESERVE_POINTS) return;
  const waitMs = Math.max(Date.parse(rateLimit.resetAt) - io.now() + 1_000, 0);
  io.log(`rate limit: ${String(rateLimit.remaining)} points left, pausing ${String(waitMs)} ms`);
  await io.sleep(waitMs);
}

function isRetryable(error) {
  return error instanceof HarvestTransportError && error.kind !== "fatal";
}

/**
 * One GraphQL request under the retry policy: a rate-limited answer waits for the reset (or at
 * least a minute, the secondary-limit guidance), a transient one backs off, a fatal one or an
 * answer carrying GraphQL `errors` fails the run. Every answer's `rateLimit` paces the next call.
 */
export async function requestGraphql(context, query, variables) {
  const { transport, io, state } = context;
  for (let attempt = 1; ; attempt += 1) {
    try {
      const payload = await transport(query, variables);
      if (Array.isArray(payload.errors) && payload.errors.length > 0) {
        const message = payload.errors.map((error) => String(error.message)).join("; ");
        throw new HarvestTransportError(classifyTransportFailure(message), message);
      }
      await paceRateLimit(payload.data.rateLimit, state, io);
      return payload.data;
    } catch (error) {
      if (!isRetryable(error) || attempt >= MAX_ATTEMPTS) throw error;
      const waitMs = waitAfterFailure(error, attempt, state, io);
      io.log(`${error.kind} answer (attempt ${String(attempt)}), retrying in ${String(waitMs)} ms`);
      await io.sleep(waitMs);
    }
  }
}

async function completeConnection(context, kind, nodeId, connection) {
  const nodes = [...connection.nodes];
  let pageInfo = connection.pageInfo;
  while (pageInfo.hasNextPage) {
    const data = await requestGraphql(context, CONNECTION_QUERIES[kind], {
      id: nodeId,
      after: pageInfo.endCursor,
    });
    const next = data.node[kind];
    nodes.push(...next.nodes);
    pageInfo = next.pageInfo;
  }
  return { nodes };
}

async function completeThread(context, thread) {
  return {
    ...thread,
    comments: await completeConnection(context, "comments", thread.id, thread.comments),
  };
}

/** Completes every overflowing connection of one pull request before it is normalized. */
async function completePullRequest(context, pullRequest) {
  const threads = await completeConnection(
    context,
    "reviewThreads",
    pullRequest.id,
    pullRequest.reviewThreads,
  );
  const completedThreads = [];
  for (const thread of threads.nodes) completedThreads.push(await completeThread(context, thread));
  return {
    ...pullRequest,
    reviews: await completeConnection(context, "reviews", pullRequest.id, pullRequest.reviews),
    reviewThreads: { nodes: completedThreads },
  };
}

function emptyCheckpoint(repository) {
  return {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    repository,
    cursor: null,
    complete: false,
    pullRequests: [],
    excludedNoticeThreads: {},
  };
}

function resumeCheckpoint(store, repository) {
  const saved = store.load();
  if (saved === undefined) return emptyCheckpoint(repository);
  if (saved.schemaVersion !== CHECKPOINT_SCHEMA_VERSION || saved.repository !== repository) {
    throw new Error(
      `review harvest: checkpoint belongs to another run (${String(saved.repository)})`,
    );
  }
  return saved;
}

// Every commit one page's region probes will ask about, so a probe can check them in one call.
function pageCommits(pullRequests) {
  const oids = new Set();
  for (const pullRequest of pullRequests) {
    if (typeof pullRequest.headRefOid === "string") oids.add(pullRequest.headRefOid);
    for (const thread of pullRequest.reviewThreads.nodes) {
      const oid = thread.comments.nodes[0]?.originalCommit?.oid;
      if (typeof oid === "string") oids.add(oid);
    }
  }
  return [...oids];
}

async function harvestPage(context, checkpoint) {
  const data = await requestGraphql(context, PULL_REQUEST_PAGE_QUERY, {
    owner: context.owner,
    name: context.name,
    count: context.pageSize,
    after: checkpoint.cursor,
  });
  const page = data.repository.pullRequests;
  const completed = [];
  for (const raw of page.nodes) completed.push(await completePullRequest(context, raw));
  context.probe.prepare?.(pageCommits(completed));
  const pullRequests = [...checkpoint.pullRequests];
  let excludedNoticeThreads = checkpoint.excludedNoticeThreads;
  for (const raw of completed) {
    const normalized = normalizePullRequest(raw, context.probe);
    pullRequests.push(normalized.record);
    excludedNoticeThreads = addNoticeCounts(excludedNoticeThreads, normalized.notices);
  }
  return {
    ...checkpoint,
    cursor: page.pageInfo.endCursor ?? checkpoint.cursor,
    complete: !page.pageInfo.hasNextPage,
    pullRequests,
    excludedNoticeThreads,
  };
}

/**
 * Reads every merged and closed pull request's review threads, oldest first, saving a checkpoint
 * after each page. A run that stops (rate limit exhausted past the retry budget, a crash, an
 * interrupt) resumes from its last saved page; a completed checkpoint returns without a request.
 */
export async function harvestReviewThreads(options) {
  const { owner, name, store } = options;
  const repository = `${owner}/${name}`;
  const context = {
    owner,
    name,
    transport: options.transport,
    probe: options.probe,
    io: options.io,
    pageSize: options.pageSize ?? DEFAULT_PAGE_SIZE,
    state: { resetAt: undefined, pointsUsed: 0 },
  };
  let checkpoint = resumeCheckpoint(store, repository);
  while (!checkpoint.complete) {
    checkpoint = await harvestPage(context, checkpoint);
    store.save(checkpoint);
    options.io.log(`harvested ${String(checkpoint.pullRequests.length)} pull requests`);
  }
  return { checkpoint, pointsUsed: context.state.pointsUsed };
}
