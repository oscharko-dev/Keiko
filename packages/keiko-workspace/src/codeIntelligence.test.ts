import { describe, expect, it } from "vitest";
import type { RetrievalQuery } from "@oscharko-dev/keiko-contracts/connected-context";
import { memFs } from "./_memfs.js";
import {
  buildCodeIntelligenceIndex,
  lookupCodeIntelligenceAtoms,
  queryCodeIntelligenceIndex,
} from "./codeIntelligence.js";
import type { WorkspaceFs } from "./fs.js";
import { DEFAULT_SEARCH_LIMITS, type SearchScope } from "./repoSearch.js";
import type { WorkspaceInfo, WorkspaceLanguage } from "./types.js";

const MEM_ROOT = "/ws";
const FIXED_NOW = (): number => 1_700_000_000_000;

function workspace(languages: readonly WorkspaceLanguage[] = [
  "typescript",
  "javascript",
  "java",
  "python",
  "go",
  "csharp",
  "graphql",
  "protobuf",
]): WorkspaceInfo {
  return {
    root: MEM_ROOT,
    name: "code-intelligence-demo",
    version: "1.0.0",
    testFramework: "vitest",
    sourceDirs: ["src", "packages", "services"],
    testDirs: [],
    languages,
    ignoreLines: [],
  };
}

function makeScope(files: Readonly<Record<string, string>>): {
  readonly scope: SearchScope;
  readonly fs: WorkspaceFs;
} {
  return {
    scope: { workspace: workspace(), scopeId: "scope-1", relativePaths: [] },
    fs: memFs(MEM_ROOT, files),
  };
}

function nlq(text: string, maxResults = 200): RetrievalQuery {
  return { kind: "natural-language", text, caseSensitive: false, maxResults, emittedAtMs: 0 };
}

function exact(text: string, maxResults = 200): RetrievalQuery {
  return { kind: "exact-symbol", text, caseSensitive: false, maxResults, emittedAtMs: 0 };
}

function sorted<T>(values: readonly T[]): readonly T[] {
  return [...values].sort();
}

function persistentMemFs(files: Record<string, string>): WorkspaceFs {
  const base = memFs(MEM_ROOT, files);
  const relative = (absolutePath: string): string =>
    absolutePath === MEM_ROOT ? "" : absolutePath.slice(MEM_ROOT.length + 1);
  return {
    ...base,
    makeDir: () => undefined,
    writeFileUtf8: (absolutePath: string, content: string): void => {
      files[relative(absolutePath)] = content;
    },
  };
}

