// Parser registry (Epic #189, Issue #266). A frozen-after-build map of `ParserAdapter`
// values. `resolveParser` returns the first registered adapter whose capability matches the
// input, OR the unsupported sentinel. The registry is intentionally tiny — selection logic
// lives inside the adapters' `matches` predicates so a new format can land by adding one
// file plus one register call.

import { unsupportedParser } from "./unsupported-parser.js";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_UNITS,
  DEFAULT_TIMEOUT_MS,
  type ParserAdapter,
  type ParserOptions,
  type ParserRegistry,
  type ParserResolution,
  type ParserSelectionInput,
} from "./types.js";

interface MutableRegistry {
  readonly adapters: ParserAdapter[];
}

export function createParserRegistry(): ParserRegistry {
  const state: MutableRegistry = { adapters: [] };
  return Object.freeze({
    list: (): readonly ParserAdapter[] => Object.freeze([...state.adapters]),
    resolve: (input: ParserSelectionInput): ParserResolution =>
      resolveFromList(state.adapters, input),
  });
}

export function registerParser(registry: ParserRegistry, adapter: ParserAdapter): ParserRegistry {
  // We re-emit a brand-new frozen registry rather than mutate. This keeps the registry
  // value-typed and lets composition layers (#196 indexer) treat it as an immutable
  // configuration object.
  const next = [...registry.list(), adapter];
  return Object.freeze({
    list: (): readonly ParserAdapter[] => Object.freeze([...next]),
    resolve: (input: ParserSelectionInput): ParserResolution => resolveFromList(next, input),
  });
}

export function resolveParser(
  registry: ParserRegistry,
  input: ParserSelectionInput,
): ParserResolution {
  return registry.resolve(input);
}

function resolveFromList(
  adapters: readonly ParserAdapter[],
  input: ParserSelectionInput,
): ParserResolution {
  for (const adapter of adapters) {
    if (adapter === unsupportedParser) continue;
    if (adapter.capability.matches(input)) {
      return { kind: "matched", adapter };
    }
  }
  // Fall through to unsupported. The unsupported adapter's `matches` is a stable predicate
  // — it returns true for any known-unsupported signal AND for arbitrary unknown formats
  // (returns true via the magic-byte / extension table OR is explicitly invoked).
  if (unsupportedParser.capability.matches(input)) {
    return { kind: "matched", adapter: unsupportedParser };
  }
  return { kind: "unsupported", reason: "no-adapter-matched" };
}

// Convenience: build a `ParserOptions` value with defaults applied. Callers supply only the
// fields they want to override.
export function buildParserOptions(overrides: Partial<ParserOptions> = {}): ParserOptions {
  const base = {
    maxBytes: overrides.maxBytes ?? DEFAULT_MAX_BYTES,
    maxUnitsPerDocument: overrides.maxUnitsPerDocument ?? DEFAULT_MAX_UNITS,
    timeoutMs: overrides.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    now: overrides.now ?? ((): number => Date.now()),
  };
  return overrides.signal !== undefined ? { ...base, signal: overrides.signal } : base;
}

export { unsupportedParser };
