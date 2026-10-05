import { describe, expect, it } from "vitest";
import { buildGroundedAnswerContextPackSummary } from "@oscharko-dev/keiko-contracts/bff-wire";
import { validateConnectedContextPack } from "@oscharko-dev/keiko-contracts/connected-context";
import { memFs } from "@oscharko-dev/keiko-workspace/testing";
import { searchText, type SearchResult } from "@oscharko-dev/keiko-workspace";
import { retrieveConnectedContextPack } from "./grounded-orchestrator.js";
import { mergeOverviewListing } from "./grounded-overview-fallback.js";
import { mergeContextPackSummaries } from "./grounded-qa-multi-source.js";
import { createBufferedServerLogSink } from "../../../tests/support/buffered-server-log.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";

async function workspaceSearch(includeUnsupported: boolean): Promise<SearchResult> {
  const root = "/private/portable-customer";
  return searchText(
    {
      scopeId: "portable",
      relativePaths: [],
      workspace: {
        root,
        selectedRoot: root,
        name: "fixture",
        version: "0",
        testFramework: "vitest",
        sourceDirs: [],
        testDirs: [],
        languages: [],
        ignoreLines: [],
      },
    },
    {
      kind: "exact-symbol",
      text: "PortableProbe",
      maxResults: 20,
      caseSensitive: true,
      emittedAtMs: 0,
    },
    undefined,
    {
      fs: memFs(root, {
        "fact.txt": "PortableProbe=VISIBLE\n",
        ...(includeUnsupported ? { "~archive/hidden.txt": "PortableProbe=UNSEARCHED\n" } : {}),
      }),
    },
  );
}

async function search(text = "PortableProbe"): Promise<{
  readonly result: Awaited<ReturnType<typeof retrieveConnectedContextPack>>;
  readonly log: ReturnType<typeof createBufferedServerLogSink>;
}> {
  const root = "/private/portable-customer";
  const log = createBufferedServerLogSink();
  const result = await retrieveConnectedContextPack(
    {
      workspaceRoot: root,
      scope: {
        schemaVersion: "1",
        scopeId: "portable",
        workspaceRoot: root,
        kind: "workspace-root",
        relativePaths: [],
        connectedAtMs: 0,
        conversationId: undefined,
        explicitConnection: true,
      },
      query: { kind: "exact-symbol", text, maxResults: 20, caseSensitive: true, emittedAtMs: 0 },
    },
    {
      fs: memFs(root, {
        "fact.txt": "PortableProbe=VISIBLE\n",
        "~archive/hidden.txt": "PortableProbe=UNSEARCHED\n",
        ".env": "SECRET_DECOY",
      }),
      nowMs: () => 0,
      correlationId: "portable-coverage-request",
      activityLog: log,
      answerer: { answer: () => Promise.reject(new TypeError("No model call permitted")) },
    },
  );
  return { result, log };
}

describe("portable-path coverage in connected Chat", () => {
  it("retains observed entry loss through overview fallback and overlapping passes", async () => {
    const partial = await workspaceSearch(true);
    const complete = await workspaceSearch(false);
    const fallback = mergeOverviewListing(partial, complete);
    expect(fallback.coverage).toMatchObject({
      incomplete: true,
      reasons: ["unrepresentable-path"],
      unrepresentablePathsByDiscovery: 1,
    });
    expect(fallback.diagnostics?.unrepresentablePathsByDiscovery).toBe(1);
    expect(mergeOverviewListing(partial, partial).coverage.unrepresentablePathsByDiscovery).toBe(2);
    expect(partial.coverage.filesSkipped).toBe(0);
  });

  it.each(["PortableProbe", "MissingPortableProbe"])(
    "keeps an honest partial result for %s",
    async (text) => {
      const { result, log } = await search(text);
      const coverage = result.pack.diagnostics?.coverage;
      expect(coverage).toMatchObject({
        incomplete: true,
        reasons: ["unrepresentable-path"],
        unrepresentablePathsByDiscovery: 1,
        deniedByDiscovery: 1,
      });
      expect(result.pack.uncertainty).toContainEqual(
        expect.objectContaining({ kind: "scope-incomplete" }),
      );
      expect(validateConnectedContextPack(result.pack).ok).toBe(true);
      expect(
        log.events.find((event) => event.op === "search.connected-context.source-details")?.extra,
      ).toMatchObject({ unrepresentablePathCount: 1 });
      expect(
        log.events.find((event) => event.op === "search.connected-context.completed")?.extra,
      ).toMatchObject({ coverageStatus: "incomplete", coverageReasons: ["unrepresentable-path"] });
      expect(JSON.stringify(log.events)).not.toContain("~archive");
      expect(JSON.stringify(log.events)).not.toContain("UNSEARCHED");
      const summary = buildGroundedAnswerContextPackSummary(result.pack, 0, 0);
      expect(summary.coverage).toEqual(coverage);
      expect(mergeContextPackSummaries([summary, summary]).coverage).toMatchObject({
        incomplete: true,
        reasons: ["unrepresentable-path"],
        unrepresentablePathsByDiscovery: 2,
      });
    },
  );
});

describe("canonical portable coverage evidence", () => {
  it("persists partial coverage and the separate rejected-entry count", async () => {
    const { log } = await search();
    const detail = log.events.find(
      (event) => event.op === "search.connected-context.source-details",
    );
    const terminal = log.events.find((event) => event.op === "search.connected-context.completed");
    expect(
      expectActivityLogProof(
        "search.connected-context.source-details.line",
        formatActivityLogProofLine(detail ?? {}),
      ),
    ).toMatchObject({ correlationId: "portable-coverage-request", unrepresentablePathCount: 1 });
    expect(
      expectActivityLogProof(
        "search.connected-context.completed.line",
        formatActivityLogProofLine(terminal ?? {}),
      ),
    ).toMatchObject({
      correlationId: "portable-coverage-request",
      coverageStatus: "incomplete",
      coverageReasons: ["unrepresentable-path"],
    });
  });
});
