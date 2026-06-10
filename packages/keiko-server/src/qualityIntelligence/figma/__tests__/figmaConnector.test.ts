import { describe, expect, it, vi } from "vitest";
import { createFigmaConnector } from "../figmaConnector.js";
import { FigmaConnectorError } from "../figmaConnectorErrors.js";
import type { FigmaHttpPort, FigmaHttpRequest, FigmaHttpResponse } from "../figmaHttpPort.js";

const TOKEN = "figd_unit-test-secret-pat-value";
const URL_OK = "https://www.figma.com/design/KEY123/Board?node-id=12-34&t=abc";

const nodesResponse = (nodeId: string, document: unknown): unknown => ({
  name: "File",
  nodes: { [nodeId]: { document } },
});

interface Recorder {
  readonly requests: FigmaHttpRequest[];
  readonly port: FigmaHttpPort;
}

const recordingPort = (response: FigmaHttpResponse): Recorder => {
  const requests: FigmaHttpRequest[] = [];
  const port: FigmaHttpPort = (request) => {
    requests.push(request);
    return Promise.resolve(response);
  };
  return { requests, port };
};

const firstRequest = (recorder: Recorder): FigmaHttpRequest => {
  const request = recorder.requests[0];
  if (request === undefined) throw new Error("expected at least one recorded request");
  return request;
};

const staticPort =
  (response: FigmaHttpResponse): FigmaHttpPort =>
  () =>
    Promise.resolve(response);

const okResponse = (
  document: unknown = { id: "12:34", name: "Release", type: "FRAME" },
): FigmaHttpResponse => ({ status: 200, json: nodesResponse("12:34", document), headers: {} });

describe("createFigmaConnector — scoped fetch", () => {
  it("calls GET /v1/files/:key/nodes with ids + depth, NEVER the whole-file endpoint", async () => {
    const recorder = recordingPort(okResponse());
    const connector = createFigmaConnector({
      http: recorder.port,
      env: { FIGMA_ACCESS_TOKEN: TOKEN },
    });

    await connector.fetchScopedNodes(URL_OK);

    expect(recorder.requests).toHaveLength(1);
    const url = firstRequest(recorder).url;
    expect(url).toContain("/v1/files/KEY123/nodes");
    expect(url).toContain("ids=12%3A34");
    expect(url).toMatch(/[?&]depth=\d+/);
    expect(url).not.toMatch(/\/v1\/files\/KEY123(\?|$)/);
  });

  it("pins the version query param when supplied", async () => {
    const recorder = recordingPort(okResponse());
    const connector = createFigmaConnector({
      http: recorder.port,
      env: { FIGMA_ACCESS_TOKEN: TOKEN },
    });

    const result = await connector.fetchScopedNodes(URL_OK, { version: "ver-999" });

    expect(firstRequest(recorder).url).toContain("version=ver-999");
    expect(result.provenance.version).toBe("ver-999");
    expect(result.readiness).toEqual({ source: "version", ready: true, version: "ver-999" });
  });

  it("returns the raw scoped node subtree plus provenance (no token)", async () => {
    const document = { id: "12:34", name: "Release", type: "FRAME" };
    const connector = createFigmaConnector({
      http: recordingPort(okResponse(document)).port,
      env: { FIGMA_ACCESS_TOKEN: TOKEN },
    });

    const result = await connector.fetchScopedNodes(URL_OK, { fetchedAt: "2026-01-01T00:00:00Z" });

    expect(result.nodes).toEqual(document);
    expect(result.provenance).toEqual({
      fileKey: "KEY123",
      nodeId: "12:34",
      version: undefined,
      fetchedAt: "2026-01-01T00:00:00Z",
    });
  });

  it("resolves readiness from the fetched subtree when no version is pinned", async () => {
    const document = {
      id: "12:34",
      name: "Work In Progress",
      type: "FRAME",
      children: [{ id: "1", name: "Login", type: "FRAME", devStatus: { type: "READY_FOR_DEV" } }],
    };
    const connector = createFigmaConnector({
      http: recordingPort(okResponse(document)).port,
      env: { FIGMA_ACCESS_TOKEN: TOKEN },
    });

    const result = await connector.fetchScopedNodes(URL_OK);
    expect(result.readiness).toEqual({ source: "devStatus", ready: true, readyNodeCount: 1 });
  });

  it("degrades readiness to none when devStatus is absent and nothing else matches", async () => {
    const document = { id: "12:34", name: "Drafts", type: "FRAME", children: [] };
    const connector = createFigmaConnector({
      http: recordingPort(okResponse(document)).port,
      env: { FIGMA_ACCESS_TOKEN: TOKEN },
    });

    const result = await connector.fetchScopedNodes(URL_OK);
    expect(result.readiness).toEqual({ source: "none", ready: false });
  });
});

