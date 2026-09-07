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

/** The existing SSE counter records counts and termination, never authenticated frame content. */
export function writeSessionStreamFrame(
  res: ServerResponse,
  frame: string,
  correlationId: string = UNKNOWN_CORRELATION_ID,
  destroyOnBackpressure = true,
): boolean {
  recordSseStreamFrame(res, frame, correlationId);
  try {
    const accepted = res.write(frame);
    if (!accepted) {
      markSseStreamBackpressureKilled(res);
      if (destroyOnBackpressure) res.destroy();
    }
    return accepted;
  } catch (error) {
    markSseStreamServerErrored(res);
    res.destroy(error instanceof Error ? error : undefined);
    throw error;
  }
}

export function createSessionStreamWriter(
  res: ServerResponse,
  close: () => void,
  correlationId: string | undefined,
): {
  readonly isClosing: () => boolean;
  readonly publish: (snapshot: CodingAppSessionChannelSnapshot) => boolean;
} {
  let closing = false;
  const finish = (): void => {
    closing = true;
    queueMicrotask(close);
  };
  return {
    isClosing: () => closing,
    publish: (snapshot): boolean => {
      if (closing) return true;
      if (res.destroyed || res.writableEnded) {
        finish();
        return true;
      }
      try {
        const frame = `event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`;
        // Node has already accepted this single frame into its bounded buffer. The publisher
        // detaches on `false`; its queued close can therefore flush the frame without accepting
        // any more channel content or turning transient pressure into a client network error.
        const accepted = writeSessionStreamFrame(res, frame, correlationId, false);
        if (!accepted || snapshot.content === null) finish();
        // A successfully written content-free terminal frame is not transport backpressure.
        return accepted;
      } catch (error) {
        finish();
        // The existing channel owner records the structured, body-free listener diagnostic.
        throw error;
      }
    },
  };
}

function guardedSessionStreamFrame(
  res: ServerResponse,
  frame: string,
  correlationId: string | undefined,
  diagnostics: ServerDiagnosticSink | undefined,
  source:
    "coding-app-session.session-channel.initial" | "coding-app-session.session-channel.heartbeat",
): boolean {
  try {
    return writeSessionStreamFrame(res, frame, correlationId);
  } catch (error) {
    emitServerDiagnostic(
      diagnostics,
      serverDiagnosticFromError({
        correlationId: correlationId ?? UNKNOWN_CORRELATION_ID,
        operation: "coding-app-session.channel.subscribe",
        source,
        error,
        redact: () => "sse-listener-failed",
      }),
    );
    return false;
  }
}

/** Initial writes and timer callbacks have no publishing channel to catch their transport errors. */
export function createSessionStreamTransport(
  res: ServerResponse,
  correlationId: string | undefined,
  diagnostics: ServerDiagnosticSink | undefined,
): {
  readonly write: (snapshot: CodingAppSessionChannelSnapshot) => boolean;
  readonly heartbeat: () => void;
} {
  return {
    write: (snapshot): boolean =>
      guardedSessionStreamFrame(
        res,
        `event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`,
        correlationId,
        diagnostics,
        "coding-app-session.session-channel.initial",
      ),
    heartbeat: (): void => {
      guardedSessionStreamFrame(
        res,
        ": heartbeat\n\n",
        correlationId,
        diagnostics,
        "coding-app-session.session-channel.heartbeat",
      );
    },
  };
}