function enterpriseFixture(): Record<string, string> {
  return {
    "package.json": JSON.stringify({
      name: "@demo/root",
      dependencies: { "@demo/api": "1.0.0" },
    }),
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        baseUrl: ".",
        paths: {
          "@domain/*": ["packages/domain/src/*"],
          "@api/*": ["packages/api/src/*"],
        },
      },
    }),
    "packages/api/package.json": JSON.stringify({
      name: "@demo/api",
      exports: { "./orders": { import: "./src/orders.ts" } },
      dependencies: { "@demo/domain": "1.0.0" },
    }),
    "packages/domain/package.json": JSON.stringify({
      name: "@demo/domain",
      main: "./src/order.ts",
      exports: { "./*": "./src/*.ts" },
    }),
    "packages/domain/src/order.ts": `
      export interface OrderDto {
        orderId: string;
        status: string;
        totalAmount: number;
      }
      export function calculateTotal(): number {
        return 42;
      }
      export default class DefaultOrder {
        readonly status = "ready";
      }
    `,
    "packages/domain/src/index.ts": `
      export { calculateTotal as computeTotal, OrderDto } from "./order";
      export { default } from "./order";
    `,
    "packages/api/src/orders.ts": `
      import DefaultOrder, { computeTotal, OrderDto } from "@domain/index";
      export function loadOrder(): OrderDto {
        const totalAmount = computeTotal();
        return { orderId: "o-1", status: new DefaultOrder().status, totalAmount };
      }
      export function handler(): OrderDto {
        return loadOrder();
      }
    `,
    "src/client/orders.ts": `
      import axios from "axios";
      import { loadOrder } from "@demo/api/orders";
      const api = axios.create({ baseURL: "/api" });
      const orderClient = new OrderServiceClient("http://localhost");
      export function renderOrder(): string {
        const order = loadOrder();
        api.get(\`/orders/\${order.orderId}\`);
        fetch("/api/orders", { method: "POST", body: JSON.stringify(order) });
        orderClient.GetOrder({ id: order.orderId });
        return order.status;
      }
      const queryDoc = gql\`
        query GetOrder {
          order(id: "o-1") { status totalAmount }
        }
        mutation CreateOrder {
          createOrder(input: { status: "ready" }) { status }
        }
      \`;
    `,
    "src/client/domain-import.ts": `
      import { calculateTotal } from "@demo/domain/order";
      export const total = calculateTotal();
    `,
    "src/client/rtk.ts": `
      const ordersApi = createApi({
        endpoints: (builder) => ({
          loadOrder: builder.query({
            query: () => "/api/orders",
          }),
          updateOrder: builder.mutation({
            query: () => ({ url: "/api/orders", method: "PATCH" }),
          }),
        }),
      });
    `,
    "src/alias/utils.ts": "export function aliasHelper(): string { return 'ok'; }\n",
    "src/base.ts": "export function baseHelper(): string { return 'base'; }\n",
    "src/module-forms.ts": `
      import { aliasHelper } from "@/alias/utils";
      import { baseHelper } from "src/base";
      import "./server";
      export * from "./base";
      export { aliasHelper as renamedAlias };
      export default function defaultModuleForm(): string {
        return aliasHelper() + baseHelper();
      }
      export = defaultModuleForm;
    `,
    "src/legacy.jsx": `
      export default function LegacyView() {
        return <span>legacy</span>;
      }
    `,
    "src/common.cjs": `
      const util = require("./alias/utils");
      module.exports = util;
    `,
    "src/dynamic.mjs": `
      export async function loadDynamic() {
        return import("./alias/utils.js");
      }
    `,
    "src/main/java/com/acme/domain/OrderDto.java": `
      package com.acme.domain;
      import com.fasterxml.jackson.annotation.JsonProperty;
      public record OrderDto(@JsonProperty("order_id") String orderId, String status, java.math.BigDecimal totalAmount) {}
    `,
    "src/main/java/com/acme/orders/OrderController.java": `
      package com.acme.orders;
      import com.acme.domain.OrderDto;
      import org.springframework.web.bind.annotation.*;
      @RestController
      @RequestMapping("/api")
      public class OrderController {
        @GetMapping("/orders/{id}")
        public OrderDto getOrder(@PathVariable String id) { return null; }
        @PostMapping(path = "/orders")
        public OrderDto createOrder(@RequestBody OrderDto order) { return order; }
      }
    `,
    "services/py/models.py": `
      class PyOrder:
        status: str
        total_amount: int
      def calculate_py_total():
        return 7
    `,
    "services/py/orders.py": `
      from .models import PyOrder, calculate_py_total
      router = APIRouter(prefix="/py")
      app.include_router(router, prefix="/v2")
      @router.get("/orders/{order_id}")
      def load_py_order(order_id: str) -> PyOrder:
        calculate_py_total()
        return PyOrder()
    `,
    "services/py/flask_routes.py": `
      blue = Blueprint("orders", __name__, url_prefix="/flask")
      @blue.route("/orders/<order_id>", methods=["DELETE"])
      def delete_order(order_id):
        return "ok"
      urlpatterns = [
        path("django/orders/<str:order_id>", view),
        re_path(r"^regex/orders/(?P<order_id>[^/]+)$", view),
      ]
    `,
    "go.mod": "module example.com/shop\n",
    "services/go/domain/domain.go": `
      package domain
      type Order struct {
        Status string \`json:"status"\`
        TotalAmount int \`json:"totalAmount"\`
      }
      func Calculate() int { return 1 }
    `,
    "services/go/orders/handler.go": `
      package orders
      import "example.com/shop/services/go/domain"
      func Handle() int {
        return domain.Calculate()
      }
      func Routes(r Router) {
        http.HandleFunc("/go/health", HandleHealth)
        r.Get("/go/orders/{id}", HandleOrder)
        r.HandleFunc("/go/orders/{id}", HandleOrder).Methods(http.MethodPost)
      }
    `,
    "services/kotlin/Order.kt": `
      data class KotlinOrder(val status: String, val totalAmount: Int)
      fun kotlinTotal(): Int { return 1 }
    `,
    "services/scala/Order.scala": "class ScalaOrder(val status: String)\n",
    "services/groovy/Order.groovy": "class GroovyOrder { String status }\n",
    "services/rust/order.rs": `
      pub mod totals;
      use crate::totals::calculate;
      struct RustOrder { status: String }
      fn rust_total() -> i32 { calculate() }
    `,
    "services/ruby/order.rb": `
      class RubyOrder
        def total()
          1
        end
      end
    `,
    "services/php/Order.php": `
      class PhpOrder {
        public string $status;
      }
    `,
    "services/swift/Order.swift": `
      struct SwiftOrder {
        let status: String
      }
    `,
    "Controllers/OrdersController.cs": `
      using Demo.Contracts;
      [Route("api/[controller]")]
      public class OrdersController {
        [HttpGet("{id}")]
        public OrderDto Get(string id) { return new OrderDto("ready", 12); }
        [HttpPost]
        public OrderDto Create(OrderDto order) { return order; }
      }
      public record OrderDto(string Status, decimal TotalAmount);
    `,
    "Program.cs": `
      app.MapGet("/api/minimal/{id}", () => "ok");
      app.MapMethods("/api/minimal", new[] { "PATCH" }, () => "ok");
    `,
    "src/server.ts": `
      import express from "express";
      const app = express();
      const router = express.Router();
      app.use("/api", router);
      app.post("/direct", (_req, res) => res.json({ ok: true }));
      router.route("/items").get((_req, res) => res.json({ ok: true }));
    `,
    "src/nest/orders.controller.ts": `
      @Controller("nest/orders")
      export class NestOrdersController {
        @Get(":id")
        getOrder() { return "ok"; }
      }
    `,
    "schema.graphql": `
      type Query {
        order(id: ID!): Order
      }
      extend type Query {
        customer(id: ID!): Customer
      }
      type Mutation {
        createOrder(input: OrderInput!): Order
      }
    `,
    "orders.proto": `
      service OrderService {
        rpc GetOrder (OrderRequest) returns (Order);
      }
    `,
    "openapi.yaml": `
      paths:
        /api/openapi-orders/{id}:
          get:
            operationId: getOpenApiOrder
      components:
        schemas:
          OpenApiOrderDto:
            type: object
            properties:
              status:
                type: string
              totalAmount:
                type: number
    `,
    "swagger.json": JSON.stringify({
      paths: {
        "/api/swagger-orders/{id}": {
          get: { operationId: "getSwaggerOrder" },
          trace: { operationId: "ignoredTrace" },
        },
      },
      components: {
        schemas: {
          SwaggerOrderDto: {
            type: "object",
            properties: {
              status: { type: "string" },
              totalAmount: { type: "number" },
            },
          },
        },
      },
    }),
  };
}