describe("createFigmaConnector — token contract", () => {
  it("reads the PAT from FIGMA_ACCESS_TOKEN and sets it ONLY as the X-Figma-Token header", async () => {
    const recorder = recordingPort(okResponse());
    const connector = createFigmaConnector({
      http: recorder.port,
      env: { FIGMA_ACCESS_TOKEN: TOKEN },
    });

    await connector.fetchScopedNodes(URL_OK);

    expect(firstRequest(recorder).headers["X-Figma-Token"]).toBe(TOKEN);
  });

  it("prefers the injected config token over the env var", async () => {
    const recorder = recordingPort(okResponse());
    const connector = createFigmaConnector({
      http: recorder.port,
      env: { FIGMA_ACCESS_TOKEN: "env-token" },
      config: { accessToken: "config-token" },
    });

    await connector.fetchScopedNodes(URL_OK);
    expect(firstRequest(recorder).headers["X-Figma-Token"]).toBe("config-token");
  });

  it("prefers the vault token over config and env (#758 precedence)", async () => {
    const recorder = recordingPort(okResponse());
    const connector = createFigmaConnector({
      http: recorder.port,
      env: { FIGMA_ACCESS_TOKEN: "env-token" },
      config: { accessToken: "config-token" },
      vaultToken: "vault-token",
    });

    await connector.fetchScopedNodes(URL_OK);
    expect(firstRequest(recorder).headers["X-Figma-Token"]).toBe("vault-token");
  });

  it("falls back to the FIGMA_ACCESS_TOKEN env var when no vault token (#751 dev default preserved)", async () => {
    const recorder = recordingPort(okResponse());
    const connector = createFigmaConnector({
      http: recorder.port,
      env: { FIGMA_ACCESS_TOKEN: TOKEN },
    });

    await connector.fetchScopedNodes(URL_OK);
    expect(firstRequest(recorder).headers["X-Figma-Token"]).toBe(TOKEN);
  });

  it("refuses with FIGMA_TOKEN_MISSING when no token is configured", async () => {
    const recorder = recordingPort(okResponse());
    const connector = createFigmaConnector({ http: recorder.port, env: {} });

    await expect(connector.fetchScopedNodes(URL_OK)).rejects.toMatchObject({
      code: "FIGMA_TOKEN_MISSING",
    });
    expect(recorder.requests).toHaveLength(0);
  });

  it("treats a blank token as missing", async () => {
    const connector = createFigmaConnector({
      http: recordingPort(okResponse()).port,
      env: { FIGMA_ACCESS_TOKEN: "   " },
    });
    await expect(connector.fetchScopedNodes(URL_OK)).rejects.toMatchObject({
      code: "FIGMA_TOKEN_MISSING",
    });
  });
});

describe("createFigmaConnector — token never leaks", () => {
  const captureThrown = async (fn: () => Promise<unknown>): Promise<unknown> => {
    try {
      await fn();
    } catch (e) {
      return e;
    }
    throw new Error("expected throw");
  };

  it("never includes the token in a thrown error (message or any enumerable field)", async () => {
    const port = staticPort({ status: 403, json: { err: "no" }, headers: {} });
    const connector = createFigmaConnector({ http: port, env: { FIGMA_ACCESS_TOKEN: TOKEN } });

    const error = await captureThrown(() => connector.fetchScopedNodes(URL_OK));
    const serialised = `${String(error)} ${JSON.stringify(error)} ${JSON.stringify(
      Object.getOwnPropertyNames(error).map((k) => (error as Record<string, unknown>)[k]),
    )}`;
    expect(serialised).not.toContain(TOKEN);
    expect(serialised).not.toContain("figd_");
  });

  it("never includes the token in the returned provenance or nodes", async () => {
    const connector = createFigmaConnector({
      http: recordingPort(okResponse()).port,
      env: { FIGMA_ACCESS_TOKEN: TOKEN },
    });
    const result = await connector.fetchScopedNodes(URL_OK);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(JSON.stringify(result)).not.toContain("figd_");
  });

  it("does not emit the token to console", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const connector = createFigmaConnector({
      http: recordingPort(okResponse()).port,
      env: { FIGMA_ACCESS_TOKEN: TOKEN },
    });
    await connector.fetchScopedNodes(URL_OK);
    for (const call of [...spy.mock.calls, ...errSpy.mock.calls].flat()) {
      expect(String(call)).not.toContain(TOKEN);
    }
    spy.mockRestore();
    errSpy.mockRestore();
  });
});

