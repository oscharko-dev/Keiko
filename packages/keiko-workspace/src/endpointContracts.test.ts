import { describe, expect, it } from "vitest";
import type { RetrievalQuery } from "@oscharko-dev/keiko-contracts/connected-context";
import { memFs } from "./_memfs.js";
import {
  buildEndpointContractGraph,
  endpointContractAdapter,
  normalizeEndpointPath,
} from "./endpointContracts.js";
import { DEFAULT_SEARCH_LIMITS, type SearchScope } from "./repoSearch.js";
import type { WorkspaceInfo } from "./types.js";

const MEM_ROOT = "/ws";
const NOW = (): number => 1_700_000_000_000;

function makeScope(files: Readonly<Record<string, string>>): {
  readonly scope: SearchScope;
  readonly fs: ReturnType<typeof memFs>;
} {
  const workspace: WorkspaceInfo = {
    root: MEM_ROOT,
    name: "endpoint-demo",
    version: "1.0.0",
    testFramework: "vitest",
    sourceDirs: ["src"],
    testDirs: [],
    languages: ["java", "typescript", "javascript"],
    ignoreLines: [],
  };
  return {
    scope: { workspace, scopeId: "scope-1", relativePaths: [] },
    fs: memFs(MEM_ROOT, files),
  };
}

function nlq(text: string): RetrievalQuery {
  return { kind: "natural-language", text, caseSensitive: false, maxResults: 100, emittedAtMs: 0 };
}

describe("normalizeEndpointPath", () => {
  it("normalizes framework and template placeholders to one comparable shape", () => {
    expect(normalizeEndpointPath("/api/orders/{id}?expand=true")).toBe("/api/orders/:param");
    expect(normalizeEndpointPath("api/orders/${id}")).toBe("/api/orders/:param");
  });
});

describe("buildEndpointContractGraph", () => {
  it("links Java Spring GET/POST routes to TypeScript axios and fetch call sites", async () => {
    const { scope, fs } = makeScope({
      "src/main/java/com/acme/OrderController.java": `
        @RestController
        @RequestMapping("/api")
        class OrderController {
          @GetMapping("/orders/{id}")
          public OrderDto getOrder(String id) { return null; }

          @PostMapping(path = "/orders")
          public OrderDto createOrder(@RequestBody OrderDto request) { return null; }
        }
        record OrderDto(String status, BigDecimal amount) {}
      `,
      "src/client/orders.ts": `
        import axios from "axios";
        interface OrderDto { status: string; amount: number; }
        export function loadOrder(id: string) {
          return axios.get<OrderDto>(\`/api/orders/\${id}\`);
        }
        export function createOrder(order: OrderDto) {
          return fetch("/api/orders", { method: "POST", body: JSON.stringify(order) });
        }
      `,
    });

    const graph = await buildEndpointContractGraph(scope, DEFAULT_SEARCH_LIMITS, fs);

    expect(graph.routes.map((route) => [route.method, route.normalizedPath])).toEqual([
      ["GET", "/api/orders/:param"],
      ["POST", "/api/orders"],
    ]);
    expect(
      graph.clientCalls.map((call) => [call.method, call.normalizedPath, call.client]),
    ).toEqual([
      ["GET", "/api/orders/:param", "axios"],
      ["POST", "/api/orders", "fetch"],
    ]);
    const getLink = graph.links.find((link) => link.method === "GET");
    expect(getLink?.dtoEvidence).toMatchObject({
      serverType: "OrderDto",
      clientType: "OrderDto",
      sharedFields: ["amount", "status"],
    });
    expect(graph.links.find((link) => link.method === "POST")?.dtoEvidence).toBeUndefined();
    expect(graph.unmatchedRoutes).toEqual([]);
  });

  it("reports unmatched routes and ambiguous client calls without fabricating one winner", async () => {
    const { scope, fs } = makeScope({
      "src/main/java/com/acme/OrderController.java": `
        @RestController
        @RequestMapping("/api")
        class OrderController {
          @GetMapping("/orders/{id}")
          public OrderDto getOrder(String id) { return null; }
          @DeleteMapping("/orders/{id}")
          public void deleteOrder(String id) {}
        }
        record OrderDto(String status) {}
      `,
      "src/client/a.ts": "axios.get<OrderDto>(`/api/orders/${id}`);",
      "src/client/b.ts": "axios.get<OrderDto>(`/api/orders/${orderId}`);",
    });

    const graph = await buildEndpointContractGraph(scope, DEFAULT_SEARCH_LIMITS, fs);

    expect(graph.links).toHaveLength(2);
    expect(graph.links.every((link) => link.ambiguous)).toBe(true);
    expect(graph.links.every((link) => link.confidence > 0 && link.confidence < 0.7)).toBe(true);
    expect(graph.ambiguousClientCalls.map((call) => call.scopePath).sort()).toEqual([
      "src/client/a.ts",
      "src/client/b.ts",
    ]);
    expect(graph.unmatchedRoutes).toEqual([
      expect.objectContaining({
        method: "DELETE",
        normalizedPath: "/api/orders/:param",
        confidence: 0.92,
      }),
    ]);
  });
});

describe("endpointContractAdapter", () => {
  it("emits structural evidence for linked server and client endpoint lines", async () => {
    const { scope, fs } = makeScope({
      "src/main/java/com/acme/OrderController.java": `
        @RestController
        @RequestMapping("/api")
        class OrderController {
          @GetMapping("/orders/{id}")
          public OrderDto getOrder(String id) { return null; }
        }
        record OrderDto(String status) {}
      `,
      "src/client/orders.ts": `
        import axios from "axios";
        interface OrderDto { status: string; }
        export const loadOrder = (id: string) => axios.get<OrderDto>(\`/api/orders/\${id}\`);
      `,
    });

    const atoms = await endpointContractAdapter.lookup(
      scope,
      nlq("frontend api route for OrderDto status"),
      DEFAULT_SEARCH_LIMITS,
      fs,
      { nowMs: NOW },
    );

    expect(atoms.map((atom) => [atom.scopePath, atom.provenance.tool])).toEqual([
      ["src/main/java/com/acme/OrderController.java", "endpoint-contract-linker"],
      ["src/client/orders.ts", "endpoint-contract-linker"],
    ]);
  });
});
