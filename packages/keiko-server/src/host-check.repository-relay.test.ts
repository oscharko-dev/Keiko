import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { isAllowedHost } from "./host-check.js";

const PORT = 1983;

// #4522: the repository relay's reads carry the capability as the HTTP Basic password (Maven) or as a
// Bearer token (npm). Only that one runtime route accepts Basic; every other keeps its Bearer rule.
describe("isAllowedHost for a relayed repository read", () => {
  function repository(
    url: string,
    headers: Record<string, string | undefined> = {},
  ): IncomingMessage {
    return {
      url,
      headers: { host: "127.0.0.1:50123", authorization: "Basic Y2FwYWJpbGl0eQ==", ...headers },
    } as unknown as IncomingMessage;
  }

  it.each([
    "/api/coding-sidecar/repository/relay-1/org/example/lib/1.0/lib-1.0.jar",
    "/api/coding-sidecar/repository/relay-1/left-pad",
    "/api/coding-sidecar/repository/relay-1/@scope%2fname",
  ])("accepts %s with a Basic or a Bearer capability", (url) => {
    expect(isAllowedHost(repository(url), PORT)).toBe(true);
    expect(isAllowedHost(repository(url, { authorization: "Bearer capability" }), PORT)).toBe(true);
  });

  it.each([
    "/api/coding-sidecar/repository/",
    "/api/coding-sidecar/repository/relay-1",
    "/api/coding-sidecar/repository//x.jar",
    "/api/coding-sidecar/repositoryx/relay-1/x.jar",
  ])("refuses the malformed repository route %s", (url) => {
    expect(isAllowedHost(repository(url), PORT)).toBe(false);
  });

  it("keeps a credential and a missing Origin mandatory, and Basic limited to this route", () => {
    const url = "/api/coding-sidecar/repository/relay-1/x.jar";
    expect(isAllowedHost(repository(url, { authorization: undefined }), PORT)).toBe(false);
    expect(isAllowedHost(repository(url, { authorization: "Token abc" }), PORT)).toBe(false);
    expect(isAllowedHost(repository(url, { origin: "http://127.0.0.1:50123" }), PORT)).toBe(false);
    expect(isAllowedHost(repository(url, { host: "evil.example.com:50123" }), PORT)).toBe(false);
    expect(isAllowedHost(repository("/api/coding-sidecar/tool"), PORT)).toBe(false);
    expect(isAllowedHost(repository("/api/coding-sidecar/mcp/relay-1"), PORT)).toBe(false);
  });
});
