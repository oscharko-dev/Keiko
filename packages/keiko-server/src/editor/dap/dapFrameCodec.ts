import type { DebugProcessErrorCode } from "@oscharko-dev/keiko-contracts";
import {
  createLspFrameReader,
  LspFrameRejectError,
  writeLspFrame,
  type LspByteSink,
  type LspByteSource,
  type LspBytes,
} from "../lsp/lspFrameCodec.js";

export const DAP_MAX_PAYLOAD_BYTES = 1_024 * 1_024;
export type DapBytes = LspBytes;
export type DapByteSource = LspByteSource;
export type DapByteSink = LspByteSink;

export class DapFrameRejectError extends Error {
  public readonly reason: Extract<DebugProcessErrorCode, "MALFORMED_HEADER" | "PAYLOAD_TOO_LARGE">;
  public constructor(reason: "MALFORMED_HEADER" | "PAYLOAD_TOO_LARGE") {
    super(reason);
    this.name = "DapFrameRejectError";
    this.reason = reason;
  }
}

export async function* createDapFrameReader(
  source: DapByteSource,
): AsyncGenerator<DapBytes, void, void> {
  try {
    yield* createLspFrameReader(source, DAP_MAX_PAYLOAD_BYTES, {
      rejectDuplicateContentLength: true,
      rejectTruncatedEof: true,
    });
  } catch (error: unknown) {
    if (error instanceof LspFrameRejectError) {
      throw new DapFrameRejectError(
        error.reason === "RESPONSE_TOO_LARGE" ? "PAYLOAD_TOO_LARGE" : "MALFORMED_HEADER",
      );
    }
    throw error;
  }
}

export function writeDapFrame(sink: DapByteSink, body: string): void {
  writeLspFrame(sink, body);
}
