import { describe, expect, it } from "vitest";

import {
  decodeSecureWorkspaceReadResponse,
  decodeSecureWorkspaceText,
  encodeSecureWorkspaceReadRequest,
} from "./secureWorkspaceTextReadProtocol.js";

const MAX_TEXT_BYTES = 65_536;
const MAX_ROOT_BYTES = 32_768;
const MAX_PATH_BYTES = 4_096;

function requestFrame(root: string, relativePath: string): Buffer {
  return encodeSecureWorkspaceReadRequest({ root, relativePath, byteCap: MAX_TEXT_BYTES });
}

function responseFrame(status: number, payload = Buffer.alloc(0), version = 1): Buffer {
  const frame = Buffer.alloc(12 + payload.byteLength);
  frame.write("KSS1", 0, "ascii");
  frame.writeUInt16LE(version, 4);
  frame.writeUInt16LE(status, 6);
  frame.writeUInt32LE(payload.byteLength, 8);
  payload.copy(frame, 12);
  return frame;
}

describe("secure workspace text-read binary protocol", () => {
  it("emits the exact little-endian KSR1 frame, including version, reserved, lengths, and cap", () => {
    const frame = requestFrame("r", "a.ts");

    expect(frame.byteLength).toBe(25);
    expect(frame.subarray(0, 4).toString("ascii")).toBe("KSR1");
    expect(frame.readUInt16LE(4)).toBe(1);
    expect(frame.readUInt16LE(6)).toBe(0);
    expect(frame.readUInt32LE(8)).toBe(1);
    expect(frame.readUInt32LE(12)).toBe(4);
    expect(frame.readUInt32LE(16)).toBe(MAX_TEXT_BYTES);
    expect(frame.subarray(20).toString("utf8")).toBe("ra.ts");
  });

  it("accepts exact KSR1 root/path bounds and rejects a byte beyond either bound", () => {
    const root = "r".repeat(MAX_ROOT_BYTES);
    const relativePath = "p".repeat(MAX_PATH_BYTES);

    expect(requestFrame(root, relativePath)).toHaveLength(20 + MAX_ROOT_BYTES + MAX_PATH_BYTES);
    expect(() => requestFrame(`${root}r`, "p")).toThrow("secure-workspace-read-invalid-request");
    expect(() => requestFrame("r", `${relativePath}p`)).toThrow(
      "secure-workspace-read-invalid-request",
    );
  });

  it.each([0, MAX_TEXT_BYTES - 1, MAX_TEXT_BYTES + 1, 0x1_0000_0000])(
    "rejects a request cap other than the fixed 65,536 bytes (%d)",
    (byteCap) => {
      expect(() =>
        encodeSecureWorkspaceReadRequest({ root: "r", relativePath: "a.ts", byteCap }),
      ).toThrow("secure-workspace-read-invalid-request");
    },
  );

  it.each(["", "root\0suffix", "path\0suffix"])(
    "rejects NUL or empty request fields (%j)",
    (value) => {
      expect(() => requestFrame(value, "a.ts")).toThrow("secure-workspace-read-invalid-request");
      expect(() => requestFrame("root", value)).toThrow("secure-workspace-read-invalid-request");
    },
  );

  it("decodes exact KSS1 success boundaries and rejects 65,537 bytes", () => {
    const payload = Buffer.alloc(MAX_TEXT_BYTES, 0x61);
    const decoded = decodeSecureWorkspaceReadResponse(responseFrame(0, payload));

    expect(decoded).toEqual({ status: "ok", bytes: payload });
    expect(() =>
      decodeSecureWorkspaceReadResponse(responseFrame(0, Buffer.alloc(MAX_TEXT_BYTES + 1))),
    ).toThrow("secure-workspace-read-malformed-response");
  });

  it.each([
    ["bad magic", Buffer.from("XSS1\x01\x00\x00\x00\x00\x00\x00\x00", "binary")],
    ["wrong version", responseFrame(0, Buffer.alloc(0), 2)],
    ["unknown status", responseFrame(10)],
    ["non-ok payload", responseFrame(4, Buffer.from("private"))],
    ["trailing byte", Buffer.concat([responseFrame(0, Buffer.from("ok")), Buffer.from([0])])],
    ["truncated header", Buffer.from("KSS1\x01\x00", "binary")],
  ])("rejects malformed KSS1 response: %s", (_label, frame) => {
    expect(() => decodeSecureWorkspaceReadResponse(frame)).toThrow(
      "secure-workspace-read-malformed-response",
    );
  });

  it.each([
    ["strict UTF-8", Buffer.from([0xc3, 0x28])],
    ["NUL", Buffer.from("safe\0text", "utf8")],
    ["C0 control", Buffer.from([0x61, 0x01])],
    ["DEL", Buffer.from([0x61, 0x7f])],
    ["C1 control", Buffer.from([0x61, 0xc2, 0x80])],
    ["binary marker", Buffer.from([0x61, 0xff])],
  ])("denies %s helper payloads without returning partial text", (_label, bytes) => {
    expect(decodeSecureWorkspaceText(bytes)).toEqual({ ok: false, reason: "not-text" });
  });

  it("returns exact safe UTF-8 text, including permitted source whitespace", () => {
    expect(
      decodeSecureWorkspaceText(Buffer.from('const x = "é";\n\t// source\r\n', "utf8")),
    ).toEqual({
      ok: true,
      text: 'const x = "é";\n\t// source\r\n',
    });
  });

  it("denies text one byte above the exact 65,536-byte boundary", () => {
    expect(decodeSecureWorkspaceText(Buffer.alloc(MAX_TEXT_BYTES + 1, 0x61))).toEqual({
      ok: false,
      reason: "not-text",
    });
  });
});
