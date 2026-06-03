import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { isAllowedHost } from "./host-check.js";

function reqWith(headers: Record<string, string | undefined>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

const PORT = 1983;

describe("isAllowedHost", () => {
  it("accepts the loopback host on the bound port", () => {
    expect(isAllowedHost(reqWith({ host: "127.0.0.1:1983" }), PORT)).toBe(true);
  });

  it("accepts localhost on the bound port", () => {
    expect(isAllowedHost(reqWith({ host: "localhost:1983" }), PORT)).toBe(true);
  });

  it("accepts the IPv6 loopback literal", () => {
    expect(isAllowedHost(reqWith({ host: "[::1]:1983" }), PORT)).toBe(true);
  });

  it("rejects a missing Host header", () => {
    expect(isAllowedHost(reqWith({}), PORT)).toBe(false);
  });

  it("rejects a non-loopback host (DNS-rebinding attempt)", () => {
    expect(isAllowedHost(reqWith({ host: "evil.example.com:1983" }), PORT)).toBe(false);
  });

  it("rejects a loopback host on a different port", () => {
    expect(isAllowedHost(reqWith({ host: "127.0.0.1:5000" }), PORT)).toBe(false);
  });

  it("rejects a loopback host with no explicit bound port", () => {
    expect(isAllowedHost(reqWith({ host: "127.0.0.1" }), PORT)).toBe(false);
  });

  it("rejects when Origin is present and non-loopback even if Host is loopback", () => {
    const req = reqWith({ host: "127.0.0.1:1983", origin: "http://evil.example.com" });
    expect(isAllowedHost(req, PORT)).toBe(false);
  });

  it("accepts when Origin matches the loopback authority", () => {
    const req = reqWith({ host: "127.0.0.1:1983", origin: "http://127.0.0.1:1983" });
    expect(isAllowedHost(req, PORT)).toBe(true);
  });

  it("rejects the opaque 'null' origin (file/sandbox) even when Host is loopback", () => {
    const req = reqWith({ host: "localhost:1983", origin: "null" });
    expect(isAllowedHost(req, PORT)).toBe(false);
  });

  it("rejects an Origin without the bound port", () => {
    const req = reqWith({ host: "localhost:1983", origin: "http://localhost" });
    expect(isAllowedHost(req, PORT)).toBe(false);
  });
});
