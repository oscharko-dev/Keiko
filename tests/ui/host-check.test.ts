import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { isAllowedHost } from "../../src/ui/host-check.js";

function reqWith(headers: Record<string, string | undefined>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

const PORT = 4319;

describe("isAllowedHost", () => {
  it("accepts the loopback host on the bound port", () => {
    expect(isAllowedHost(reqWith({ host: "127.0.0.1:4319" }), PORT)).toBe(true);
  });

  it("accepts localhost on the bound port", () => {
    expect(isAllowedHost(reqWith({ host: "localhost:4319" }), PORT)).toBe(true);
  });

  it("accepts the IPv6 loopback literal", () => {
    expect(isAllowedHost(reqWith({ host: "[::1]:4319" }), PORT)).toBe(true);
  });

  it("rejects a missing Host header", () => {
    expect(isAllowedHost(reqWith({}), PORT)).toBe(false);
  });

  it("rejects a non-loopback host (DNS-rebinding attempt)", () => {
    expect(isAllowedHost(reqWith({ host: "evil.example.com:4319" }), PORT)).toBe(false);
  });

  it("rejects a loopback host on a different port", () => {
    expect(isAllowedHost(reqWith({ host: "127.0.0.1:5000" }), PORT)).toBe(false);
  });

  it("accepts a loopback host with no port (defaults match)", () => {
    expect(isAllowedHost(reqWith({ host: "127.0.0.1" }), PORT)).toBe(true);
  });

  it("rejects when Origin is present and non-loopback even if Host is loopback", () => {
    const req = reqWith({ host: "127.0.0.1:4319", origin: "http://evil.example.com" });
    expect(isAllowedHost(req, PORT)).toBe(false);
  });

  it("accepts when Origin matches the loopback authority", () => {
    const req = reqWith({ host: "127.0.0.1:4319", origin: "http://127.0.0.1:4319" });
    expect(isAllowedHost(req, PORT)).toBe(true);
  });

  it("accepts the opaque 'null' origin (file/sandbox) when Host is loopback", () => {
    const req = reqWith({ host: "localhost:4319", origin: "null" });
    expect(isAllowedHost(req, PORT)).toBe(true);
  });
});