describe("createFigmaConnector — coded errors", () => {
  const connectorWith = (
    response: Omit<FigmaHttpResponse, "headers">,
  ): ReturnType<typeof createFigmaConnector> =>
    createFigmaConnector({
      http: staticPort({ ...response, headers: {} }),
      env: { FIGMA_ACCESS_TOKEN: TOKEN },
    });

  it("maps a malformed / whole-file URL to FIGMA_MALFORMED_URL", async () => {
    const connector = connectorWith(okResponse());
    await expect(
      connector.fetchScopedNodes("https://www.figma.com/design/KEY/Board"),
    ).rejects.toMatchObject({ code: "FIGMA_MALFORMED_URL" });
  });

  it("maps 404 to FIGMA_NOT_FOUND", async () => {
    await expect(
      connectorWith({ status: 404, json: {} }).fetchScopedNodes(URL_OK),
    ).rejects.toMatchObject({ code: "FIGMA_NOT_FOUND" });
  });

  it("maps a reasonless 403 to the safe default FIGMA_TOKEN_INVALID (#758 taxonomy)", async () => {
    await expect(
      connectorWith({ status: 403, json: {} }).fetchScopedNodes(URL_OK),
    ).rejects.toMatchObject({ code: "FIGMA_TOKEN_INVALID" });
  });

  it("maps a 403 scope reason to FIGMA_INSUFFICIENT_SCOPE (#758 taxonomy)", async () => {
    await expect(
      connectorWith({ status: 403, json: { err: "Invalid scope(s)" } }).fetchScopedNodes(URL_OK),
    ).rejects.toMatchObject({ code: "FIGMA_INSUFFICIENT_SCOPE" });
  });

  it("maps a 403 expired reason to FIGMA_TOKEN_EXPIRED (#758 taxonomy)", async () => {
    await expect(
      connectorWith({ status: 403, json: { err: "Token has expired" } }).fetchScopedNodes(URL_OK),
    ).rejects.toMatchObject({ code: "FIGMA_TOKEN_EXPIRED" });
  });

  it("maps 401 to FIGMA_TOKEN_INVALID (bad/invalid token, #758 taxonomy)", async () => {
    await expect(
      connectorWith({ status: 401, json: {} }).fetchScopedNodes(URL_OK),
    ).rejects.toMatchObject({ code: "FIGMA_TOKEN_INVALID" });
  });

  it("maps a 407 proxy response to FIGMA_PROXY_EGRESS_FAILED (#758 taxonomy)", async () => {
    await expect(
      connectorWith({ status: 407, json: {} }).fetchScopedNodes(URL_OK),
    ).rejects.toMatchObject({ code: "FIGMA_PROXY_EGRESS_FAILED" });
  });

  it("maps 5xx to FIGMA_UPSTREAM_UNAVAILABLE", async () => {
    await expect(
      connectorWith({ status: 503, json: {} }).fetchScopedNodes(URL_OK),
    ).rejects.toMatchObject({ code: "FIGMA_UPSTREAM_UNAVAILABLE" });
  });

  it("maps an empty / missing node entry to FIGMA_NOT_FOUND", async () => {
    await expect(
      connectorWith({ status: 200, json: { nodes: {} } }).fetchScopedNodes(URL_OK),
    ).rejects.toMatchObject({ code: "FIGMA_NOT_FOUND" });
  });

  it("maps an unparseable 200 body to FIGMA_INTERNAL", async () => {
    await expect(
      connectorWith({ status: 200, json: "not-an-object" }).fetchScopedNodes(URL_OK),
    ).rejects.toMatchObject({ code: "FIGMA_INTERNAL" });
  });

  it("enforces a deterministic oversized-scope guard on node count", async () => {
    const children = Array.from({ length: 5 }, (_, i) => ({
      id: `c${String(i)}`,
      name: `n${String(i)}`,
      type: "FRAME",
    }));
    const document = { id: "12:34", name: "Big", type: "FRAME", children };
    const connector = createFigmaConnector({
      http: staticPort(okResponse(document)),
      env: { FIGMA_ACCESS_TOKEN: TOKEN },
      config: { maxNodeCount: 3 },
    });
    await expect(connector.fetchScopedNodes(URL_OK)).rejects.toMatchObject({
      code: "FIGMA_OVERSIZED_SCOPE",
    });
  });

  it("throws a FigmaConnectorError instance (typed, not a bare Error)", async () => {
    const error = await connectorWith({ status: 404, json: {} })
      .fetchScopedNodes(URL_OK)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FigmaConnectorError);
  });
});

