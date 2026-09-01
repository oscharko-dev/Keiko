import { describe, expect, it } from "vitest";
import type { RetrievalQuery } from "@oscharko-dev/keiko-contracts/connected-context";
import { memFs } from "./_memfs.js";
import {
  buildCodeIntelligenceIndex,
  buildCodeIntelligenceIndexFromCandidates,
  controlledBuild,
  lookupCodeIntelligenceAtoms,
  openApiComponentSchemas,
  queryCodeIntelligenceIndex,
  type CodeIntelligenceIndex,
} from "./codeIntelligence.js";
import type { WorkspaceDescriptorUtf8Read, WorkspaceFs, WorkspaceStat } from "./fs.js";
import { DEFAULT_SEARCH_LIMITS, type SearchScope } from "./repoSearch.js";
import { gatherCandidates } from "./repoSearchScan.js";
import type { WorkspaceInfo, WorkspaceLanguage } from "./types.js";

const MEM_ROOT = "/ws";
const FIXED_NOW = (): number => 1_700_000_000_000;

function workspace(
  languages: readonly WorkspaceLanguage[] = [
    "typescript",
    "javascript",
    "java",
    "python",
    "go",
    "csharp",
    "graphql",
    "protobuf",
  ],
): WorkspaceInfo {
  return {
    root: MEM_ROOT,
    selectedRoot: MEM_ROOT,
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

// A WorkspaceFs that CAN persist, so a regressed index writer would leave a visible artifact in
// `files`. The index must stay in process only (issue #2670, AC6).
interface PersistenceCapableTestFs extends WorkspaceFs {
  readonly makeDir: () => void;
  readonly writeFileUtf8: (absolutePath: string, content: string) => void;
}

function persistentMemFs(files: Record<string, string>): PersistenceCapableTestFs {
  const base = memFs(MEM_ROOT, files);
  const relative = (absolutePath: string): string =>
    absolutePath === MEM_ROOT ? "" : absolutePath.slice(MEM_ROOT.length + 1);
  return {
    ...base,
    stat: (absolutePath): ReturnType<WorkspaceFs["stat"]> => {
      const stat = base.stat(absolutePath);
      return stat.isFile ? { ...stat, hardLinkCount: 1, mtimeMs: 1, ctimeMs: 1 } : stat;
    },
    makeDir: () => undefined,
    writeFileUtf8: (absolutePath: string, content: string): void => {
      files[relative(absolutePath)] = content;
    },
  };
}

// A same-descriptor read for fixtures that fabricate a `stat` identity disconnected from the
// underlying memFs content (e.g. a synthetic fileIdentity/timestamp for cache-key tests). memFs's
// own readFileUtf8SameDescriptor would reject that mismatch as "changed", so these fixtures build
// the WorkspaceDescriptorUtf8Read directly from the SAME fabricated stat instead of delegating.
function fabricatedDescriptorRead(
  rawText: string,
  stat: WorkspaceStat,
): WorkspaceDescriptorUtf8Read {
  return { rawText, sizeBytes: Buffer.byteLength(rawText, "utf8"), stat };
}

function hasResolvedApiContract(
  index: CodeIntelligenceIndex,
  clientMethod: string,
  clientPath: string,
  serverMethod: string,
  serverPath: string,
): boolean {
  return index.apiContracts.some(
    (contract) =>
      contract.confidence === "resolved" &&
      contract.client.method === clientMethod &&
      contract.client.path === clientPath &&
      contract.server.method === serverMethod &&
      contract.server.path === serverPath,
  );
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
    README: "not source\n",
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
        @RequestMapping(method = RequestMethod.GET)
        public SharedDto getRoot() { return null; }
        @RequestMapping()
        public SharedDto anyRoot() { return null; }
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
  it("does not start candidate discovery when its execution signal is already aborted", () => {
    const { scope, fs: base } = makeScope({
      "src/aborted.ts": "export const shouldNotBeDiscovered = true;",
    });
    const controller = new AbortController();
    controller.abort();
    let directoryReads = 0;
    const fs: WorkspaceFs = {
      ...base,
      readDir: (absolutePath) => {
        directoryReads += 1;
        return base.readDir(absolutePath);
      },
    };

    const index = buildCodeIntelligenceIndex(scope, DEFAULT_SEARCH_LIMITS, fs, {
      disableCache: true,
      signal: controller.signal,
    });

    expect(directoryReads).toBe(0);
    expect(index.filesIndexed).toBe(0);
    expect(index.candidateLimitReached).toBe(true);
  });

  it("bounds the explicit-scope outer loop at the candidate discovery ceiling", () => {
    const relativePaths = Array.from(
      { length: 26 },
      (_, index) => `src/file-${String(index).padStart(2, "0")}.ts`,
    );
    const { scope: baseScope, fs: base } = makeScope(
      Object.fromEntries(relativePaths.map((scopePath) => [scopePath, "export const value = 1;"])),
    );
    const scope = {
      ...baseScope,
      relativePaths,
    };
    const pathPastDiscoveryCeiling = `${MEM_ROOT}/${relativePaths.at(-1) ?? ""}`;
    let statCallsPastCeiling = 0;
    const fs: WorkspaceFs = {
      ...base,
      stat: (absolutePath) => {
        if (absolutePath === pathPastDiscoveryCeiling) statCallsPastCeiling += 1;
        return base.stat(absolutePath);
      },
    };

    const index = buildCodeIntelligenceIndex(
      scope,
      { ...DEFAULT_SEARCH_LIMITS, maxFilesScanned: 1 },
      fs,
      { disableCache: true },
    );

    expect(statCallsPastCeiling).toBe(0);
    expect(index.filesIndexed).toBe(1);
    expect(index.candidateLimitReached).toBe(true);
  });

  it("reserves resolver metadata inside the structural file ceiling", () => {
    const files = {
      "src/consumer.ts": `
        import { aliasTarget } from "@lib/target";
        import { packageTarget } from "@demo/lib";
        export const combined = aliasTarget + packageTarget;
      `,
      "src/lib/target.ts": "export const aliasTarget = 1;",
      "packages/lib/src/index.ts": "export const packageTarget = 2;",
      "cmd/main.go": `
        package main
        import "example.com/root/pkg"
        func Run() int { return pkg.Target() }
      `,
      "pkg/target.go": "package pkg\nfunc Target() int { return 3 }\n",
      "src/decoy-a.ts": "export const decoyA = true;",
      "src/decoy-b.ts": "export const decoyB = true;",
      "src/decoy-c.ts": "export const decoyC = true;",
      "src/decoy-d.ts": "export const decoyD = true;",
      "tsconfig.json": JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "@lib/*": ["src/lib/*"] } },
      }),
      "package.json": JSON.stringify({
        name: "@demo/root",
        dependencies: { "@demo/lib": "1.0.0" },
      }),
      "packages/lib/package.json": JSON.stringify({
        name: "@demo/lib",
        main: "./src/index.ts",
      }),
      "go.mod": "module example.com/root\n",
    };
    const { scope, fs } = makeScope(files);
    const discovered = gatherCandidates(scope, DEFAULT_SEARCH_LIMITS, fs);
    const sourcePaths = [
      "src/consumer.ts",
      "src/lib/target.ts",
      "packages/lib/src/index.ts",
      "cmd/main.go",
      "pkg/target.go",
      "src/decoy-a.ts",
      "src/decoy-b.ts",
      "src/decoy-c.ts",
      "src/decoy-d.ts",
    ];
    const metadataPaths = ["tsconfig.json", "package.json", "packages/lib/package.json", "go.mod"];
    const candidates = {
      ...discovered,
      files: [...sourcePaths, ...metadataPaths].map((scopePath) => {
        const file = discovered.files.find((candidate) => candidate.relativePath === scopePath);
        if (file === undefined) throw new TypeError(`missing test candidate: ${scopePath}`);
        return file;
      }),
    };
    const limits = { ...DEFAULT_SEARCH_LIMITS, maxFilesScanned: 9 };

    const index = buildCodeIntelligenceIndexFromCandidates(scope, limits, fs, candidates, {
      disableCache: true,
    });

    expect(index.filesIndexed).toBe(5);
    expect(index.candidateLimitReached).toBe(true);
    expect(index.imports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          importerPath: "src/consumer.ts",
          specifier: "@lib/target",
          targetPath: "src/lib/target.ts",
          confidence: "resolved",
        }),
        expect.objectContaining({
          importerPath: "src/consumer.ts",
          specifier: "@demo/lib",
          targetPath: "packages/lib/src/index.ts",
          confidence: "resolved",
        }),
        expect.objectContaining({
          importerPath: "cmd/main.go",
          specifier: "example.com/root/pkg",
          targetPath: "pkg/target.go",
          confidence: "resolved",
        }),
      ]),
    );
    expect(index.packageDependencies).toContainEqual(
      expect.objectContaining({
        sourcePackage: "@demo/root",
        targetPackage: "@demo/lib",
        dependencyKind: "dependencies",
      }),
    );
  });

  it("prioritizes selected-source resolver metadata over unrelated manifests", () => {
    const files = {
      "apps/api/src/consumer.ts": 'import { target } from "@local/service";',
      "apps/api/src/target.ts": "export const target = 1;",
      "decoys/a/package.json": JSON.stringify({ name: "@decoy/a" }),
      "decoys/b/package.json": JSON.stringify({ name: "@decoy/b" }),
      "decoys/c/package.json": JSON.stringify({ name: "@decoy/c" }),
      "apps/api/tsconfig.json": JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "@local/service": ["src/target"] } },
      }),
    };
    const { scope, fs } = makeScope(files);
    const discovered = gatherCandidates(scope, DEFAULT_SEARCH_LIMITS, fs);
    const orderedPaths = [
      "apps/api/src/consumer.ts",
      "apps/api/src/target.ts",
      "decoys/a/package.json",
      "decoys/b/package.json",
      "decoys/c/package.json",
      "apps/api/tsconfig.json",
    ];
    const candidates = {
      ...discovered,
      files: orderedPaths.map((scopePath) => {
        const file = discovered.files.find((candidate) => candidate.relativePath === scopePath);
        if (file === undefined) throw new TypeError(`missing test candidate: ${scopePath}`);
        return file;
      }),
    };

    const index = buildCodeIntelligenceIndexFromCandidates(
      scope,
      { ...DEFAULT_SEARCH_LIMITS, maxFilesScanned: 3 },
      fs,
      candidates,
      { disableCache: true },
    );

    expect(index.filesIndexed).toBe(2);
    expect(index.candidateLimitReached).toBe(true);
    expect(index.imports).toContainEqual(
      expect.objectContaining({
        importerPath: "apps/api/src/consumer.ts",
        specifier: "@local/service",
        targetPath: "apps/api/src/target.ts",
        confidence: "resolved",
      }),
    );
  });

  it("returns unused metadata capacity to sources on cold and warm builds", () => {
    const sourcePaths = Array.from({ length: 6 }, (_, index) => `src/source-${String(index)}.ts`);
    const decoyPaths = Array.from(
      { length: 8 },
      (_, index) => `decoys/package-${String(index)}/package.json`,
    );
    const files = {
      ...Object.fromEntries(
        sourcePaths.map((scopePath, index) => [
          scopePath,
          `export const value${String(index)} = ${String(index)};`,
        ]),
      ),
      "tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: "." } }),
      ...Object.fromEntries(
        decoyPaths.map((scopePath, index) => [
          scopePath,
          JSON.stringify({ name: `@decoy/package-${String(index)}` }),
        ]),
      ),
    };
    const { scope, fs: base } = makeScope(files);
    const discovered = gatherCandidates(scope, DEFAULT_SEARCH_LIMITS, base);
    const orderedPaths = [...sourcePaths, ...decoyPaths, "tsconfig.json"];
    const candidates = {
      ...discovered,
      files: orderedPaths.map((scopePath) => {
        const file = discovered.files.find((candidate) => candidate.relativePath === scopePath);
        if (file === undefined) throw new TypeError(`missing test candidate: ${scopePath}`);
        return file;
      }),
    };
    let fileReads = 0;
    const fs: WorkspaceFs = {
      ...base,
      // readWorkspaceFile's only read primitive is readFileUtf8SameDescriptor (the unbounded
      // readFileUtf8 fallback was removed), so the counter below has to wrap it instead.
      readFileUtf8SameDescriptor: (
        absolutePath,
        maxBytes,
        hardLinkPolicy,
        expected,
      ): WorkspaceDescriptorUtf8Read => {
        fileReads += 1;
        if (base.readFileUtf8SameDescriptor === undefined) {
          throw new Error("test fixture requires memFs's readFileUtf8SameDescriptor");
        }
        return base.readFileUtf8SameDescriptor(absolutePath, maxBytes, hardLinkPolicy, expected);
      },
    };
    const limits = { ...DEFAULT_SEARCH_LIMITS, maxFilesScanned: 6 };

    const cold = buildCodeIntelligenceIndexFromCandidates(scope, limits, fs, candidates);
    const readsAfterColdBuild = fileReads;
    const warm = buildCodeIntelligenceIndexFromCandidates(scope, limits, fs, candidates);

    expect(cold.filesIndexed).toBe(5);
    expect(cold.symbols).toContainEqual(expect.objectContaining({ name: "value4" }));
    expect(cold.symbols).not.toContainEqual(expect.objectContaining({ name: "value5" }));
    expect(readsAfterColdBuild).toBeGreaterThan(0);
    expect(fileReads).toBe(readsAfterColdBuild);
    expect(warm).toEqual(cold);
  });

  it("discards link output completed after the execution deadline and reports truncation", () => {
    let now = 0;
    const executionControl = {
      deadlineAtMs: 1,
      nowMs: (): number => now,
    };
    const state = { truncated: false };

    const linked = controlledBuild(
      executionControl,
      state,
      [] as readonly string[],
      (): readonly string[] => {
        now = executionControl.deadlineAtMs;
        return ["late-api-contract"];
      },
    );

    expect(linked).toEqual([]);
    expect(state.truncated).toBe(true);
  });

  it("indexes polyglot imports, symbols, endpoints, DTOs, packages, and graph atoms", () => {
    const { scope, fs } = makeScope(enterpriseFixture());

    const index = buildCodeIntelligenceIndex(scope, DEFAULT_SEARCH_LIMITS, fs, {
      disableCache: true,
      nowMs: FIXED_NOW,
    });

    expect(index.filesIndexed).toBeGreaterThan(15);
    expect(index.filesSkipped).toBe(0);
    const parserCoverage = new Map(
      index.parserCoverage.map((entry) => [entry.parser, entry.filesIndexed]),
    );
    expect(parserCoverage.get("polyglot-regex")).toBeGreaterThan(0);
    expect(parserCoverage.get("typescript-compiler-ast")).toBeGreaterThan(0);
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
      sorted(
        index.endpoints.map((endpoint) => `${endpoint.role}:${endpoint.method}:${endpoint.path}`),
      ),
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
    expect(
      hasResolvedApiContract(index, "GET", "/api/orders/:param", "GET", "/api/orders/:param"),
    ).toBe(true);
    expect(hasResolvedApiContract(index, "POST", "/api/orders", "POST", "/api/orders")).toBe(true);
    expect(
      hasResolvedApiContract(
        index,
        "RPC",
        "/protobuf/orderservice/getorder",
        "RPC",
        "/protobuf/orderservice/getorder",
      ),
    ).toBe(true);
    expect(
      index.dtoContracts.some(
        (contract) =>
          contract.confidence === "resolved" &&
          contract.source.scopePath === "packages/domain/src/order.ts" &&
          contract.target.scopePath === "src/main/java/com/acme/domain/OrderDto.java" &&
          contract.sharedFields.join(",") === "orderId,status,totalAmount",
      ),
    ).toBe(true);

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
    expect(index.filesSkipped).toBe(2);
    expect(index.candidateLimitReached).toBe(false);
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
        }),
        expect.objectContaining({ name: "GoEdge" }),
        expect.objectContaining({
          name: "EdgeOpenApiDto",
          fields: ["id", "label"],
        }),
      ]),
    );
    const sharedDto = index.symbols.find(
      (symbol) =>
        symbol.name === "SharedDto" &&
        symbol.scopePath === "src/main/java/com/edge/shared/SharedDto.java",
    );
    expect(sharedDto?.fields).toEqual(expect.arrayContaining(["wire_id", "label"]));
    const goEdge = index.symbols.find((symbol) => symbol.name === "GoEdge");
    expect(goEdge?.fields).toEqual(expect.arrayContaining(["wire_id", "Ignored", "Label"]));
    expect(
      sorted(
        index.endpoints.map((endpoint) => `${endpoint.role}:${endpoint.method}:${endpoint.path}`),
      ),
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
        expect.objectContaining({ path: "/java", method: "GET" }),
        expect.objectContaining({ path: "/java", method: "ANY" }),
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
    expect(
      index.apiContracts.some(
        (contract) =>
          contract.confidence === "heuristic" &&
          contract.client.method === "ANY" &&
          contract.client.path === "/rtk-default" &&
          contract.server.method === "POST" &&
          contract.server.path === "/rtk-default",
      ),
    ).toBe(true);
    expect(
      index.dtoContracts.some(
        (contract) =>
          contract.confidence === "heuristic" &&
          contract.target.name === "SharedDto" &&
          contract.sharedFields.includes("wire_id") &&
          contract.sharedFields.includes("Label"),
      ),
    ).toBe(true);

    const exactImportAtoms = queryCodeIntelligenceIndex(
      scope,
      {
        kind: "exact-symbol",
        text: "@exact/shared",
        caseSensitive: true,
        maxResults: 20,
        emittedAtMs: 0,
      },
      index,
      FIXED_NOW(),
    );
    expect(
      exactImportAtoms.some(
        (atom) =>
          atom.score === 1 && atom.edge?.kind === "import" && atom.edge.label === "@exact/shared",
      ),
    ).toBe(true);

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
      {
        kind: "exact-symbol",
        text: "ExactDto",
        caseSensitive: true,
        maxResults: 3,
        emittedAtMs: 0,
      },
      { ...DEFAULT_SEARCH_LIMITS, maxMatchesReturned: 3 },
      fs,
      { disableCache: true },
    );
    expect(lookedUp).toHaveLength(3);
  });

  // Replaces the former persistent-cache pin: the disk tier is gone (issue #2670, AC6), so the
  // memory tier is the whole cache and a writable WorkspaceFs must stay untouched by indexing.
  it("caches in process only and leaves no artifact on a writable workspace fs", () => {
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
    expect(Object.keys(files).filter((path) => path.startsWith(".keiko/"))).toEqual([]);

    // A distinct WorkspaceFs identity misses the in-process cache and rebuilds from source instead
    // of adopting anything on disk.
    const secondFs = persistentMemFs(files);
    const rebuilt = buildCodeIntelligenceIndex(scope, DEFAULT_SEARCH_LIMITS, secondFs);
    expect(rebuilt).not.toBe(first);
    expect(rebuilt.imports).toEqual(first.imports);

    // A plaintext artifact left by an older version is neither consulted nor rewritten.
    const stale = JSON.stringify({ schemaVersion: 13, fingerprint: "stale", index: null });
    files[".keiko/code-intelligence/stale.json"] = stale;
    const afterStale = buildCodeIntelligenceIndex(
      scope,
      DEFAULT_SEARCH_LIMITS,
      persistentMemFs(files),
    );
    expect(afterStale.imports).toEqual(first.imports);
    expect(Object.keys(files).filter((path) => path.startsWith(".keiko/"))).toEqual([
      ".keiko/code-intelligence/stale.json",
    ]);
    expect(files[".keiko/code-intelligence/stale.json"]).toBe(stale);
  });

  it("invalidates a cache key when only high-resolution timestamps change", () => {
    const files = { "src/mutable.ts": "export const alpha = 1;" };
    const scope: SearchScope = {
      workspace: workspace(),
      scopeId: "scope-high-resolution-cache",
      relativePaths: [],
    };
    const base = persistentMemFs(files);
    let timestampNs = "1000000";
    const statOverride = (absolutePath: string): WorkspaceStat => {
      const stat = base.stat(absolutePath);
      return stat.isFile
        ? {
            ...stat,
            fileIdentity: "1:1",
            mtimeMs: 1,
            ctimeMs: 1,
            mtimeNs: timestampNs,
            ctimeNs: timestampNs,
          }
        : stat;
    };
    const fs: WorkspaceFs = {
      ...base,
      stat: statOverride,
      // The fabricated fileIdentity above is deliberately disconnected from memFs's own
      // content-hash identity, which readFileUtf8SameDescriptor's expected-stat check would
      // otherwise reject as "changed" on every read — build the descriptor from the caller's
      // already-captured `expected` stat instead of delegating to memFs's real same-descriptor
      // read (mirrors the removed unbounded fallback, which echoed the same captured stat back).
      readFileUtf8SameDescriptor: (absolutePath, _maxBytes, _hardLinkPolicy, expected) =>
        fabricatedDescriptorRead(base.readFileUtf8(absolutePath), expected),
    };
    const candidates = gatherCandidates(scope, DEFAULT_SEARCH_LIMITS, fs);
    const first = buildCodeIntelligenceIndexFromCandidates(
      scope,
      DEFAULT_SEARCH_LIMITS,
      fs,
      candidates,
    );

    files["src/mutable.ts"] = "export const bravo = 1;";
    timestampNs = "1000001";
    const changed = buildCodeIntelligenceIndexFromCandidates(
      scope,
      DEFAULT_SEARCH_LIMITS,
      fs,
      candidates,
    );

    expect(changed).not.toBe(first);
    expect(changed.symbols.some((symbol) => symbol.name === "bravo")).toBe(true);
  });

  it("invalidates a cache key when file identity changes with stable timestamps", () => {
    const files = { "src/replaced.ts": "export const alpha = 1;" };
    const scope: SearchScope = {
      workspace: workspace(),
      scopeId: "scope-file-identity-cache",
      relativePaths: [],
    };
    const base = persistentMemFs(files);
    let fileIdentity = "1:1";
    const statOverride = (absolutePath: string): WorkspaceStat => {
      const stat = base.stat(absolutePath);
      return stat.isFile
        ? {
            ...stat,
            fileIdentity,
            mtimeMs: 1,
            ctimeMs: 1,
            mtimeNs: "1000000",
            ctimeNs: "1000000",
          }
        : stat;
    };
    const fs: WorkspaceFs = {
      ...base,
      stat: statOverride,
      // The fabricated fileIdentity above is deliberately disconnected from memFs's own
      // content-hash identity, which readFileUtf8SameDescriptor's expected-stat check would
      // otherwise reject as "changed" on every read — build the descriptor from the caller's
      // already-captured `expected` stat instead of delegating to memFs's real same-descriptor
      // read (mirrors the removed unbounded fallback, which echoed the same captured stat back).
      readFileUtf8SameDescriptor: (absolutePath, _maxBytes, _hardLinkPolicy, expected) =>
        fabricatedDescriptorRead(base.readFileUtf8(absolutePath), expected),
    };
    const candidates = gatherCandidates(scope, DEFAULT_SEARCH_LIMITS, fs);
    const first = buildCodeIntelligenceIndexFromCandidates(
      scope,
      DEFAULT_SEARCH_LIMITS,
      fs,
      candidates,
    );

    files["src/replaced.ts"] = "export const bravo = 1;";
    fileIdentity = "1:2";
    const replaced = buildCodeIntelligenceIndexFromCandidates(
      scope,
      DEFAULT_SEARCH_LIMITS,
      fs,
      candidates,
    );

    expect(replaced).not.toBe(first);
    expect(replaced.symbols.some((symbol) => symbol.name === "bravo")).toBe(true);
  });

  it("revalidates a cache hit after its initial fingerprint", () => {
    const files = { "src/racy.ts": "export const alpha = 1;" };
    const scope: SearchScope = {
      workspace: workspace(),
      scopeId: "scope-cache-hit-race",
      relativePaths: [],
    };
    const base = persistentMemFs(files);
    let timestamp = 1;
    let mutateAfterStat = false;
    const fs: WorkspaceFs = {
      ...base,
      stat: (absolutePath) => {
        const stat = base.stat(absolutePath);
        const snapshot = stat.isFile
          ? { ...stat, hardLinkCount: 1, mtimeMs: timestamp, ctimeMs: timestamp }
          : stat;
        if (mutateAfterStat && absolutePath.endsWith("/src/racy.ts")) {
          mutateAfterStat = false;
          files["src/racy.ts"] = "export const bravo = 1;";
          timestamp = 2;
        }
        return snapshot;
      },
    };
    const candidates = gatherCandidates(scope, DEFAULT_SEARCH_LIMITS, fs);
    const first = buildCodeIntelligenceIndexFromCandidates(
      scope,
      DEFAULT_SEARCH_LIMITS,
      fs,
      candidates,
    );
    mutateAfterStat = true;

    const rebuilt = buildCodeIntelligenceIndexFromCandidates(
      scope,
      DEFAULT_SEARCH_LIMITS,
      fs,
      candidates,
    );

    expect(rebuilt).not.toBe(first);
    expect(rebuilt.symbols.some((symbol) => symbol.name === "bravo")).toBe(true);
  });

  it("does not store an index when the post-build fingerprint changed", () => {
    const files = { "src/post-build.ts": "export const alpha = 1;" };
    const scope: SearchScope = {
      workspace: workspace(),
      scopeId: "scope-post-build-cache-race",
      relativePaths: [],
    };
    const base = persistentMemFs(files);
    let timestamp = 1;
    let sourceStatCalls = 0;
    let mutationStatCall = 4;
    const fs: WorkspaceFs = {
      ...base,
      stat: (absolutePath) => {
        if (absolutePath.endsWith("/src/post-build.ts")) {
          sourceStatCalls += 1;
          if (sourceStatCalls === mutationStatCall) {
            files["src/post-build.ts"] = "export const bravo = 1;";
            timestamp = 2;
          }
        }
        const stat = base.stat(absolutePath);
        return stat.isFile
          ? {
              ...stat,
              hardLinkCount: 1,
              fileIdentity: "1:1",
              mtimeMs: timestamp,
              ctimeMs: timestamp,
              mtimeNs: `${String(timestamp)}000000`,
              ctimeNs: `${String(timestamp)}000000`,
            }
          : stat;
      },
      // The fabricated fileIdentity above is deliberately disconnected from memFs's own
      // content-hash identity, which readFileUtf8SameDescriptor's expected-stat check would
      // otherwise reject as "changed" on every read. Echo the caller's already-captured
      // `expected` stat back verbatim (mirrors the removed unbounded fallback's `stat:
      // target.stat`) rather than calling `stat()` again, which would perturb sourceStatCalls'
      // carefully staged count above.
      readFileUtf8SameDescriptor: (absolutePath, _maxBytes, _hardLinkPolicy, expected) =>
        fabricatedDescriptorRead(base.readFileUtf8(absolutePath), expected),
    };
    const candidates = gatherCandidates(scope, DEFAULT_SEARCH_LIMITS, fs);
    sourceStatCalls = 0;
    const raced = buildCodeIntelligenceIndexFromCandidates(
      scope,
      DEFAULT_SEARCH_LIMITS,
      fs,
      candidates,
    );
    expect(raced.symbols.some((symbol) => symbol.name === "alpha")).toBe(true);

    timestamp = 1;
    sourceStatCalls = 0;
    mutationStatCall = Number.POSITIVE_INFINITY;
    const rebuilt = buildCodeIntelligenceIndexFromCandidates(
      scope,
      DEFAULT_SEARCH_LIMITS,
      fs,
      candidates,
    );

    expect(rebuilt).not.toBe(raced);
    expect(rebuilt.symbols.some((symbol) => symbol.name === "bravo")).toBe(true);
  });

  it("does not stat a discovered file after it is swapped to an out-of-root symlink", () => {
    const scope: SearchScope = {
      workspace: workspace(),
      scopeId: "scope-1",
      relativePaths: [],
    };
    const base = memFs(MEM_ROOT, {
      "src/swappable.ts": "export function Swappable(): string { return 'safe'; }",
    });
    const swappablePath = `${MEM_ROOT}/src/swappable.ts`;
    let escaped = false;
    let unsafeStatCalls = 0;
    const fs: WorkspaceFs = {
      ...base,
      realPath: (absolutePath: string): string =>
        escaped && absolutePath === swappablePath
          ? "/outside/swappable.ts"
          : base.realPath(absolutePath),
      stat: (absolutePath: string): ReturnType<WorkspaceFs["stat"]> => {
        if (
          escaped &&
          (absolutePath === swappablePath || absolutePath === "/outside/swappable.ts")
        ) {
          unsafeStatCalls += 1;
        }
        return base.stat(absolutePath);
      },
    };
    const candidates = gatherCandidates(scope, DEFAULT_SEARCH_LIMITS, fs);
    const first = buildCodeIntelligenceIndexFromCandidates(
      scope,
      DEFAULT_SEARCH_LIMITS,
      fs,
      candidates,
    );
    expect(first.symbols.some((symbol) => symbol.name === "Swappable")).toBe(true);

    const unsafeStatCallsBeforeSwap = unsafeStatCalls;
    escaped = true;
    const inaccessible = buildCodeIntelligenceIndexFromCandidates(
      scope,
      DEFAULT_SEARCH_LIMITS,
      fs,
      candidates,
    );

    expect(inaccessible).not.toBe(first);
    expect(inaccessible.filesIndexed).toBe(0);
    expect(inaccessible.symbols.some((symbol) => symbol.name === "Swappable")).toBe(false);
    expect(unsafeStatCalls).toBe(unsafeStatCallsBeforeSwap);

    const rebuiltInaccessible = buildCodeIntelligenceIndexFromCandidates(
      scope,
      DEFAULT_SEARCH_LIMITS,
      fs,
      candidates,
    );
    expect(rebuiltInaccessible).not.toBe(inaccessible);
    expect(unsafeStatCalls).toBe(unsafeStatCallsBeforeSwap);
  });

  it("does not reuse a cached index after a candidate becomes a hard-link alias", () => {
    const searchScope: SearchScope = {
      workspace: workspace(),
      scopeId: "scope-hard-link-cache",
      relativePaths: [],
    };
    const base = memFs(MEM_ROOT, {
      "src/hard.ts": "export const hardLinked = 1;",
    });
    let hardLinkCount = 1;
    const fs: WorkspaceFs = {
      ...base,
      stat: (absolutePath): ReturnType<WorkspaceFs["stat"]> => {
        const stat = base.stat(absolutePath);
        return stat.isFile ? { ...stat, hardLinkCount, mtimeMs: 1, ctimeMs: 1 } : stat;
      },
    };
    const candidates = gatherCandidates(searchScope, DEFAULT_SEARCH_LIMITS, fs);
    const first = buildCodeIntelligenceIndexFromCandidates(
      searchScope,
      DEFAULT_SEARCH_LIMITS,
      fs,
      candidates,
    );
    expect(first.symbols.some((symbol) => symbol.name === "hardLinked")).toBe(true);

    hardLinkCount = 2;
    const rejected = buildCodeIntelligenceIndexFromCandidates(
      searchScope,
      DEFAULT_SEARCH_LIMITS,
      fs,
      candidates,
    );
    expect(rejected).not.toBe(first);
    expect(rejected.symbols.some((symbol) => symbol.name === "hardLinked")).toBe(false);
    expect(rejected.filesSkipped).toBe(1);
  });

  it("does not reuse a cached index after a symlinked workspace root is retargeted", () => {
    const files: Record<string, string> = {
      "src/retargeted.ts": "export const alpha = 1;",
    };
    const searchScope: SearchScope = {
      workspace: workspace(),
      scopeId: "scope-retargeted-root-cache",
      relativePaths: [],
    };
    const base = memFs(MEM_ROOT, files);
    let target = "a";
    const lexicalPath = (absolutePath: string): string =>
      absolutePath.replace(/^\/real\/[ab](?=\/|$)/u, MEM_ROOT);
    const fs: WorkspaceFs = {
      ...base,
      // The untranslated resolvedPath discovery.ts passes to readFileUtf8SameDescriptor would miss
      // in `base`'s own MEM_ROOT-keyed file map, since that lane isn't retargeted the way the other
      // overrides here already are — translate it through the SAME lexicalPath before delegating.
      readFileUtf8SameDescriptor: (absolutePath, maxBytes, hardLinkPolicy, expected) => {
        if (base.readFileUtf8SameDescriptor === undefined) {
          throw new Error("test fixture requires memFs's readFileUtf8SameDescriptor");
        }
        return base.readFileUtf8SameDescriptor(
          lexicalPath(absolutePath),
          maxBytes,
          hardLinkPolicy,
          expected,
        );
      },
      realPath: (absolutePath): string => {
        if (absolutePath === MEM_ROOT || absolutePath.startsWith(`${MEM_ROOT}/`)) {
          return absolutePath.replace(MEM_ROOT, `/real/${target}`);
        }
        return absolutePath;
      },
      stat: (absolutePath): ReturnType<WorkspaceFs["stat"]> => {
        const stat = base.stat(lexicalPath(absolutePath));
        return stat.isFile ? { ...stat, hardLinkCount: 1, mtimeMs: 1, ctimeMs: 1 } : stat;
      },
      readDir: (absolutePath): ReturnType<WorkspaceFs["readDir"]> =>
        base.readDir(lexicalPath(absolutePath)),
      readFileUtf8: (absolutePath): string => base.readFileUtf8(lexicalPath(absolutePath)),
      readFileUtf8Prefix: (absolutePath, maxBytes, hardLinkPolicy, expected): string =>
        base.readFileUtf8Prefix?.(lexicalPath(absolutePath), maxBytes, hardLinkPolicy, expected) ??
        "",
      exists: (absolutePath): boolean => base.exists(lexicalPath(absolutePath)),
    };
    const candidates = gatherCandidates(searchScope, DEFAULT_SEARCH_LIMITS, fs);
    const first = buildCodeIntelligenceIndexFromCandidates(
      searchScope,
      DEFAULT_SEARCH_LIMITS,
      fs,
      candidates,
    );
    expect(first.symbols.some((symbol) => symbol.name === "alpha")).toBe(true);

    target = "b";
    files["src/retargeted.ts"] = "export const bravo = 1;";
    const retargeted = buildCodeIntelligenceIndexFromCandidates(
      searchScope,
      DEFAULT_SEARCH_LIMITS,
      fs,
      candidates,
    );

    expect(retargeted).not.toBe(first);
    expect(retargeted.symbols.some((symbol) => symbol.name === "bravo")).toBe(true);
    expect(retargeted.symbols.some((symbol) => symbol.name === "alpha")).toBe(false);
  });

  it("skips files instead of an unbounded read when the filesystem cannot provide mutation timestamps", () => {
    // A WorkspaceFs unable to report stable mutation timestamps is, by construction, unable to
    // supply readFileUtf8SameDescriptor either — a real port in that position would not implement
    // the same-descriptor lane. The removed unbounded readFileUtf8 fallback used to let such a
    // port keep reading (while only caching was bypassed); the port boundary now fails closed:
    // metadata unavailable means read unavailable, so the file is skipped, never silently indexed
    // through an unbounded read.
    const files = { "src/mutable.ts": "export const first = 1;" };
    const searchScope: SearchScope = {
      workspace: workspace(),
      scopeId: "scope-no-timestamps",
      relativePaths: [],
    };
    const base = memFs(MEM_ROOT, files);
    // Omit (never assign undefined to, under exactOptionalPropertyTypes) readFileUtf8SameDescriptor
    // so this port matches one genuinely unable to supply it.
    const { readFileUtf8SameDescriptor: removedSameDescriptor, ...baseWithoutSameDescriptor } =
      base;
    if (removedSameDescriptor === undefined) {
      throw new Error("memFs always provides readFileUtf8SameDescriptor");
    }
    const fs: WorkspaceFs = {
      ...baseWithoutSameDescriptor,
      stat: (absolutePath) => {
        const stat = base.stat(absolutePath);
        if (!stat.isFile) return stat;
        return {
          ...stat,
          fileIdentity: undefined,
          mtimeNs: undefined,
          ctimeNs: undefined,
        };
      },
    };
    const candidates = gatherCandidates(searchScope, DEFAULT_SEARCH_LIMITS, fs);
    const result = buildCodeIntelligenceIndexFromCandidates(
      searchScope,
      DEFAULT_SEARCH_LIMITS,
      fs,
      candidates,
    );

    expect(result.filesSkipped).toBe(1);
    expect(result.symbols.some((symbol) => symbol.name === "first")).toBe(false);
  });

  it("does not cache a partial index after a transient source read failure", () => {
    const files = { "src/transient.ts": "export const recovered = 1;" };
    const searchScope: SearchScope = {
      workspace: workspace(),
      scopeId: "scope-transient-read",
      relativePaths: [],
    };
    const base = persistentMemFs(files);
    let failNextRead = true;
    const fs: WorkspaceFs = {
      ...base,
      // readWorkspaceFile's only read primitive is readFileUtf8SameDescriptor (the unbounded
      // readFileUtf8 fallback was removed), so the transient-failure injection has to live there.
      readFileUtf8SameDescriptor: (absolutePath, maxBytes, hardLinkPolicy, expected) => {
        if (failNextRead && absolutePath.endsWith("/src/transient.ts")) {
          failNextRead = false;
          throw new Error("EIO");
        }
        if (base.readFileUtf8SameDescriptor === undefined) {
          throw new Error("test fixture requires memFs's readFileUtf8SameDescriptor");
        }
        return base.readFileUtf8SameDescriptor(absolutePath, maxBytes, hardLinkPolicy, expected);
      },
    };
    const candidates = gatherCandidates(searchScope, DEFAULT_SEARCH_LIMITS, fs);
    const partial = buildCodeIntelligenceIndexFromCandidates(
      searchScope,
      DEFAULT_SEARCH_LIMITS,
      fs,
      candidates,
    );
    const recovered = buildCodeIntelligenceIndexFromCandidates(
      searchScope,
      DEFAULT_SEARCH_LIMITS,
      fs,
      candidates,
    );

    expect(partial.filesSkipped).toBe(1);
    expect(recovered).not.toBe(partial);
    expect(recovered.symbols.some((symbol) => symbol.name === "recovered")).toBe(true);
  });

  it("keeps candidate truncation in the cache identity", () => {
    const files: Record<string, string> = { "src/a.ts": "export const a = 1;" };
    const searchScope: SearchScope = {
      workspace: workspace(),
      scopeId: "scope-cache-truncation",
      relativePaths: [],
    };
    const fs = persistentMemFs(files);
    const capped = { ...DEFAULT_SEARCH_LIMITS, maxFilesScanned: 1 };
    const complete = buildCodeIntelligenceIndexFromCandidates(
      searchScope,
      capped,
      fs,
      gatherCandidates(searchScope, capped, fs),
    );
    expect(complete.candidateLimitReached).toBe(false);

    files["src/z.ts"] = "export const z = 1;";
    const truncated = buildCodeIntelligenceIndexFromCandidates(
      searchScope,
      capped,
      fs,
      gatherCandidates(searchScope, capped, fs),
    );

    expect(truncated).not.toBe(complete);
    expect(truncated.candidateLimitReached).toBe(true);
  });
});

