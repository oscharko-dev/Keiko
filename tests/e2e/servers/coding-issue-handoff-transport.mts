// #3389 test-only provider boundary for the read-only journey observation route AND (epic #3384
// correction 7) the pr-mark-ready draft->ready transition. Reuses the #3387 delivery transport
// verbatim for git/gh REST calls (push, PR create, issue reads, the canonical per-PR identity read
// `readPullRequest`/`markPullRequestReady` re-read before and after the mutation both use) and
// layers a SEPARATE `gh`-only shim, found first on PATH, that answers exactly three deterministic,
// fixture-mode-controlled shapes on top of it: the journey observation GraphQL query
// (`buildGitJourneyReadArgv`), the node-id lookup `markPullRequestReady`'s adapter performs before
// the mutation (`fetchPrNodeId`, git-pr-node.ts), and the fixed `markPullRequestReadyForReview`
// GraphQL mutation (`buildPrMarkReadyGraphqlArgv`, git-pr-gateway.ts) — falling through to the real
// delivery fixture's `gh` for everything else. No other endpoint or query is recognized; every
// unmatched shape is denied the same way the delivery fixture already denies an unmatched request
// (AGENTS.md fail-closed).

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import {
  installDeliveryTransport,
  readState as readDeliveryState,
  writeState as writeDeliveryState,
  type DeliveryProviderState,
} from "./coding-issue-delivery-transport.mjs";
import { DELIVERY_REPOSITORY } from "../support/coding-issue-delivery.js";
import {
  handoffProviderPath,
  type HandoffFixtureMode,
  type HandoffProviderState,
} from "../support/coding-issue-handoff.js";

const ISSUE_NUMBER = 44;
const REPOSITORY_DATABASE_ID = 4139;

function readHandoffState(stateDir: string): HandoffProviderState {
  return JSON.parse(readFileSync(handoffProviderPath(stateDir), "utf8")) as HandoffProviderState;
}
function writeHandoffState(stateDir: string, state: HandoffProviderState): void {
  writeFileSync(handoffProviderPath(stateDir), JSON.stringify(state));
}
function deny(stateDir: string): never {
  const state = readHandoffState(stateDir);
  writeHandoffState(stateDir, { ...state, deniedCalls: state.deniedCalls + 1 });
  process.stderr.write("handoff-fixture-provider-boundary-denied\n");
  process.exit(73);
}

function fieldValue(args: readonly string[], key: string): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "-f" && args[index] !== "-F") continue;
    const pair = args[index + 1] ?? "";
    const at = pair.indexOf("=");
    if (at !== -1 && pair.slice(0, at) === key) return pair.slice(at + 1);
  }
  return undefined;
}

/** Exactly `buildGitJourneyReadArgv`'s shape: a GraphQL POST naming its own operation. */
function isJourneyQuery(args: readonly string[]): boolean {
  return (
    args[0] === "api" &&
    args.includes("--hostname") &&
    args[args.indexOf("--hostname") + 1] === "github.com" &&
    args.includes("--method") &&
    args[args.indexOf("--method") + 1] === "POST" &&
    args.includes("graphql") &&
    (fieldValue(args, "query") ?? "").includes("KeikoJourneyObservation")
  );
}

