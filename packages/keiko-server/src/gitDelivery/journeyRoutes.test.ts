// Route-level tests for the read-only journey observation route (#3389 AC1/AC5/AC6, epic #3384).
//
// Proves: the route is actually registered in the real server route table; a malformed request is
// rejected before any provider read; an unknown/unbound run yields the closed "draft-unavailable"
// fact without ever invoking a reader; and a fake GitJourneyReader driven through the real route
// handler produces a JourneyOutcome — never a fabricated "current"/green result on a description or
// readiness that was never actually observed.

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import { URL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createNodeEvidenceStore } from "@oscharko-dev/keiko-evidence";
import type { DraftDeliveryRecord } from "@oscharko-dev/keiko-contracts/runtime/draft-delivery";
import type { ReadinessSnapshot } from "@oscharko-dev/keiko-contracts/runtime/git-delivery-provider";
import type {
  GitCiFactsResult,
  GitCiProviderFacts,
  GitCiProviderReader,
  GitJourneyFactsResult,
  GitJourneyReader,
} from "@oscharko-dev/keiko-tools/internal/git-mutation";
import type { RouteContext, RouteResult } from "../routes.js";
import { buildRedactor, createRunRegistry, type UiHandlerDeps } from "../index.js";
import { createInMemoryUiStore } from "../store/index.js";
import type { ServerLogEvent } from "../observability/server-log.js";
import {
  createCodingRuntimeSnapshotStore,
  type CodingRuntimeSnapshotStore,
} from "../coding-runtime/codingRuntimeSnapshotStore.js";
import { runMigrations } from "../store/schema.js";
import { githubIssueReaderRepositoryId } from "../coding-context/githubIssueReaderAuthorization.js";
import { codingWorkbenchRemoteDigest } from "../coding-context/githubIssueResolution.js";
import { AT, createDraftRun, readySnapshot } from "./ciObservationTest/_support.js";
import { clearJourneyReadinessMemo, createGitDeliveryJourneyRouteGroup } from "./journeyRoutes.js";
import { DescriptionFixture } from "./prDescriptionTestSupport.js";
import { applicationStatus } from "./prDescriptionProjection.js";
import { createPrDescriptionReceiptStore } from "./prDescriptionReceiptStore.js";

// Builds a fully-typed UiHandlerDeps (all 8 required fields), matching the `deps(overrides)`
// pattern shared by the sibling gitDelivery route test files (e.g. actionSheetRoutes.test.ts),
// so the fixture stays structurally checked against UiHandlerDeps instead of double-cast past it.
function baseDeps(overrides: Partial<UiHandlerDeps> = {}): UiHandlerDeps {
  return {
    config: undefined,
    configPresent: false,
    evidenceStore: { put: () => "", list: () => [], get: () => undefined, delete: () => undefined },
    env: {},
    redactor: buildRedactor({}),
    registry: createRunRegistry(),
    modelPortFactory: () => undefined,
    store: createInMemoryUiStore(),
    ...overrides,
  };
}

const PATTERN = "/api/git-delivery/journey/refresh";

function requestWithBody(body: unknown): IncomingMessage {
  const req = Readable.from([Buffer.from(JSON.stringify(body), "utf8")]) as IncomingMessage;
  req.method = "POST";
  req.headers = { "content-type": "application/json" };
  return req;
}

function ctxFor(body: unknown): RouteContext {
  return {
    correlationId: "journey-refresh-1",
    req: requestWithBody(body),
    res: undefined as never,
    params: {},
    url: new URL(`http://127.0.0.1${PATTERN}`),
  };
}

interface Harness {
  readonly deps: UiHandlerDeps;
  readonly events: ServerLogEvent[];
  readonly cleanup: () => void;
}