describe("openApiComponentSchemas", () => {
  it("returns undefined when the parsed document is not an object (e.g. a JSON array)", () => {
    expect(openApiComponentSchemas(["not", "an", "object"])).toBeUndefined();
  });

  it("returns undefined when the document has no components object", () => {
    expect(openApiComponentSchemas({ paths: {} })).toBeUndefined();
  });

  it("returns the components.schemas value when present", () => {
    const schemas = { WidgetDto: { type: "object", properties: {} } };
    expect(openApiComponentSchemas({ components: { schemas } })).toBe(schemas);
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
    });
    expect(atoms[0]?.provenance.tool).toBe("code-intelligence-index");
    expect(
      atoms.some((atom) => atom.edge?.kind === "call" || atom.edge?.kind === "reference"),
    ).toBe(true);
  });
});

// Regression coverage for SonarCloud S8786 (superlinear regex backtracking) remediation in
// codeIntelligence.ts. Each case feeds a large, adversarially-shaped input through the public
// buildCodeIntelligenceIndex entry point (the regexes involved are all private) and asserts the
// whole build stays well inside a wall-clock budget. Before the fix, the equivalent standalone
// regex on comparable input took from hundreds of milliseconds up to several seconds and kept
// growing quadratically with input size; a genuine reintroduction of that shape would blow well
// past any of the budgets below. 3s leaves large headroom over the fixed implementation's
// measured cost (tens of milliseconds) while decoupling the correctness assertions from
// CI-load-driven wall-clock noise (code review finding, PR #2471).
describe("regex superlinear-backtracking regressions (S8786)", () => {
  it("parses a go.mod module directive preceded by many blank lines without quadratic backtracking", () => {
    const manyBlankLines = "\n".repeat(40_000);
    const { scope, fs } = makeScope({
      "go.mod": `${manyBlankLines}module example.com/perf\n`,
      "service/handler.go": `
        package service
        import "example.com/perf/pkg/helper"
        func UseHelper() { helper.Do() }
      `,
      "pkg/helper/helper.go": `
        package helper
        func Do() {}
      `,
    });

    const startedAtMs = Date.now();
    const index = buildCodeIntelligenceIndex(scope, DEFAULT_SEARCH_LIMITS, fs, {
      disableCache: true,
      nowMs: FIXED_NOW,
    });
    expect(Date.now() - startedAtMs).toBeLessThan(3000);

    expect(
      index.imports.some(
        (edge) =>
          edge.importerPath === "service/handler.go" &&
          edge.targetPath === "pkg/helper/helper.go" &&
          edge.confidence === "resolved",
      ),
    ).toBe(true);
  });

  it("parses a long python import line and strips a trailing comment without quadratic backtracking", () => {
    const paddedTail = " ".repeat(20_000);
    const { scope, fs } = makeScope({
      "services/py/perfpkg/__init__.py": `
        def perf_helper():
          return 1
      `,
      "services/py/perf_consumer.py": `
        from services.py.perfpkg import perf_helper${paddedTail}
        perf_helper()
      `,
    });

    const startedAtMs = Date.now();
    const index = buildCodeIntelligenceIndex(scope, DEFAULT_SEARCH_LIMITS, fs, {
      disableCache: true,
      nowMs: FIXED_NOW,
    });
    expect(Date.now() - startedAtMs).toBeLessThan(3000);

    expect(
      index.imports.some(
        (edge) =>
          edge.importerPath === "services/py/perf_consumer.py" &&
          edge.specifier === "services.py.perfpkg" &&
          edge.targetPath === "services/py/perfpkg/__init__.py",
      ),
    ).toBe(true);
  });

  it("extracts DTO field names from adversarial C#-like declarations without quadratic backtracking", () => {
    const wideGap = " ".repeat(20_000);
    const longDefaultValue = `"${"=".repeat(20_000)},"`;
    const { scope, fs } = makeScope({
      "src/PerfDto.cs": `
        public record PerfRecord(string Label, string Text = ${longDefaultValue});
        public class PerfDto {
          public T${wideGap}BigProp { get; set; }
        }
      `,
    });

    const startedAtMs = Date.now();
    const index = buildCodeIntelligenceIndex(scope, DEFAULT_SEARCH_LIMITS, fs, {
      disableCache: true,
      nowMs: FIXED_NOW,
    });
    expect(Date.now() - startedAtMs).toBeLessThan(3000);

    const perfRecord = index.symbols.find((symbol) => symbol.name === "PerfRecord");
    expect(perfRecord?.fields).toEqual(expect.arrayContaining(["Label", "Text"]));
    const perfDto = index.symbols.find((symbol) => symbol.name === "PerfDto");
    expect(perfDto?.fields).toEqual(expect.arrayContaining(["BigProp"]));
  });

  it("normalizes route paths with unterminated bracket segments without quadratic backtracking", () => {
    const longSegment = "a".repeat(20_000);
    const { scope, fs } = makeScope({
      "src/perf/routes.ts": `
        import express from "express";
        const app = express();
        app.get("/perf/<${longSegment}", (_req, res) => res.json({ ok: true }));
      `,
    });

    const startedAtMs = Date.now();
    const index = buildCodeIntelligenceIndex(scope, DEFAULT_SEARCH_LIMITS, fs, {
      disableCache: true,
      nowMs: FIXED_NOW,
    });
    expect(Date.now() - startedAtMs).toBeLessThan(3000);

    expect(
      index.endpoints.some(
        (endpoint) => endpoint.scopePath === "src/perf/routes.ts" && endpoint.method === "GET",
      ),
    ).toBe(true);
  });

  it("parses GraphQL schema fields and operation text without quadratic backtracking", () => {
    const trailingFieldGap = " ".repeat(20_000);
    const trailingBlankRun = "\n ".repeat(10_000);
    const { scope, fs } = makeScope({
      "schema.graphql": `
        type Query {
          order(id: ID!): Order
          padding${trailingFieldGap}
        }
        ${trailingBlankRun}
      `,
    });

    const startedAtMs = Date.now();
    const index = buildCodeIntelligenceIndex(scope, DEFAULT_SEARCH_LIMITS, fs, {
      disableCache: true,
      nowMs: FIXED_NOW,
    });
    expect(Date.now() - startedAtMs).toBeLessThan(3000);

    expect(
      index.endpoints.some(
        (endpoint) => endpoint.scopePath === "schema.graphql" && endpoint.path.includes("order"),
      ),
    ).toBe(true);
  });
});

