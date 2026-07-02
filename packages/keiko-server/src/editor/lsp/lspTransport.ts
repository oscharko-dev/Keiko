// Transport wiring (Issue #1381, Epic #1491, ADR-0069 D3). Binds a spawned LSP child's stdio to the
// pure frame codec and the JSON-RPC client: stdout frames feed the client's request/response
// correlation, the client's outbound frames are written to stdin, and stderr is drained for a byte
// COUNT only — never stored, logged, or surfaced (ADR-0069 I3/I4/D6 content-free invariant). Only the
// drained-byte count is exposed via `stderrBytesSeen()` for the lifecycle event's `stderrBytesSeen`.

import { createLspFrameReader, writeLspFrame } from "./lspFrameCodec.js";
import type { LspByteSink, LspByteSource, LspBytes } from "./lspFrameCodec.js";
import { createLspJsonRpcClient } from "./lspJsonRpcClient.js";
import type { LspJsonRpcClient, LspRpcScheduler } from "./lspJsonRpcClient.js";

// Structural handle over a spawned child's stdio. Kept stream-type-agnostic so both the node adapter
// (wrapping `child_process.spawn`) and the in-memory fake harness satisfy it without subclassing a
// Node stream. `stdout`/`stderr` are async-iterable over Buffers; `stdin` is a write-only sink.
export interface LspSpawnHandle {
  readonly stdin: LspByteSink;
  readonly stdout: LspByteSource;
  readonly stderr: LspByteSource;
  readonly pid: number | undefined;
}

export interface LspTransport {
  readonly client: LspJsonRpcClient;
  stderrBytesSeen(): number;
  dispose(): void;
}

export interface LspTransportDeps {
  readonly scheduler?: LspRpcScheduler | undefined;
  // Surfaced when the stdout frame reader rejects (oversized or malformed frame). The manager
  // (Stage C/D) maps this onto a process-level RESPONSE_TOO_LARGE / CRASHED transition.
  readonly onReaderError?: ((error: unknown) => void) | undefined;
}

export function createLspTransport(
  handle: LspSpawnHandle,
  maxFrameBytes: number,
  deps: LspTransportDeps = {},
): LspTransport {
  let stderrBytes = 0;
  let disposed = false;

  const reader = createLspFrameReader(handle.stdout, maxFrameBytes);
  const guardedSource = guardReader(reader, deps.onReaderError);

  const client = createLspJsonRpcClient({
    source: guardedSource,
    sendFrame: (body) => {
      writeLspFrame(handle.stdin, body);
    },
    ...(deps.scheduler !== undefined ? { scheduler: deps.scheduler } : {}),
  });

  void drainStderr(handle.stderr, (count) => {
    stderrBytes += count;
  });

  return {
    client,
    stderrBytesSeen: (): number => stderrBytes,
    dispose: (): void => {
      if (disposed) return;
      disposed = true;
      client.dispose();
    },
  };
}

// Wraps the frame reader so a frame-level reject (oversized/malformed) is surfaced to the manager via
// `onReaderError` and then ends the stream cleanly, rather than propagating as an unhandled rejection
// in the client's detached consume loop. The reader stops after the first reject (the connection is
// considered poisoned, ADR-0069 I3).
async function* guardReader(
  reader: AsyncGenerator<LspBytes, void, void>,
  onReaderError: ((error: unknown) => void) | undefined,
): AsyncGenerator<LspBytes, void, void> {
  try {
    yield* reader;
  } catch (error) {
    onReaderError?.(error);
  }
}

// Counts stderr bytes without storing them. The bytes are read and immediately discarded; only the
// running total survives (ADR-0069 D6: raw stderr never crosses an audit or status boundary).
async function drainStderr(stderr: LspByteSource, onCount: (count: number) => void): Promise<void> {
  try {
    for await (const chunk of stderr) {
      onCount(chunk.length);
    }
  } catch {
    // A stderr read error is non-fatal to the protocol channel; the count simply stops advancing.
  }
}