function edgeCaseFixture(): Record<string, string> {
  return {
    Dockerfile: "FROM node:22\n",
    "README": "not source\n",
    "package.json": JSON.stringify({
      name: "@edge/root",
      dependencies: {
        "@edge/missing-entry": "1.0.0",
        "@edge/self": "1.0.0",
        "@edge/string-export": "1.0.0",
        missing: "1.0.0",
      },
      devDependencies: { "@edge/conditional": "1.0.0" },
      peerDependencies: { "@edge/plain": "1.0.0" },
      optionalDependencies: { "@edge/source-sibling": "1.0.0" },
    }),
    "node_modules/ignored/package.json": JSON.stringify({ name: "ignored" }),
    "bad/package.json": "{",
    "nameless/package.json": JSON.stringify({ private: true }),
    "tsconfig.bad.json": "{",
    "tsconfig.empty.json": JSON.stringify({ compilerOptions: "invalid" }),
    "tsconfig.pathsless.json": JSON.stringify({ compilerOptions: { baseUrl: "src" } }),
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        baseUrl: ".",
        paths: {
          "@exact/shared": ["src/exact-shared.ts"],
          "@edge/*": ["src/edge/*"],
          "@bad-array/*": "src/bad-array/*",
          "@missing/*": ["src/missing/*"],
        },
      },
    }),
    "packages/self/package.json": JSON.stringify({
      name: "@edge/self",
      main: "./src/index.ts",
      dependencies: { "@edge/self": "1.0.0" },
    }),
    "packages/self/src/index.ts": "export const selfValue = 1;\n",
    "packages/string-export/package.json": JSON.stringify({
      name: "@edge/string-export",
      exports: "./src/main.ts",
      module: "./src/module.ts",
      types: "./src/types.d.ts",
    }),
    "packages/string-export/src/main.ts": "export function stringExport(): number { return 1; }\n",
    "packages/string-export/src/module.ts": "export const moduleExport = 1;\n",
    "packages/string-export/src/types.d.ts": "export interface StringExportTypes { id: string }\n",
    "packages/conditional/package.json": JSON.stringify({
      name: "@edge/conditional",
      exports: {
        ".": { require: "./src/require.cjs", import: "./src/import.mjs" },
        "./feature": { default: "./src/feature.ts" },
      },
    }),
    "packages/conditional/src/feature.ts": "export const conditionalFeature = 1;\n",
    "packages/conditional/src/import.mjs": "export const conditionalImport = 1;\n",
    "packages/plain/package.json": JSON.stringify({
      name: "@edge/plain",
      main: "./src/index.ts",
      exports: { "./tool": "./src/tool.ts", "./bad": { browser: 1 } },
    }),
    "packages/plain/src/index.ts": "export const plain = 1;\n",
    "packages/plain/src/tool.ts": "export const tool = 1;\n",
    "packages/missing-entry/package.json": JSON.stringify({
      name: "@edge/missing-entry",
      main: "./dist/missing.js",
    }),
    "packages/source-sibling/package.json": JSON.stringify({
      name: "@edge/source-sibling",
      main: "./dist/index.js",
    }),
    "packages/source-sibling/dist/index.ts": "export const sourceSibling = 1;\n",
    "src/exact-shared.ts": `
      export interface ExactDto {
        one: string;
        two: number;
      }
      export class ExactClass {
        public visible = "yes";
        #secret = "hidden";
        method(): string {
          return this.visible;
        }
      }
      export type ExactAlias = { aliasField: string; otherField: number };
      export enum ExactKind { One = "one" }
      export namespace ExactNamespace { export const value = 1; }
      export const exactConstant = stringExport();
      export default { exactConstant };
    `,
    "src/edge/tool.ts": "export function edgeTool(): number { return 2; }\n",
    "src/barrel.ts": `
      export * from "./exact-shared";
      export * as ExactExports from "./exact-shared";
      export { edgeTool as renamedTool } from "@edge/tool";
      export { edgeTool as default } from "@edge/tool";
    `,
    "src/import-forms.ts": `
      import legacy = require("./legacy.cjs");
      import * as Barrel from "./barrel";
      import { indexed } from "./index-dir";
      import "@edge/plain";
      import "@edge/missing-entry";
      import stringExportDefault, { stringExport } from "@edge/string-export";
      import { conditionalFeature } from "@edge/conditional/feature";
      import { sourceSibling } from "@edge/source-sibling";
      import { ExactDto, exactConstant } from "@exact/shared";
      import { missing } from "@missing/not-found";
      import("/absolute/not-found");
      require("./legacy.cjs");
      type Local = ExactDto;
      export const importForms = [
        legacy,
        Barrel,
        indexed,
        stringExportDefault,
        stringExport(),
        conditionalFeature,
        sourceSibling,
        exactConstant,
        missing,
      ];
    `,
    "src/index-dir/index.ts": "export const indexed = 1;\n",
    "src/anonymous-default.ts": `
      const namedDefault = 1;
      const renamedDefault = 2;
      export { renamedDefault as default };
      export { namedDefault };
      export default function () { return "anonymous"; }
      export class Host {
        ["literalName"]() { return "ok"; }
      }
    `,
    "src/legacy.cjs": "module.exports = { legacy: true };\n",
    "src/component.vue": `
      <script setup lang="ts">
      export * from "./edge/tool";
      import { edgeTool } from "./edge/tool";
      edgeTool();
      </script>
    `,
    "src/routes-and-comments.ts": `
      import axios from "axios";
      const api = axios.create({ baseURL: "https://service.local/base/" });
      // fetch("/ignored/comment")
      const ignored = "fetch('/ignored/string')";
      const escaped = "quote \\" // not a comment";
      /*
       * app.get("/ignored/block", handler);
       */
      const q = graphql\`
        query EdgeLookup { edgeLookup { id } }
        mutation EdgeChange { edgeChange { id } }
      \`;
      fetch("https://service.local/base/fetch?expand=true");
      fetch("/fetch-post", { method: "PUT" });
      axios.delete("/axios-delete");
      api.patch("/patch-target");
      const ordersApi = createApi({
        endpoints: (builder) => ({
          read: builder.query({ query: () => "/rtk-direct" }),
          write: builder.mutation({ query: () => ({ url: "/rtk-default" }) }),
        }),
      });
      @Controller()
      class RootController {
        @All()
        all() { return "ok"; }
        @Options("options")
        options() { return "ok"; }
      }
    `,
    "src/server-edge.js": `
      const server = express();
      const mounted = express.Router();
      server.use("/mounted", mounted);
      server.head("/health", handler);
      server.post("/rtk-default", handler);
      mounted.options("/", handler);
      mounted.route("/chain").delete(handler);
      ignored.get("/not-a-route", handler);
    `,
    "src/main/java/com/edge/shared/SharedDto.java": `
      package com.edge.shared;
      import com.fasterxml.jackson.annotation.JsonProperty;
      public class SharedDto {
        @JsonProperty(value = "wire_id")
        private String id;
        private String label;
      }
    `,
    "src/main/java/com/edge/Routes.java": `
      package com.edge;
      import static com.edge.shared.SharedDto.*;
      import com.edge.shared.SharedDto;
      @RequestMapping(path = "/java", method = RequestMethod.PUT)
      public class Routes {
        @RequestMapping(value = "/request")
        public SharedDto request() { return null; }
      }
    `,
    "src/main/kotlin/com/edge/KotlinOrder.kt": `
      package com.edge
      import com.edge.SharedDto
      data class KotlinOrder(@JsonPropertyName("-") val ignored: String, val label: String)
      class KotlinBlock {
        var bodyLabel: String = ""
      }
      fun kotlinEdge(): Int { return 1 }
    `,
    "src/main/scala/com/edge/ScalaOrder.scala": `
      package com.edge
      import com.edge.SharedDto
      class ScalaOrder(val label: String)
    `,
    "src/main/groovy/com/edge/GroovyOrder.groovy": `
      package com.edge
      import com.edge.SharedDto
      class GroovyOrder { String label }
    `,
    "src/main/csharp/EdgeController.cs": `
      [Route("edge/[controller]")]
      public class EdgeController {
        [Route("method")]
        public string MethodRoute() { return "ok"; }
        [HttpHead]
        public string Head() { return "ok"; }
      }
      public record EdgeRecord(string Label, List<string> Items = null, Dictionary<string, string> Lookup = null);
      public class EdgeDto {
        [JsonPropertyName("wire_id")]
        public string Id { get; set; }
        public string Label { get; set; }
      }
      public record StrangeRecord(name?: string, Dictionary<string, List<int>> Lookup, string Text = "a,b");
    `,
    "Program.cs": `
      app.MapMethods("/edge/methods-any", new[] { methodName }, () => "ok");
      app.MapOptions("/edge/options", () => "ok");
    `,
    "services/py/__init__.py": "",
    "services/py/models.py": `
      class PyThing:
        label: str
      def py_helper():
        return PyThing()
    `,
    "services/py/subpackage/__init__.py": `
      def sub_helper():
        return 1
    `,
    "vendor/edgepkg/__init__.py": `
      def edgepkg_helper():
        return 1
    `,
    "services/py/edge.py": `
      import services.py.models as models
      import edgepkg
      from services.py.subpackage import sub_helper as helper
      from .missing import absent
      router = APIRouter()
      blue = Blueprint("edge", __name__)
      app.include_router(router)
      """
      @router.get("/ignored-docstring")
      """
      # @router.get("/ignored-line-comment")
      @router.post("/py-post")
      def py_post():
        helper()
        return models.py_helper()
      @blue.route("/blue-any")
      def blue_any():
        return "ok"
      urlpatterns = [
        url(r"^legacy/(?P<id>[^/]+)$", view),
      ]
    `,
    "go.mod": "module example.com/edge\n",
    "bad/go.mod": "not a module file\n",
    "services/go/direct.go": "package direct\nfunc Direct() int { return 1 }\n",
    "services/go/pkg/a.go": "package pkg\nfunc Helper() int { return 1 }\n",
    "services/go/pkg/z_test.go": "package pkg\nfunc TestHelper() {}\n",
    "services/go/edge.go": `
      package main
      import (
        "example.com/edge/services/go/direct"
        "example.com/edge/services/go/pkg"
        alias "example.com/edge/services/go/missing"
      )
      type GoEdge struct {
        WireID string \`json:"wire_id,omitempty"\`
        Ignored string \`json:"-"\`
        Label string
      }
      func GoEdgeHandler(r Router) {
        direct.Direct()
        pkg.Helper()
        alias.Helper()
        r.HandleFunc("/go/any", Handle)
        r.HandleFunc("/go/post", Handle).Methods("POST")
        r.Options("/go/options", Handle)
      }
    `,
    "src/rust/edge.rs": `
      pub mod nested;
      use nested;
      use crate::missing::thing;
      pub trait EdgeTrait { fn run(&self); }
      struct EdgeStruct { label: String }
      fn edge_fn() { thing(); }
    `,
    "src/rust/nested.rs": "pub fn nested() {}\n",
    "src/ruby/edge.rb": `
      require "missing"
      class EdgeRuby
        def edge_method()
          edge_method()
        end
      end
    `,
    "src/php/Edge.php": `
      use Demo\\Missing;
      class EdgePhp { public string $label; }
    `,
    "src/swift/Edge.swift": `
      import Foundation
      struct EdgeSwift { let label: String }
    `,
    "src/cpp/edge.cpp": "struct EdgeCpp { int label; };\n",
    "src/fsharp/Edge.fs": "type EdgeFSharp = { Label: string }\n",
    "src/vb/Edge.vb": "Class EdgeVb\nEnd Class\n",
    "schema.graphql": `
      schema { query: Query }
      type Query {
        inline(id: ID!): Inline
      }
      extend type Mutation {
        edgeMutation: Edge
      }
    `,
    "empty-schema.graphql": "type Query\n",
    "orders.proto": `
      service EdgeService {
        rpc First (EdgeRequest) returns (EdgeResponse);
      }
      // service Ignored { rpc Bad (Bad) returns (Bad); }
    `,
    "invalid-openapi.json": "{",
    "openapi.json": JSON.stringify({
      paths: {
        "/edge/openapi": {
          get: {},
          options: {},
          trace: {},
        },
        ignored: [],
      },
      components: {
        schemas: {
          BadSchema: "not an object",
          EmptyDto: { type: "object", properties: {} },
          EdgeOpenApiDto: {
            type: "object",
            properties: { id: { type: "string" }, label: { type: "string" } },
          },
        },
      },
    }),
    "openapi.yaml": `
      paths:
        /edge/yaml:
          head:
            operationId: headEdge
      info:
        title: Edge
      components:
        schemas:
          EmptyYamlDto:
            type: object
            properties:
          EdgeYamlDto:
            type: object
            properties:
              id:
                type: string
              label:
                type: string
      trailing:
        ignored: true
    `,
  };
}

