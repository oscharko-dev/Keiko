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

// #4068: a confined Windows runtime's request arrives through its pipe relay, so its Host names the
// relay's inner loopback port, not the bound port.
describe("isAllowedHost for a relayed coding runtime request", () => {
  const RELAY_HOST = "127.0.0.1:50123";
  function relayed(url: string, headers: Record<string, string | undefined> = {}): IncomingMessage {
    return {
      url,
      headers: { host: RELAY_HOST, authorization: "Bearer capability", ...headers },
    } as unknown as IncomingMessage;
  }

  it.each([
    "/api/coding-sidecar/gateway/chat/completions",
    "/api/coding-sidecar/tool",
    "/api/coding-sidecar/tool?x=1",
    "/api/coding-sidecar/mcp/relay-1",
  ])("accepts the runtime route %s", (url) => {
    expect(isAllowedHost(relayed(url), PORT)).toBe(true);
  });

  it("accepts the localhost name", () => {
    const req = relayed("/api/coding-sidecar/tool", { host: "localhost:50123" });
    expect(isAllowedHost(req, PORT)).toBe(true);
  });

  it.each([
    "/api/coding-sidecar/gateway/profile",
    "/api/coding-sidecar/mcp/",
    "/api/coding-sidecar/mcp/relay-1/extra",
    "/api/coding-sidecar/toolx",
    "/api/chats",
    "/",
  ])("refuses the non-runtime route %s", (url) => {
    expect(isAllowedHost(relayed(url), PORT)).toBe(false);
  });

  it("refuses a request that carries an Origin", () => {
    const req = relayed("/api/coding-sidecar/tool", { origin: "http://127.0.0.1:50123" });
    expect(isAllowedHost(req, PORT)).toBe(false);
  });

  it("refuses a request without a bearer credential", () => {
    expect(
      isAllowedHost(relayed("/api/coding-sidecar/tool", { authorization: undefined }), PORT),
    ).toBe(false);
    expect(
      isAllowedHost(relayed("/api/coding-sidecar/tool", { authorization: "Basic abc" }), PORT),
    ).toBe(false);
  });

  it.each(["evil.example.com:50123", "127.0.0.1", "127.0.0.1:0", "127.0.0.1:abc"])(
    "refuses the host %s",
    (host) => {
      expect(isAllowedHost(relayed("/api/coding-sidecar/tool", { host }), PORT)).toBe(false);
    },
  );
});
