import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_EXPLORATION_BUDGET } from "@oscharko-dev/keiko-contracts/connected-context";
import { DEFAULT_LEXICAL_MATCH_LIMIT } from "@oscharko-dev/keiko-workflows";
import {
  DEFAULT_SEARCH_LIMITS,
  detectWorkspaceAt,
  searchText,
  readExcerpt,
  RepoSearchInvalidRangeError,
  type ReadExcerptRequest,
  type SearchScope,
} from "@oscharko-dev/keiko-workspace";
import { createFileServerLogSink } from "./observability/index.js";
import {
  expectActivityLogProof,
  readPersistedActivityLog,
} from "../../../tests/support/activity-log-proof.js";
import { buildGroundedGatewayMessages } from "./grounded-qa.js";
import { buildRedactor } from "./deps.js";
import { retrieveConnectedContextPack } from "./grounded-orchestrator.js";

const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function ordinaryReadAndElapsedBudget(index: number): string {
  const body = Array.from(
    { length: 38 },
    (_, field) =>
      `  const readElapsedBudget${String(field)} = budget.readBytes - usage.elapsedMs + ${String(field)};`,
  );
  return [
    `export function readElapsedBudget${String(index)}(budget, usage) {`,
    ...body,
    "  return budget.readBytes - usage.elapsedMs;",
    "}",
    ...Array.from({ length: 12 }, () => "// Independent utility boundary."),
  ].join("\n");
}

function source(): string {
  return [
    ...Array.from({ length: 100 }, (_, index) => ordinaryReadAndElapsedBudget(index)),
    "export function remainingTokenAllowance(budget, usage) {",
    "  return Math.max(0, budget.modelInputTokensMax - usage.promptTokens);",
    "}",
    "",
  ].join("\n");
}

function fixture(path = "quota-engine.ts"): {
  readonly root: string;
  readonly path: string;
  readonly content: string;
} {
  const root = mkdtempSync(join(tmpdir(), "keiko-query-facets-"));
  roots.push(root);
  const content = source();
  writeFileSync(join(root, path), content);
  return { root, path, content };
}

function query(text: string): {
  readonly kind: "natural-language";
  readonly text: string;
  readonly maxResults: number;
  readonly caseSensitive: false;
  readonly emittedAtMs: number;
} {
  return {
    kind: "natural-language",
    text,
    maxResults: DEFAULT_LEXICAL_MATCH_LIMIT,
    caseSensitive: false,
    emittedAtMs: 0,
  };
}

function selectedScope(root: string): SearchScope {
  return {
    workspace: detectWorkspaceAt(root, undefined, { scanSourceFilesForLanguages: false }),
    scopeId: "query-facets",
    relativePaths: [],
  };
}

async function assertLowerScoredTokenAtom(
  current: ReturnType<typeof fixture>,
  request: ReturnType<typeof query>,
): Promise<void> {
  const raw = await searchText(
    selectedScope(current.root),
    request,
    { ...DEFAULT_SEARCH_LIMITS, maxMatchesReturned: request.maxResults, elapsedMsMax: null },
    { nowMs: () => 0, searchHints: { retrievalIntent: "targeted-code-search" } },
  );
  const tokenLine =
    current.content.split("\n").findIndex((line) => line.includes("usage.promptTokens")) + 1;
  const tokenAtom = raw.atoms.find(
    (atom) =>
      (atom.lineRange?.startLine ?? Infinity) <= tokenLine &&
      (atom.lineRange?.endLine ?? 0) >= tokenLine,
  );
  expect(tokenAtom).toBeDefined();
  expect(tokenAtom?.score).toBeLessThan(Math.max(...raw.atoms.map((atom) => atom.score)));
}

function retrievalInput(
  root: string,
  request: ReturnType<typeof query>,
): Parameters<typeof retrieveConnectedContextPack>[0] {
  return {
    workspaceRoot: root,
    scope: {
      schemaVersion: "1",
      scopeId: "query-facets",
      workspaceRoot: root,
      kind: "workspace-root",
      relativePaths: [],
      connectedAtMs: 0,
      explicitConnection: true,
      conversationId: undefined,
    },
    query: request,
    budget: DEFAULT_EXPLORATION_BUDGET,
  };
}

function range(line: number): { readonly startLine: number; readonly endLine: number } {
  return { startLine: line, endLine: line };
}

function excerptFixture(content: string): {
  readonly scope: SearchScope;
  readonly request: ReadExcerptRequest;
} {
  const root = mkdtempSync(join(tmpdir(), "keiko-query-facet-reader-"));
  roots.push(root);
  writeFileSync(join(root, "source.txt"), content);
  return {
    scope: selectedScope(root),
    request: {
      scopePath: "source.txt",
      startLine: 1,
      endLine: content.split("\n").length,
      maxBytes: 18,
      maxTotalBytes: 18,
      ranges: [],
      rangeQueues: [[range(1), range(2), range(3)]],
      query: query("read token elapsed"),
    },
  };
}

