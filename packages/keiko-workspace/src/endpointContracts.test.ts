import { describe, expect, it } from "vitest";
import type { RetrievalQuery } from "@oscharko-dev/keiko-contracts/connected-context";
import { memFs } from "./_memfs.js";
import { lineNumberOf } from "./endpointContractPaths.js";
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
    expect(normalizeEndpointPath("api/${tenant}/orders/${id}?expand=true")).toBe(
      "/api/:param/orders/:param",
    );
  });

  it("treats a supplementary-plane character (2 UTF-16 code units) as an ordinary path byte", () => {
    // Regression for the charCodeAt -> codePointAt rename (typescript:S7758). A lone surrogate
    // half or a combined astral code point is never equal to the ASCII "$"/"{" the template-
    // expression scanner looks for, so the emoji passes through untouched and the following
    // "${id}" is still recognized and collapsed.
    expect(normalizeEndpointPath("api/𝐀${id}/x")).toBe("/api/𝐀{param}/x");
    // A colon segment is only a route param when every character after ":" is an identifier
    // character; a supplementary-plane character in the middle correctly disqualifies it (its
    // surrogate halves never fall in the ASCII identifier ranges), so the segment stays literal.
    expect(normalizeEndpointPath("/api/:id𝐀comment/orders")).toBe("/api/:id𝐀comment/orders");
  });
});

describe("lineNumberOf", () => {
  it("counts newlines correctly when a supplementary-plane character sits on an earlier line", () => {
    // "😀" is 2 UTF-16 code units; neither unit's code point ever equals the ASCII line-feed
    // (10), so it cannot be miscounted as a newline or skipped, whether read with charCodeAt or
    // codePointAt.
    expect(lineNumberOf("a\n😀b\nc", 6)).toBe(3);
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

  it("preserves fetch literal and options parsing across all supported quote styles", async () => {
    const { scope, fs } = makeScope({
      "src/client/fetch-forms.ts": [
        "fetch('/single', { method: 'POST' });",
        'fetch("/double", { method: "PUT" });',
        "fetch(`/template`, { method: `PATCH` });",
      ].join("\n"),
    });

    const graph = await buildEndpointContractGraph(scope, DEFAULT_SEARCH_LIMITS, fs);

    expect(graph.clientCalls.map((call) => [call.method, call.path])).toEqual([
      ["POST", "/single"],
      ["PUT", "/double"],
      ["GET", "/template"],
    ]);
  });
});

describe("buildEndpointContractGraph regex complexity safety (S8786 regression)", () => {
  it("stays within a tight time budget for adversarial whitespace and identifier runs", async () => {
    // Each blob below is shaped to hit one specific finding fixed in endpointContractGraph.ts:
    // - a long, non-matching whitespace run between an annotation and its declaration used to
    //   let JAVA_ROUTE / AXIOS_CALL's adjacent unbounded `\s*` atoms backtrack against each
    //   other (now bounded with `\s{0,N}`).
    // - a long quote-free annotation-argument body used to let firstStringLiteral's adjacent
    //   `\s*` atoms around the optional `=` backtrack (now bounded).
    // - a long, comma-free record field with no trailing identifier used to force the old
    //   unanchored `/(...)$/` field-name regex to retry at every offset (now a linear scan).
    // Before the fix, inputs this size took seconds-to-minutes (verified empirically outside
    // this suite); the fixed patterns complete in low milliseconds.
    const wsChars = " \t\n\r  ";
    const wsRun = (length: number): string =>
      Array.from({ length }, (_, i) => wsChars[i % wsChars.length]).join("");
    const identChars = "abcXYZ019_$";
    const identRun = (length: number): string =>
      Array.from({ length }, (_, i) => identChars[i % identChars.length]).join("");

    const javaGap = wsRun(4000);
    const noQuoteArgs = identRun(8000);
    const badField = `${identRun(20000)}.`;

    const { scope, fs } = makeScope({
      "src/main/java/com/acme/Adversarial.java": `
        @GetMapping${javaGap}!
        class NeverMatches {}

        @GetMapping(${noQuoteArgs})
        public OrderDto getOrder(String id) { return null; }

        record BigRecord(${badField}) {}
        record OrderDto(String status) {}
      `,
      "src/client/adversarial.ts": `axios.get${wsRun(4000)}!`,
    });

    const startedAtMs = Date.now();
    const graph = await buildEndpointContractGraph(scope, DEFAULT_SEARCH_LIMITS, fs);
    const elapsedMs = Date.now() - startedAtMs;

    expect(elapsedMs).toBeLessThan(2000);
    expect(graph.routes).toHaveLength(1);
    expect(graph.routes[0]?.handler).toBe("getOrder");
    expect(graph.clientCalls).toHaveLength(0);
    expect(graph.dtoShapes.map((shape) => [shape.typeName, shape.fields])).toEqual([
      ["BigRecord", []],
      ["OrderDto", ["status"]],
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