describe("createFigmaConnector — depth cap", () => {
  it("uses a configurable depth and never an unbounded fetch", async () => {
    const recorder = recordingPort(okResponse());
    const connector = createFigmaConnector({
      http: recorder.port,
      env: { FIGMA_ACCESS_TOKEN: TOKEN },
      config: { depth: 5 },
    });
    await connector.fetchScopedNodes(URL_OK);
    expect(firstRequest(recorder).url).toContain("depth=5");
  });
});

describe("createFigmaConnector — deep scoped pagination (#837)", () => {
  interface Tree {
    readonly id: string;
    readonly type: string;
    readonly characters?: string;
    readonly children?: readonly Tree[];
  }

  const findById = (root: Tree, id: string): Tree | undefined => {
    if (root.id === id) return root;
    for (const c of root.children ?? []) {
      const hit = findById(c, id);
      if (hit !== undefined) return hit;
    }
    return undefined;
  };

  // Serve any node id from `full`, truncated at the requested `depth` (children:[] at the frontier),
  // exactly like GET /v1/files/:key/nodes. `statusById` injects a non-200 for a specific node id.
  const treePort = (full: Tree, statusById: Map<string, number> = new Map()): FigmaHttpPort => {
    const truncate = (n: Tree, depth: number): unknown => ({
      id: n.id,
      name: n.id,
      type: n.type,
      ...(n.characters !== undefined ? { characters: n.characters } : {}),
      children: depth <= 0 ? [] : (n.children ?? []).map((c) => truncate(c, depth - 1)),
    });
    return (request) => {
      const url = new URL(request.url);
      const id = url.searchParams.get("ids") ?? "";
      const depth = Number(url.searchParams.get("depth") ?? "0");
      const status = statusById.get(id);
      if (status !== undefined) return Promise.resolve({ status, json: {}, headers: {} });
      const target = findById(full, id);
      if (target === undefined) return Promise.resolve({ status: 404, json: {}, headers: {} });
      return Promise.resolve({
        status: 200,
        json: nodesResponse(id, truncate(target, depth)),
        headers: {},
      });
    };
  };

  // Root is the scoped CANVAS (id 12:34 — matches URL_OK's node-id). Each screen hides its TEXT at
  // screen-depth 3, below a shallow page-depth-2 frontier — the #837 shape.
  const screen = (id: string): Tree => ({
    id,
    type: "FRAME",
    children: [
      {
        id: `${id}-a`,
        type: "FRAME",
        children: [
          {
            id: `${id}-b`,
            type: "FRAME",
            children: [{ id: `${id}-t`, type: "TEXT", characters: "x" }],
          },
        ],
      },
    ],
  });
  const fullTree = (screenIds: readonly string[]): Tree => ({
    id: "12:34",
    type: "CANVAS",
    children: screenIds.map(screen),
  });

  const deepConfig = { depth: 2, pagination: { pageDepth: 2, fetchConcurrency: 2 } } as const;

  const countText = (node: unknown): number => {
    if (typeof node !== "object" || node === null) return 0;
    const n = node as { type?: unknown; children?: unknown };
    const self = n.type === "TEXT" ? 1 : 0;
    const kids = Array.isArray(n.children) ? n.children : [];
    return self + kids.reduce<number>((s, c) => s + countText(c), 0);
  };

  it("recovers deep in-screen text the shallow fetch misses, and reports coverage", async () => {
    const connector = createFigmaConnector({
      http: treePort(fullTree(["s1", "s2"])),
      env: { FIGMA_ACCESS_TOKEN: TOKEN },
      config: deepConfig,
    });

    const shallow = await connector.fetchScopedNodes(URL_OK);
    expect(countText(shallow.nodes)).toBe(0); // depth-2 discovery misses depth-3 text

    const deep = await connector.fetchScopedNodesDeep(URL_OK);
    expect(countText(deep.nodes)).toBe(2); // both screens' text recovered
    expect(deep.coverage).toMatchObject({
      screenCount: 2,
      screensDeepFetched: 2,
      capped: false,
    });
  });

  it("never leaks the token on the deep path (header only)", async () => {
    const requests: FigmaHttpRequest[] = [];
    const base = treePort(fullTree(["s1"]));
    const connector = createFigmaConnector({
      http: (req) => {
        requests.push(req);
        return base(req);
      },
      env: { FIGMA_ACCESS_TOKEN: TOKEN },
      config: deepConfig,
    });

    const deep = await connector.fetchScopedNodesDeep(URL_OK);
    expect(JSON.stringify(deep)).not.toContain(TOKEN);
    for (const req of requests) {
      expect(req.headers["X-Figma-Token"]).toBe(TOKEN);
      expect(req.url).not.toContain(TOKEN);
    }
  });

  it("aborts the build on an auth failure during a per-screen fetch (no silent shallow)", async () => {
    // Discovery (12:34) succeeds; the s1 deep fetch 403s → must abort, not degrade to shallow.
    const port = treePort(fullTree(["s1", "s2"]), new Map([["s1", 403]]));
    const connector = createFigmaConnector({
      http: port,
      env: { FIGMA_ACCESS_TOKEN: TOKEN },
      config: deepConfig,
    });
    await expect(connector.fetchScopedNodesDeep(URL_OK)).rejects.toMatchObject({
      code: "FIGMA_TOKEN_INVALID",
    });
  });

  it("soft-skips a transient per-screen 5xx, keeping that screen shallow and the build alive", async () => {
    const port = treePort(fullTree(["s1", "s2"]), new Map([["s1", 503]]));
    const connector = createFigmaConnector({
      http: port,
      env: { FIGMA_ACCESS_TOKEN: TOKEN },
      config: deepConfig,
    });
    const deep = await connector.fetchScopedNodesDeep(URL_OK);
    // s2 deepened (1 text), s1 stayed shallow (0) — the build did not abort.
    expect(countText(deep.nodes)).toBe(1);
    expect(deep.coverage?.screensDeepFetched).toBe(1);
  });
});

