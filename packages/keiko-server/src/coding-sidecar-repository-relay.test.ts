import { describe, expect, it } from "vitest";
import { handleCodingSidecarRepositoryRelay } from "./coding-sidecar-repository-relay.js";
import { matchRoute } from "./routes.js";

// #4522: the router's trailing `*path` carries the repository path as sent; the relay validates it.
describe("the repository relay route", () => {
  it.each(["GET", "HEAD"])(
    "routes %s to the relay handler with the relay id and the rest of the path",
    (method) => {
      const match = matchRoute(
        method,
        "/api/coding-sidecar/repository/relay-1/org/example/lib/1.0/lib-1.0.jar",
      );
      if (match === undefined || match === "method-not-allowed") throw new Error("unrouted");
      expect(match.definition.pattern).toBe("/api/coding-sidecar/repository/:relayId/*path");
      expect(match.params).toEqual({
        relayId: "relay-1",
        path: "org/example/lib/1.0/lib-1.0.jar",
      });
      expect(match.definition.handler).toBe(handleCodingSidecarRepositoryRelay);
    },
  );

  it("routes a single segment and an encoded scoped name", () => {
    expect(matchRoute("GET", "/api/coding-sidecar/repository/relay-1/left-pad")).toMatchObject({
      params: { path: "left-pad" },
    });
    expect(matchRoute("GET", "/api/coding-sidecar/repository/relay-1/@scope%2Fname")).toMatchObject(
      { params: { path: "@scope%2Fname" } },
    );
  });

  it.each(["POST", "PUT", "PATCH", "DELETE"])(
    "never routes %s: the repository is read, not written",
    (method) => {
      expect(matchRoute(method, "/api/coding-sidecar/repository/relay-1/x.jar")).toBe(
        "method-not-allowed",
      );
    },
  );

  it("does not route a request without a repository path", () => {
    expect(matchRoute("GET", "/api/coding-sidecar/repository/relay-1")).toBeUndefined();
    expect(matchRoute("GET", "/api/coding-sidecar/repository")).toBeUndefined();
  });

  it("leaves the MCP relay's matching as it was", () => {
    expect(matchRoute("POST", "/api/coding-sidecar/mcp/relay-1")).toMatchObject({
      params: { relayId: "relay-1" },
    });
  });
});