function harness(): Harness {
  const db = new DatabaseSync(":memory:");
  const snapshots = createDraftRun(db);
  const dir = mkdtempSync(join(tmpdir(), "keiko-journey-route-"));
  const events: ServerLogEvent[] = [];
  const deps = baseDeps({
    codingRuntimeSnapshotStore: snapshots,
    evidenceStore: createNodeEvidenceStore(dir),
    redactor: (value: unknown): unknown => value,
    activityLog: {
      write: (event: ServerLogEvent): void => {
        events.push(event);
      },
    },
  });
  return {
    deps,
    events,
    cleanup: (): void => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const OBSERVED_FACTS: GitJourneyFactsResult = {
  status: "observed",
  identity: {
    number: 17,
    externalId: "PR_17",
    url: "https://github.com/owner/repository/pull/17",
    repository: "owner/repository",
    headRepository: "owner/repository",
    headRef: "feature/issue-1",
    headSha: "3".repeat(40),
    baseRef: "dev",
    baseSha: "1".repeat(40),
    state: "open",
    isDraft: true,
  },
  repositoryId: 41,
  defaultBranchRef: "dev",
  mergedAt: null,
  mergeCommitSha: null,
  reviewDecision: "unknown",
  issue: { number: 1, state: "open", closedAt: null },
  reviewConversations: { total: 0, unresolved: 0, resolved: 0 },
  factsDigest: "a".repeat(64),
};

function fakeReader(result: GitJourneyFactsResult): GitJourneyReader {
  return { readJourney: (): Promise<GitJourneyFactsResult> => Promise.resolve(result) };
}

describe("journey observation route registration (#3389 AC1)", () => {
  it("registers POST /api/git-delivery/journey/refresh in the real route table", async () => {
    const { API_ROUTES } = await import("../routes.js");
    expect(API_ROUTES.some((route) => route.method === "POST" && route.pattern === PATTERN)).toBe(
      true,
    );
  });
});

describe("journey observation route (#3389 AC1/AC5/AC6)", () => {
  it("rejects a malformed request before any provider read is attempted", async () => {
    const h = harness();
    try {
      const group = createGitDeliveryJourneyRouteGroup({
        reader: (): never => {
          throw new Error("must not be called for a bad request");
        },
      });
      const result = (await group[0]?.handler(
        ctxFor({ schemaVersion: "1", runId: "bad id with spaces" }),
        h.deps,
      )) as RouteResult;
      expect(result.status).toBe(400);
    } finally {
      h.cleanup();
    }
  });

  it("reports the closed draft-unavailable fact for an unbound run, never a fabricated outcome", async () => {
    const h = harness();
    try {
      const group = createGitDeliveryJourneyRouteGroup({
        reader: (): never => {
          throw new Error("must not be called for an unbound run");
        },
      });
      const result = (await group[0]?.handler(
        ctxFor({ schemaVersion: "1", runId: "unbound-run" }),
        h.deps,
      )) as RouteResult;
      expect(result).toEqual({
        status: 200,
        body: { status: "unavailable", reason: "draft-unavailable" },
      });
    } finally {
      h.cleanup();
    }
  });

  // Owner audit finding b3-20: a request that never reaches the controller (an unbound run) still
  // ran an operation and must leave a body-free activity-log line on the observation op, never a
  // silent early return.
  it("logs a body-free unavailable line for the draft-unavailable early return", async () => {
    const h = harness();
    try {
      const group = createGitDeliveryJourneyRouteGroup({
        reader: (): never => {
          throw new Error("must not be called for an unbound run");
        },
      });
      await group[0]?.handler(ctxFor({ schemaVersion: "1", runId: "unbound-run" }), h.deps);
      const line = h.events.find((event) => event.op === "git.journey-observation");
      expect(line).toMatchObject({
        op: "git.journey-observation",
        correlationId: "journey-refresh-1",
        level: "warn",
        extra: { phase: "unavailable", runId: "unbound-run", reason: "draft-unavailable" },
      });
    } finally {
      h.cleanup();
    }
  });

  // Owner audit finding b2-9: `JourneyObservationController` is constructed fresh per request, so
  // its own `this.active` in-flight guard never sees two concurrent calls for the same run on the
  // real (per-request) path. A double-click or a retried refresh must still be refused rather than
  // dispatching two concurrent provider observations for the same run.
  it("fails closed with observation-in-flight instead of dispatching a second concurrent observation for the same run", async () => {
    const h = harness();
    try {
      let readerCalls = 0;
      let signalEntered: (() => void) | undefined;
      const entered = new Promise<void>((resolve) => {
        signalEntered = resolve;
      });
      let releaseFirst: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const group = createGitDeliveryJourneyRouteGroup({
        reader: (): GitJourneyReader => ({
          readJourney: async (): Promise<GitJourneyFactsResult> => {
            readerCalls += 1;
            signalEntered?.();
            await gate;
            return OBSERVED_FACTS;
          },
        }),
        readiness: () => Promise.resolve(readySnapshot()),
        description: () => Promise.resolve(null),
        outcomes: { get: () => undefined, record: () => true },
      });
      const first = group[0]?.handler(
        ctxFor({ schemaVersion: "1", runId: "run-1" }),
        h.deps,
      ) as Promise<RouteResult>;
      // Waits until the first call's observation has actually reached the provider read — by then
      // the per-run guard is armed, since it is set synchronously before that read is ever awaited.
      await entered;

      const second = (await group[0]?.handler(
        ctxFor({ schemaVersion: "1", runId: "run-1" }),
        h.deps,
      )) as RouteResult;
      expect(second).toEqual({
        status: 200,
        body: { status: "unavailable", reason: "observation-in-flight" },
      });
      const line = h.events.find(
        (event) =>
          event.op === "git.journey-observation" && event.extra?.reason === "observation-in-flight",
      );
      expect(line).toMatchObject({ level: "warn", extra: { runId: "run-1" } });

      releaseFirst?.();
      const resolvedFirst = await first;
      expect(resolvedFirst.status).toBe(200);
      expect(resolvedFirst.body).toMatchObject({ status: "observed" });
      expect(readerCalls).toBe(2); // before/after drift-check reads within the ONE surviving observation
    } finally {
      h.cleanup();
    }
  });

  it("produces a JourneyOutcome from a fake GitJourneyReader through the real route handler", async () => {
    const h = harness();
    try {
      const group = createGitDeliveryJourneyRouteGroup({
        reader: (): GitJourneyReader => fakeReader(OBSERVED_FACTS),
        readiness: () => Promise.resolve(readySnapshot()),
        description: () => Promise.resolve(null),
        outcomes: { get: () => undefined, record: () => true },
      });
      const result = (await group[0]?.handler(
        ctxFor({ schemaVersion: "1", runId: "run-1" }),
        h.deps,
      )) as RouteResult;
      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({
        status: "observed",
        outcome: {
          binding: { runId: "run-1", remoteDigest: "a".repeat(64), prNumber: 17 },
        },
      });
    } finally {
      h.cleanup();
    }
  });

  it("logs a body-free recorded/rejected outcome line for the durable projection write (#3389 AC6)", async () => {
    const h = harness();
    try {
      const outcomes = { get: (): undefined => undefined, record: (): boolean => false };
      const group = createGitDeliveryJourneyRouteGroup({
        reader: (): GitJourneyReader => fakeReader(OBSERVED_FACTS),
        readiness: () => Promise.resolve(readySnapshot()),
        description: () => Promise.resolve(null),
        outcomes,
      });
      const result = (await group[0]?.handler(
        ctxFor({ schemaVersion: "1", runId: "run-1" }),
        h.deps,
      )) as RouteResult;
      expect(result.body).toMatchObject({
        status: "unavailable",
        reason: "observation-superseded",
      });
      const recorded = h.events.find((event) => event.op === "git.journey-outcome.recorded");
      expect(recorded).toMatchObject({
        op: "git.journey-outcome.recorded",
        level: "warn",
        extra: { runId: "run-1", recorded: false },
      });
      expect(JSON.stringify(h.events)).not.toMatch(/owner\/repository|PR_17/u);
    } finally {
      h.cleanup();
    }
  });

  it("logs when the optional durable outcome store is unavailable", async () => {
    const h = harness();
    try {
      const snapshots = h.deps.codingRuntimeSnapshotStore;
      if (snapshots === undefined) throw new Error("snapshot store fixture missing");
      const snapshotsWithoutOutcomes = { ...snapshots };
      delete snapshotsWithoutOutcomes.journeyOutcomes;
      const group = createGitDeliveryJourneyRouteGroup({
        reader: (): GitJourneyReader => fakeReader(OBSERVED_FACTS),
        readiness: () => Promise.resolve(readySnapshot()),
        description: () => Promise.resolve(null),
      });
      const result = (await group[0]?.handler(ctxFor({ schemaVersion: "1", runId: "run-1" }), {
        ...h.deps,
        codingRuntimeSnapshotStore: snapshotsWithoutOutcomes,
      })) as RouteResult;
      expect(result.body).toMatchObject({
        status: "unavailable",
        reason: "observation-superseded",
      });
      const recorded = h.events.find((event) => event.op === "git.journey-outcome.recorded");
      expect(recorded).toMatchObject({
        op: "git.journey-outcome.recorded",
        level: "warn",
        extra: { runId: "run-1", recorded: false, store: "unavailable" },
      });
    } finally {
      h.cleanup();
    }
  });

  it("never lets a description read failure surface as the finished, described outcome (AC9)", async () => {
    const h = harness();
    try {
      const group = createGitDeliveryJourneyRouteGroup({
        reader: (): GitJourneyReader => fakeReader(OBSERVED_FACTS),
        readiness: () => Promise.resolve(readySnapshot()),
        description: () => Promise.resolve(null),
      });
      const result = (await group[0]?.handler(
        ctxFor({ schemaVersion: "1", runId: "run-1" }),
        h.deps,
      )) as RouteResult;
      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({
        status: "observed",
        outcome: { description: null, keikoDescriptionApplied: false },
      });
    } finally {
      h.cleanup();
    }
  });

  // Before this wiring, `codingRuntimeSnapshotStore.ts` exposed no `journeyOutcomes` sub-store, so
  // `GitDeliveryJourneyRouteOptions.outcomes` had no production default and this route's CAS write
  // always recorded successfully against nothing: restart reconstruction was proven only at the
  // store's own unit level, never through the live, mounted route (failing-before: dropping the
  // `outcomesFor` default and passing `outcomes: undefined` here reproduces that — the persisted
  // read below then finds nothing after "restart", because the write never reached the projection).
  it("persists the CAS outcome through the real, unmounted-override production route wiring, surviving a db close/reopen (#3389 AC6)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keiko-journey-restart-"));
    const evidenceDir = mkdtempSync(join(tmpdir(), "keiko-journey-restart-evidence-"));
    const dbPath = join(dir, "keiko.db");
    try {
      const db = new DatabaseSync(dbPath);
      const snapshots = createDraftRun(db);
      const deps = baseDeps({
        codingRuntimeSnapshotStore: snapshots,
        evidenceStore: createNodeEvidenceStore(evidenceDir),
        redactor: (value: unknown): unknown => value,
      });
      // No `outcomes` override: exercises the same default wiring the mounted production route
      // group (`GIT_DELIVERY_JOURNEY_ROUTE_GROUP`) uses.
      const group = createGitDeliveryJourneyRouteGroup({
        reader: (): GitJourneyReader => fakeReader(OBSERVED_FACTS),
        readiness: () => Promise.resolve(readySnapshot()),
        description: () => Promise.resolve(null),
      });
      const result = (await group[0]?.handler(
        ctxFor({ schemaVersion: "1", runId: "run-1" }),
        deps,
      )) as RouteResult;
      expect(result.body).toMatchObject({ status: "observed" });
      db.close();

      // Simulate a process restart: a brand-new connection and a brand-new store instance over the
      // SAME on-disk file, carrying no in-process state from the handler call above.
      const reopened = new DatabaseSync(dbPath);
      try {
        const restarted = createCodingRuntimeSnapshotStore(reopened);
        const persisted = restarted.journeyOutcomes?.get("a".repeat(64), 17);
        expect(persisted).toMatchObject({
          runId: "run-1",
          revision: 0,
          headSha: "3".repeat(40),
        });
      } finally {
        reopened.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(evidenceDir, { recursive: true, force: true });
    }
  });
});

