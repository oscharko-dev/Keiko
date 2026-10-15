import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  DEFAULT_EXPLORATION_BUDGET,
  MAX_OMITTED_CONTEXT_ENTRIES,
  connectedContextOmittedCount,
  connectedContextOmittedCounts,
  validateConnectedContextPack,
} from "@oscharko-dev/keiko-contracts/connected-context";
import { createMicroIndex, type MicroIndex } from "@oscharko-dev/keiko-workflows";
import {
  retrieveConnectedContextPack,
  type OrchestratorInput,
  type RetrievalOnlyOutput,
} from "./grounded-orchestrator.js";
import { createBufferedServerLogSink } from "../../../tests/support/buffered-server-log.js";
import { staleSemanticMarker } from "./grounded-semantic-request.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function corpus(count: number): string {
  const root = mkdtempSync(join(tmpdir(), "keiko-wave-scale-"));
  roots.push(root);
  for (let index = 0; index < count; index += 1)
    writeFileSync(
      join(root, `fact-${String(index).padStart(5, "0")}.txt`),
      `WaveScaleProbe value=${String(index)} ${"x".repeat(80)}\n`,
    );
  return root;
}

function request(root: string, count: number): OrchestratorInput {
  return {
    workspaceRoot: root,
    scope: {
      schemaVersion: "1",
      scopeId: "scale-fixture",
      workspaceRoot: root,
      kind: "workspace-root",
      relativePaths: [],
      connectedAtMs: 0,
      explicitConnection: true,
      conversationId: undefined,
    },
    query: {
      kind: "exact-symbol",
      text: "WaveScaleProbe",
      maxResults: count,
      caseSensitive: true,
      emittedAtMs: 0,
    },
    budget: { ...DEFAULT_EXPLORATION_BUDGET, excerptBytesMax: count },
  };
}

async function retrieve(
  input: OrchestratorInput,
  microIndex?: MicroIndex,
): Promise<RetrievalOnlyOutput & { log: ReturnType<typeof createBufferedServerLogSink> }> {
  const log = createBufferedServerLogSink();
  const output = await retrieveConnectedContextPack(input, {
    correlationId: "wave-scale-fixture",
    activityLog: log,
    nowMs: () => 0,
    ...(microIndex === undefined ? {} : { microIndex }),
    answerer: { answer: () => Promise.reject(new TypeError("No model call is permitted.")) },
  });
  return { ...output, log };
}

describe("real retrieval omission and cache scale", () => {
  it("keeps exact full omission totals when a live byte tail exceeds retained detail capacity", async () => {
    const count = MAX_OMITTED_CONTEXT_ENTRIES + 1_024;
    const input = request(corpus(count), count);
    const { pack, log } = await retrieve(input);
    expect(pack.files.length).toBeGreaterThan(0);
    expect(pack.files.length).toBeLessThan(100);
    expect(pack.usage.excerptBytes).toBeLessThanOrEqual(count);
    expect(connectedContextOmittedCounts(pack)["budget-exhausted"]).toBeGreaterThan(
      MAX_OMITTED_CONTEXT_ENTRIES,
    );
    expect(pack.files.length + connectedContextOmittedCount(pack)).toBe(count);
    expect(pack.omitted).toHaveLength(MAX_OMITTED_CONTEXT_ENTRIES);
    expect(new Set(pack.omitted.map((entry) => entry.scopePath)).size).toBe(pack.omitted.length);
    expect(validateConnectedContextPack(pack)).toEqual({ ok: true });
    expect(
      log.events.find((event) => event.op === "search.connected-context.source-details")?.extra,
    ).toMatchObject({
      omittedBudgetExhaustedCount: connectedContextOmittedCounts(pack)["budget-exhausted"],
      omittedDetailsClipped: true,
    });
  });

  it("reuses a produced truncated pack with its exact read and omitted sets", async () => {
    const input = request(corpus(64), 64);
    const real = createMicroIndex({ maxEntries: 4, ttlMs: 60_000, nowMs: () => 0 });
    let hits = 0;
    const cache: MicroIndex = {
      ...real,
      get: (key) => {
        const pack = real.get(key);
        if (pack !== undefined) hits += 1;
        return pack;
      },
    };
    const first = await retrieve(input, cache);
    expect(first.pack.files.length).toBeGreaterThan(0);
    expect(connectedContextOmittedCount(first.pack)).toBeGreaterThan(0);
    const second = await retrieve(input, cache);
    expect(hits).toBe(1);
    expect(second.pack).toBe(first.pack);
    expect(second.pack.files.length + connectedContextOmittedCount(second.pack)).toBe(64);
    expect(validateConnectedContextPack(second.pack)).toEqual({ ok: true });
  });

  it("reprojects changed cache diagnostics without mutating historical observations", async () => {
    const input = request(corpus(64), 64);
    const real = createMicroIndex({ maxEntries: 4, ttlMs: 60_000, nowMs: () => 0 });
    const first = await retrieve(input, real);
    const historical = Object.freeze({
      ...first.pack,
      diagnostics: Object.freeze({
        rankedCandidates: [],
        ...first.pack.diagnostics,
        semanticProviderDisposition: "unavailable" as const,
        scopeContextState: "overflow" as const,
      }),
      uncertainty: Object.freeze([
        ...first.pack.uncertainty,
        ...staleSemanticMarker({ semanticStaleFallbackCount: 1, semanticRefreshedFileCount: 0 }, 0),
      ]),
    });
    let hits = 0;
    const cache: MicroIndex = {
      ...real,
      get: (key) => {
        if (real.get(key) === undefined) return undefined;
        hits += 1;
        return historical;
      },
    };
    const current = await retrieve(input, cache);
    expect(hits).toBe(1);
    expect(current.pack).not.toBe(historical);
    expect(current.pack.diagnostics).toEqual(first.pack.diagnostics);
    expect(current.pack.uncertainty).toEqual(first.pack.uncertainty);
    expect(historical.diagnostics).toMatchObject({
      semanticProviderDisposition: "unavailable",
      scopeContextState: "overflow",
    });
    expect(historical.uncertainty).toHaveLength(first.pack.uncertainty.length + 1);
    expect(validateConnectedContextPack(current.pack)).toEqual({ ok: true });
  });
});
