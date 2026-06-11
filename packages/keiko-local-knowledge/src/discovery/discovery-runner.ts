// Discovery orchestrator (Epic #189, Issue #194). Composes the walker (walk.ts) with the
// per-file extractor (extract.ts) and emits a stream of `ExtractionEvent` values. The
// runner is intentionally an async generator so the consumer (e.g. the eventual indexer
// loop in #196 or the streaming UI surface) decides how aggressively to back-pressure.
//
// Cancellation: a single `AbortSignal` flows into BOTH the walker AND the per-file parser
// options. Aborting the signal mid-walk drops out within one directory of work; aborting
// between extractions yields a terminal `cancelled` event and stops iteration.

import type { KnowledgeCapsuleId, KnowledgeSource } from "@oscharko-dev/keiko-contracts";
import type { WorkspaceFs } from "@oscharko-dev/keiko-workspace";

import { buildParserOptions, type ParserOptions, type ParserRegistry } from "../parsers/index.js";
import type { KnowledgeStore } from "../store.js";

import { extractDocument, recordExtractionFailure } from "./extract.js";
import { DEFAULT_DISCOVERY_OPTIONS, type DiscoveryOptions, type ExtractionEvent } from "./types.js";
import { walkSource, type WalkYield } from "./walk.js";

export interface DiscoverAndExtractDeps {
  readonly fs: WorkspaceFs;
  readonly store: KnowledgeStore;
  readonly parserRegistry: ParserRegistry;
}

export interface DiscoverAndExtractParams {
  readonly capsuleId: KnowledgeCapsuleId;
  readonly source: KnowledgeSource;
  readonly discovery?: DiscoveryOptions;
  readonly parserOptions?: ParserOptions;
}

interface RunCounters {
  discovered: number;
  extracted: number;
  skipped: number;
  failed: number;
}

function makeParserOptions(
  params: DiscoverAndExtractParams,
  signal: AbortSignal | undefined,
): ParserOptions {
  if (params.parserOptions !== undefined) {
    if (signal === undefined || params.parserOptions.signal !== undefined) {
      return params.parserOptions;
    }
    return { ...params.parserOptions, signal };
  }
  return buildParserOptions(signal !== undefined ? { signal } : {});
}

function makeDiscoveryOptions(
  params: DiscoverAndExtractParams,
  signal: AbortSignal | undefined,
): DiscoveryOptions {
  const base = params.discovery ?? DEFAULT_DISCOVERY_OPTIONS;
  if (signal === undefined || base.signal !== undefined) {
    return base;
  }
  return { ...base, signal };
}

function bumpCounters(counters: RunCounters, kind: "persisted" | "skipped" | "failed"): void {
  if (kind === "persisted") {
    counters.extracted += 1;
    return;
  }
  if (kind === "skipped") {
    counters.skipped += 1;
    return;
  }
  counters.failed += 1;
}

async function* handleWalkYield(
  yld: WalkYield,
  deps: DiscoverAndExtractDeps,
  params: DiscoverAndExtractParams,
  parserOptions: ParserOptions,
  counters: RunCounters,
): AsyncGenerator<ExtractionEvent> {
  if (yld.kind === "error") {
    if (yld.error.code === "CANCELLED") {
      yield { kind: "cancelled", reason: yld.error.message };
      return;
    }
    if (yld.error.relativePath !== undefined && yld.error.code !== "INVALID_SCOPE") {
      recordExtractionFailure(deps, {
        capsuleId: params.capsuleId,
        source: params.source,
        file: { relativePath: yld.error.relativePath, sizeBytes: 0 },
        error: yld.error,
      });
      counters.failed += 1;
    }
    yield { kind: "scope-error", error: yld.error };
    return;
  }
  counters.discovered += 1;
  yield {
    kind: "file-discovered",
    relativePath: yld.file.relativePath,
    sizeBytes: yld.file.sizeBytes,
  };
  const result = await extractDocument(deps, {
    capsuleId: params.capsuleId,
    source: params.source,
    file: yld.file,
    parserOptions,
  });
  bumpCounters(counters, result.outcome.kind);
  yield { kind: "file-extracted", result };
}

function completionEvent(counters: RunCounters): ExtractionEvent {
  return {
    kind: "completed",
    totalDiscovered: counters.discovered,
    totalExtracted: counters.extracted,
    totalSkipped: counters.skipped,
    totalFailed: counters.failed,
  };
}

// Reads `signal?.aborted` through a function call so TypeScript's control-flow analysis
// does NOT narrow the optional chain after the first false branch (same pattern as walk.ts).
function aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

export async function* discoverAndExtract(
  deps: DiscoverAndExtractDeps,
  params: DiscoverAndExtractParams,
): AsyncGenerator<ExtractionEvent> {
  const signal = params.discovery?.signal ?? params.parserOptions?.signal;
  const discovery = makeDiscoveryOptions(params, signal);
  const parserOptions = makeParserOptions(params, signal);
  const counters: RunCounters = { discovered: 0, extracted: 0, skipped: 0, failed: 0 };
  let cancelled = false;
  for (const yld of walkSource(deps.fs, params.source.scope, discovery)) {
    if (aborted(signal)) {
      yield { kind: "cancelled", reason: "AbortSignal fired between files" };
      cancelled = true;
      break;
    }
    for await (const evt of handleWalkYield(yld, deps, params, parserOptions, counters)) {
      yield evt;
      if (evt.kind === "cancelled") cancelled = true;
    }
    if (cancelled) break;
  }
  if (!cancelled) yield completionEvent(counters);
}