function journeyPullRequest(
  mode: HandoffFixtureMode,
  pr: DeliveryProviderState["pullRequests"][number],
): unknown {
  const merged = mode === "merged-open" || mode === "merged-closed";
  const blockedReview = mode === "blocked-review";
  return {
    id: pr.externalId,
    number: pr.number,
    url: pr.url,
    state: merged ? "MERGED" : mode === "closed-unmerged" ? "CLOSED" : "OPEN",
    // #3389 (correction 7): the REAL, mutable per-PR draft flag — not a mode-derived guess — so a
    // journey re-read genuinely observes the pr-mark-ready mutation's effect once it has run.
    isDraft: pr.isDraft,
    baseRefName: pr.baseRef,
    baseRefOid: pr.baseSha,
    headRefName: pr.headRef,
    headRefOid: pr.headSha,
    mergedAt: merged ? "2026-09-05T00:04:00Z" : null,
    mergeCommit: merged ? { oid: "f".repeat(40) } : null,
    reviewDecision: blockedReview ? "CHANGES_REQUESTED" : "REVIEW_REQUIRED",
    repository: { nameWithOwner: DELIVERY_REPOSITORY },
    headRepository: { nameWithOwner: DELIVERY_REPOSITORY },
    reviewThreads: {
      totalCount: blockedReview ? 1 : 0,
      nodes: blockedReview ? [{ id: "PRRT_fixture_1", isResolved: false }] : [],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  };
}

function journeyResponse(
  mode: HandoffFixtureMode,
  pr: DeliveryProviderState["pullRequests"][number],
): unknown {
  const issueClosed = mode === "merged-closed";
  return {
    data: {
      repository: {
        nameWithOwner: DELIVERY_REPOSITORY,
        databaseId: REPOSITORY_DATABASE_ID,
        defaultBranchRef: { name: pr.baseRef },
        issue: {
          id: `I_fixture_${String(ISSUE_NUMBER)}`,
          number: ISSUE_NUMBER,
          state: issueClosed ? "CLOSED" : "OPEN",
          closedAt: issueClosed ? "2026-09-05T00:05:00Z" : null,
          repository: { nameWithOwner: DELIVERY_REPOSITORY },
        },
        pullRequest: journeyPullRequest(mode, pr),
      },
    },
  };
}

function answerJourneyQuery(stateDir: string): never {
  const handoff = readHandoffState(stateDir);
  const delivery = readDeliveryState(stateDir);
  const pr = delivery.pullRequests.find((candidate) => candidate.headRef === delivery.headRef);
  if (pr === undefined) deny(stateDir);
  writeHandoffState(stateDir, { ...handoff, reads: handoff.reads + 1 });
  process.stdout.write(JSON.stringify(journeyResponse(handoff.mode, pr)));
  process.exit(0);
}

// #3389 (epic #3384 correction 2): the node-id lookup `markPullRequestReady`'s adapter performs
// immediately before the draft->ready mutation (`fetchPrNodeId`, git-pr-node.ts) — a plain REST GET
// with NO --hostname/--method flags (unlike the canonical `inspectionArgv` reads the delivery
// transport already answers), so it needs its own recognizer here.
const NODE_ID_PROJECTION = ".node_id";

function isNodeIdLookup(args: readonly string[]): boolean {
  return (
    args[0] === "api" &&
    args.some((arg) => arg.startsWith(`/repos/${DELIVERY_REPOSITORY}/pulls/`)) &&
    args.at(-1) === NODE_ID_PROJECTION
  );
}

function pullRequestNumberFromEndpoint(args: readonly string[]): number | undefined {
  const endpoint = args.find((arg) => arg.startsWith(`/repos/${DELIVERY_REPOSITORY}/pulls/`));
  if (endpoint === undefined) return undefined;
  const parsed = Number(endpoint.slice(endpoint.lastIndexOf("/") + 1));
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function answerNodeIdLookup(stateDir: string, args: readonly string[]): never {
  const number = pullRequestNumberFromEndpoint(args);
  const delivery = readDeliveryState(stateDir);
  const pr = delivery.pullRequests.find((candidate) => candidate.number === number);
  if (pr === undefined) deny(stateDir);
  process.stdout.write(`${pr.externalId}\n`);
  process.exit(0);
}

// #3389 (epic #3384 correction 2/7): the fixed `markPullRequestReadyForReview` mutation
// `buildPrMarkReadyGraphqlArgv` builds — the ONLY mutation this adapter's execute path can ever
// spawn (no PATCH, no merge, no issue-close mutation exists to intercept). Persists the observed
// draft->ready transition into the SAME delivery provider state the journey query and the adapter's
// own pre/post reads consult, so a real re-read genuinely observes the flip.
const MARK_READY_MUTATION_MARKER = "markPullRequestReadyForReview";

function isMarkReadyMutation(args: readonly string[]): boolean {
  return (
    args[0] === "api" &&
    args[1] === "graphql" &&
    (fieldValue(args, "query") ?? "").includes(MARK_READY_MUTATION_MARKER)
  );
}

function answerMarkReadyMutation(stateDir: string, args: readonly string[]): never {
  const nodeId = fieldValue(args, "pullRequestId");
  const delivery = readDeliveryState(stateDir);
  const pr = delivery.pullRequests.find((candidate) => candidate.externalId === nodeId);
  if (pr === undefined) deny(stateDir);
  writeDeliveryState(stateDir, {
    ...delivery,
    pullRequests: delivery.pullRequests.map((candidate) =>
      candidate.externalId === nodeId ? { ...candidate, isDraft: false } : candidate,
    ),
  });
  process.stdout.write(
    JSON.stringify({
      data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } },
    }),
  );
  process.exit(0);
}

export function runHandoffGh(input: {
  readonly stateDir: string;
  readonly fallbackGh: string;
}): void {
  const args = process.argv.slice(2);
  if (isJourneyQuery(args)) {
    answerJourneyQuery(input.stateDir);
    return;
  }
  if (isNodeIdLookup(args)) {
    answerNodeIdLookup(input.stateDir, args);
    return;
  }
  if (isMarkReadyMutation(args)) {
    answerMarkReadyMutation(input.stateDir, args);
    return;
  }
  const result = spawnSync(input.fallbackGh, args, { stdio: "inherit", timeout: 30_000 });
  process.exitCode = result.status ?? 74;
}

/**
 * Installs the base #3387 delivery transport first (push/PR-create/issue-REST fixtures, unchanged),
 * then prepends a `gh`-only overlay bin ahead of it on PATH so the journey GraphQL read is answered
 * deterministically while every other `gh`/`git` invocation still reaches the original fixture.
 */
export function installHandoffTransport(stateDir: string): { readonly realGit: string } {
  const base = installDeliveryTransport(stateDir);
  const overlayBin = join(stateDir, "handoff-overlay-bin");
  mkdirSync(overlayBin, { recursive: true });
  const fallbackGh = join(base.bin, "gh");
  const invocation = `import { runHandoffGh } from ${JSON.stringify(import.meta.url)};\nrunHandoffGh(${JSON.stringify(
    { stateDir, fallbackGh },
  )});\n`;
  writeFileSync(join(overlayBin, "gh"), `#!${process.execPath}\n${invocation}`, { mode: 0o755 });
  process.env.PATH = `${overlayBin}${delimiter}${process.env.PATH ?? ""}`;
  return { realGit: base.realGit };
}
