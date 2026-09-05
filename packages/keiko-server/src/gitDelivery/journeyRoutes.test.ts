// Route-level tests for the read-only journey observation route (#3389 AC1/AC5/AC6, epic #3384).
//
// Proves: the route is actually registered in the real server route table; a malformed request is
// rejected before any provider read; an unknown/unbound run yields the closed "draft-unavailable"
// fact without ever invoking a reader; and a fake GitJourneyReader driven through the real route
// handler produces a JourneyOutcome — never a fabricated "current"/green result on a description or
// readiness that was never actually observed.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import { URL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createNodeEvidenceStore } from "@oscharko-dev/keiko-evidence";
import type {
  GitJourneyFactsResult,
  GitJourneyReader,
} from "@oscharko-dev/keiko-tools/internal/git-mutation";
import type { RouteContext, RouteResult } from "../routes.js";
import { buildRedactor, createRunRegistry, type UiHandlerDeps } from "../index.js";
import { createInMemoryUiStore } from "../store/index.js";
import type { ServerLogEvent } from "../observability/server-log.js";
import { createCodingRuntimeSnapshotStore } from "../coding-runtime/codingRuntimeSnapshotStore.js";
import { createDraftRun, readySnapshot } from "./ciObservationTest/_support.js";
import { createGitDeliveryJourneyRouteGroup } from "./journeyRoutes.js";

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
    redactor: (value: string): string => value,
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
        redactor: (value: string): string => value,
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
