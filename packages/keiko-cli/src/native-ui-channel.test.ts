import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readNativeUiResponse } from "./native-ui-channel.js";
import { nativeUiCommitPacket } from "./native-ui-runtime.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("native UI response deadline", () => {
  it.each([false, true])("checks the original deadline after decoding (late=%s)", async (late) => {
    let now = late ? 99 : 10;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const stream = new PassThrough();
    const frame = nativeUiCommitPacket("a".repeat(32));
    frame.write("KRS1");
    frame.writeUInt16LE(5, 6);
    const result = readNativeUiResponse(stream, 5, 32, 100).then(
      () => "accepted",
      () => "refused",
    );
    const original = Buffer.concat.bind(Buffer);
    const concat = vi.spyOn(Buffer, "concat").mockImplementation((...args) => {
      const bytes = original(...args);
      if (late) now = 101;
      return bytes;
    });
    stream.write(frame);
    concat.mockRestore();
    stream.destroy();
    expect(await result).toBe(late ? "refused" : "accepted");
  });
});