describe("buildCodeIntelligenceIndex", () => {
  it("indexes polyglot imports, symbols, endpoints, DTOs, packages, and graph atoms", () => {
    const { scope, fs } = makeScope(enterpriseFixture());

    const index = buildCodeIntelligenceIndex(scope, DEFAULT_SEARCH_LIMITS, fs, {
      disableCache: true,
      nowMs: FIXED_NOW,
    });

    expect(index.filesIndexed).toBeGreaterThan(15);
    expect(index.filesSkipped).toBe(0);
    expect(index.parserCoverage).toEqual(
      expect.arrayContaining([
        { parser: "polyglot-regex", filesIndexed: expect.any(Number) },
        { parser: "typescript-compiler-ast", filesIndexed: expect.any(Number) },
      ]),
    );
    expect(index.imports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          importerPath: "packages/api/src/orders.ts",
          specifier: "@domain/index",
          targetPath: "packages/domain/src/index.ts",
          confidence: "resolved",
        }),
        expect.objectContaining({
          importerPath: "src/client/orders.ts",
          specifier: "@demo/api/orders",
          targetPath: "packages/api/src/orders.ts",
          confidence: "resolved",
        }),
        expect.objectContaining({
          importerPath: "src/main/java/com/acme/orders/OrderController.java",
          specifier: "com.acme.domain.OrderDto",
          targetPath: "src/main/java/com/acme/domain/OrderDto.java",
          confidence: "resolved",
        }),
        expect.objectContaining({
          importerPath: "services/py/orders.py",
          specifier: ".models",
          targetPath: "services/py/models.py",
          confidence: "resolved",
        }),
        expect.objectContaining({
          importerPath: "services/go/orders/handler.go",
          specifier: "example.com/shop/services/go/domain",
          targetPath: "services/go/domain/domain.go",
          confidence: "resolved",
        }),
      ]),
    );
    expect(index.packageDependencies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourcePackage: "@demo/root",
          targetPackage: "@demo/api",
          dependencyKind: "dependencies",
        }),
        expect.objectContaining({
          sourcePackage: "@demo/api",
          targetPackage: "@demo/domain",
          dependencyKind: "dependencies",
        }),
      ]),
    );
    expect(index.symbols).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "OrderDto",
          scopePath: "packages/domain/src/order.ts",
          fields: ["orderId", "status", "totalAmount"],
        }),
        expect.objectContaining({
          name: "OrderDto",
          scopePath: "src/main/java/com/acme/domain/OrderDto.java",
          fields: ["order_id", "status", "totalAmount"],
        }),
        expect.objectContaining({
          name: "PyOrder",
          scopePath: "services/py/models.py",
          fields: ["status", "total_amount"],
        }),
        expect.objectContaining({
          name: "Order",
          scopePath: "services/go/domain/domain.go",
          fields: ["struct", "status", "totalAmount"],
        }),
        expect.objectContaining({
          name: "OpenApiOrderDto",
          scopePath: "openapi.yaml",
          fields: ["status", "type", "totalAmount"],
        }),
      ]),
    );
    expect(index.calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          callerPath: "packages/api/src/orders.ts",
          calleeName: "computeTotal",
          targetName: "calculateTotal",
          targetPath: "packages/domain/src/order.ts",
          confidence: "resolved",
        }),
        expect.objectContaining({
          callerPath: "src/client/orders.ts",
          calleeName: "loadOrder",
          targetPath: "packages/api/src/orders.ts",
          confidence: "resolved",
        }),
        expect.objectContaining({
          callerPath: "services/py/orders.py",
          calleeName: "calculate_py_total",
          targetPath: "services/py/models.py",
          confidence: "resolved",
        }),
      ]),
    );
    expect(
      sorted(index.endpoints.map((endpoint) => `${endpoint.role}:${endpoint.method}:${endpoint.path}`)),
    ).toEqual(
      expect.arrayContaining([
        "client:GET:/api/orders/:param",
        "client:POST:/api/orders",
        "client:QUERY:/graphql/query/order",
        "client:RPC:/protobuf/orderservice/getorder",
        "server:GET:/api/orders/:param",
        "server:GET:/api/openapi-orders/:param",
        "server:GET:/api/orders/:param",
        "server:GET:/api/items",
        "server:GET:/nest/orders/:param",
        "server:GET:/orders/:param",
        "server:GET:/v2/py/orders/:param",
        "server:MUTATION:/graphql/mutation/createOrder",
        "server:POST:/api/orders",
        "server:QUERY:/graphql/query/order",
        "server:RPC:/protobuf/orderservice/getorder",
      ]),
    );
    expect(index.apiContracts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          confidence: "resolved",
          client: expect.objectContaining({ method: "GET", path: "/api/orders/:param" }),
          server: expect.objectContaining({ method: "GET", path: "/api/orders/:param" }),
        }),
        expect.objectContaining({
          confidence: "resolved",
          client: expect.objectContaining({ method: "POST", path: "/api/orders" }),
          server: expect.objectContaining({ method: "POST", path: "/api/orders" }),
        }),
        expect.objectContaining({
          confidence: "resolved",
          client: expect.objectContaining({ method: "RPC", path: "/protobuf/orderservice/getorder" }),
          server: expect.objectContaining({ method: "RPC", path: "/protobuf/orderservice/getorder" }),
        }),
      ]),
    );
    expect(index.dtoContracts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          confidence: "resolved",
          sharedFields: ["orderId", "status", "totalAmount"],
          source: expect.objectContaining({ scopePath: "packages/domain/src/order.ts" }),
          target: expect.objectContaining({ scopePath: "src/main/java/com/acme/domain/OrderDto.java" }),
        }),
      ]),
    );

    const atoms = queryCodeIntelligenceIndex(
      scope,
      nlq("OrderDto status computeTotal api orders @demo/domain"),
      index,
      FIXED_NOW(),
    );
    expect(sorted(atoms.map((atom) => atom.edge?.kind).filter(Boolean))).toEqual(
      expect.arrayContaining([
        "api-contract",
        "call",
        "definition",
        "dto-contract",
        "import",
        "package-dependency",
        "reference",
      ]),
    );
    expect(atoms.some((atom) => atom.provenance.tool === "code-intelligence-index")).toBe(true);
  });

  it("covers edge parser variants without indexing comments or unresolved workspace noise", () => {
    const { scope, fs } = makeScope(edgeCaseFixture());

    const index = buildCodeIntelligenceIndex(scope, DEFAULT_SEARCH_LIMITS, fs, {
      disableCache: true,
      nowMs: FIXED_NOW,
    });

    expect(index.filesIndexed).toBeGreaterThan(40);
    expect(index.filesSkipped).toBe(0);
    expect(index.imports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          importerPath: "src/import-forms.ts",
          specifier: "@exact/shared",
          targetPath: "src/exact-shared.ts",
          confidence: "resolved",
        }),
        expect.objectContaining({
          importerPath: "src/import-forms.ts",
          specifier: "@missing/not-found",
          confidence: "heuristic",
        }),
        expect.objectContaining({
          importerPath: "src/import-forms.ts",
          specifier: "@edge/source-sibling",
          targetPath: "packages/source-sibling/dist/index.ts",
          confidence: "resolved",
        }),
        expect.objectContaining({
          importerPath: "services/py/edge.py",
          specifier: "services.py.subpackage",
          targetPath: "services/py/subpackage/__init__.py",
          confidence: "resolved",
        }),
        expect.objectContaining({
          importerPath: "services/go/edge.go",
          specifier: "example.com/edge/services/go/pkg",
          targetPath: "services/go/pkg/a.go",
          confidence: "resolved",
        }),
        expect.objectContaining({
          importerPath: "src/main/java/com/edge/Routes.java",
          specifier: "com.edge.shared.SharedDto",
          targetPath: "src/main/java/com/edge/shared/SharedDto.java",
          confidence: "resolved",
        }),
      ]),
    );
    expect(index.packageDependencies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourcePackage: "@edge/root",
          targetPackage: "@edge/string-export",
          dependencyKind: "dependencies",
        }),
        expect.objectContaining({
          sourcePackage: "@edge/root",
          targetPackage: "@edge/conditional",
          dependencyKind: "devDependencies",
        }),
        expect.objectContaining({
          sourcePackage: "@edge/root",
          targetPackage: "@edge/plain",
          dependencyKind: "peerDependencies",
        }),
        expect.objectContaining({
          sourcePackage: "@edge/root",
          targetPackage: "@edge/source-sibling",
          dependencyKind: "optionalDependencies",
        }),
      ]),
    );
    expect(index.symbols).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "ExactDto",
          fields: ["one", "two"],
          parser: "typescript-compiler-ast",
        }),
        expect.objectContaining({
          name: "ExactAlias",
          fields: ["aliasField", "otherField"],
        }),
        expect.objectContaining({
          name: "ExactKind",
          kind: "enum",
        }),
        expect.objectContaining({
          name: "ExactNamespace",
          kind: "module",
        }),
        expect.objectContaining({
          name: "SharedDto",
          scopePath: "src/main/java/com/edge/shared/SharedDto.java",
          fields: expect.arrayContaining(["wire_id", "label"]),
        }),
        expect.objectContaining({
          name: "GoEdge",
          fields: expect.arrayContaining(["wire_id", "Ignored", "Label"]),
        }),
        expect.objectContaining({
          name: "EdgeOpenApiDto",
          fields: ["id", "label"],
        }),
      ]),
    );
    expect(
      sorted(index.endpoints.map((endpoint) => `${endpoint.role}:${endpoint.method}:${endpoint.path}`)),
    ).toEqual(
      expect.arrayContaining([
        "client:GET:/base/fetch",
        "client:PUT:/fetch-post",
        "client:PATCH:/base/patch-target",
        "client:ANY:/rtk-default",
        "client:QUERY:/graphql/query/edgeLookup",
        "server:ANY:/",
        "server:ANY:/blue-any",
        "server:ANY:/edge/edge/method",
        "server:ANY:/edge/methods-any",
        "server:ANY:/go/any",
        "server:ANY:/java/request",
        "server:ANY:/legacy/(",
        "server:GET:/edge/openapi",
        "server:HEAD:/edge/edge",
        "server:HEAD:/edge/yaml",
        "server:OPTIONS:/edge/openapi",
        "server:OPTIONS:/edge/options",
        "server:POST:/go/post",
        "server:POST:/py-post",
      ]),
    );
    expect(index.endpoints).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "/ignored/comment" }),
        expect.objectContaining({ path: "/ignored/block" }),
        expect.objectContaining({ path: "/ignored-docstring" }),
      ]),
    );
    expect(index.calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          callerPath: "src/import-forms.ts",
          calleeName: "stringExport",
          targetName: "stringExport",
          targetPath: "packages/string-export/src/main.ts",
          confidence: "resolved",
        }),
        expect.objectContaining({
          callerPath: "services/py/edge.py",
          calleeName: "helper",
          targetName: "sub_helper",
          targetPath: "services/py/subpackage/__init__.py",
          confidence: "resolved",
        }),
      ]),
    );
    expect(index.apiContracts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          confidence: "heuristic",
          client: expect.objectContaining({ method: "ANY", path: "/rtk-default" }),
          server: expect.objectContaining({ method: "POST", path: "/rtk-default" }),
        }),
      ]),
    );
    expect(index.dtoContracts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          confidence: "heuristic",
          sharedFields: expect.arrayContaining(["wire_id", "Label"]),
          target: expect.objectContaining({ name: "SharedDto" }),
        }),
      ]),
    );

    const exactImportAtoms = queryCodeIntelligenceIndex(
      scope,
      { kind: "exact-symbol", text: "@exact/shared", caseSensitive: true, maxResults: 20, emittedAtMs: 0 },
      index,
      FIXED_NOW(),
    );
    expect(exactImportAtoms).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          score: 1,
          edge: expect.objectContaining({ kind: "import", label: "@exact/shared" }),
        }),
      ]),
    );

    const caseSensitiveAtoms = queryCodeIntelligenceIndex(
      scope,
      {
        kind: "natural-language",
        text: "EdgeOpenApiDto wire_id",
        caseSensitive: true,
        maxResults: 20,
        emittedAtMs: 0,
      },
      index,
      FIXED_NOW(),
    );
    expect(caseSensitiveAtoms.some((atom) => atom.edge?.kind === "dto-contract")).toBe(true);

    const lookedUp = lookupCodeIntelligenceAtoms(
      scope,
      { kind: "exact-symbol", text: "ExactDto", caseSensitive: true, maxResults: 3, emittedAtMs: 0 },
      { ...DEFAULT_SEARCH_LIMITS, maxMatchesReturned: 3 },
      fs,
      { disableCache: true },
    );
    expect(lookedUp).toHaveLength(3);
  });

  it("uses memory and persistent cache only for valid matching index payloads", () => {
    const files = enterpriseFixture();
    const scope: SearchScope = {
      workspace: workspace(),
      scopeId: "scope-1",
      relativePaths: [],
    };
    const firstFs = persistentMemFs(files);

    const first = buildCodeIntelligenceIndex(scope, DEFAULT_SEARCH_LIMITS, firstFs);
    const cached = buildCodeIntelligenceIndex(scope, DEFAULT_SEARCH_LIMITS, firstFs);

    expect(cached).toBe(first);
    const cachePath = Object.keys(files).find((path) => path.startsWith(".keiko/code-intelligence/"));
    expect(cachePath).toBeDefined();

    const secondFs = persistentMemFs(files);
    const fromPersistent = buildCodeIntelligenceIndex(scope, DEFAULT_SEARCH_LIMITS, secondFs);
    expect(fromPersistent).not.toBe(first);
    expect(fromPersistent.imports).toEqual(first.imports);

    if (cachePath !== undefined) {
      files[cachePath] = JSON.stringify({ schemaVersion: -1, fingerprint: "stale", index: null });
    }
    const rebuilt = buildCodeIntelligenceIndex(scope, DEFAULT_SEARCH_LIMITS, persistentMemFs(files));
    expect(rebuilt.imports).toEqual(first.imports);

    const validEnvelope = JSON.parse(files[cachePath ?? ""] ?? "{}") as {
      readonly schemaVersion?: number;
      readonly fingerprint?: string;
      readonly index?: unknown;
    };
    expect(validEnvelope.fingerprint).toEqual(expect.any(String));
    const validIndex = validEnvelope.index as Record<string, unknown>;
    const firstImport = (validIndex.imports as readonly Record<string, unknown>[])[0] ?? {};
    const firstSymbol = (validIndex.symbols as readonly Record<string, unknown>[])[0] ?? {};
    const firstCall = (validIndex.calls as readonly Record<string, unknown>[])[0] ?? {};
    const firstReference = (validIndex.references as readonly Record<string, unknown>[])[0] ?? {};
    const firstEndpoint = (validIndex.endpoints as readonly Record<string, unknown>[])[0] ?? {};
    const firstApiContract = (validIndex.apiContracts as readonly Record<string, unknown>[])[0] ?? {};
    const firstDtoContract = (validIndex.dtoContracts as readonly Record<string, unknown>[])[0] ?? {};
    const firstPackageDependency =
      (validIndex.packageDependencies as readonly Record<string, unknown>[])[0] ?? {};
    const firstParserCoverage = (validIndex.parserCoverage as readonly Record<string, unknown>[])[0] ?? {};
    const corruptions: readonly ((index: Record<string, unknown>) => unknown)[] = [
      () => null,
      () => [],
      (index) => ({ ...index, imports: [{ kind: "bad" }] }),
      (index) => ({ ...index, imports: [null] }),
      (index) => ({ ...index, imports: [{ ...firstImport, confidence: "trusted" }] }),
      (index) => ({ ...index, symbols: [{ name: "OrderDto" }] }),
      (index) => ({ ...index, symbols: [null] }),
      (index) => ({ ...index, symbols: [{ ...firstSymbol, lineRange: { startLine: "1", endLine: 2 } }] }),
      (index) => ({ ...index, calls: [{ callerPath: "a.ts" }] }),
      (index) => ({ ...index, calls: [null] }),
      (index) => ({ ...index, calls: [{ ...firstCall, parser: "unknown" }] }),
      (index) => ({ ...index, references: [{ referencerPath: "a.ts" }] }),
      (index) => ({ ...index, references: [null] }),
      (index) => ({ ...index, references: [{ ...firstReference, confidence: "trusted" }] }),
      (index) => ({ ...index, endpoints: [{ role: "server" }] }),
      (index) => ({ ...index, endpoints: [null] }),
      (index) => ({ ...index, endpoints: [{ ...firstEndpoint, role: "worker" }] }),
      (index) => ({ ...index, apiContracts: [{ confidence: "resolved" }] }),
      (index) => ({ ...index, apiContracts: [null] }),
      (index) => ({ ...index, apiContracts: [{ ...firstApiContract, confidence: "trusted" }] }),
      (index) => ({ ...index, dtoContracts: [{ sharedFields: ["status"] }] }),
      (index) => ({ ...index, dtoContracts: [null] }),
      (index) => ({ ...index, dtoContracts: [{ ...firstDtoContract, sharedFields: ["status", 1] }] }),
      (index) => ({ ...index, packageDependencies: [{ sourcePackage: "@demo/root" }] }),
      (index) => ({ ...index, packageDependencies: [null] }),
      (index) => ({
        ...index,
        packageDependencies: [{ ...firstPackageDependency, dependencyKind: "bundled" }],
      }),
      (index) => ({ ...index, parserCoverage: [{ parser: "unknown", filesIndexed: 1 }] }),
      (index) => ({ ...index, parserCoverage: [null] }),
      (index) => ({ ...index, parserCoverage: [{ ...firstParserCoverage, filesIndexed: "one" }] }),
      (index) => ({ ...index, filesIndexed: "many" }),
      (index) => ({ ...index, filesSkipped: "none" }),
      (index) => ({ ...index, filesPartiallyIndexed: "none" }),
    ];

    for (const corrupt of corruptions) {
      if (cachePath === undefined || validEnvelope.schemaVersion === undefined) {
        throw new Error("expected persistent code-intelligence cache path");
      }
      files[cachePath] = JSON.stringify({
        schemaVersion: validEnvelope.schemaVersion,
        fingerprint: validEnvelope.fingerprint,
        index: corrupt(validIndex),
      });
      const recovered = buildCodeIntelligenceIndex(scope, DEFAULT_SEARCH_LIMITS, persistentMemFs(files));
      expect(recovered.imports).toEqual(first.imports);
    }
  });
});

describe("lookupCodeIntelligenceAtoms", () => {
  it("honors query limits and expands graph neighbors from exact symbols", () => {
    const { scope, fs } = makeScope(enterpriseFixture());

    const atoms = lookupCodeIntelligenceAtoms(
      scope,
      exact("loadOrder", 4),
      { ...DEFAULT_SEARCH_LIMITS, maxMatchesReturned: 4 },
      fs,
      { disableCache: true, nowMs: FIXED_NOW },
    );

    expect(atoms).toHaveLength(4);
    expect(atoms[0]).toMatchObject({
      scopePath: "packages/api/src/orders.ts",
      provenance: expect.objectContaining({ tool: "code-intelligence-index" }),
    });
    expect(atoms.some((atom) => atom.edge?.kind === "call" || atom.edge?.kind === "reference")).toBe(
      true,
    );
  });
});