describe("ordinary source ranges cover independently requested query facets", () => {
  it("retains current token accounting after stronger repeated read/elapsed matches", async () => {
    const current = fixture();
    const request = query(
      `Explain ${current.path} and how it preserves read, token and elapsed budgets.`,
    );
    await assertLowerScoredTokenAtom(current, request);
    const stateDir = mkdtempSync(join(tmpdir(), "keiko-query-facet-log-"));
    roots.push(stateDir);
    const activityLog = createFileServerLogSink(stateDir, { level: "debug" });
    const correlationId = "query-facet-public-regression";
    const { pack } = await retrieveConnectedContextPack(retrievalInput(current.root, request), {
      nowMs: () => 0,
      activityLog,
      correlationId,
      answerer: { answer: () => Promise.reject(new TypeError("No synthesis is permitted.")) },
    });
    activityLog.close?.();
    const expression = "budget.modelInputTokensMax - usage.promptTokens";
    expect(
      pack.files.flatMap((file) => file.excerpts).some((view) => view.content.includes(expression)),
    ).toBe(true);
    expect(pack.usage.excerptBytes).toBeLessThanOrEqual(DEFAULT_EXPLORATION_BUDGET.excerptBytesMax);
    const prompt = buildGroundedGatewayMessages(request.text, pack, buildRedactor({}, undefined))
      .map((message) => message.content)
      .join("\n");
    expect(prompt).toContain(expression);
    const raw = readPersistedActivityLog(stateDir);
    const line = raw
      .split("\n")
      .find((entry) => entry.includes('"op":"search.connected-context.completion-details"'));
    if (line === undefined) throw new TypeError("Missing completion details");
    const record = expectActivityLogProof("search.connected-context.completion-details.line", line);
    expect(record.correlationId).toBe(correlationId);
    expect(raw).not.toContain(current.path);
    expect(raw).not.toContain(expression);
  });

  it("persists actual ordinary facet counts on the registered completion operation", async () => {
    const current = fixture("quota-guide.txt");
    const stateDir = mkdtempSync(join(tmpdir(), "keiko-query-facet-count-log-"));
    roots.push(stateDir);
    const activityLog = createFileServerLogSink(stateDir, { level: "debug" });
    const correlationId = "ordinary-facet-returned-content";
    await retrieveConnectedContextPack(
      retrievalInput(
        current.root,
        query(`Explain ${current.path} and how it preserves read, token and elapsed budgets.`),
      ),
      {
        nowMs: () => 0,
        activityLog,
        correlationId,
        answerer: { answer: () => Promise.reject(new TypeError("No synthesis is permitted.")) },
      },
    );
    activityLog.close?.();
    const raw = readPersistedActivityLog(stateDir);
    const line = raw
      .split("\n")
      .find((entry) => entry.includes('"op":"search.connected-context.completion-details"'));
    if (line === undefined) throw new TypeError("Missing completion details");
    const record = expectActivityLogProof("search.connected-context.completion-details.line", line);
    expect(record.correlationId).toBe(correlationId);
    expect(record).not.toHaveProperty("excerptPlannedQueryFacetCount");
    expect(record.excerptServedQueryFacetCount).toBeGreaterThan(0);
    const served = record.excerptServedQueryFacetCount;
    if (typeof served !== "number") throw new TypeError("Missing numeric query facet observations");
    expect(record).not.toHaveProperty("_truncatedFieldCount");
    expect(raw).not.toContain(current.path);
    expect(raw).not.toContain("budget.modelInputTokensMax - usage.promptTokens");
  });

  it("counts returned facets once despite overlapping duplicate group queues", async () => {
    const current = excerptFixture("read elapsed\nread elapsed\ntoken\nunrequested tail");
    const result = await readExcerpt(current.scope, current.request);
    const content = (result.windows ?? [result]).map((window) => window.content).join("\n");
    expect(content).toContain("token");
    expect(content).toContain("read elapsed");
    expect(result.queryFacetObservation?.plannedGroups).toHaveLength(3);
    expect(result.queryFacetObservation?.servedGroups).toHaveLength(3);
    expect(content).not.toContain("unrequested tail");
    expect(
      (result.windows ?? [result]).reduce(
        (sum, window) => sum + Buffer.byteLength(window.content),
        0,
      ),
    ).toBeLessThanOrEqual(18);
  });

  it("keeps the original ordered queue when no query was supplied", async () => {
    const current = excerptFixture("read elapsed\nread elapsed\ntoken");
    const result = await readExcerpt(current.scope, { ...current.request, query: undefined });
    expect(result.content).toBe("read elapsed");
    expect(result.queryFacetObservation).toBeUndefined();
  });

  it("does not invent a requested but absent facet", async () => {
    const current = excerptFixture("read elapsed\nread elapsed\nread elapsed");
    const result = await readExcerpt(current.scope, current.request);
    expect(result.queryFacetObservation?.plannedGroups).toHaveLength(2);
    expect(result.queryFacetObservation?.servedGroups).toHaveLength(2);
    expect((result.windows ?? [result]).every((window) => !window.content.includes("token"))).toBe(
      true,
    );
  });

  it("does not report a facet beyond a truncated oversized returned range", async () => {
    const current = excerptFixture(`read\n${"x".repeat(100)} token\nunrequested elapsed`);
    const result = await readExcerpt(current.scope, {
      ...current.request,
      query: query("read token"),
      rangeQueues: [[range(1), range(2)]],
      maxBytes: 8,
      maxTotalBytes: 8,
    });
    expect(result.queryFacetObservation?.plannedGroups).toHaveLength(2);
    expect(result.queryFacetObservation?.servedGroups).toHaveLength(1);
    expect((result.windows ?? [result]).some((window) => window.truncated)).toBe(true);
    expect(
      (result.windows ?? [result]).reduce(
        (sum, window) => sum + Buffer.byteLength(window.content),
        0,
      ),
    ).toBeLessThanOrEqual(8);
  });

  it("serves a funded prefix before ordinary facet opportunities", async () => {
    const current = excerptFixture("manual\nread\ntoken");
    const result = await readExcerpt(current.scope, {
      ...current.request,
      ranges: [range(1)],
      rangeQueues: [[range(2), range(3)]],
      query: query("read token"),
      maxBytes: 6,
      maxTotalBytes: 6,
    });
    expect(result.content).toBe("manual");
    expect(result.queryFacetObservation?.servedGroups).toEqual([]);
  });

  it("preserves explicit selected line geometry instead of expanding to a late facet", async () => {
    const current = fixture();
    const request = query(`Explain ${current.path}:1 and its read, token and elapsed budgets.`);
    const { pack } = await retrieveConnectedContextPack(retrievalInput(current.root, request), {
      correlationId: undefined,
      nowMs: () => 0,
      answerer: { answer: () => Promise.reject(new TypeError("No synthesis is permitted.")) },
    });
    const excerpts = pack.files.flatMap((file) => file.excerpts);
    expect(excerpts.some((view) => view.atom.lineRange?.startLine === 1)).toBe(true);
    expect(excerpts.every((view) => !view.content.includes("usage.promptTokens"))).toBe(true);
    expect(pack.usage.excerptBytes).toBeLessThanOrEqual(DEFAULT_EXPLORATION_BUDGET.excerptBytesMax);
  });

  it("retains independent pre-existing queues without ordinary facet regrouping", async () => {
    const current = excerptFixture("read elapsed\nread elapsed\ntoken");
    const result = await readExcerpt(current.scope, {
      ...current.request,
      rangeQueues: [[range(1)], [range(3)]],
    });
    expect((result.windows ?? [result]).map((window) => window.content)).toEqual([
      "token",
      "read elapsed",
    ]);
    expect(result.queryFacetObservation).toBeUndefined();
  });

  it("yields to queued cancellation even when every proposed range overlaps cached lines", async () => {
    const current = excerptFixture("read elapsed\ntoken\nunrequested");
    const controller = new AbortController();
    let cancelled: NodeJS.Immediate | undefined;
    let checks = 0;
    const nowMs = (): number => {
      checks += 1;
      if (checks === 100)
        cancelled = setImmediate(() => {
          controller.abort();
        });
      return 0;
    };
    try {
      await expect(
        readExcerpt(
          current.scope,
          {
            ...current.request,
            rangeQueues: [Array.from({ length: 600 }, () => ({ startLine: 1, endLine: 2 }))],
          },
          { signal: controller.signal, nowMs },
        ),
      ).rejects.toMatchObject({ reason: "aborted" });
    } finally {
      if (cancelled !== undefined) clearImmediate(cancelled);
    }
  });

  it.each(["file-pattern", "regex", "exact-symbol"] as const)(
    "does not enable natural-language facet planning for %s requests",
    async (kind) => {
      const current = excerptFixture("read elapsed\nread elapsed\ntoken");
      await expect(
        readExcerpt(current.scope, { ...current.request, query: { ...query("read"), kind } }),
      ).rejects.toBeInstanceOf(RepoSearchInvalidRangeError);
    },
  );

  it.each(["aborted", "timeout"] as const)(
    "stops facet planning under the original %s control",
    async (reason) => {
      // The supplied clock drives this planning stop; live IO must not win a 10 ms wall-clock race.
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const current = excerptFixture(
        Array.from({ length: 600 }, () => "read token elapsed").join("\n"),
      );
      const controller = new AbortController();
      let checks = 0;
      const nowMs = (): number => {
        checks += 1;
        if (checks === 100 && reason === "aborted") controller.abort();
        return checks >= 100 && reason === "timeout" ? 10 : 0;
      };
      await expect(
        readExcerpt(
          current.scope,
          { ...current.request, rangeQueues: [[{ startLine: 1, endLine: 600 }]] },
          { nowMs, signal: controller.signal, deadlineAtMs: 10 },
        ),
      ).rejects.toMatchObject({ reason });
      expect(checks).toBeGreaterThanOrEqual(100);
    },
  );
});
