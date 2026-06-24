// Pure shaper: CommandResult -> ShapedCommandObservation (ADR-0054, PR3-W3, D4). No IO, no clock,
// no randomness. Total — never throws on empty streams. The exit-code/duration/timedOut/truncated
// signals are preserved verbatim; each non-empty stream contributes a redacted, byte-bounded
// excerpt whose combined bytes stay within MAX_OBSERVATION_EXCERPT_BYTES. Injection signals are
// recorded content-free over the already-redacted excerpt text. A rehydration handle is attached
// ONLY when the output was truncated (there is omitted content worth re-fetching in PR5).

import {
  MAX_OBSERVATION_EXCERPT_BYTES,
  type CommandResult,
  type ShapedCommandObservation,
  type ShapedStreamExcerpt,
} from "@oscharko-dev/keiko-contracts";

import {
  boundExcerpt,
  buildToolRehydrationHandle,
  estimateTokens,
  injectionSignalsFor,
  makeObservationId,
  utf8ByteLength,
} from "./shared.js";

export interface ShapeCommandOptions {
  readonly observationId?: string | undefined;
}

const TRUNCATED_NOT_PERSISTED = "tool output not persisted in PR3 (artifact store wired in PR5)";

interface StreamSource {
  readonly stream: "stdout" | "stderr";
  readonly text: string;
}

// Builds the bounded excerpts, allocating the shared MAX_OBSERVATION_EXCERPT_BYTES budget across the
// non-empty streams in order (stdout first, then stderr from the remaining budget) so the SUM of
// excerpt bytes never exceeds the cap. Each excerpt is redacted before clamping (boundExcerpt).
function buildExcerpts(sources: readonly StreamSource[]): readonly ShapedStreamExcerpt[] {
  const excerpts: ShapedStreamExcerpt[] = [];
  let remaining = MAX_OBSERVATION_EXCERPT_BYTES;
  for (const source of sources) {
    if (source.text.length === 0 || remaining <= 0) {
      continue;
    }
    const text = boundExcerpt(source.text, remaining);
    if (text.length === 0) {
      continue;
    }
    const bytes = utf8ByteLength(text);
    excerpts.push({ stream: source.stream, bytes, text });
    remaining -= bytes;
  }
  return excerpts;
}

function injectionFor(excerpts: readonly ShapedStreamExcerpt[]): {
  readonly injectionSignalCount: number;
  readonly hasCriticalInjectionSignal: boolean;
} {
  const combined = excerpts.map((excerpt) => excerpt.text).join("\n");
  const summary = injectionSignalsFor(combined);
  return {
    injectionSignalCount: summary.count,
    hasCriticalInjectionSignal: summary.critical,
  };
}

export function shapeCommandObservation(
  result: CommandResult,
  opts?: ShapeCommandOptions,
): ShapedCommandObservation {
  const observationId = opts?.observationId ?? makeObservationId("");
  const excerpts = buildExcerpts([
    { stream: "stdout", text: result.stdout },
    { stream: "stderr", text: result.stderr },
  ]);
  const injection = injectionFor(excerpts);
  return {
    kind: "command",
    observationId,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    timedOut: result.timedOut,
    truncated: result.truncated,
    ...(result.omittedByteCount !== undefined ? { omittedByteCount: result.omittedByteCount } : {}),
    excerpts,
    injectionSignalCount: injection.injectionSignalCount,
    hasCriticalInjectionSignal: injection.hasCriticalInjectionSignal,
    ...(result.truncated
      ? {
          rehydration: buildToolRehydrationHandle({
            artifactSeed: `${observationId}:full`,
            itemCount: 1,
            approxTokens: estimateTokens(excerpts.map((excerpt) => excerpt.text).join("\n")),
            notPersistedReason: TRUNCATED_NOT_PERSISTED,
          }),
        }
      : {}),
  };
}