// Regression (defect: the persisted CI readiness snapshot is written only by the run's own in-run
// CI tool call, expires 60s after that last observation, and nothing ever renews it once the run
// has settled). Before this fix, `readinessFor` always resolved the FROZEN snapshot read straight
// off the coding-runtime snapshot row, so `journey/refresh` reported `readiness-stale` on every
// single call once the run reached `succeeded` -- forever, since nothing after that point could
// ever write a newer one through the old, always-pass-through path. Live evidence: a real
// qualification run reported `readiness-stale` on ~272 consecutive refreshes over ten minutes while
// CI was in fact green.
describe("journey readiness renewal after the run has settled (regression, epic #3384)", () => {
  interface SettledHarness extends Harness {
    readonly snapshots: CodingRuntimeSnapshotStore;
    readonly draft: DraftDeliveryRecord;
  }

  // Reproduces the defect's exact shape: an expired readiness snapshot recorded while the run was
  // still live (the only way production ever writes one), then the run settles to `succeeded` --
  // the point at which the old code could never refresh it again.
  function settledHarness(): SettledHarness {
    const db = new DatabaseSync(":memory:");
    const snapshots = createDraftRun(db);
    const ticket = snapshots.ciReadiness?.begin("run-1");
    if (ticket === undefined) throw new Error("missing ciReadiness store in fixture");
    if (!snapshots.ciReadiness?.complete(ticket, readySnapshot()))
      throw new Error("failed to seed expired readiness fixture");
    const beforeSucceeded = snapshots.get("run-1");
    if (beforeSucceeded === undefined) throw new Error("missing fixture snapshot");
    snapshots.transition("run-1", {
      state: "succeeded",
      revision: beforeSucceeded.revision + 1,
      updatedAt: AT,
      terminalAt: AT,
    });
    const settled = snapshots.get("run-1");
    const draft = settled?.draftDelivery;
    if (draft === undefined) throw new Error("missing fixture draft after settling");
    const dir = mkdtempSync(join(tmpdir(), "keiko-journey-readiness-"));
    const events: ServerLogEvent[] = [];
    const deps = baseDeps({
      codingRuntimeSnapshotStore: snapshots,
      evidenceStore: createNodeEvidenceStore(dir),
      redactor: (value: unknown): unknown => value,
      activityLog: {
        write: (event: ServerLogEvent): void => {
          events.push(event);
        },
      },
    });
    return {
      deps,
      events,
      snapshots,
      draft,
      cleanup: (): void => {
        // The process-local readiness memo is keyed per deps, so it cannot leak between harnesses;
        // clearing it anyway keeps a fresh-read expectation independent of execution order.
        clearJourneyReadinessMemo();
        db.close();
        rmSync(dir, { recursive: true, force: true });
      },
    };
  }

  // Same minimal green-facts shape as ciReadinessSnapshot.test.ts's own fixture: empty/unprotected
  // requirements so `assessGitCiFacts` resolves "required-checks-passed" / "technical-ready".
  function greenCiFacts(draft: DraftDeliveryRecord): GitCiProviderFacts {
    if (draft.pullRequest === undefined) throw new Error("Missing fixture pull request");
    const page = {
      values: [],
      completeness: { complete: true, pages: 1, entries: 0, bytes: 2 },
    } as const;
    return {
      status: "observed",
      identity: draft.pullRequest,
      repositoryId: 41,
      mergeable: true,
      mergeState: "clean",
      merged: false,
      protection: { outcome: "unprotected" },
      requirements: { status: "observed", requirements: [], strict: false, digest: "c".repeat(64) },
      workflowDefinitions: { status: "observed", definitions: [] },
      lists: {
        "branch-rules": page,
        "check-runs": page,
        "commit-statuses": page,
        "workflow-runs": page,
        reviews: page,
      },
    };
  }

  it("re-observes CI facts through a fresh, run-independent read and clears readiness-stale once the run has succeeded and the cached snapshot has expired", async () => {
    const h = settledHarness();
    try {
      // Sanity: this is genuinely the frozen, expired evidence the defect leaves behind, not a
      // fixture that happens to already look fresh.
      expect(Date.parse(h.snapshots.get("run-1")?.ciReadiness?.expiresAt ?? "")).toBeLessThan(
        Date.now(),
      );
      const group = createGitDeliveryJourneyRouteGroup({
        reader: (): GitJourneyReader => fakeReader(OBSERVED_FACTS),
        description: () => Promise.resolve(null),
        // New injectable seam: a deterministic, no-network CI reader standing in for
        // `createProductionJourneyCiReader`, proving the refresh renews readiness through a fresh
        // read instead of ever reusing the frozen snapshot seeded above.
        ciReader: (): GitCiProviderReader => ({
          readFacts: (target): Promise<GitCiFactsResult> => {
            // The provider read matches the pull request by NUMBER (`revisionMatches` in
            // git-ci-facts.ts compares `identity.number === Number(target.prExternalId)`), so a
            // node id here silently yields NaN and every read reports revision-changed.
            expect(target.prExternalId).toBe(String(h.draft.pullRequest?.number));
            expect(target.headSha).toBe(h.draft.binding.headSha);
            return Promise.resolve(greenCiFacts(h.draft));
          },
        }),
      });
      const result = (await group[0]?.handler(
        ctxFor({ schemaVersion: "1", runId: "run-1" }),
        h.deps,
      )) as RouteResult;
      expect(result.body).toMatchObject({
        status: "observed",
        outcome: {
          // Not "readiness-stale": the freshly observed readiness is current, so the outcome
          // advances to the next (unrelated, deliberately mocked-null) description gate instead.
          reason: "description-unavailable",
          readiness: { state: "technical-ready", reason: "required-checks-passed" },
        },
      });
    } finally {
      h.cleanup();
    }
  });

  // The renewal must not turn into a provider read per poll: the handoff card refreshes every few
  // seconds, and a snapshot inside its own 60s TTL observed for this exact run and head is by
  // definition still current. Expiry, a different run, or a moved head must still read afresh --
  // that is the renewal this route owns and the defect above was the absence of it.
  it("reuses a still-fresh snapshot for the same head instead of spending a provider read", async () => {
    const h = settledHarness();
    try {
      let reads = 0;
      const ciReader = (): GitCiProviderReader => ({
        readFacts: (): Promise<GitCiFactsResult> => {
          reads += 1;
          return Promise.resolve(greenCiFacts(h.draft));
        },
      });
      const group = createGitDeliveryJourneyRouteGroup({
        reader: (): GitJourneyReader => fakeReader(OBSERVED_FACTS),
        description: () => Promise.resolve(null),
        ciReader,
      });
      const refresh = async (): Promise<RouteResult> =>
        (await group[0]?.handler(
          ctxFor({ schemaVersion: "1", runId: "run-1" }),
          h.deps,
        )) as RouteResult;

      // First refresh renews the expired evidence through one real read.
      await refresh();
      expect(reads).toBe(1);
      // The renewed snapshot is inside its TTL for the same head, so the next refreshes reuse it.
      await refresh();
      await refresh();
      expect(reads).toBe(1);
    } finally {
      h.cleanup();
    }
  });

  it("falls back to the existing cached snapshot -- never fabricating readiness -- when the fresh read is unavailable", async () => {
    const h = settledHarness();
    try {
      const group = createGitDeliveryJourneyRouteGroup({
        reader: (): GitJourneyReader => fakeReader(OBSERVED_FACTS),
        description: () => Promise.resolve(null),
        ciReader: (): GitCiProviderReader | undefined => undefined,
      });
      const result = (await group[0]?.handler(
        ctxFor({ schemaVersion: "1", runId: "run-1" }),
        h.deps,
      )) as RouteResult;
      expect(result.body).toMatchObject({
        status: "observed",
        outcome: { reason: "readiness-stale" },
      });
      const line = h.events.find((event) => event.op === "git.journey-readiness.refreshed");
      expect(line).toMatchObject({ level: "warn", extra: { reason: "reader-unavailable" } });
    } finally {
      h.cleanup();
    }
  });
});

