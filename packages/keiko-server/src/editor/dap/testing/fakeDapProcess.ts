import { PassThrough } from "node:stream";
import type { DapByteSource } from "../dapFrameCodec.js";

export interface FakeDapProcess {
  readonly source: DapByteSource;
  readonly sentCommands: readonly string[];
  sendFrame(body: string): void;
  emitStopped(reason: string, threadId: number, hitBreakpointIds: readonly number[]): void;
  emitReverseRequest(command: string): void;
  close(): void;
}

interface DapRequest {
  readonly seq: number;
  readonly type: "request";
  readonly command: string;
}

function parseRequest(body: string): DapRequest | null {
  try {
    const value: unknown = JSON.parse(body);
    if (typeof value !== "object" || value === null) return null;
    const record = value as Record<string, unknown>;
    return Number.isSafeInteger(record.seq) &&
      record.type === "request" &&
      typeof record.command === "string"
      ? { seq: record.seq as number, type: "request", command: record.command }
      : null;
  } catch {
    return null;
  }
}

export function createFakeDapProcess(): FakeDapProcess {
  const source = new PassThrough({ objectMode: true });
  const sentCommands: string[] = [];
  let sequence = 1_000;
  const emit = (message: Record<string, unknown>): void => {
    source.write(Buffer.from(JSON.stringify({ seq: sequence++, ...message }), "utf8"));
  };
  return {
    source,
    sentCommands,
    sendFrame: (body): void => {
      const request = parseRequest(body);
      if (request === null) return;
      sentCommands.push(request.command);
      queueMicrotask(() => {
        emit({
          type: "response",
          request_seq: request.seq,
          success: true,
          command: request.command,
          body: request.command === "threads" ? { threads: [] } : {},
        });
      });
    },
    emitStopped: (reason, threadId, hitBreakpointIds): void => {
      emit({ type: "event", event: "stopped", body: { reason, threadId, hitBreakpointIds } });
    },
    emitReverseRequest: (command): void => {
      emit({ type: "request", command, arguments: {} });
    },
    close: (): void => {
      source.end();
    },
  };
}
