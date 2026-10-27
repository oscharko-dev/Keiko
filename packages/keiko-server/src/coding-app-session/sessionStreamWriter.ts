import type { ServerResponse } from "node:http";
import {
  emitServerDiagnostic,
  serverDiagnosticFromError,
  type ServerDiagnosticSink,
} from "../diagnostics-log.js";
import { UNKNOWN_CORRELATION_ID } from "../correlation.js";
import {
  markSseStreamBackpressureKilled,
  markSseStreamServerErrored,
  recordSseStreamFrame,
} from "../sse-write.js";
import type { CodingAppSessionChannelSnapshot } from "./channelContract.js";

/**
 * How long one buffered app-session frame may wait for its peer to drain it, and how long a closing
 * stream may take to flush. `res.write()` returning `false` only says that Node's buffer is above its
 * high-water mark — Node 24 answers so for any single write of 64 KiB or more, even to an idle local
 * browser — so a frame that drains within this bound is ordinary flow, not a stalled client.
 */
export const CODING_APP_SESSION_STREAM_DRAIN_TIMEOUT_MS = 1_000;

type SessionStreamSource =
  | "coding-app-session.session-channel.initial"
  | "coding-app-session.session-channel.heartbeat"
  | "coding-app-session.session-channel.drain";

/** Body-free counts of the stream's flow control, for its `coding-app-session.channel.closed` line. */
export interface SessionStreamFlowCounts {
  /** Writes that left the buffer above its high-water mark and then waited for `drain`. */
  readonly drainWaitCount: number;
  /** Snapshots replaced by a newer one while a frame drained; the newest is the one written. */
  readonly coalescedSnapshotCount: number;
}

export interface SessionStreamWriter {
  readonly isClosing: () => boolean;
  /** The channel listener. It only answers `false` after the response itself rejected the write. */
  readonly publish: (snapshot: CodingAppSessionChannelSnapshot) => boolean;
  /** Writes the subscription's first snapshot; `false` only when the transport failed outright. */
  readonly writeInitial: (snapshot: CodingAppSessionChannelSnapshot) => boolean;
  readonly heartbeat: () => void;
  readonly flowCounts: () => SessionStreamFlowCounts;
}

export interface SessionStreamWriterInput {
  readonly res: ServerResponse;
  readonly correlationId: string | undefined;
  readonly diagnostics: ServerDiagnosticSink | undefined;
  /** Ends the stream; the route flushes and bounds what is still buffered. */
  readonly close: () => void;
  /** The peer did not drain a frame within the bound: report it once and stop publishing. */
  readonly onStalled: () => void;
}

/** The existing SSE counter records counts and termination, never authenticated frame content. */
export function writeSessionStreamFrame(
  res: ServerResponse,
  frame: string,
  correlationId: string = UNKNOWN_CORRELATION_ID,
): boolean {
  recordSseStreamFrame(res, frame, correlationId);
  try {
    return res.write(frame);
  } catch (error) {
    markSseStreamServerErrored(res);
    res.destroy(error instanceof Error ? error : undefined);
    throw error;
  }
}

function snapshotFrame(snapshot: CodingAppSessionChannelSnapshot): string {
  return `event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`;
}

function guardedSessionStreamFrame(
  input: Pick<SessionStreamWriterInput, "res" | "correlationId" | "diagnostics">,
  frame: string,
  source: SessionStreamSource,
): boolean | "failed" {
  try {
    return writeSessionStreamFrame(input.res, frame, input.correlationId);
  } catch (error) {
    emitServerDiagnostic(
      input.diagnostics,
      serverDiagnosticFromError({
        correlationId: input.correlationId ?? UNKNOWN_CORRELATION_ID,
        operation: "coding-app-session.channel.subscribe",
        source,
        error,
        redact: () => "sse-listener-failed",
      }),
    );
    return "failed";
  }
}

/** A stream without a composed channel serves one content-free snapshot and ends. */
export function writeContentFreeSessionStream(
  res: ServerResponse,
  snapshot: CodingAppSessionChannelSnapshot,
  correlationId: string | undefined,
  diagnostics: ServerDiagnosticSink | undefined,
): void {
  guardedSessionStreamFrame(
    { res, correlationId, diagnostics },
    snapshotFrame(snapshot),
    "coding-app-session.session-channel.initial",
  );
  if (!res.writableEnded && !res.destroyed) res.end();
}

/**
 * The app-session stream's one writer. A snapshot is the complete current projection, so while one
 * frame drains only the newest pending snapshot is kept and written on `drain` (latest wins). A peer
 * that does not drain within {@link CODING_APP_SESSION_STREAM_DRAIN_TIMEOUT_MS} is the stalled client
 * KEIKO-0225 reports: the stream stops publishing and closes; the route keeps that close bounded.
 */