// Regression (epic #3384 issue-to-PR): the description apply always writes the receipt keyed to
// the coding run's OWN workspace root -- for a worktree-isolated run, its managed worktree. The
// journey route's `repositoryId`, however, is captured once from the ORIGINAL repository the issue
// was accepted against (`issueBinding.repositoryId`, deliberately durable across the worktree's own
// eventual archival) -- a DIFFERENT local directory. Before the fix, `resolveJourneyCheckoutRoot`
// could only ever resolve back to that original, registered checkout, so the receipt the apply just
// wrote -- keyed to the worktree -- could never be found: every refresh reported
// `description-unavailable` forever, even though the receipt existed and was perfectly readable
// under the identity it was actually written with.
describe("journey description read finds the run's own workspace receipt (regression, epic #3384)", () => {
  const COUNTS = { total: 0, passed: 0, failed: 0, pending: 0, blocked: 0, unknown: 0 };

  it("reads the receipt the real apply path wrote even though it lives under a different local checkout than the issue-bound repository", async () => {
    const description = new DescriptionFixture();
    const receiptDir = mkdtempSync(join(tmpdir(), "keiko-journey-receipt-"));
    const parentDir = realpathSync(mkdtempSync(join(tmpdir(), "keiko-journey-parent-")));
    const db = new DatabaseSync(":memory:");
    const events: ServerLogEvent[] = [];
    try {
      // WRITE side: the REAL receipt store, exactly as the apply in `prDescriptionEffects.ts` /
      // `prDescriptionService.ts` writes through it -- keyed to `description.root`, the coding
      // run's OWN workspace (standing in for its managed worktree). Two CAS'd writes, exactly
      // `bodyEffectAdapter`'s own sequence in `prDescriptionEffects.ts`: a pre-mutation
      // "recovery-required"/"uncertain" journal (so a crash mid-PATCH is never read back as
      // confirmed), then the post-mutation "applied"/"confirmed" status
      // (`applicationStatus(..., "applied", "confirmed", ...)`, the exact call made after a
      // confirmed apply) CAS'd against the first write's version. The binding comes from a real
      // preview so every digest is genuine, not hand-typed.
      const evidenceStore = createNodeEvidenceStore(receiptDir);
      const preview = await description.service.preview({ language: "en" });
      if (preview.outcome !== "preview") throw new Error("Fixture preview failed");
      const now = Date.now();
      const descriptionBinding = preview.preview.status.binding;
      const writeStore = createPrDescriptionReceiptStore({
        evidenceStore,
        redact: (value: string): string => value,
      });
      const uncertain = applicationStatus(
        descriptionBinding,
        "complete",
        "recovery-required",
        "uncertain",
        now,
      );
      const started = writeStore.recordStatus(description.context, uncertain, null);
      expect(started.ok).toBe(true);
      const applied = applicationStatus(
        descriptionBinding,
        "complete",
        "applied",
        "confirmed",
        now,
      );
      const written = writeStore.recordStatus(
        description.context,
        applied,
        started.ok ? started.version : null,
      );
      expect(written.ok).toBe(true);

      // READ side: `parentDir` stands in for the ORIGINAL repository the issue was accepted
      // against -- the checkout `issueBinding.repositoryId` is keyed to -- and is registered as a
      // project so `journeyReaderRoot` can resolve it. `description.root` (the run's own worktree)
      // is ALSO registered so the real, unmocked `resolveProjectWorkspace` admits it once
      // `workspaceLifecycle.list` names it as a candidate; this proves the fix's own composition
      // (`resolveJourneyDescriptionCheckoutRoots`) without re-proving the separately-tested managed
      // worktree strong-prover. `journeyReaderRoot` still cannot find `description.root` through
      // `repositoryId` matching alone -- its own content-free id is necessarily different from
      // `parentDir`'s -- reproducing the exact defect precondition.
      const store = createInMemoryUiStore();
      store.createProject(parentDir, "parent");
      store.createProject(description.root, "worktree");
      const repositoryId = githubIssueReaderRepositoryId(parentDir);
      if (repositoryId === undefined) throw new Error("Fixture parent repository required");
      expect(repositoryId).not.toBe(githubIssueReaderRepositoryId(description.root));

      const remoteDigest = codingWorkbenchRemoteDigest("owner/repo");
      const identity = description.remote.identity;
      const nowIso = new Date(now).toISOString();
      const DIGEST = "b".repeat(64);

      runMigrations(db);
      const snapshots = createCodingRuntimeSnapshotStore(db);
      const binding = {
        runId: "run-1",
        workspaceDigest: DIGEST,
        runtimeAuthorityDigest: DIGEST,
        envelopeDigest: DIGEST,
        remoteDigest,
        issueBindingDigest: DIGEST,
        issueIdDigest: DIGEST,
        issueNumber: 1,
        repository: "owner/repo",
        remoteAlias: "origin" as const,
        baseRef: identity.baseRef,
        baseSha: identity.baseSha,
        headRef: identity.headRef,
        headSha: identity.headSha,
        verifiedCommitProposalId: "commit-1",
        recoveryId: "delivery-1",
      };
      snapshots.create({
        schemaVersion: "1",
        runId: "run-1",
        state: "running",
        revision: 0,
        requestedMode: "autonomous-delivery",
        runtimeSource: "keiko-sidecar",
        modelSource: "keiko-model-gateway",
        createdAt: nowIso,
        updatedAt: nowIso,
        taskDigest: DIGEST,
        workspaceDigest: DIGEST,
        operatorDigest: DIGEST,
        authorityDigest: DIGEST,
        bindingDigest: DIGEST,
        provenanceDigest: DIGEST,
        toolCallCount: 0,
        patchByteCount: 0,
        modelRequestCount: 0,
        issueBinding: {
          schemaVersion: "1",
          repositoryId,
          remoteDigest,
          issueNumber: 1,
          issueIdDigest: DIGEST,
          defaultBaseRef: identity.baseRef,
          contentRevisionDigest: DIGEST,
          bindingDigest: DIGEST,
        },
      });
      snapshots.recordVerifiedCommit({
        schemaVersion: "1",
        runId: "run-1",
        proposalId: "commit-1",
        envelopeDigest: DIGEST,
        runtimeAuthorityDigest: DIGEST,
        workspaceDigest: DIGEST,
        // Must equal the draft binding's `remoteDigest`, not a generic placeholder:
        // `matchesVerifiedCommit` (codingRuntimeDraftDeliverySource.ts) checks
        // `commit.repositoryDigest === target.remoteDigest`.
        repositoryDigest: remoteDigest,
        baseSha: identity.baseSha,
        parentSha: "2".repeat(40),
        stagedTreeDigest: DIGEST,
        verificationEvidenceId: "verification-1",
        messageDigest: DIGEST,
        issueBindingDigest: DIGEST,
        status: "succeeded",
        reason: "completed",
        headSha: identity.headSha,
        committedTreeDigest: DIGEST,
        recordedAt: nowIso,
      });
      const initial: DraftDeliveryRecord = {
        schemaVersion: "1",
        revision: 0,
        phase: "push-proposed",
        reason: "approval-required",
        proposalId: "push-1",
        proposalDigest: DIGEST,
        recordedAt: nowIso,
        binding,
      };
      snapshots.recordDraftDelivery(initial, null);
      const steps: readonly Pick<DraftDeliveryRecord, "phase" | "reason">[] = [
        { phase: "pushing", reason: "in-flight" },
        { phase: "pushed", reason: "completed" },
        { phase: "pr-proposed", reason: "approval-required" },
        { phase: "creating-pr", reason: "in-flight" },
        { phase: "draft-created", reason: "completed" },
      ];
      for (const [index, step] of steps.entries())
        snapshots.recordDraftDelivery(
          {
            ...initial,
            ...step,
            revision: index + 1,
            ...(step.phase === "draft-created"
              ? {
                  pullRequest: {
                    number: 123,
                    externalId: identity.externalId,
                    url: identity.url,
                    repository: "owner/repo",
                    headRepository: "owner/repo",
                    headRef: identity.headRef,
                    headSha: identity.headSha,
                    baseRef: identity.baseRef,
                    baseSha: identity.baseSha,
                    state: "open",
                    isDraft: true,
                  } as const,
                }
              : {}),
          },
          index,
        );

      const deps = baseDeps({
        store,
        codingRuntimeSnapshotStore: snapshots,
        evidenceStore,
        redactor: (value: unknown): unknown => value,
        workspaceLifecycle: {
          list: (root: string): readonly unknown[] =>
            root === parentDir ? [{ managedWorktreePath: description.root }] : [],
        } as never,
        activityLog: {
          write: (event: ServerLogEvent): void => {
            events.push(event);
          },
        },
      });

      const facts: GitJourneyFactsResult = {
        status: "observed",
        identity: {
          number: 123,
          externalId: identity.externalId,
          url: identity.url,
          repository: "owner/repo",
          headRepository: "owner/repo",
          headRef: identity.headRef,
          headSha: identity.headSha,
          baseRef: identity.baseRef,
          baseSha: identity.baseSha,
          state: "open",
          isDraft: true,
        },
        repositoryId: 41,
        defaultBranchRef: identity.baseRef,
        mergedAt: null,
        mergeCommitSha: null,
        reviewDecision: "unknown",
        issue: { number: 1, state: "open", closedAt: null },
        reviewConversations: { total: 0, unresolved: 0, resolved: 0 },
        factsDigest: "a".repeat(64),
      };
      const readiness: ReadinessSnapshot = {
        schemaVersion: "1",
        runId: "run-1",
        remoteDigest,
        repository: "owner/repo",
        prNumber: 123,
        baseRef: identity.baseRef,
        baseSha: identity.baseSha,
        headRef: identity.headRef,
        headSha: identity.headSha,
        requirementsVersion: "1",
        requirementsDigest: DIGEST,
        strictBaseRequired: false,
        observedAt: nowIso,
        expiresAt: new Date(now + 60_000).toISOString(),
        evidenceRef: "ci-observation-1",
        complete: true,
        state: "technical-ready",
        reason: "required-checks-passed",
        requiredChecks: COUNTS,
        advisoryChecks: COUNTS,
        pullRequest: { status: "open", isDraft: true, conflict: "clear", baseCurrency: "current" },
        humanReview: {
          visibility: "complete",
          requiredCount: 0,
          approvedCount: 0,
          changesRequestedCount: 0,
        },
      };

      const group = createGitDeliveryJourneyRouteGroup({
        reader: (): GitJourneyReader => fakeReader(facts),
        readiness: () => Promise.resolve(readiness),
        // No `description` override: exercises the REAL descriptionFor/readDescriptionStatus path
        // this regression is about.
      });
      const result = (await group[0]?.handler(
        ctxFor({ schemaVersion: "1", runId: "run-1" }),
        deps,
      )) as RouteResult;

      // Before the fix: `resolveJourneyCheckoutRoot` only ever resolves `parentDir`, so the receipt
      // written under `description.root` is never found -- `outcome.description` stays null and
      // `reason` is stuck at "description-unavailable" on every refresh. After the fix, the read
      // finds the SAME status the write recorded and the outcome advances all the way to the
      // ready-for-review handoff.
      expect(result.body).toMatchObject({
        status: "observed",
        outcome: {
          reason: "ready-approval-required",
          keikoDescriptionApplied: true,
          description: { reason: "applied", effect: "confirmed" },
        },
      });
      // The miss on `parentDir` (the first, ordinary candidate) is a clean "not found", never a
      // logged failure -- trying further candidates must stay silent on an expected miss so a
      // routine poll for a not-yet-applied description does not spam the activity log.
      const readFailures = events.filter(
        (event) => event.op === "git.pr-description.receipt" && event.extra?.phase === "read",
      );
      expect(readFailures).toHaveLength(0);
    } finally {
      description.close();
      db.close();
      rmSync(receiptDir, { recursive: true, force: true });
      rmSync(parentDir, { recursive: true, force: true });
    }
  });
});
