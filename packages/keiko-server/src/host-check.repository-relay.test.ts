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

  // The router matches `new URL(req.url).pathname`, which collapses dot segments in any spelling and
  // turns a backslash into a slash. A relay-shaped raw path that the router would serve as another
  // route is refused, whatever the credential and whatever the Host.
  const RELAY_ID = "AbCdEfGhIjKlMnOpQrStUv";
  const PREFIX = `/api/coding-sidecar/repository/${RELAY_ID}`;

  it.each([
    `${PREFIX}/../../../chats`,
    `${PREFIX}/../../../health`,
    `${PREFIX}/%2e%2e/%2e%2e/%2e%2e/models`,
    `${PREFIX}/%2E%2E/%2E%2E/%2E%2E/models`,
    `${PREFIX}/.%2e/.%2e/.%2e/chats`,
    `${PREFIX}/%2e./%2e./%2e./chats`,
    `${PREFIX}/./x.jar`,
    `${PREFIX}/%2e/x.jar`,
    `${PREFIX}/..%2f..%2f..%2fchats`,
    `${PREFIX}/..%5c..%5c..%5cchats`,
    `${PREFIX}\\..\\..\\..\\chats`,
    `${PREFIX}/a\\..\\..\\..\\chats`,
    `${PREFIX}/x.jar#/../../../chats`,
    `${PREFIX}/a\tb/../../../chats`,
  ])("refuses the dot-segment spelling %s on a foreign Host port", (url) => {
    expect(isAllowedHost(repository(url), PORT)).toBe(false);
    expect(isAllowedHost(repository(url, { authorization: "Bearer capability" }), PORT)).toBe(
      false,
    );
  });

  it("judges the pathname the router sees for every other runtime route as well", () => {
    const bearer = { authorization: "Bearer capability" };
    expect(isAllowedHost(repository("/api/coding-sidecar/mcp/relay-1", bearer), PORT)).toBe(true);
    for (const url of [
      "/api/coding-sidecar/mcp/..",
      "/api/coding-sidecar/mcp/%2e%2e",
      "/api/coding-sidecar/mcp/%2E",
      "/api/coding-sidecar/tool/../../chats",
      "/api/coding-sidecar/mcp/relay-1/../../../chats",
      "//evil.example.com/api/coding-sidecar/tool",
    ]) {
      expect(isAllowedHost(repository(url, bearer), PORT), url).toBe(false);
    }
  });

  it("keeps a legitimate artifact path accepted, dotted file names included", () => {
    for (const url of [
      `${PREFIX}/org/example/lib/1.0/lib-1.0.jar`,
      `${PREFIX}/org/example/lib/1.0.0..1/lib.tar.gz`,
      `${PREFIX}/.hidden/file..name.jar`,
      `${PREFIX}/@scope%2fname`,
      `${PREFIX}/left-pad/-/left-pad-1.3.0.tgz`,
    ]) {
      expect(isAllowedHost(repository(url), PORT), url).toBe(true);
    }
  });
});
