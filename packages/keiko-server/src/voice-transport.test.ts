import { describe, expect, it } from "vitest";
import type { RawData } from "ws";
import { rawDataByteLength, rawDataToString } from "./voice-transport.js";

const frames: readonly {
  name: string;
  encode: (bytes: Buffer) => RawData;
}[] = [
  { name: "buffer", encode: (bytes): RawData => bytes },
  {
    name: "fragments split inside a UTF-8 character",
    encode: (bytes): RawData => [bytes.subarray(0, 9), bytes.subarray(9)],
  },
  { name: "array buffer", encode: (bytes): RawData => Uint8Array.from(bytes).buffer },
];

describe.each(frames)("voice transport: $name", ({ encode }) => {
  it.each(["Keiko Grüße 🌍", ""])("preserves text and byte length for %j", (text) => {
    const bytes = Buffer.from(text, "utf8");
    const data = encode(bytes);

    expect(rawDataToString(data, false)).toBe(text);
    expect(rawDataByteLength(data)).toBe(bytes.byteLength);
    expect(rawDataToString(data, true)).toBeUndefined();
  });
});