describe("createFigmaConnector — resilience (#759)", () => {
  const TEST_POLICY = { maxRetries: 3, baseDelayMs: 100, maxDelayMs: 5000 } as const;

  const recordingSleep = (): {
    readonly sleep: (ms: number) => Promise<void>;
    readonly delays: number[];
  } => {
    const delays: number[] = [];
    return { sleep: (ms) => (delays.push(ms), Promise.resolve()), delays };
  };

  // A scripted port that returns each response once, then sticks on the last entry.
  const scriptedPort = (
    script: readonly FigmaHttpResponse[],
  ): { readonly port: FigmaHttpPort; readonly calls: () => number } => {
    let index = 0;
    const port: FigmaHttpPort = () => {
      const response = script[Math.min(index, script.length - 1)];
      index += 1;
      if (response === undefined) throw new Error("empty script");
      return Promise.resolve(response);
    };
    return { port, calls: () => index };
  };

  it("retries a 429 scoped fetch then succeeds, sleeping the deterministic schedule", async () => {
    const scripted = scriptedPort([{ status: 429, json: {}, headers: {} }, okResponse()]);
    const { sleep, delays } = recordingSleep();
    const connector = createFigmaConnector({
      http: scripted.port,
      env: { FIGMA_ACCESS_TOKEN: TOKEN },
      retryPolicy: TEST_POLICY,
      sleep,
    });

    const result = await connector.fetchScopedNodes(URL_OK);

    expect(scripted.calls()).toBe(2);
    expect(delays).toEqual([100]);
    expect(result.provenance.fileKey).toBe("KEY123");
  });

  it("honours a Retry-After header on the scoped fetch 429", async () => {
    const scripted = scriptedPort([
      { status: 429, json: {}, headers: { "retry-after": "4" } },
      okResponse(),
    ]);
    const { sleep, delays } = recordingSleep();
    const connector = createFigmaConnector({
      http: scripted.port,
      env: { FIGMA_ACCESS_TOKEN: TOKEN },
      retryPolicy: TEST_POLICY,
      sleep,
    });

    await connector.fetchScopedNodes(URL_OK);

    expect(delays).toEqual([4000]);
  });

  it("raises FIGMA_RATE_LIMITED when scoped-fetch 429s exhaust the bounded retries", async () => {
    const scripted = scriptedPort([{ status: 429, json: {}, headers: {} }]);
    const { sleep } = recordingSleep();
    const connector = createFigmaConnector({
      http: scripted.port,
      env: { FIGMA_ACCESS_TOKEN: TOKEN },
      retryPolicy: TEST_POLICY,
      sleep,
    });

    await expect(connector.fetchScopedNodes(URL_OK)).rejects.toMatchObject({
      code: "FIGMA_RATE_LIMITED",
    });
    expect(scripted.calls()).toBe(TEST_POLICY.maxRetries + 1);
  });
});