// Regression coverage for a second, adversarial-verifier-confirmed pass over the S8786 fixes
// above: each case reproduces the exact shape the verifier used to show that the *first* fix
// either changed accept/reject behavior for a realistic input, or silently dropped data, rather
// than actually removing the backtracking risk. Every test below fails against the previously
// committed (first-pass) bound/regex and passes against the corrected implementation.
describe("second-pass correctness regressions (verifier-confirmed)", () => {
  it("splits two GraphQL operations separated by a newline plus a long run of same-line whitespace instead of merging them", () => {
    // A single newline, then 250 non-newline whitespace characters - more than the 200-char
    // bound the first-pass fix put on the lookahead's `\s*`. Under that bound the lazy operation
    // body silently swallows the second operation, and its endpoint is lost.
    const wideGap = `\n${" ".repeat(250)}`;
    const graphqlOperations =
      'query EdgeLookup { edgeLookup(id: "1") { id } }' +
      wideGap +
      'mutation EdgeChange { edgeChange(id: "1") { id } }';
    const { scope, fs } = makeScope({
      "src/perf/edge-ops.ts": `
        const q = graphql\`${graphqlOperations}\`;
      `,
    });

    const index = buildCodeIntelligenceIndex(scope, DEFAULT_SEARCH_LIMITS, fs, {
      disableCache: true,
      nowMs: FIXED_NOW,
    });

    expect(
      sorted(
        index.endpoints.map((endpoint) => `${endpoint.role}:${endpoint.method}:${endpoint.path}`),
      ),
    ).toEqual(
      expect.arrayContaining([
        "client:QUERY:/graphql/query/edgeLookup",
        "client:MUTATION:/graphql/mutation/edgeChange",
      ]),
    );
  });

  it("resolves a go.mod module directive preceded by 65 same-line leading spaces", () => {
    // Same-line indentation, not blank lines: the multiline anchor cannot restart mid-line, so
    // this exercises the leading-`\s` bound directly rather than the (already-safe) blank-line
    // case covered above.
    const { scope, fs } = makeScope({
      "go.mod": `${" ".repeat(65)}module example.com/indented\n`,
      "service/handler.go": `
        package service
        import "example.com/indented/pkg/helper"
        func UseHelper() { helper.Do() }
      `,
      "pkg/helper/helper.go": `
        package helper
        func Do() {}
      `,
    });

    const index = buildCodeIntelligenceIndex(scope, DEFAULT_SEARCH_LIMITS, fs, {
      disableCache: true,
      nowMs: FIXED_NOW,
    });

    expect(
      index.imports.some(
        (edge) =>
          edge.importerPath === "service/handler.go" &&
          edge.targetPath === "pkg/helper/helper.go" &&
          edge.confidence === "resolved",
      ),
    ).toBe(true);
  });

  it("resolves a Python relative import with 60 leading dots", () => {
    // 60 exceeds the first-pass fix's 50-dot bound; `dirname` bottoms out at "." well before that
    // many levels, so the actual resolved directory is unaffected by the dot count once it
    // exceeds the real nesting depth. The import is aliased (`as helper`) so the call can only
    // resolve through the binding this regex produces, not through the separate
    // global-symbol-name fallback (which would also "succeed" - for the wrong reason - if the
    // callee were named `perf_dot_helper` directly, masking the very bug under test).
    const relativeSpecifier = `${".".repeat(60)}perfpkg`;
    const { scope, fs } = makeScope({
      "perfpkg/__init__.py": `
        def perf_dot_helper():
          return 1
      `,
      "services/py/perf_consumer.py": `
        from ${relativeSpecifier} import perf_dot_helper as helper
        def use():
          helper()
      `,
    });

    const index = buildCodeIntelligenceIndex(scope, DEFAULT_SEARCH_LIMITS, fs, {
      disableCache: true,
      nowMs: FIXED_NOW,
    });

    expect(index.calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          callerPath: "services/py/perf_consumer.py",
          calleeName: "helper",
          targetName: "perf_dot_helper",
          targetPath: "perfpkg/__init__.py",
          confidence: "resolved",
        }),
      ]),
    );
  });

  it("extracts a C#-like field name behind a 311-character type expression", () => {
    // A genuinely long *type* (not merely padding whitespace, which the mandatory unbounded
    // `\s+` already absorbs regardless of the bound) - past the first-pass fix's 300-char bound.
    const longType = `T${"Z".repeat(310)}`;
    const { scope, fs } = makeScope({
      "src/LongTypeDto.cs": `
        public class LongTypeDto {
          public ${longType} BigProp { get; set; }
        }
      `,
    });

    const index = buildCodeIntelligenceIndex(scope, DEFAULT_SEARCH_LIMITS, fs, {
      disableCache: true,
      nowMs: FIXED_NOW,
    });

    const dto = index.symbols.find((symbol) => symbol.name === "LongTypeDto");
    expect(dto?.fields).toEqual(expect.arrayContaining(["BigProp"]));
  });

  it("collapses closed <...> and {...} route segments of 210 characters instead of leaving them raw", () => {
    const longParam = "a".repeat(210);
    const { scope, fs } = makeScope({
      "src/routes/angle.ts": `
        import express from "express";
        const app = express();
        app.get("/perf/<${longParam}>/detail", (_req, res) => res.json({ ok: true }));
      `,
      "src/routes/brace.ts": `
        import express from "express";
        const app = express();
        app.get("/perf/{${longParam}}/detail", (_req, res) => res.json({ ok: true }));
      `,
    });

    const index = buildCodeIntelligenceIndex(scope, DEFAULT_SEARCH_LIMITS, fs, {
      disableCache: true,
      nowMs: FIXED_NOW,
    });

    const paths = index.endpoints.map((endpoint) => endpoint.path);
    expect(paths).toEqual(expect.arrayContaining(["/perf/:param/detail"]));
    expect(paths.some((path) => path.includes(longParam))).toBe(false);
  });
});
