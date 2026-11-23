import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { handleCodingSidecarRepositoryRelay } from "./coding-sidecar-repository-relay.js";
import type { UiHandlerDeps } from "./deps.js";
import {
  createRepositoryCredentialRelay,
  repositoryRelayBaseUrl,
} from "./repository-relay/repositoryCredentialRelay.js";
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

// A relay or an upstream that is not wired answers the run with a closed refusal and never reaches
// a repository.
describe("the repository relay handler without its wiring (#4522)", () => {
  let server: Server | undefined;
  afterEach(async () => {
    await new Promise<void>((resolve) => {
      server?.closeAllConnections();
      server?.close(() => {
        resolve();
      });
    });
    server = undefined;
  });

  async function answer(input: {
    readonly deps: Partial<UiHandlerDeps>;
    readonly params: Record<string, string>;
    readonly path: string;
    readonly headers?: Record<string, string>;
  }): Promise<number> {
    const listening = createServer((req, res) => {
      void handleCodingSidecarRepositoryRelay(
        {
          req,
          res,
          params: input.params,
          url: new URL("http://127.0.0.1/"),
          correlationId: undefined,
        },
        input.deps as UiHandlerDeps,
      );
    });
    server = listening;
    await new Promise<void>((resolve) => listening.listen(0, "127.0.0.1", resolve));
    const port = (listening.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${String(port)}${input.path}`, {
      ...(input.headers === undefined ? {} : { headers: input.headers }),
    });
    await response.text();
    return response.status;
  }

  it("challenges a request that presents nothing when no relay is wired", async () => {
    expect(await answer({ deps: {}, params: {}, path: "/x" })).toBe(401);
  });

  it("refuses a capability the relay does not know", async () => {
    const relay = createRepositoryCredentialRelay({ activityLog: () => undefined });
    const status = await answer({
      deps: { repositoryRelay: { relay, upstream: () => Promise.reject(new TypeError("unused")) } },
      params: { relayId: "x" },
      path: "/x",
      headers: { authorization: "Basic eDp5" },
    });
    expect(status).toBe(401);
  });

  it("fails a read closed, with no repository reached, when no upstream is wired", async () => {
    const relay = createRepositoryCredentialRelay({ activityLog: () => undefined });
    const binding = relay.bind({
      runId: "run-1",
      ecosystem: "maven",
      upstreamBaseUrl: "https://repo.example.test/maven/",
      secrets: [],
      ownOrigin: "http://127.0.0.1:1983",
    });
    if (binding === undefined) throw new Error("fixture-bind-failed");
    const path = new URL(repositoryRelayBaseUrl("http://127.0.0.1:1983", binding.relayId)).pathname;
    const status = await answer({
      deps: { repositoryRelay: { relay } } as unknown as Partial<UiHandlerDeps>,
      params: { relayId: binding.relayId },
      path: `${path}a/b.pom`,
      headers: {
        authorization: `Basic ${Buffer.from(`keiko-relay:${binding.capability}`).toString("base64")}`,
      },
    });
    expect(status).toBe(502);
  });
});