class AppSessionStreamWriter implements SessionStreamWriter {
  private closing = false;
  private draining = false;
  // The frame being drained was the channel's content-free terminal frame.
  private terminalDraining = false;
  private pending: CodingAppSessionChannelSnapshot | undefined;
  private stallTimer: ReturnType<typeof setTimeout> | undefined;
  private drainWaitCount = 0;
  private coalescedSnapshotCount = 0;
  private readonly onDrain = (): void => {
    this.drained();
  };
  private readonly onStall = (): void => {
    this.stalled();
  };

  public constructor(private readonly input: SessionStreamWriterInput) {
    input.res.once("close", () => {
      this.stopWaiting();
    });
  }

  public readonly isClosing = (): boolean => this.closing;

  public readonly publish = (snapshot: CodingAppSessionChannelSnapshot): boolean => {
    const { res } = this.input;
    if (this.closing) return true;
    if (res.destroyed || res.writableEnded) {
      this.finish();
      return true;
    }
    if (this.draining) {
      if (this.pending !== undefined) this.coalescedSnapshotCount += 1;
      this.pending = snapshot;
      return true;
    }
    try {
      const accepted = writeSessionStreamFrame(
        res,
        snapshotFrame(snapshot),
        this.input.correlationId,
      );
      this.settleWrite(accepted ? "sent" : "queued", snapshot);
      return true;
    } catch (error) {
      this.finish();
      // The existing channel owner records the structured, body-free listener diagnostic.
      throw error;
    }
  };

  public readonly writeInitial = (snapshot: CodingAppSessionChannelSnapshot): boolean => {
    const written = guardedSessionStreamFrame(
      this.input,
      snapshotFrame(snapshot),
      "coding-app-session.session-channel.initial",
    );
    if (written === "failed") return false;
    if (!written) this.awaitDrain(false);
    return true;
  };

  public readonly heartbeat = (): void => {
    // A frame still draining already proves the stream is alive; nothing is queued behind it.
    if (this.closing || this.draining) return;
    const written = guardedSessionStreamFrame(
      this.input,
      ": heartbeat\n\n",
      "coding-app-session.session-channel.heartbeat",
    );
    if (written === "failed") this.finish();
    else if (!written) this.awaitDrain(false);
  };

  public readonly flowCounts = (): SessionStreamFlowCounts => ({
    drainWaitCount: this.drainWaitCount,
    coalescedSnapshotCount: this.coalescedSnapshotCount,
  });

  // A written frame either went out, waits for its drain, or ends the stream when it was terminal.
  private settleWrite(outcome: "sent" | "queued", snapshot: CodingAppSessionChannelSnapshot): void {
    const terminal = snapshot.content === null;
    if (outcome === "queued") this.awaitDrain(terminal);
    else if (terminal) this.finish();
  }

  private awaitDrain(terminal: boolean): void {
    this.draining = true;
    this.terminalDraining = terminal;
    this.drainWaitCount += 1;
    this.input.res.once("drain", this.onDrain);
    this.stallTimer = setTimeout(this.onStall, CODING_APP_SESSION_STREAM_DRAIN_TIMEOUT_MS);
    this.stallTimer.unref();
  }

  private stopWaiting(): void {
    this.draining = false;
    this.pending = undefined;
    this.input.res.off("drain", this.onDrain);
    if (this.stallTimer !== undefined) clearTimeout(this.stallTimer);
    this.stallTimer = undefined;
  }

  private drained(): void {
    const next = this.pending;
    const terminal = this.terminalDraining;
    this.stopWaiting();
    if (this.closing) return;
    if (terminal) {
      this.finish();
      return;
    }
    if (next === undefined) return;
    const written = guardedSessionStreamFrame(
      this.input,
      snapshotFrame(next),
      "coding-app-session.session-channel.drain",
    );
    if (written === "failed") this.finish();
    else this.settleWrite(written ? "sent" : "queued", next);
  }

  private stalled(): void {
    this.stopWaiting();
    if (this.closing) return;
    markSseStreamBackpressureKilled(this.input.res);
    this.input.onStalled();
    this.finish();
  }

  private finish(): void {
    if (this.closing) return;
    this.closing = true;
    this.stopWaiting();
    queueMicrotask(this.input.close);
  }
}

export function createSessionStreamWriter(input: SessionStreamWriterInput): SessionStreamWriter {
  return new AppSessionStreamWriter(input);
}
