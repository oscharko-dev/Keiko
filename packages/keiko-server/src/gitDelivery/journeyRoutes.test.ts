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
import type { UiHandlerDeps } from "../deps.js";
import { createDraftRun, readySnapshot } from "./ciObservationTest/_support.js";
import { createGitDeliveryJourneyRouteGroup } from "./journeyRoutes.js";

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
  readonly cleanup: () => void;
}

function harness(): Harness {
  const db = new DatabaseSync(":memory:");
  const snapshots = createDraftRun(db);
  const dir = mkdtempSync(join(tmpdir(), "keiko-journey-route-"));
  const deps = {
    codingRuntimeSnapshotStore: snapshots,
    evidenceStore: createNodeEvidenceStore(dir),
    redactor: (value: string): string => value,
  } as UiHandlerDeps;
  return {
    deps,
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
    expect(
      API_ROUTES.some((route) => route.method === "POST" && route.pattern === PATTERN),
    ).toBe(true);
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
      expect(result).toEqual({ status: 200, body: { status: "unavailable", reason: "draft-unavailable" } });
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
});
