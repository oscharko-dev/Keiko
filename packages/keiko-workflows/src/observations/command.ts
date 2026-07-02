// CommandResult -> ShapedCommandObservation (ADR-0054, PR3-W3, D4). Total — never throws on empty
// streams or artifact-write failure. The exit-code/duration/timedOut/truncated signals are
// preserved verbatim; each non-empty stream contributes a redacted, byte-bounded excerpt whose
// combined bytes stay within MAX_OBSERVATION_EXCERPT_BYTES. Injection signals are recorded
// content-free over the already-redacted excerpt text. A rehydration handle is attached only when
// output was truncated; production callers may inject an evidence-layer artifact writer.

import {
  MAX_OBSERVATION_EXCERPT_BYTES,
  type CommandResult,
  type ContextToolRehydrationHandle,
  type ShapedCommandObservation,
  type ShapedStreamExcerpt,
} from "@oscharko-dev/keiko-contracts";

import {
  boundExcerpt,
  buildToolRehydrationHandle,
  estimateTokens,
  injectionSignalsFor,
  makeObservationId,
  type ToolResultArtifactWriter,
  utf8ByteLength,
} from "./shared.js";

export interface ShapeCommandOptions {
  readonly observationId?: string | undefined;
  readonly artifactWriter?: ToolResultArtifactWriter | undefined;
}

const TRUNCATED_NOT_PERSISTED = "tool output not persisted: artifact writer unavailable";
const TRUNCATED_PERSIST_FAILED = "tool output not persisted: artifact writer failed";

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

function commandArtifactText(result: CommandResult): string {
  const omitted =
    result.omittedByteCount === undefined
      ? ""
      : `\nomittedByteCount: ${result.omittedByteCount.toString()}`;
  return [
    `exitCode: ${result.exitCode === null ? "null" : result.exitCode.toString()}`,
    `timedOut: ${String(result.timedOut)}`,
    `truncated: ${String(result.truncated)}${omitted}`,
    "stdout:",
    boundExcerpt(result.stdout, Number.MAX_SAFE_INTEGER),
    "stderr:",
    boundExcerpt(result.stderr, Number.MAX_SAFE_INTEGER),
  ].join("\n");
}

function commandRehydrationHandle(
  observationId: string,
  artifactText: string,
  writer: ToolResultArtifactWriter | undefined,
): ContextToolRehydrationHandle {
  const input = {
    artifactSeed: `${observationId}:full`,
    itemCount: 1,
    approxTokens: estimateTokens(artifactText),
  };
  if (writer === undefined) {
    return buildToolRehydrationHandle({ ...input, notPersistedReason: TRUNCATED_NOT_PERSISTED });
  }
  const handle = buildToolRehydrationHandle(input);
  try {
    writer.write(handle.artifactId, artifactText);
    return handle;
  } catch {
    return buildToolRehydrationHandle({ ...input, notPersistedReason: TRUNCATED_PERSIST_FAILED });
  }
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
  const artifactText = result.truncated ? commandArtifactText(result) : undefined;
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
          rehydration: commandRehydrationHandle(
            observationId,
            artifactText ?? "",
            opts?.artifactWriter,
          ),
        }
      : {}),
  };
}
