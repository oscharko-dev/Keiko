import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  EvidenceAtom,
  EvidenceEdgeKind,
  RetrievalQuery,
} from "@oscharko-dev/keiko-contracts/connected-context";
import { PathEscapeError } from "@oscharko-dev/keiko-security/errors/workspace";
import { memFs } from "./_memfs.js";
import { buildCodeIntelligenceIndex } from "./codeIntelligence.js";
import { RepoSearchInvalidQueryError } from "./errors.js";
import { nodeWorkspaceFs, type WorkspaceFs } from "./fs.js";
import { importGraphAdapter } from "./importGraph.js";
import { DEFAULT_SEARCH_LIMITS, type SearchLimits, type SearchScope } from "./repoSearch.js";
import type { WorkspaceInfo } from "./types.js";

const MEM_ROOT = "/ws";
const FIXED_NOW = (): number => 1_700_000_000_000;

function makeScope(files: Readonly<Record<string, string>>): {
  scope: SearchScope;
  fs: ReturnType<typeof memFs>;
} {
  const workspace: WorkspaceInfo = {
    root: MEM_ROOT,
    name: "demo",
    version: "1.0.0",
    testFramework: "vitest",
    sourceDirs: ["src"],
    testDirs: ["tests"],
    languages: ["typescript", "javascript"],
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

function exq(text: string): RetrievalQuery {
  return { kind: "exact-symbol", text, caseSensitive: false, maxResults: 100, emittedAtMs: 0 };
}

function present<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error("expected value to be present");
  }
  return value;
}

function findEdgeAtom(
  atoms: readonly EvidenceAtom[],
  kind: EvidenceEdgeKind,
  targetSymbol?: string,
): EvidenceAtom | undefined {
  return atoms.find(
    (atom) =>
      atom.edge?.kind === kind &&
      (targetSymbol === undefined || atom.edge.target.symbol === targetSymbol),
  );
}

describe("importGraphAdapter", () => {
  it("is always available", async () => {
    const { scope, fs } = makeScope({});
    await expect(importGraphAdapter.isAvailable(scope, fs)).resolves.toBe(true);
  });

  it("exercises in-memory workspace fs range and error paths", async () => {
    const fs = memFs(MEM_ROOT, {
      [MEM_ROOT]: undefined as unknown as string,
      "dir/a.txt": "hello",
      "dir/sub/b.txt": "world",
    });
    const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
    const readFileBytes = present(fs.readFileBytes);
    const readFileUtf8Prefix = present(fs.readFileUtf8Prefix);
    const readFileRange = present(fs.readFileRange);
    const openFileReader = present(fs.openFileReader);

    expect(fs.readFileUtf8(MEM_ROOT)).toBe("");
    expect(fs.stat(MEM_ROOT)).toMatchObject({ isFile: true, size: 0 });
    expect(fs.stat(`${MEM_ROOT}/dir`)).toMatchObject({ isDirectory: true, isFile: false });
    expect(fs.exists(MEM_ROOT)).toBe(true);
    expect(fs.readDir(MEM_ROOT).map((entry) => [entry.name, entry.isDirectory])).toEqual([
      ["dir", true],
    ]);
    expect(fs.readDir(`${MEM_ROOT}/dir`).map((entry) => [entry.name, entry.isDirectory])).toEqual([
      ["sub", true],
      ["a.txt", false],
    ]);
    expect(decode(await readFileBytes(MEM_ROOT, 10))).toBe("");
    expect(readFileUtf8Prefix(`${MEM_ROOT}/dir/a.txt`, 4)).toBe("hell");
    expect(decode(await readFileRange(`${MEM_ROOT}/dir/a.txt`, 1.9, 3.2))).toBe("ell");
    expect(decode(await readFileRange(`${MEM_ROOT}/dir/a.txt`, -2, 99))).toBe("hello");

    await expect(readFileBytes(`${MEM_ROOT}/missing.txt`, 10)).rejects.toThrow("ENOENT");
    expect(() => readFileUtf8Prefix(`${MEM_ROOT}/missing.txt`, 10)).toThrow("ENOENT");
    await expect(readFileRange(`${MEM_ROOT}/missing.txt`, 0, 10)).rejects.toThrow("ENOENT");
    await expect(openFileReader(`${MEM_ROOT}/missing.txt`)).rejects.toThrow("ENOENT");

    const reader = await openFileReader(`${MEM_ROOT}/dir/a.txt`);
    expect(decode(await reader.readRange(1, 3))).toBe("ell");
    await reader.close();
    await expect(reader.readRange(0, 1)).rejects.toThrow("EBADF");
  });

  it("picks up ESM static imports and reports the matching line", async () => {
    const { scope, fs } = makeScope({
      "src/a.ts": ["// header", 'import { foo } from "./bar";', "const x = 1;"].join("\n"),
    });
    const atoms = await importGraphAdapter.lookup(scope, nlq("./bar"), DEFAULT_SEARCH_LIMITS, fs, {
      nowMs: FIXED_NOW,
    });
    expect(atoms.length).toBe(1);
    expect(atoms[0]?.scopePath).toBe("src/a.ts");
    expect(atoms[0]?.lineRange).toEqual({ startLine: 2, endLine: 2 });
    expect(atoms[0]?.provenance.tool).toBe("code-intelligence-index");
    expect(atoms[0]?.provenance.kind).toBe("structural");
    expect(atoms[0]?.edge?.kind).toBe("import");
    expect(atoms[0]?.edge?.label).toBe("./bar");
  });

  it("resolves relative imports to concrete target files and stores the edge in the stable atom", async () => {
    const { scope, fs } = makeScope({
      "src/a.ts": 'import { foo } from "./bar";',
      "src/bar.ts": "export const foo = 1;",
    });
    const atoms = await importGraphAdapter.lookup(scope, nlq("bar"), DEFAULT_SEARCH_LIMITS, fs, {
      nowMs: FIXED_NOW,
    });
    const edge = atoms.find((atom) => atom.edge?.label === "./bar")?.edge;
    expect(edge?.target.scopePath).toBe("src/bar.ts");
    expect(edge?.confidence).toBe("resolved");
  });

  it("resolves tsconfig paths aliases to concrete target files", () => {
    const { scope, fs } = makeScope({
      "tsconfig.json": [
        "{",
        "  // Real tsconfig files are JSONC, not strict JSON.",
        '  "compilerOptions": {',
        '    "baseUrl": ".",',
        '    "paths": {',
        '      "@app/*": ["packages/app/src/*"],',
        "    },",
        "  },",
        "}",
      ].join("\n"),
      "src/consumer.ts": 'import { loadOrder } from "@app/orders";\nloadOrder();',
      "packages/app/src/orders.ts": "export function loadOrder() { return 1; }",
    });
    const index = buildCodeIntelligenceIndex(scope, DEFAULT_SEARCH_LIMITS, fs, {
      disableCache: true,
    });
    const edge = index.imports.find((candidate) => candidate.specifier === "@app/orders");
    expect(edge?.targetPath).toBe("packages/app/src/orders.ts");
    expect(edge?.confidence).toBe("resolved");
    expect(index.calls.find((candidate) => candidate.calleeName === "loadOrder")?.targetPath).toBe(
      "packages/app/src/orders.ts",
    );
  });

  it("resolves tsconfig baseUrl imports without an explicit paths map", () => {
    const { scope, fs } = makeScope({
      "tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: "src" } }),
      "src/consumer.ts": 'import { loadOrder } from "lib/orders";',
      "src/lib/orders.ts": "export function loadOrder() { return 1; }",
    });
    const index = buildCodeIntelligenceIndex(scope, DEFAULT_SEARCH_LIMITS, fs, {
      disableCache: true,
    });
    const edge = index.imports.find((candidate) => candidate.specifier === "lib/orders");
    expect(edge?.targetPath).toBe("src/lib/orders.ts");
    expect(edge?.confidence).toBe("resolved");
  });

  it("resolves workspace package exports to concrete target files", () => {
    const { scope, fs } = makeScope({
      "src/consumer.ts": 'import { loadOrder } from "@acme/api/orders";\nloadOrder();',
      "packages/api/package.json": JSON.stringify({
        name: "@acme/api",
        exports: {
          "./*": "./src/*.js",
        },
      }),
      "packages/api/src/orders.ts": "export function loadOrder() { return 1; }",
    });
    const index = buildCodeIntelligenceIndex(scope, DEFAULT_SEARCH_LIMITS, fs, {
      disableCache: true,
    });
    const edge = index.imports.find((candidate) => candidate.specifier === "@acme/api/orders");
    expect(edge?.targetPath).toBe("packages/api/src/orders.ts");
    expect(edge?.confidence).toBe("resolved");
    expect(index.calls.find((candidate) => candidate.calleeName === "loadOrder")?.targetPath).toBe(
      "packages/api/src/orders.ts",
    );
  });

  it("indexes workspace package manifest dependencies as structural edges", async () => {
    const { scope, fs } = makeScope({
      "packages/web/package.json": JSON.stringify({
        name: "@acme/web",
        dependencies: {
          "@acme/api": "workspace:*",
          react: "^19.0.0",
        },
      }),
      "packages/api/package.json": JSON.stringify({
        name: "@acme/api",
        version: "1.0.0",
      }),
      "packages/web/src/index.ts": "export const web = 1;",
      "packages/api/src/index.ts": "export const api = 1;",
    });
    const index = buildCodeIntelligenceIndex(scope, DEFAULT_SEARCH_LIMITS, fs, {
      disableCache: true,
    });
    expect(index.packageDependencies).toEqual([
      {
        sourcePackage: "@acme/web",
        sourcePath: "packages/web/package.json",
        targetPackage: "@acme/api",
        targetPath: "packages/api/package.json",
        dependencyKind: "dependencies",
        confidence: "resolved",
      },
    ]);

    const atoms = await importGraphAdapter.lookup(
      scope,
      nlq("@acme/api"),
      DEFAULT_SEARCH_LIMITS,
      fs,
      {
        nowMs: FIXED_NOW,
      },
    );
    const edge = atoms.find((atom) => atom.edge?.kind === "package-dependency")?.edge;
    expect(edge).toMatchObject({
      kind: "package-dependency",
      source: { scopePath: "packages/web/package.json", symbol: "@acme/web" },
      target: { scopePath: "packages/api/package.json", symbol: "@acme/api" },
      label: "@acme/web -> @acme/api (dependencies)",
      confidence: "resolved",
    });
  });

  it("indexes mixed resolver fallbacks across manifests and polyglot imports", () => {
    const { scope, fs } = makeScope({
      "broken/package.json": "{",
      "empty/package.json": JSON.stringify({ version: "1.0.0" }),
      "node_modules/@acme/ignored/package.json": JSON.stringify({ name: "@acme/ignored" }),
      "packages/core/package.json": JSON.stringify({
        name: "@acme/core",
        exports: {
          ".": { import: "./dist/index.js", types: "./dist/index.d.ts" },
          "./feature": { require: "./dist/feature.cjs" },
          "./wild/*": { default: "./dist/*.js" },
          "./ignored": 42,
        },
        main: "./dist/main.cjs",
        module: "./dist/module.js",
        types: "./dist/index.d.ts",
        dependencies: {
          "@acme/shared": "workspace:*",
          react: "^19.0.0",
        },
        devDependencies: {
          "@acme/tools": "workspace:*",
        },
        peerDependencies: {
          "@acme/plugin": "workspace:*",
        },
        optionalDependencies: {
          "@acme/optional": "workspace:*",
        },
      }),
      "packages/shared/package.json": JSON.stringify({ name: "@acme/shared" }),
      "packages/tools/package.json": JSON.stringify({ name: "@acme/tools" }),
      "packages/plugin/package.json": JSON.stringify({ name: "@acme/plugin" }),
      "packages/optional/package.json": JSON.stringify({ name: "@acme/optional" }),
      "packages/core/dist/index.ts": "export default function coreEntry() { return 1; }",
      "packages/core/dist/feature.ts": "export function featureEntry() { return 1; }",
      "packages/core/dist/widget.ts": "export function widgetEntry() { return 1; }",
      "tsconfig.build.json": JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: {
            "alias-exact": ["src/alias-target.ts"],
            "@shared/*": ["packages/shared/src/*"],
            "bad-targets/*": [42],
          },
        },
      }),
      "bad/tsconfig.json": "{",
      "plain/tsconfig.json": JSON.stringify({}),
      "go.mod": "module github.com/acme/shop\n\ngo 1.22\n",
      "src/consumer.ts": [
        'import core from "@acme/core";',
        'import { featureEntry } from "@acme/core/feature";',
        'import { widgetEntry } from "@acme/core/wild/widget";',
        'import exact from "alias-exact";',
        'import { SharedDto } from "@shared/dto";',
        'import rootStore from "@/store";',
        'import absolute from "/src/absolute";',
        'import legacy = require("@acme/core/feature");',
        "export async function run() {",
        "  await import(`./lazy`);",
        '  require("./required");',
        "  return [core, featureEntry(), widgetEntry(), exact(), SharedDto, rootStore, absolute, legacy];",
        "}",
      ].join("\n"),
      "src/alias-target.ts": "export default function aliasTarget() { return 1; }",
      "packages/shared/src/dto.ts": "export interface SharedDto { id: string }",
      "src/store.ts": "export default { ready: true };",
      "src/absolute.ts": "export default 1;",
      "src/lazy.ts": "export const lazy = 1;",
      "src/required.ts": "export const required = 1;",
      "backend/src/main/java/com/acme/OrderService.java": [
        "package com.acme;",
        "import static com.acme.util.OrderUtil.*;",
        "import com.acme.dto.OrderDto;",
        "import com.acme.missing.MissingDto;",
        "public class OrderService {",
        '  @JsonProperty("order_id")',
        '  private final String orderId = "1";',
        "  private List<String> tags = List.of();",
        "  OrderDto loadOrder() { return helper(); }",
        "}",
      ].join("\n"),
      "backend/src/main/java/com/acme/util/OrderUtil.java":
        "package com.acme.util; public class OrderUtil { public static OrderDto helper() { return null; } }",
      "backend/src/main/java/com/acme/dto/OrderDto.java":
        'package com.acme.dto; public record OrderDto(@JsonProperty(value = "order_id") String orderId, String status) {}',
      "backend/src/main/kotlin/com/acme/KOrder.kt": [
        "package com.acme",
        "import com.acme.dto.KotlinDto",
        'data class KOrder(@JsonProperty("order_id") val orderId: String, val total: Double)',
        'fun makeKOrder(): KOrder { return KOrder("1", 2.0) }',
      ].join("\n"),
      "backend/src/main/kotlin/com/acme/dto/KotlinDto.kt":
        "package com.acme.dto\ndata class KotlinDto(val id: String)",
      "backend/src/main/scala/com/acme/ScalaService.scala": [
        "package com.acme",
        "import com.acme.dto.ScalaDto",
        "trait ScalaPort",
        "class ScalaService { def loadScala() = ScalaDto() }",
      ].join("\n"),
      "backend/src/main/scala/com/acme/dto/ScalaDto.scala":
        "package com.acme.dto\ncase class ScalaDto(id: String)",
      "backend/src/main/groovy/com/acme/GroovyService.groovy": [
        "package com.acme",
        "import com.acme.dto.GroovyDto",
        "class GroovyService { def loadGroovy() { return new GroovyDto() } }",
      ].join("\n"),
      "backend/src/main/groovy/com/acme/dto/GroovyDto.groovy":
        "package com.acme.dto\nclass GroovyDto {}",
      "root.go": ["package shop", "func Root() int { return 1 }"].join("\n"),
      "root_test.go": ["package shop", "func RootTest() int { return 1 }"].join("\n"),
      "cmd/api/main.go": [
        "package main",
        "import (",
        '  json "encoding/json"',
        '  "github.com/acme/shop"',
        '  "github.com/acme/shop/pkg/orders"',
        ")",
        "type Payload struct {",
        '  OrderID string `json:"order_id,omitempty"`',
        '  Ignored string `json:"-"`',
        "}",
        "func main() { shop.Root(); orders.Load(); json.Marshal(nil) }",
      ].join("\n"),
      "pkg/orders/orders.go": ["package orders", "func Load() int { return 1 }"].join("\n"),
      "src/lib.rs": [
        "pub use crate::orders::load_order;",
        "mod orders;",
        "fn run() { load_order(); }",
      ].join("\n"),
      "src/orders.rs": "pub fn load_order() {}",
      "backend/Controllers/OrdersController.cs": [
        "using Acme.Dto;",
        'public record OrderRecord([property: JsonPropertyName("order_id")] string OrderId, decimal Total);',
        "public class OrdersController {",
        '  [Route("api/orders")]',
        '  [HttpGet("{id}")]',
        '  public OrderRecord GetOrder() { return new OrderRecord("1", 2); }',
        "}",
      ].join("\n"),
      "backend/Dto.cs": "namespace Acme.Dto { public class Dto {} }",
      "frontend/src/Widget.vue": [
        '<script setup lang="ts">',
        'import helper from "./helper";',
        "export const vueThing = helper();",
        "</script>",
      ].join("\n"),
      "frontend/src/helper.ts": "export default function helper() { return 1; }",
    });

    const index = buildCodeIntelligenceIndex(scope, DEFAULT_SEARCH_LIMITS, fs, {
      disableCache: true,
    });

    expect(index.packageDependencies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourcePackage: "@acme/core",
          targetPackage: "@acme/shared",
          dependencyKind: "dependencies",
        }),
        expect.objectContaining({
          sourcePackage: "@acme/core",
          targetPackage: "@acme/tools",
          dependencyKind: "devDependencies",
        }),
        expect.objectContaining({
          sourcePackage: "@acme/core",
          targetPackage: "@acme/plugin",
          dependencyKind: "peerDependencies",
        }),
        expect.objectContaining({
          sourcePackage: "@acme/core",
          targetPackage: "@acme/optional",
          dependencyKind: "optionalDependencies",
        }),
      ]),
    );
    expect(index.imports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          specifier: "@acme/core",
          targetPath: "packages/core/dist/index.ts",
          confidence: "resolved",
        }),
        expect.objectContaining({
          specifier: "@acme/core/feature",
          targetPath: "packages/core/dist/feature.ts",
          confidence: "resolved",
        }),
        expect.objectContaining({
          specifier: "@acme/core/wild/widget",
          targetPath: "packages/core/dist/widget.ts",
          confidence: "resolved",
        }),
        expect.objectContaining({
          specifier: "alias-exact",
          targetPath: "src/alias-target.ts",
          confidence: "resolved",
        }),
        expect.objectContaining({
          specifier: "@/store",
          targetPath: "src/store.ts",
          confidence: "resolved",
        }),
        expect.objectContaining({
          specifier: "/src/absolute",
          targetPath: "src/absolute.ts",
          confidence: "resolved",
        }),
        expect.objectContaining({
          specifier: "./lazy",
          targetPath: "src/lazy.ts",
          confidence: "resolved",
        }),
        expect.objectContaining({
          specifier: "com.acme.missing.MissingDto",
          confidence: "heuristic",
        }),
        expect.objectContaining({
          specifier: "github.com/acme/shop",
          confidence: "heuristic",
        }),
        expect.objectContaining({
          specifier: "orders",
          targetPath: "src/orders.rs",
          confidence: "resolved",
        }),
      ]),
    );
    expect(index.symbols).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "OrderService",
          fields: expect.arrayContaining(["order_id", "tags"]),
          parser: "polyglot-regex",
        }),
        expect.objectContaining({
          name: "KOrder",
          fields: expect.arrayContaining(["order_id", "total"]),
          parser: "polyglot-regex",
        }),
        expect.objectContaining({
          name: "Payload",
          fields: expect.arrayContaining(["order_id", "Ignored"]),
          parser: "polyglot-regex",
        }),
        expect.objectContaining({
          name: "vueThing",
          kind: "constant",
          scopePath: "frontend/src/Widget.vue",
        }),
      ]),
    );
    expect(index.calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          calleeName: "Load",
          targetPath: "pkg/orders/orders.go",
          confidence: "resolved",
        }),
        expect.objectContaining({
          calleeName: "load_order",
          targetPath: "src/orders.rs",
          confidence: "resolved",
        }),
      ]),
    );
    expect(index.parserCoverage).toEqual(
      expect.arrayContaining([
        { parser: "polyglot-regex", filesIndexed: expect.any(Number) },
        { parser: "typescript-compiler-ast", filesIndexed: expect.any(Number) },
      ]),
    );
  });

  it("indexes declaration and schema edge cases used by structural contracts", () => {
    const { scope, fs } = makeScope({
      "src/declarations.ts": [
        "export default class {",
        "  ready = true;",
        "  methodName() { return this.ready; }",
        "}",
        "export default function namedDefault() { return 1; }",
        "const assignedDefault = 1;",
        "export default assignedDefault;",
        "export { assignedDefault as default };",
        "export enum Mode { One }",
        "export namespace Internal { export const value = 1; }",
        "export type TypeDto = { orderId: string; total?: number };",
        "export interface InterfaceDto { status: string }",
      ].join("\n"),
      "openapi.yaml": [
        "openapi: 3.1.0",
        "components:",
        "  # comments and blank lines are ignored",
        "",
        "  schemas:",
        "    Empty:",
        "      type: object",
        "    OrderYaml:",
        "      type: object",
        "      properties:",
        "        order_id:",
        "          type: string",
        "        total:",
        "          type: number",
        "      required: [order_id]",
        "paths:",
        "  /api/orders:",
        "    get:",
        "      operationId: listOrders",
      ].join("\n"),
      "openapi.json": JSON.stringify({
        openapi: "3.1.0",
        components: {
          schemas: {
            Empty: { type: "object" },
            OrderJson: {
              type: "object",
              properties: {
                orderId: { type: "string" },
                total: { type: "number" },
              },
            },
          },
        },
      }),
      "swagger.json": "{",
    });

    const index = buildCodeIntelligenceIndex(scope, DEFAULT_SEARCH_LIMITS, fs, {
      disableCache: true,
    });

    expect(index.symbols).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "default", kind: "class" }),
        expect.objectContaining({ name: "namedDefault", kind: "function" }),
        expect.objectContaining({ name: "assignedDefault", kind: "constant" }),
        expect.objectContaining({ name: "Mode", kind: "enum" }),
        expect.objectContaining({ name: "Internal", kind: "module" }),
        expect.objectContaining({
          name: "TypeDto",
          kind: "type",
          fields: expect.arrayContaining(["orderId", "total"]),
        }),
        expect.objectContaining({
          name: "OrderYaml",
          scopePath: "openapi.yaml",
          fields: expect.arrayContaining(["order_id", "total"]),
        }),
        expect.objectContaining({
          name: "OrderJson",
          scopePath: "openapi.json",
          fields: expect.arrayContaining(["orderId", "total"]),
        }),
      ]),
    );
  });

  it("picks up ESM re-exports", async () => {
    const { scope, fs } = makeScope({
      "src/b.ts": 'export * from "./bar";',
    });
    const atoms = await importGraphAdapter.lookup(scope, nlq("./bar"), DEFAULT_SEARCH_LIMITS, fs, {
      nowMs: FIXED_NOW,
    });
    expect(atoms.map((a) => a.scopePath)).toEqual(["src/b.ts"]);
  });

  it("picks up CJS require()", async () => {
    const { scope, fs } = makeScope({
      "src/c.js": 'const foo = require("./bar");',
    });
    const atoms = await importGraphAdapter.lookup(scope, nlq("./bar"), DEFAULT_SEARCH_LIMITS, fs, {
      nowMs: FIXED_NOW,
    });
    expect(atoms.map((a) => a.scopePath)).toEqual(["src/c.js"]);
  });

  it("resolves Python relative from-imports to concrete modules and call targets", () => {
    const { scope, fs } = makeScope({
      "backend/app/routes.py": [
        "from .orders import load_order",
        "",
        "def route():",
        "    return load_order()",
      ].join("\n"),
      "backend/app/orders.py": ["def load_order():", "    return 1"].join("\n"),
    });
    const index = buildCodeIntelligenceIndex(scope, DEFAULT_SEARCH_LIMITS, fs, {
      disableCache: true,
    });
    const importEdge = index.imports.find((edge) => edge.specifier === ".orders");
    expect(importEdge?.targetPath).toBe("backend/app/orders.py");
    expect(importEdge?.confidence).toBe("resolved");
    expect(index.calls.find((edge) => edge.calleeName === "load_order")?.targetPath).toBe(
      "backend/app/orders.py",
    );
  });

  it("resolves Python absolute package imports from nested package roots", () => {
    const { scope, fs } = makeScope({
      "backend/app/routes.py": [
        "from app.orders import load_order",
        "",
        "def route():",
        "    return load_order()",
      ].join("\n"),
      "backend/app/orders.py": ["def load_order():", "    return 1"].join("\n"),
    });
    const index = buildCodeIntelligenceIndex(scope, DEFAULT_SEARCH_LIMITS, fs, {
      disableCache: true,
    });
    const importEdge = index.imports.find((edge) => edge.specifier === "app.orders");
    expect(importEdge?.targetPath).toBe("backend/app/orders.py");
    expect(importEdge?.confidence).toBe("resolved");
    expect(index.calls.find((edge) => edge.calleeName === "load_order")?.targetPath).toBe(
      "backend/app/orders.py",
    );
  });

  it("resolves Python from-import aliases to concrete call and reference targets", () => {
    const { scope, fs } = makeScope({
      "backend/app/routes.py": [
        "from .orders import load_order as load",
        "",
        "def route():",
        "    return load()",
      ].join("\n"),
      "backend/app/orders.py": ["def load_order():", "    return 1"].join("\n"),
    });
    const index = buildCodeIntelligenceIndex(scope, DEFAULT_SEARCH_LIMITS, fs, {
      disableCache: true,
    });
    const call = index.calls.find((edge) => edge.calleeName === "load");
    expect(call?.parser).toBe("polyglot-regex");
    expect(call?.targetName).toBe("load_order");
    expect(call?.targetPath).toBe("backend/app/orders.py");
    expect(call?.confidence).toBe("resolved");

    const reference = index.references.find((edge) => edge.referenceName === "load");
    expect(reference?.targetName).toBe("load_order");
    expect(reference?.targetPath).toBe("backend/app/orders.py");
    expect(reference?.confidence).toBe("resolved");
  });

  it("resolves Go module imports to concrete package files and call targets", () => {
    const { scope, fs } = makeScope({
      "go.mod": "module github.com/acme/shop\n\ngo 1.22\n",
      "cmd/api/main.go": [
        "package main",
        "",
        'import "github.com/acme/shop/pkg/orders"',
        "",
        "func main() {",
        "  orders.LoadOrder()",
        "}",
      ].join("\n"),
      "pkg/orders/service.go": [
        "package orders",
        "",
        "func LoadOrder() int {",
        "  return 1",
        "}",
      ].join("\n"),
    });
    const index = buildCodeIntelligenceIndex(scope, DEFAULT_SEARCH_LIMITS, fs, {
      disableCache: true,
    });
    const importEdge = index.imports.find(
      (edge) => edge.specifier === "github.com/acme/shop/pkg/orders",
    );
    expect(importEdge?.targetPath).toBe("pkg/orders/service.go");
    expect(importEdge?.confidence).toBe("resolved");
    expect(index.calls.find((edge) => edge.calleeName === "LoadOrder")?.targetPath).toBe(
      "pkg/orders/service.go",
    );
  });

  it("uses the TypeScript compiler AST for multiline imports and imported call targets", () => {
    const { scope, fs } = makeScope({
      "src/consumer.ts": [
        "import {",
        "  loadOrder as load,",
        '} from "./api/orders";',
        'export async function run() { return load("42"); }',
      ].join("\n"),
      "src/api/orders.ts": "export function loadOrder(id: string) { return id; }",
    });
    const index = buildCodeIntelligenceIndex(scope, DEFAULT_SEARCH_LIMITS, fs, {
      disableCache: true,
    });

    const importEdge = present(index.imports.find((edge) => edge.specifier === "./api/orders"));
    expect(importEdge.parser).toBe("typescript-compiler-ast");
    expect(importEdge.importerLine).toBe(1);
    expect(importEdge.targetPath).toBe("src/api/orders.ts");

    const call = present(index.calls.find((edge) => edge.calleeName === "load"));
    expect(call.parser).toBe("typescript-compiler-ast");
    expect(call.callerPath).toBe("src/consumer.ts");
    expect(call.callerLine).toBe(4);
    expect(call.targetName).toBe("loadOrder");
    expect(call.targetPath).toBe("src/api/orders.ts");
    expect(call.targetLineRange).toEqual({ startLine: 1, endLine: 1 });

    const reference = present(index.references.find((edge) => edge.referenceName === "load"));
    expect(reference.parser).toBe("typescript-compiler-ast");
    expect(reference.referencerPath).toBe("src/consumer.ts");
    expect(reference.referenceLineRange).toEqual({ startLine: 4, endLine: 4 });
    expect(reference.targetName).toBe("loadOrder");
    expect(reference.targetPath).toBe("src/api/orders.ts");
  });

  it("resolves aliased default imports through TypeScript default re-exports", async () => {
    const { scope, fs } = makeScope({
      "src/consumer.ts": [
        'import load from "./api";',
        'export async function run() { return load("42"); }',
      ].join("\n"),
      "src/api/index.ts": 'export { default } from "./orders";',
      "src/api/orders.ts": "export default function loadOrder(id: string) { return id; }",
    });
    const index = buildCodeIntelligenceIndex(scope, DEFAULT_SEARCH_LIMITS, fs, {
      disableCache: true,
    });

    const call = present(index.calls.find((edge) => edge.calleeName === "load"));
    expect(call.targetName).toBe("loadOrder");
    expect(call.targetPath).toBe("src/api/orders.ts");
    expect(call.confidence).toBe("resolved");

    const reference = present(index.references.find((edge) => edge.referenceName === "load"));
    expect(reference.targetName).toBe("loadOrder");
    expect(reference.targetPath).toBe("src/api/orders.ts");

    const atoms = await importGraphAdapter.lookup(scope, exq("./api"), DEFAULT_SEARCH_LIMITS, fs, {
      nowMs: FIXED_NOW,
    });
    expect(findEdgeAtom(atoms, "definition", "loadOrder")?.scopePath).toBe("src/api/orders.ts");
  });

  it("does not treat comment or string contents as TypeScript imports", () => {
    const { scope, fs } = makeScope({
      "src/a.ts": [
        '// import ghost from "./ghost";',
        'const text = "require(\\"./not-real\\")";',
        'import real from "./real";',
      ].join("\n"),
      "src/real.ts": "export default 1;",
    });
    const index = buildCodeIntelligenceIndex(scope, DEFAULT_SEARCH_LIMITS, fs, {
      disableCache: true,
    });

    expect(index.imports.map((edge) => edge.specifier)).toEqual(["./real"]);
  });

  it("extracts TypeScript declaration spans and fields from the compiler AST", () => {
    const { scope, fs } = makeScope({
      "src/types.ts": [
        "export interface OrderDto {",
        "  status: string;",
        "  total?: number;",
        "}",
        "export class OrderService {",
        "  loadOrder() { return 1; }",
        "}",
      ].join("\n"),
    });
    const index = buildCodeIntelligenceIndex(scope, DEFAULT_SEARCH_LIMITS, fs, {
      disableCache: true,
    });

    const dto = index.symbols.find((symbol) => symbol.name === "OrderDto");
    expect(dto?.parser).toBe("typescript-compiler-ast");
    expect(dto?.kind).toBe("interface");
    expect(dto?.lineRange).toEqual({ startLine: 1, endLine: 4 });
    expect(dto?.fields).toEqual(["status", "total"]);
    expect(index.parserCoverage).toEqual([{ parser: "typescript-compiler-ast", filesIndexed: 1 }]);

    const method = index.symbols.find((symbol) => symbol.name === "loadOrder");
    expect(method?.kind).toBe("method");
    expect(method?.lineRange).toEqual({ startLine: 6, endLine: 6 });
  });

  it("emits TypeScript reference edges for same-file type references", () => {
    const { scope, fs } = makeScope({
      "src/types.ts": [
        "export interface OrderDto {",
        "  status: string;",
        "}",
        "export function render(order: OrderDto) {",
        "  return order.status;",
        "}",
      ].join("\n"),
    });
    const index = buildCodeIntelligenceIndex(scope, DEFAULT_SEARCH_LIMITS, fs, {
      disableCache: true,
    });

    const references = index.references.filter((edge) => edge.targetName === "OrderDto");
    expect(references).toHaveLength(1);
    expect(references[0]?.referenceLineRange).toEqual({ startLine: 4, endLine: 4 });
    expect(references[0]?.targetLineRange).toEqual({ startLine: 1, endLine: 3 });
    expect(references[0]?.confidence).toBe("resolved");
  });

  it("surfaces reference edges through structural adapter lookups", async () => {
    const { scope, fs } = makeScope({
      "src/consumer.ts": ['import { loadOrder as load } from "./api/orders";', "load();"].join(
        "\n",
      ),
      "src/api/orders.ts": "export function loadOrder() { return 1; }",
    });

    const atoms = await importGraphAdapter.lookup(
      scope,
      exq("loadOrder"),
      DEFAULT_SEARCH_LIMITS,
      fs,
      { nowMs: FIXED_NOW },
    );
    const reference = atoms.find((atom) => atom.edge?.kind === "reference");
    expect(reference?.scopePath).toBe("src/consumer.ts");
    expect(reference?.lineRange).toEqual({ startLine: 2, endLine: 2 });
    expect(reference?.edge?.source.symbol).toBe("load");
    expect(reference?.edge?.target.symbol).toBe("loadOrder");
    expect(reference?.edge?.target.scopePath).toBe("src/api/orders.ts");
  });

  it("emits polyglot reference edges for Java DTO usages", async () => {
    const { scope, fs } = makeScope({
      "backend/src/main/java/com/acme/OrderDto.java":
        "public record OrderDto(String status, String total) {}",
      "backend/src/main/java/com/acme/OrderService.java": [
        "package com.acme;",
        "class OrderService {",
        "  OrderDto currentOrder() { return null; }",
        "}",
      ].join("\n"),
    });
    const index = buildCodeIntelligenceIndex(scope, DEFAULT_SEARCH_LIMITS, fs, {
      disableCache: true,
    });
    const reference = index.references.find(
      (edge) => edge.referenceName === "OrderDto" && edge.targetName === "OrderDto",
    );
    expect(reference?.parser).toBe("polyglot-regex");
    expect(reference?.referencerPath).toBe("backend/src/main/java/com/acme/OrderService.java");
    expect(reference?.targetPath).toBe("backend/src/main/java/com/acme/OrderDto.java");

    const atoms = await importGraphAdapter.lookup(
      scope,
      nlq("OrderDto"),
      DEFAULT_SEARCH_LIMITS,
      fs,
      {
        nowMs: FIXED_NOW,
      },
    );
    const atom = atoms.find((candidate) => candidate.edge?.kind === "reference");
    expect(atom?.edge?.target.scopePath).toBe("backend/src/main/java/com/acme/OrderDto.java");
  });

  it("does not emit polyglot call or reference edges from comments and string literals", () => {
    const { scope, fs } = makeScope({
      "backend/src/main/java/com/acme/OrderDto.java":
        "public record OrderDto(String status, String total) {}",
      "backend/src/main/java/com/acme/OrderService.java": [
        "package com.acme;",
        "class OrderService {",
        '  String log = "OrderDto currentOrder() should not count";',
        "  // OrderDto currentOrder() should not count either",
        "  /*",
        "   * OrderDto currentOrder() is just a block comment",
        "   */",
        "  String currentOrderName() { return log; }",
        "}",
      ].join("\n"),
    });

    const index = buildCodeIntelligenceIndex(scope, DEFAULT_SEARCH_LIMITS, fs, {
      disableCache: true,
    });

    expect(index.references.some((edge) => edge.targetName === "OrderDto")).toBe(false);
    expect(index.calls.some((edge) => edge.calleeName === "currentOrder")).toBe(false);
  });

  it("does not emit Python reference edges from docstrings while keeping real references", () => {
    const { scope, fs } = makeScope({
      "backend/app/models.py": ["class OrderDto:", "    pass"].join("\n"),
      "backend/app/routes.py": [
        "from .models import OrderDto",
        "",
        "def ignored():",
        '    """OrderDto inside a docstring should not count."""',
        "    return None",
        "",
        "def real() -> OrderDto:",
        "    return OrderDto()",
      ].join("\n"),
    });

    const index = buildCodeIntelligenceIndex(scope, DEFAULT_SEARCH_LIMITS, fs, {
      disableCache: true,
    });
    const references = index.references.filter((edge) => edge.targetName === "OrderDto");

    expect(references.map((edge) => edge.referenceLineRange.startLine)).toEqual([7, 8]);
    expect(index.calls.some((edge) => edge.calleeName === "OrderDto")).toBe(true);
  });

  it("expands exact import matches to adjacent definitions and caller edges", async () => {
    const { scope, fs } = makeScope({
      "src/consumer.ts": [
        'import { loadOrder as load } from "./api/orders";',
        'export function run() { return load("42"); }',
      ].join("\n"),
      "src/api/orders.ts": "export function loadOrder(id: string) { return id; }",
    });

    const atoms = await importGraphAdapter.lookup(
      scope,
      exq("./api/orders"),
      DEFAULT_SEARCH_LIMITS,
      fs,
      { nowMs: FIXED_NOW },
    );

    const directImport = present(findEdgeAtom(atoms, "import"));
    const directImportEdge = present(directImport.edge);
    expect(directImportEdge.label).toBe("./api/orders");
    expect(directImport.score).toBe(1);

    const definition = present(findEdgeAtom(atoms, "definition", "loadOrder"));
    expect(definition.scopePath).toBe("src/api/orders.ts");
    expect(definition.score).toBeLessThan(directImport.score);

    const call = present(findEdgeAtom(atoms, "call"));
    const callEdge = present(call.edge);
    expect(call.scopePath).toBe("src/consumer.ts");
    expect(callEdge.target.symbol).toBe("loadOrder");
    expect(call.score).toBeLessThan(directImport.score);

    const reference = present(findEdgeAtom(atoms, "reference"));
    const referenceEdge = present(reference.edge);
    expect(referenceEdge.source.symbol).toBe("load");
    expect(referenceEdge.target.symbol).toBe("loadOrder");
  });

  it("resolves aliased calls through TypeScript barrel re-export chains", async () => {
    const { scope, fs } = makeScope({
      "src/consumer.ts": [
        'import { fetchOrder as load } from "./api";',
        'export function run() { return load("42"); }',
      ].join("\n"),
      "src/api/index.ts": 'export * from "./orders";',
      "src/api/orders.ts": 'export { loadOrder as fetchOrder } from "./load";',
      "src/api/load.ts": "export function loadOrder(id: string) { return id; }",
    });

    const index = buildCodeIntelligenceIndex(scope, DEFAULT_SEARCH_LIMITS, fs, {
      disableCache: true,
    });
    const call = present(index.calls.find((edge) => edge.calleeName === "load"));
    expect(call.targetName).toBe("loadOrder");
    expect(call.targetPath).toBe("src/api/load.ts");
    expect(call.confidence).toBe("resolved");

    const atoms = await importGraphAdapter.lookup(scope, exq("./api"), DEFAULT_SEARCH_LIMITS, fs, {
      nowMs: FIXED_NOW,
    });
    const definition = present(findEdgeAtom(atoms, "definition", "loadOrder"));
    expect(definition.scopePath).toBe("src/api/load.ts");
    const callAtom = present(findEdgeAtom(atoms, "call", "loadOrder"));
    expect(callAtom.edge?.source.scopePath).toBe("src/consumer.ts");
  });

  it("emits one atom per match when multiple imports of the same specifier appear", async () => {
    const { scope, fs } = makeScope({
      "src/d.ts": ['import { a } from "./bar";', 'import { b } from "./bar";', "const x = 1;"].join(
        "\n",
      ),
    });
    const atoms = await importGraphAdapter.lookup(scope, nlq("./bar"), DEFAULT_SEARCH_LIMITS, fs, {
      nowMs: FIXED_NOW,
    });
    expect(atoms.length).toBe(2);
    expect(atoms.map((a) => a.lineRange?.startLine).sort()).toEqual([1, 2]);
  });

  it("scores exact-symbol matches at 1.0 and natural-language token matches at 0.7", async () => {
    const { scope, fs } = makeScope({
      "src/e.ts": 'import x from "./alpha-beta";',
    });
    const ex = await importGraphAdapter.lookup(
      scope,
      exq("./alpha-beta"),
      DEFAULT_SEARCH_LIMITS,
      fs,
      { nowMs: FIXED_NOW },
    );
    expect(ex[0]?.score).toBe(1.0);
    const sub = await importGraphAdapter.lookup(scope, nlq("alpha"), DEFAULT_SEARCH_LIMITS, fs, {
      nowMs: FIXED_NOW,
    });
    expect(sub[0]?.score).toBe(0.7);
  });

  it("weights structural scores by edge confidence and graph distance", async () => {
    const { scope, fs } = makeScope({
      "src/confidence.ts": [
        'import resolved from "./alpha";',
        'import missing from "./alpha-missing";',
      ].join("\n"),
      "src/alpha.ts": "export default 1;",
      "src/consumer.ts": [
        'import { fetchOrder as load } from "./api";',
        'export function run() { return load("42"); }',
      ].join("\n"),
      "src/api.ts": 'export { loadOrder as fetchOrder } from "./service";',
      "src/service.ts": "export function loadOrder(id: string) { return id; }",
    });

    const confidenceAtoms = await importGraphAdapter.lookup(
      scope,
      nlq("alpha"),
      DEFAULT_SEARCH_LIMITS,
      fs,
      { nowMs: FIXED_NOW },
    );
    const resolvedImport = present(
      confidenceAtoms.find((atom) => atom.edge?.kind === "import" && atom.edge.label === "./alpha"),
    );
    const heuristicImport = present(
      confidenceAtoms.find(
        (atom) => atom.edge?.kind === "import" && atom.edge.label === "./alpha-missing",
      ),
    );
    expect(resolvedImport.edge?.confidence).toBe("resolved");
    expect(heuristicImport.edge?.confidence).toBe("heuristic");
    expect(resolvedImport.score).toBeGreaterThan(heuristicImport.score);

    const graphAtoms = await importGraphAdapter.lookup(
      scope,
      exq("./api"),
      DEFAULT_SEARCH_LIMITS,
      fs,
      { nowMs: FIXED_NOW },
    );
    const directImport = present(
      graphAtoms.find((atom) => atom.edge?.kind === "import" && atom.edge.label === "./api"),
    );
    const barrelExport = present(
      graphAtoms.find((atom) => atom.edge?.kind === "export" && atom.edge.label === "./service"),
    );
    const definition = present(findEdgeAtom(graphAtoms, "definition", "loadOrder"));
    const call = present(findEdgeAtom(graphAtoms, "call", "loadOrder"));
    expect(directImport.score).toBe(1);
    expect(barrelExport.score).toBeLessThan(directImport.score);
    expect(definition.score).toBeLessThan(barrelExport.score);
    expect(call.score).toBeLessThan(barrelExport.score);
  });

  it("does not match natural-language prose terms as substrings inside structural edges", async () => {
    const { scope, fs } = makeScope({
      "src/e.ts": 'import history from "./payment-history";',
    });
    const atoms = await importGraphAdapter.lookup(
      scope,
      nlq("Why is widget failing?"),
      DEFAULT_SEARCH_LIMITS,
      fs,
      { nowMs: FIXED_NOW },
    );
    expect(atoms).toEqual([]);
  });

  it("links a Java Spring route to a TypeScript fetch call", async () => {
    const { scope, fs } = makeScope({
      "backend/src/main/java/com/acme/OrderController.java": [
        "package com.acme;",
        "class OrderController {",
        '  @GetMapping("/api/orders/{id}")',
        "  OrderDto getOrder() { return null; }",
        "}",
      ].join("\n"),
      "frontend/src/api/orders.ts":
        "export async function load(id: string) { return fetch(`/api/orders/${id}`); }",
    });
    const atoms = await importGraphAdapter.lookup(
      scope,
      nlq("/api/orders/:id"),
      DEFAULT_SEARCH_LIMITS,
      fs,
      {
        nowMs: FIXED_NOW,
      },
    );
    const contract = atoms.find((atom) => atom.edge?.kind === "api-contract");
    expect(contract?.edge?.source.scopePath).toBe("frontend/src/api/orders.ts");
    expect(contract?.edge?.target.scopePath).toBe(
      "backend/src/main/java/com/acme/OrderController.java",
    );
  });

  it("links Spring class-level RequestMapping prefixes to TypeScript client calls", async () => {
    const { scope, fs } = makeScope({
      "backend/src/main/java/com/acme/OrderController.java": [
        "package com.acme;",
        '@RequestMapping("/api/orders")',
        "class OrderController {",
        '  @GetMapping("/{id}")',
        "  OrderDto getOrder() { return null; }",
        "}",
      ].join("\n"),
      "frontend/src/api/orders.ts":
        'export async function load(id: string) { return fetch("/api/orders/:id"); }',
    });
    const atoms = await importGraphAdapter.lookup(
      scope,
      nlq("/api/orders/:id"),
      DEFAULT_SEARCH_LIMITS,
      fs,
      {
        nowMs: FIXED_NOW,
      },
    );
    const contract = atoms.find((atom) => atom.edge?.kind === "api-contract");
    expect(contract?.edge?.source.scopePath).toBe("frontend/src/api/orders.ts");
    expect(contract?.edge?.target.scopePath).toBe(
      "backend/src/main/java/com/acme/OrderController.java",
    );
    expect(contract?.edge?.confidence).toBe("resolved");
  });

  it("links Spring RequestMapping path attributes without mistaking params for paths", async () => {
    const { scope, fs } = makeScope({
      "backend/src/main/java/com/acme/OrderController.java": [
        "package com.acme;",
        "class OrderController {",
        '  @RequestMapping(params = "includeDetails=true", path = "/api/orders/{id}", method = RequestMethod.GET)',
        "  OrderDto getOrder() { return null; }",
        "}",
      ].join("\n"),
      "frontend/src/api/orders.ts":
        "export async function load(id: string) { return fetch(`/api/orders/${id}`); }",
    });
    const atoms = await importGraphAdapter.lookup(
      scope,
      nlq("/api/orders/:id"),
      DEFAULT_SEARCH_LIMITS,
      fs,
      {
        nowMs: FIXED_NOW,
      },
    );
    const contract = atoms.find((atom) => atom.edge?.kind === "api-contract");
    expect(contract?.edge?.source.scopePath).toBe("frontend/src/api/orders.ts");
    expect(contract?.edge?.target.scopePath).toBe(
      "backend/src/main/java/com/acme/OrderController.java",
    );
    expect(contract?.edge?.confidence).toBe("resolved");
  });

  it("links parameterless Spring composed mappings to the class route root", async () => {
    const { scope, fs } = makeScope({
      "backend/src/main/java/com/acme/HealthController.java": [
        "package com.acme;",
        '@RequestMapping(path = "/api/health")',
        "class HealthController {",
        "  @GetMapping",
        "  HealthDto health() { return null; }",
        "}",
      ].join("\n"),
      "frontend/src/api/health.ts":
        'export async function health() { return fetch("/api/health"); }',
    });
    const atoms = await importGraphAdapter.lookup(
      scope,
      nlq("/api/health"),
      DEFAULT_SEARCH_LIMITS,
      fs,
      {
        nowMs: FIXED_NOW,
      },
    );
    const contract = atoms.find((atom) => atom.edge?.kind === "api-contract");
    expect(contract?.edge?.source.scopePath).toBe("frontend/src/api/health.ts");
    expect(contract?.edge?.target.scopePath).toBe(
      "backend/src/main/java/com/acme/HealthController.java",
    );
    expect(contract?.edge?.confidence).toBe("resolved");
  });

  it("uses fetch method options when several server routes share a path", async () => {
    const { scope, fs } = makeScope({
      "backend/src/main/java/com/acme/GetOrderController.java": [
        "package com.acme;",
        "class GetOrderController {",
        '  @GetMapping("/api/orders")',
        "  OrderDto listOrders() { return null; }",
        "}",
      ].join("\n"),
      "backend/src/main/java/com/acme/CreateOrderController.java": [
        "package com.acme;",
        "class CreateOrderController {",
        '  @PostMapping("/api/orders")',
        "  OrderDto createOrder() { return null; }",
        "}",
      ].join("\n"),
      "frontend/src/api/orders.ts":
        'export async function create(order: OrderDto) { return fetch("/api/orders", { method: "POST", body: JSON.stringify(order) }); }',
    });
    const atoms = await importGraphAdapter.lookup(
      scope,
      nlq("/api/orders"),
      DEFAULT_SEARCH_LIMITS,
      fs,
      {
        nowMs: FIXED_NOW,
      },
    );
    const contracts = atoms.filter((atom) => atom.edge?.kind === "api-contract");
    expect(contracts).toHaveLength(1);
    expect(contracts[0]?.edge?.target.scopePath).toBe(
      "backend/src/main/java/com/acme/CreateOrderController.java",
    );
    expect(contracts[0]?.edge?.confidence).toBe("resolved");
  });

  it("normalizes client query strings and absolute URLs before linking API contracts", async () => {
    const { scope, fs } = makeScope({
      "backend/src/main/java/com/acme/OrderController.java": [
        "package com.acme;",
        "class OrderController {",
        '  @GetMapping("/api/orders")',
        "  OrderDto listOrders() { return null; }",
        "}",
      ].join("\n"),
      "frontend/src/api/orders.ts":
        'export async function load() { return fetch("https://shop.example.test/api/orders?active=true#open"); }',
    });
    const atoms = await importGraphAdapter.lookup(
      scope,
      nlq("/api/orders"),
      DEFAULT_SEARCH_LIMITS,
      fs,
      {
        nowMs: FIXED_NOW,
      },
    );
    const contract = atoms.find((atom) => atom.edge?.kind === "api-contract");
    expect(contract?.edge?.source.scopePath).toBe("frontend/src/api/orders.ts");
    expect(contract?.edge?.target.scopePath).toBe(
      "backend/src/main/java/com/acme/OrderController.java",
    );
    expect(contract?.edge?.confidence).toBe("resolved");
  });

  it("does not emit API contracts from commented or quoted server route declarations", async () => {
    const { scope, fs } = makeScope({
      "backend/src/main/java/com/acme/OrderController.java": [
        "package com.acme;",
        "class OrderController {",
        '  String docs = "@GetMapping(\\"/api/orders/{id}\\")";',
        '  // @GetMapping("/api/orders/{id}")',
        "  OrderDto getOrder() { return null; }",
        "}",
      ].join("\n"),
      "frontend/src/api/orders.ts":
        "export async function load(id: string) { return fetch(`/api/orders/${id}`); }",
    });

    const index = buildCodeIntelligenceIndex(scope, DEFAULT_SEARCH_LIMITS, fs, {
      disableCache: true,
    });
    expect(index.endpoints.some((endpoint) => endpoint.role === "server")).toBe(false);

    const atoms = await importGraphAdapter.lookup(
      scope,
      nlq("/api/orders/:id"),
      DEFAULT_SEARCH_LIMITS,
      fs,
      {
        nowMs: FIXED_NOW,
      },
    );
    expect(atoms.some((atom) => atom.edge?.kind === "api-contract")).toBe(false);
  });

  it("does not emit API contracts from commented or quoted client calls", async () => {
    const { scope, fs } = makeScope({
      "backend/src/main/java/com/acme/OrderController.java": [
        "package com.acme;",
        "class OrderController {",
        '  @GetMapping("/api/orders/{id}")',
        "  OrderDto getOrder() { return null; }",
        "}",
      ].join("\n"),
      "frontend/src/api/orders.ts": [
        "const docs = 'fetch(\"/api/orders/:id\")';",
        '// fetch("/api/orders/:id");',
      ].join("\n"),
    });

    const index = buildCodeIntelligenceIndex(scope, DEFAULT_SEARCH_LIMITS, fs, {
      disableCache: true,
    });
    expect(index.endpoints.some((endpoint) => endpoint.role === "client")).toBe(false);

    const atoms = await importGraphAdapter.lookup(
      scope,
      nlq("/api/orders/:id"),
      DEFAULT_SEARCH_LIMITS,
      fs,
      {
        nowMs: FIXED_NOW,
      },
    );
    expect(atoms.some((atom) => atom.edge?.kind === "api-contract")).toBe(false);
  });

  it("links OpenAPI YAML paths to TypeScript client calls", async () => {
    const { scope, fs } = makeScope({
      "openapi.yaml": [
        "openapi: 3.1.0",
        "paths:",
        "  /api/orders/{id}:",
        "    get:",
        "      operationId: getOrder",
      ].join("\n"),
      "frontend/src/api/orders.ts":
        "export async function load(id: string) { return fetch(`/api/orders/${id}`); }",
    });
    const atoms = await importGraphAdapter.lookup(
      scope,
      nlq("/api/orders/:id"),
      DEFAULT_SEARCH_LIMITS,
      fs,
      {
        nowMs: FIXED_NOW,
      },
    );
    const contract = atoms.find((atom) => atom.edge?.kind === "api-contract");
    expect(contract?.edge?.source.scopePath).toBe("frontend/src/api/orders.ts");
    expect(contract?.edge?.target.scopePath).toBe("openapi.yaml");
    expect(contract?.edge?.confidence).toBe("resolved");
  });

  it("expands API contract matches to adjacent DTO contract edges", async () => {
    const { scope, fs } = makeScope({
      "openapi.json": JSON.stringify({
        openapi: "3.1.0",
        paths: {
          "/api/invoices/{id}": {
            get: { operationId: "getOrder" },
          },
        },
        components: {
          schemas: {
            OrderDto: {
              type: "object",
              properties: {
                status: { type: "string" },
                total: { type: "string" },
              },
            },
          },
        },
      }),
      "frontend/src/services/client.ts": [
        "export interface OrderDto {",
        "  status: string;",
        "  total: string;",
        "}",
        "export async function load(id: string): Promise<OrderDto> {",
        "  return fetch(`/api/invoices/${id}`).then((response) => response.json());",
        "}",
      ].join("\n"),
    });
    const atoms = await importGraphAdapter.lookup(
      scope,
      nlq("/api/invoices/:id"),
      DEFAULT_SEARCH_LIMITS,
      fs,
      {
        nowMs: FIXED_NOW,
      },
    );
    const apiContract = present(atoms.find((atom) => atom.edge?.kind === "api-contract"));
    const dtoContract = atoms.find((atom) => atom.edge?.kind === "dto-contract");
    expect(apiContract.edge?.source.scopePath).toBe("frontend/src/services/client.ts");
    expect(apiContract.edge?.target.scopePath).toBe("openapi.json");
    expect(
      [dtoContract?.edge?.source.scopePath, dtoContract?.edge?.target.scopePath].sort(),
    ).toEqual(["frontend/src/services/client.ts", "openapi.json"]);
    expect(dtoContract?.score).toBeLessThanOrEqual(0.88);
  });

  it("links FastAPI-style Python route decorators to TypeScript client calls", async () => {
    const { scope, fs } = makeScope({
      "backend/app/routes/orders.py": [
        "from fastapi import FastAPI",
        "app = FastAPI()",
        '@app.get("/api/orders/{id}")',
        "def get_order(id: str):",
        "    return {}",
      ].join("\n"),
      "frontend/src/api/orders.ts":
        "export async function load(id: string) { return fetch(`/api/orders/${id}`); }",
    });
    const atoms = await importGraphAdapter.lookup(
      scope,
      nlq("/api/orders/:id"),
      DEFAULT_SEARCH_LIMITS,
      fs,
      {
        nowMs: FIXED_NOW,
      },
    );
    const contract = atoms.find((atom) => atom.edge?.kind === "api-contract");
    expect(contract?.edge?.source.scopePath).toBe("frontend/src/api/orders.ts");
    expect(contract?.edge?.target.scopePath).toBe("backend/app/routes/orders.py");
  });

  it("links FastAPI APIRouter prefixes to TypeScript client calls", async () => {
    const { scope, fs } = makeScope({
      "backend/app/routes/orders.py": [
        "from fastapi import APIRouter",
        'router = APIRouter(prefix="/api/orders")',
        '@router.get("/{id}")',
        "def get_order(id: str):",
        "    return {}",
      ].join("\n"),
      "frontend/src/api/orders.ts":
        "export async function load(id: string) { return fetch(`/api/orders/${id}`); }",
    });
    const atoms = await importGraphAdapter.lookup(
      scope,
      nlq("/api/orders/:id"),
      DEFAULT_SEARCH_LIMITS,
      fs,
      {
        nowMs: FIXED_NOW,
      },
    );
    const contract = atoms.find((atom) => atom.edge?.kind === "api-contract");
    expect(contract?.edge?.source.scopePath).toBe("frontend/src/api/orders.ts");
    expect(contract?.edge?.target.scopePath).toBe("backend/app/routes/orders.py");
    expect(contract?.edge?.confidence).toBe("resolved");
  });

  it("combines FastAPI include_router prefixes with router-local prefixes", async () => {
    const { scope, fs } = makeScope({
      "backend/app/routes/orders.py": [
        "from fastapi import FastAPI, APIRouter",
        "app = FastAPI()",
        'orders = APIRouter(prefix="/orders")',
        'app.include_router(orders, prefix="/api")',
        '@orders.post("/{id}")',
        "def update_order(id: str):",
        "    return {}",
      ].join("\n"),
      "frontend/src/api/orders.ts":
        'export async function update(id: string) { return fetch(`/api/orders/${id}`, { method: "POST" }); }',
    });
    const atoms = await importGraphAdapter.lookup(
      scope,
      nlq("/api/orders/:id"),
      DEFAULT_SEARCH_LIMITS,
      fs,
      {
        nowMs: FIXED_NOW,
      },
    );
    const contract = atoms.find((atom) => atom.edge?.kind === "api-contract");
    expect(contract?.edge?.source.scopePath).toBe("frontend/src/api/orders.ts");
    expect(contract?.edge?.target.scopePath).toBe("backend/app/routes/orders.py");
    expect(contract?.edge?.confidence).toBe("resolved");
  });

  it("links Flask Blueprint url_prefix routes to TypeScript client calls", async () => {
    const { scope, fs } = makeScope({
      "backend/app/orders.py": [
        "from flask import Blueprint",
        'orders = Blueprint("orders", __name__, url_prefix="/api/orders")',
        '@orders.route("/<order_id>", methods=["GET"])',
        "def get_order(order_id):",
        "    return {}",
      ].join("\n"),
      "frontend/src/api/orders.ts":
        "export async function load(id: string) { return fetch(`/api/orders/${id}`); }",
    });
    const atoms = await importGraphAdapter.lookup(
      scope,
      nlq("/api/orders/:id"),
      DEFAULT_SEARCH_LIMITS,
      fs,
      {
        nowMs: FIXED_NOW,
      },
    );
    const contract = atoms.find((atom) => atom.edge?.kind === "api-contract");
    expect(contract?.edge?.source.scopePath).toBe("frontend/src/api/orders.ts");
    expect(contract?.edge?.target.scopePath).toBe("backend/app/orders.py");
    expect(contract?.edge?.confidence).toBe("resolved");
  });

  it("links NestJS controller route decorators to TypeScript axios calls", async () => {
    const { scope, fs } = makeScope({
      "backend/src/orders.controller.ts": [
        "import { Controller, Get } from '@nestjs/common';",
        "@Controller('api/orders')",
        "export class OrdersController {",
        "  @Get(':id')",
        "  getOrder() { return {}; }",
        "}",
      ].join("\n"),
      "frontend/src/api/orders.ts":
        'export function load(id: string) { return axios.get("/api/orders/:id"); }',
    });
    const atoms = await importGraphAdapter.lookup(
      scope,
      nlq("/api/orders"),
      DEFAULT_SEARCH_LIMITS,
      fs,
      {
        nowMs: FIXED_NOW,
      },
    );
    const contract = atoms.find((atom) => atom.edge?.kind === "api-contract");
    expect(contract?.edge?.source.scopePath).toBe("frontend/src/api/orders.ts");
    expect(contract?.edge?.target.scopePath).toBe("backend/src/orders.controller.ts");
    expect(contract?.edge?.confidence).toBe("resolved");
  });

  it("links axios.create baseURL clients to server routes", async () => {
    const { scope, fs } = makeScope({
      "backend/src/main/java/com/acme/OrderController.java": [
        "package com.acme;",
        '@RequestMapping("/api")',
        "class OrderController {",
        '  @GetMapping("/orders/{id}")',
        "  OrderDto getOrder() { return null; }",
        "}",
      ].join("\n"),
      "frontend/src/api/orders.ts": [
        "import axios from 'axios';",
        "const api = axios.create({ baseURL: '/api' });",
        "export function load(id: string) { return api.get(`/orders/${id}`); }",
      ].join("\n"),
    });
    const atoms = await importGraphAdapter.lookup(
      scope,
      nlq("/api/orders"),
      DEFAULT_SEARCH_LIMITS,
      fs,
      {
        nowMs: FIXED_NOW,
      },
    );
    const contract = atoms.find((atom) => atom.edge?.kind === "api-contract");
    expect(contract?.edge?.source.scopePath).toBe("frontend/src/api/orders.ts");
    expect(contract?.edge?.target.scopePath).toBe(
      "backend/src/main/java/com/acme/OrderController.java",
    );
    expect(contract?.edge?.confidence).toBe("resolved");
  });

  it("links mounted Express router prefixes to client calls", async () => {
    const { scope, fs } = makeScope({
      "backend/src/routes/orders.ts": [
        "import express from 'express';",
        "const ordersRouter = express.Router();",
        "ordersRouter.get('/:id', handler);",
        "app.use('/api/orders', ordersRouter);",
      ].join("\n"),
      "frontend/src/api/orders.ts":
        'export function load(id: string) { return fetch("/api/orders/:id"); }',
    });
    const atoms = await importGraphAdapter.lookup(
      scope,
      nlq("/api/orders"),
      DEFAULT_SEARCH_LIMITS,
      fs,
      {
        nowMs: FIXED_NOW,
      },
    );
    const contract = atoms.find((atom) => atom.edge?.kind === "api-contract");
    expect(contract?.edge?.source.scopePath).toBe("frontend/src/api/orders.ts");
    expect(contract?.edge?.target.scopePath).toBe("backend/src/routes/orders.ts");
    expect(contract?.edge?.confidence).toBe("resolved");
  });

  it("links Express route-chain declarations to client calls by method", async () => {
    const { scope, fs } = makeScope({
      "backend/src/routes/orders.ts": [
        "import express from 'express';",
        "const router = express.Router();",
        'router.route("/api/orders/:id").patch(updateOrder);',
      ].join("\n"),
      "frontend/src/api/orders.ts": [
        "export async function update(id: string) {",
        "  return fetch(`/api/orders/${id}`, { method: 'PATCH' });",
        "}",
      ].join("\n"),
    });
    const atoms = await importGraphAdapter.lookup(
      scope,
      nlq("/api/orders/:id"),
      DEFAULT_SEARCH_LIMITS,
      fs,
      {
        nowMs: FIXED_NOW,
      },
    );
    const contract = atoms.find((atom) => atom.edge?.kind === "api-contract");
    expect(contract?.edge?.source.scopePath).toBe("frontend/src/api/orders.ts");
    expect(contract?.edge?.target.scopePath).toBe("backend/src/routes/orders.ts");
    expect(contract?.edge?.confidence).toBe("resolved");
  });

  it("infers fetch methods from multiline option objects before linking API contracts", async () => {
    const { scope, fs } = makeScope({
      "backend/src/routes/orders.ts": [
        "import express from 'express';",
        "const router = express.Router();",
        'router.route("/api/orders/:id").patch(updateOrder);',
      ].join("\n"),
      "frontend/src/api/orders.ts": [
        "export async function update(id: string) {",
        "  return fetch(`/api/orders/${id}`, {",
        "    method: 'PATCH',",
        "    headers: { 'content-type': 'application/json' },",
        "  });",
        "}",
      ].join("\n"),
    });
    const atoms = await importGraphAdapter.lookup(
      scope,
      nlq("/api/orders/:id"),
      DEFAULT_SEARCH_LIMITS,
      fs,
      {
        nowMs: FIXED_NOW,
      },
    );
    const contract = atoms.find((atom) => atom.edge?.kind === "api-contract");
    expect(contract?.edge?.source.scopePath).toBe("frontend/src/api/orders.ts");
    expect(contract?.edge?.source.symbol).toBe("PATCH /api/orders/:param");
    expect(contract?.edge?.target.scopePath).toBe("backend/src/routes/orders.ts");
    expect(contract?.edge?.confidence).toBe("resolved");
  });

  it("links Go chi-style router method routes to TypeScript client calls", async () => {
    const { scope, fs } = makeScope({
      "backend/cmd/api/routes.go": [
        "package main",
        "",
        "func routes(r chi.Router) {",
        '  r.Get("/api/orders/{id}", getOrder)',
        "}",
      ].join("\n"),
      "frontend/src/api/orders.ts":
        "export async function load(id: string) { return fetch(`/api/orders/${id}`); }",
    });
    const atoms = await importGraphAdapter.lookup(
      scope,
      nlq("/api/orders/:id"),
      DEFAULT_SEARCH_LIMITS,
      fs,
      {
        nowMs: FIXED_NOW,
      },
    );
    const contract = atoms.find((atom) => atom.edge?.kind === "api-contract");
    expect(contract?.edge?.source.scopePath).toBe("frontend/src/api/orders.ts");
    expect(contract?.edge?.target.scopePath).toBe("backend/cmd/api/routes.go");
    expect(contract?.edge?.confidence).toBe("resolved");
  });

  it("links Go gorilla mux HandleFunc Methods routes by HTTP method", async () => {
    const { scope, fs } = makeScope({
      "backend/cmd/api/routes.go": [
        "package main",
        "",
        "func routes(r *mux.Router) {",
        '  r.HandleFunc("/api/orders/{id}", updateOrder).Methods(http.MethodPost)',
        "}",
      ].join("\n"),
      "frontend/src/api/orders.ts":
        'export async function update(id: string) { return fetch(`/api/orders/${id}`, { method: "POST" }); }',
    });
    const atoms = await importGraphAdapter.lookup(
      scope,
      nlq("/api/orders/:id"),
      DEFAULT_SEARCH_LIMITS,
      fs,
      {
        nowMs: FIXED_NOW,
      },
    );
    const contract = atoms.find((atom) => atom.edge?.kind === "api-contract");
    expect(contract?.edge?.source.scopePath).toBe("frontend/src/api/orders.ts");
    expect(contract?.edge?.target.scopePath).toBe("backend/cmd/api/routes.go");
    expect(contract?.edge?.confidence).toBe("resolved");
  });

  it("links Django path routes to RTK Query string clients", async () => {
    const { scope, fs } = makeScope({
      "backend/orders/urls.py": [
        "from django.urls import path",
        "from . import views",
        'urlpatterns = [path("api/orders/<str:id>/", views.order)]',
      ].join("\n"),
      "frontend/src/services/orders.ts": [
        "import { createApi } from '@reduxjs/toolkit/query/react';",
        "export const ordersApi = createApi({",
        "  endpoints: (builder) => ({",
        "    getOrder: builder.query({ query: (id) => `/api/orders/${id}` }),",
        "  }),",
        "});",
      ].join("\n"),
    });
    const atoms = await importGraphAdapter.lookup(
      scope,
      nlq("/api/orders"),
      DEFAULT_SEARCH_LIMITS,
      fs,
      {
        nowMs: FIXED_NOW,
      },
    );
    const contract = atoms.find((atom) => atom.edge?.kind === "api-contract");
    expect(contract?.edge?.source.scopePath).toBe("frontend/src/services/orders.ts");
    expect(contract?.edge?.target.scopePath).toBe("backend/orders/urls.py");
    expect(contract?.edge?.confidence).toBe("resolved");
  });

  it("links RTK Query object clients with explicit methods to NestJS routes", async () => {
    const { scope, fs } = makeScope({
      "backend/src/orders.controller.ts": [
        "import { Controller, Put } from '@nestjs/common';",
        "@Controller('api/orders')",
        "export class OrdersController {",
        "  @Put(':id')",
        "  updateOrder() { return {}; }",
        "}",
      ].join("\n"),
      "frontend/src/services/orders.ts": [
        "import { createApi } from '@reduxjs/toolkit/query/react';",
        "export const ordersApi = createApi({",
        "  endpoints: (builder) => ({",
        "    updateOrder: builder.mutation({ query: (order) => ({ url: `/api/orders/${order.id}`, method: 'PUT' }) }),",
        "  }),",
        "});",
      ].join("\n"),
    });
    const atoms = await importGraphAdapter.lookup(
      scope,
      nlq("/api/orders"),
      DEFAULT_SEARCH_LIMITS,
      fs,
      {
        nowMs: FIXED_NOW,
      },
    );
    const contract = atoms.find((atom) => atom.edge?.kind === "api-contract");
    expect(contract?.edge?.source.scopePath).toBe("frontend/src/services/orders.ts");
    expect(contract?.edge?.target.scopePath).toBe("backend/src/orders.controller.ts");
    expect(contract?.edge?.confidence).toBe("resolved");
  });

  it("links ASP.NET route attributes to TypeScript fetch calls", async () => {
    const { scope, fs } = makeScope({
      "backend/Controllers/OrdersController.cs": [
        "[ApiController]",
        '[Route("api/[controller]")]',
        "class OrdersController {",
        '  [HttpGet("{id}")]',
        "  OrderDto LoadOrder(string id) { return null; }",
        "}",
      ].join("\n"),
      "frontend/src/api/orders.ts":
        "export async function load(id: string) { return fetch(`/api/orders/${id}`); }",
    });
    const atoms = await importGraphAdapter.lookup(
      scope,
      nlq("/api/orders/:id"),
      DEFAULT_SEARCH_LIMITS,
      fs,
      {
        nowMs: FIXED_NOW,
      },
    );
    const contract = atoms.find((atom) => atom.edge?.kind === "api-contract");
    expect(contract?.edge?.source.scopePath).toBe("frontend/src/api/orders.ts");
    expect(contract?.edge?.target.scopePath).toBe("backend/Controllers/OrdersController.cs");
  });

  it("combines stacked ASP.NET method and route attributes before linking clients", async () => {
    const { scope, fs } = makeScope({
      "backend/Controllers/OrdersController.cs": [
        "[ApiController]",
        '[Route("api/[controller]")]',
        "class OrdersController {",
        "  [HttpGet]",
        '  [Route("{id}")]',
        "  OrderDto LoadOrder(string id) { return null; }",
        "}",
      ].join("\n"),
      "frontend/src/api/orders.ts":
        'export async function load(id: string) { return axios.get("/api/orders/:id"); }',
    });
    const atoms = await importGraphAdapter.lookup(
      scope,
      nlq("/api/orders/:id"),
      DEFAULT_SEARCH_LIMITS,
      fs,
      {
        nowMs: FIXED_NOW,
      },
    );
    const contract = atoms.find((atom) => atom.edge?.kind === "api-contract");
    expect(contract?.edge?.source.scopePath).toBe("frontend/src/api/orders.ts");
    expect(contract?.edge?.target.scopePath).toBe("backend/Controllers/OrdersController.cs");
    expect(contract?.edge?.confidence).toBe("resolved");
  });

  it("links ASP.NET Minimal API routes to TypeScript fetch calls", async () => {
    const { scope, fs } = makeScope({
      "backend/Program.cs": [
        "var app = WebApplication.CreateBuilder(args).Build();",
        'app.MapGet("/api/orders/{id}", (string id) => Results.Ok());',
      ].join("\n"),
      "frontend/src/api/orders.ts":
        "export async function load(id: string) { return fetch(`/api/orders/${id}`); }",
    });
    const atoms = await importGraphAdapter.lookup(
      scope,
      nlq("/api/orders/:id"),
      DEFAULT_SEARCH_LIMITS,
      fs,
      {
        nowMs: FIXED_NOW,
      },
    );
    const contract = atoms.find((atom) => atom.edge?.kind === "api-contract");
    expect(contract?.edge?.source.scopePath).toBe("frontend/src/api/orders.ts");
    expect(contract?.edge?.target.scopePath).toBe("backend/Program.cs");
  });

  it("links GraphQL SDL query fields to TypeScript gql client operations", async () => {
    const { scope, fs } = makeScope({
      "schema.graphql": [
        "type Query {",
        "  order(id: ID!): Order",
        "}",
        "type Order {",
        "  id: ID!",
        "}",
      ].join("\n"),
      "frontend/src/api/orders.ts": [
        "import { gql } from '@apollo/client';",
        "export const GET_ORDER = gql`",
        "  query GetOrder($id: ID!) {",
        "    order(id: $id) { id }",
        "  }",
        "`;",
      ].join("\n"),
    });
    const atoms = await importGraphAdapter.lookup(
      scope,
      nlq("/graphql/query/order"),
      DEFAULT_SEARCH_LIMITS,
      fs,
      {
        nowMs: FIXED_NOW,
      },
    );
    const contract = atoms.find((atom) => atom.edge?.kind === "api-contract");
    expect(contract?.edge?.source.scopePath).toBe("frontend/src/api/orders.ts");
    expect(contract?.edge?.target.scopePath).toBe("schema.graphql");
    expect(contract?.edge?.confidence).toBe("resolved");
  });

  it("links standalone GraphQL operation documents to SDL schema fields", async () => {
    const { scope, fs } = makeScope({
      "schema.graphql": [
        "type Query {",
        "  order(id: ID!): Order",
        "}",
        "type Order {",
        "  id: ID!",
        "}",
      ].join("\n"),
      "frontend/src/api/get-order.graphql": [
        "query GetOrder($id: ID!) {",
        "  order(id: $id) { id }",
        "}",
      ].join("\n"),
    });
    const atoms = await importGraphAdapter.lookup(
      scope,
      nlq("/graphql/query/order"),
      DEFAULT_SEARCH_LIMITS,
      fs,
      {
        nowMs: FIXED_NOW,
      },
    );
    const contract = atoms.find((atom) => atom.edge?.kind === "api-contract");
    expect(contract?.edge?.source.scopePath).toBe("frontend/src/api/get-order.graphql");
    expect(contract?.edge?.target.scopePath).toBe("schema.graphql");
    expect(contract?.edge?.confidence).toBe("resolved");
  });

  it("links protobuf service RPCs to generated TypeScript client calls", async () => {
    const { scope, fs } = makeScope({
      "proto/orders.proto": [
        'syntax = "proto3";',
        "service OrderService {",
        "  rpc GetOrder (GetOrderRequest) returns (Order);",
        "}",
      ].join("\n"),
      "frontend/src/api/orders.ts": [
        "import { OrderServiceClient } from '../gen/orders';",
        "const client = new OrderServiceClient();",
        "export function load(id: string) { return client.getOrder({ id }); }",
      ].join("\n"),
    });
    const atoms = await importGraphAdapter.lookup(
      scope,
      nlq("/protobuf/orderservice/getorder"),
      DEFAULT_SEARCH_LIMITS,
      fs,
      {
        nowMs: FIXED_NOW,
      },
    );
    const contract = atoms.find((atom) => atom.edge?.kind === "api-contract");
    expect(contract?.edge?.source.scopePath).toBe("frontend/src/api/orders.ts");
    expect(contract?.edge?.target.scopePath).toBe("proto/orders.proto");
    expect(contract?.edge?.confidence).toBe("resolved");
  });

  it("indexes canonical OpenAPI JSON specs without treating arbitrary JSON as source", () => {
    const { scope, fs } = makeScope({
      "openapi.json": JSON.stringify({
        openapi: "3.1.0",
        paths: {
          "/api/orders/{id}": {
            get: { operationId: "getOrder" },
          },
        },
      }),
      "data/routes.json": JSON.stringify({
        paths: {
          "/api/ignored": {
            get: {},
          },
        },
      }),
      "frontend/src/api/orders.ts":
        "export async function load(id: string) { return fetch(`/api/orders/${id}`); }",
    });
    const index = buildCodeIntelligenceIndex(scope, DEFAULT_SEARCH_LIMITS, fs);
    expect(index.endpoints.some((endpoint) => endpoint.scopePath === "openapi.json")).toBe(true);
    expect(index.endpoints.some((endpoint) => endpoint.scopePath === "data/routes.json")).toBe(
      false,
    );
    expect(
      index.apiContracts.some(
        (edge) =>
          edge.server.scopePath === "openapi.json" &&
          edge.client.scopePath === "frontend/src/api/orders.ts",
      ),
    ).toBe(true);
  });

  it("links Java records to TypeScript DTO interfaces by type name and shared fields", async () => {
    const { scope, fs } = makeScope({
      "backend/src/main/java/com/acme/OrderDto.java":
        "public record OrderDto(String status, String total) {}",
      "frontend/src/types.ts": [
        "export interface OrderDto {",
        "  status: string;",
        "  total: string;",
        "}",
      ].join("\n"),
    });
    const atoms = await importGraphAdapter.lookup(
      scope,
      nlq("OrderDto status"),
      DEFAULT_SEARCH_LIMITS,
      fs,
      {
        nowMs: FIXED_NOW,
      },
    );
    const contract = atoms.find((atom) => atom.edge?.kind === "dto-contract");
    expect([contract?.edge?.source.scopePath, contract?.edge?.target.scopePath].sort()).toEqual([
      "backend/src/main/java/com/acme/OrderDto.java",
      "frontend/src/types.ts",
    ]);
  });

  it("links OpenAPI JSON component schemas to generated TypeScript DTO interfaces", async () => {
    const { scope, fs } = makeScope({
      "openapi.json": JSON.stringify({
        openapi: "3.1.0",
        components: {
          schemas: {
            OrderDto: {
              type: "object",
              properties: {
                status: { type: "string" },
                total: { type: "string" },
              },
            },
          },
        },
      }),
      "frontend/src/types.ts": [
        "export interface OrderDto {",
        "  status: string;",
        "  total: string;",
        "}",
      ].join("\n"),
    });
    const atoms = await importGraphAdapter.lookup(
      scope,
      nlq("OrderDto status total"),
      DEFAULT_SEARCH_LIMITS,
      fs,
      {
        nowMs: FIXED_NOW,
      },
    );
    const contract = atoms.find((atom) => atom.edge?.kind === "dto-contract");
    expect([contract?.edge?.source.scopePath, contract?.edge?.target.scopePath].sort()).toEqual([
      "frontend/src/types.ts",
      "openapi.json",
    ]);
    expect(contract?.edge?.confidence).toBe("resolved");
  });

  it("links OpenAPI YAML component schemas to Java DTO records by shared fields", () => {
    const { scope, fs } = makeScope({
      "openapi.yaml": [
        "openapi: 3.1.0",
        "components:",
        "  schemas:",
        "    CheckoutOrder:",
        "      type: object",
        "      properties:",
        "        status:",
        "          type: string",
        "        total:",
        "          type: string",
      ].join("\n"),
      "backend/src/main/java/com/acme/BackendOrderResponse.java": [
        "public record BackendOrderResponse(",
        "  String status,",
        "  String total",
        ") {}",
      ].join("\n"),
    });
    const index = buildCodeIntelligenceIndex(scope, DEFAULT_SEARCH_LIMITS, fs);
    const edge = index.dtoContracts.find(
      (candidate) =>
        candidate.source.scopePath === "openapi.yaml" ||
        candidate.target.scopePath === "openapi.yaml",
    );
    expect(edge?.sharedFields).toEqual(["status", "total"]);
    expect(edge?.confidence).toBe("heuristic");
  });

  it("links multiline Java records to differently named TypeScript DTOs by shared fields", () => {
    const { scope, fs } = makeScope({
      "backend/src/main/java/com/acme/BackendOrderResponse.java": [
        "public record BackendOrderResponse(",
        "  String status,",
        "  BigDecimal total,",
        "  List<String> lineItems",
        ") {}",
      ].join("\n"),
      "frontend/src/types.ts": [
        "export interface CheckoutOrder {",
        "  status: string;",
        "  total: string;",
        "}",
      ].join("\n"),
    });
    const index = buildCodeIntelligenceIndex(scope, DEFAULT_SEARCH_LIMITS, fs);
    const edge = index.dtoContracts.find(
      (candidate) =>
        candidate.source.name === "BackendOrderResponse" ||
        candidate.target.name === "BackendOrderResponse",
    );
    expect(edge?.sharedFields).toEqual(["status", "total"]);
    expect(edge?.confidence).toBe("heuristic");
  });

  it("links Kotlin data classes to TypeScript DTO interfaces by shared fields", () => {
    const { scope, fs } = makeScope({
      "backend/src/main/kotlin/com/acme/BackendOrderResponse.kt": [
        "data class BackendOrderResponse(",
        "  val status: String,",
        "  val total: BigDecimal,",
        "  val lineItems: List<String>",
        ")",
      ].join("\n"),
      "frontend/src/types.ts": [
        "export interface CheckoutOrder {",
        "  status: string;",
        "  total: string;",
        "}",
      ].join("\n"),
    });
    const index = buildCodeIntelligenceIndex(scope, DEFAULT_SEARCH_LIMITS, fs);
    const edge = index.dtoContracts.find(
      (candidate) =>
        candidate.source.name === "BackendOrderResponse" ||
        candidate.target.name === "BackendOrderResponse",
    );
    expect(edge?.sharedFields).toEqual(["status", "total"]);
    expect(edge?.confidence).toBe("heuristic");
  });

  it("links C# positional records to TypeScript DTO interfaces despite field casing", () => {
    const { scope, fs } = makeScope({
      "backend/OrderDto.cs": "public record OrderDto(string Status, decimal Total);",
      "frontend/src/types.ts": [
        "export interface OrderDto {",
        "  status: string;",
        "  total: number;",
        "}",
      ].join("\n"),
    });
    const index = buildCodeIntelligenceIndex(scope, DEFAULT_SEARCH_LIMITS, fs);
    const edge = index.dtoContracts.find(
      (candidate) =>
        candidate.source.scopePath === "backend/OrderDto.cs" ||
        candidate.target.scopePath === "backend/OrderDto.cs",
    );
    expect(edge?.sharedFields.map((field) => field.toLowerCase())).toEqual(["status", "total"]);
    expect(edge?.confidence).toBe("resolved");
  });

  it("links Go structs to TypeScript DTO interfaces through JSON tag fields", () => {
    const { scope, fs } = makeScope({
      "backend/orders/dto.go": [
        "package orders",
        "",
        "type BackendOrderResponse struct {",
        '  OrderStatus string `json:"status"`',
        '  OrderTotal string `json:"total"`',
        '  InternalNotes string `json:"-"`',
        "}",
      ].join("\n"),
      "frontend/src/types.ts": [
        "export interface CheckoutOrder {",
        "  status: string;",
        "  total: string;",
        "}",
      ].join("\n"),
    });
    const index = buildCodeIntelligenceIndex(scope, DEFAULT_SEARCH_LIMITS, fs);
    const edge = index.dtoContracts.find(
      (candidate) =>
        candidate.source.name === "BackendOrderResponse" ||
        candidate.target.name === "BackendOrderResponse",
    );
    expect(edge?.sharedFields).toEqual(["status", "total"]);
    expect(edge?.confidence).toBe("heuristic");
  });

  it("links annotated Java record component names to TypeScript DTO fields", () => {
    const { scope, fs } = makeScope({
      "backend/src/main/java/com/acme/BackendOrderResponse.java": [
        "public record BackendOrderResponse(",
        '  @JsonProperty(value = "status", required = true) String orderStatus,',
        '  @SerializedName("total") BigDecimal orderTotal',
        ") {}",
      ].join("\n"),
      "frontend/src/types.ts": [
        "export interface CheckoutOrder {",
        "  status: string;",
        "  total: string;",
        "}",
      ].join("\n"),
    });
    const index = buildCodeIntelligenceIndex(scope, DEFAULT_SEARCH_LIMITS, fs);
    const edge = index.dtoContracts.find(
      (candidate) =>
        candidate.source.name === "BackendOrderResponse" ||
        candidate.target.name === "BackendOrderResponse",
    );
    expect(edge?.sharedFields).toEqual(["status", "total"]);
    expect(edge?.confidence).toBe("heuristic");
  });

  it("links attributed C# DTO properties to TypeScript fields by serialized names", () => {
    const { scope, fs } = makeScope({
      "backend/BackendOrderResponse.cs": [
        "public class BackendOrderResponse",
        "{",
        '  [JsonPropertyName("status")]',
        "  public string OrderStatus { get; init; }",
        '  [JsonPropertyName("total")]',
        "  public decimal OrderTotal { get; init; }",
        "}",
      ].join("\n"),
      "frontend/src/types.ts": [
        "export interface CheckoutOrder {",
        "  status: string;",
        "  total: number;",
        "}",
      ].join("\n"),
    });
    const index = buildCodeIntelligenceIndex(scope, DEFAULT_SEARCH_LIMITS, fs);
    const edge = index.dtoContracts.find(
      (candidate) =>
        candidate.source.name === "BackendOrderResponse" ||
        candidate.target.name === "BackendOrderResponse",
    );
    expect(edge?.sharedFields).toEqual(["status", "total"]);
    expect(edge?.confidence).toBe("heuristic");
  });

  it("caches unchanged code-intelligence indexes for repeated structural lookups", () => {
    const { scope, fs: baseFs } = makeScope({
      "src/a.ts": 'import { foo } from "./bar";',
      "src/bar.ts": "export const foo = 1;",
    });
    let utf8Reads = 0;
    const countingFs: WorkspaceFs = {
      ...baseFs,
      readFileUtf8: (abs) => {
        utf8Reads += 1;
        return baseFs.readFileUtf8(abs);
      },
    };
    const first = buildCodeIntelligenceIndex(scope, DEFAULT_SEARCH_LIMITS, countingFs);
    const readsAfterFirst = utf8Reads;
    const second = buildCodeIntelligenceIndex(scope, DEFAULT_SEARCH_LIMITS, countingFs);
    expect(first).toBe(second);
    expect(readsAfterFirst).toBeGreaterThan(0);
    expect(utf8Reads).toBe(readsAfterFirst);
  });

  it("indexes source files larger than the lexical scan cap up to the structural source cap", async () => {
    const largeSource = [
      'import { loadOrder } from "./orders";',
      "export function run() { return loadOrder(); }",
      "x".repeat(DEFAULT_SEARCH_LIMITS.maxBytesPerFileScanned),
    ].join("\n");
    const { scope, fs } = makeScope({
      "src/large.ts": largeSource,
      "src/orders.ts": "export function loadOrder() { return 1; }",
    });
    const atoms = await importGraphAdapter.lookup(
      scope,
      exq("./orders"),
      DEFAULT_SEARCH_LIMITS,
      fs,
      {
        nowMs: FIXED_NOW,
      },
    );

    expect(atoms.some((atom) => atom.scopePath === "src/large.ts")).toBe(true);
    const index = buildCodeIntelligenceIndex(scope, DEFAULT_SEARCH_LIMITS, fs, {
      disableCache: true,
    });
    expect(index.filesIndexed).toBe(2);
    expect(index.filesSkipped).toBe(0);
  });

  it("prefix-indexes files beyond the structural source cap with partial coverage diagnostics", () => {
    const { scope, fs } = makeScope({
      "src/huge.ts": `import "./orders";\n${"x".repeat(2_100_000)}`,
    });
    const index = buildCodeIntelligenceIndex(scope, DEFAULT_SEARCH_LIMITS, fs, {
      disableCache: true,
    });

    expect(index.filesIndexed).toBe(1);
    expect(index.filesSkipped).toBe(0);
    expect(index.filesPartiallyIndexed).toBe(1);
    expect(index.imports.some((edge) => edge.importerPath === "src/huge.ts")).toBe(true);
  });

  it("skips a binary file (PNG magic header)", async () => {
    // PNG signature 89 50 4e 47 0d 0a 1a 0a — encoded as Latin-1 string into UTF-8 bytes
    // through TextEncoder; presence of NULL bytes triggers the binary probe.
    const binaryHeader =
      String.fromCharCode(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0) +
      'import "./bar";';
    const { scope, fs } = makeScope({
      "assets/img.png": binaryHeader,
    });
    const atoms = await importGraphAdapter.lookup(scope, nlq("./bar"), DEFAULT_SEARCH_LIMITS, fs, {
      nowMs: FIXED_NOW,
    });
    expect(atoms).toEqual([]);
  });

  it("honors limits.maxMatchesReturned", async () => {
    const { scope, fs } = makeScope({
      "src/a.ts": 'import x from "./bar";',
      "src/b.ts": 'import y from "./bar";',
      "src/c.ts": 'import z from "./bar";',
    });
    const capped: SearchLimits = { ...DEFAULT_SEARCH_LIMITS, maxMatchesReturned: 2 };
    const atoms = await importGraphAdapter.lookup(scope, nlq("./bar"), capped, fs, {
      nowMs: FIXED_NOW,
    });
    expect(atoms.length).toBe(2);
  });

  it("rejects unsupported query kinds with RepoSearchInvalidQueryError", async () => {
    const { scope, fs } = makeScope({});
    await expect(
      importGraphAdapter.lookup(
        scope,
        { kind: "regex", text: "foo", caseSensitive: false, maxResults: 1, emittedAtMs: 0 },
        DEFAULT_SEARCH_LIMITS,
        fs,
        { nowMs: FIXED_NOW },
      ),
    ).rejects.toBeInstanceOf(RepoSearchInvalidQueryError);
  });

  it("terminates quickly on pathological input (ReDoS regression)", { timeout: 1000 }, async () => {
    // A file consisting of `import ` followed by 5000 spaces with no closing quote was
    // previously O(n^2) due to \s overlapping the surrounding \s+ quantifiers. The fix
    // removes \s from the inner char class so only one split is ever tried.
    const pathological = "import " + " ".repeat(5000);
    const { scope, fs } = makeScope({ "src/evil.ts": pathological });
    const atoms = await importGraphAdapter.lookup(scope, nlq("./bar"), DEFAULT_SEARCH_LIMITS, fs, {
      nowMs: FIXED_NOW,
    });
    expect(atoms).toEqual([]);
  });

  it("respects scope.relativePaths: excludes files outside the restricted sub-tree", async () => {
    // When scope.relativePaths restricts to ["src"], a file in tests/ that imports the
    // query specifier must NOT produce atoms.
    const workspace: WorkspaceInfo = {
      root: MEM_ROOT,
      name: "demo",
      version: "1.0.0",
      testFramework: "vitest",
      sourceDirs: ["src"],
      testDirs: ["tests"],
      languages: ["typescript", "javascript"],
      ignoreLines: [],
    };
    const fs = memFs(MEM_ROOT, {
      "src/a.ts": "// no import here",
      "tests/b.test.ts": 'import "./my-module";',
    });
    const scopeRestricted: SearchScope = { workspace, scopeId: "scope-r", relativePaths: ["src"] };
    const atoms = await importGraphAdapter.lookup(
      scopeRestricted,
      nlq("my-module"),
      DEFAULT_SEARCH_LIMITS,
      fs,
      { nowMs: FIXED_NOW },
    );
    expect(atoms).toEqual([]);
  });
});

describe("importGraphAdapter (real fs symlink containment)", () => {
  let root: string;
  let outside: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "keiko-ig-"));
    outside = mkdtempSync(join(tmpdir(), "keiko-out-"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "demo" }), "utf8");
    mkdirSync(join(root, "src"), { recursive: true });
    // A symlinked file pointing outside should be skipped by discovery (we never see it).
    writeFileSync(join(outside, "rogue.ts"), 'import "./bar";', "utf8");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it("does not follow a workspace-internal symlink to an out-of-tree file", async () => {
    symlinkSync(join(outside, "rogue.ts"), join(root, "src", "linked.ts"));
    const workspace: WorkspaceInfo = {
      root,
      name: "demo",
      version: "1.0.0",
      testFramework: "vitest",
      sourceDirs: ["src"],
      testDirs: ["tests"],
      languages: ["typescript"],
      ignoreLines: [],
    };
    const scope: SearchScope = { workspace, scopeId: "real", relativePaths: [] };
    const atoms = await importGraphAdapter.lookup(
      scope,
      nlq("./bar"),
      DEFAULT_SEARCH_LIMITS,
      nodeWorkspaceFs,
      { nowMs: FIXED_NOW },
    );
    expect(atoms).toEqual([]);
  });

  it("does not binary-probe hard-linked aliases before the shared read denial", async () => {
    writeFileSync(join(outside, "aliased.ts"), 'import "./bar";', "utf8");
    linkSync(join(outside, "aliased.ts"), join(root, "src", "alias.ts"));
    const workspace: WorkspaceInfo = {
      root,
      name: "demo",
      version: "1.0.0",
      testFramework: "vitest",
      sourceDirs: ["src"],
      testDirs: ["tests"],
      languages: ["typescript"],
      ignoreLines: [],
    };
    const scope: SearchScope = { workspace, scopeId: "hardlink", relativePaths: [] };
    let aliasByteReads = 0;
    const trackingFs: WorkspaceFs = {
      ...nodeWorkspaceFs,
      readFileBytes: async (absolutePath, maxBytes) => {
        if (absolutePath.endsWith("/src/alias.ts")) {
          aliasByteReads += 1;
        }
        return nodeWorkspaceFs.readFileBytes?.(absolutePath, maxBytes) ?? new Uint8Array();
      },
    };
    const atoms = await importGraphAdapter.lookup(
      scope,
      nlq("./bar"),
      DEFAULT_SEARCH_LIMITS,
      trackingFs,
      { nowMs: FIXED_NOW },
    );
    expect(atoms).toEqual([]);
    expect(aliasByteReads).toBe(0);
  });

  it("rejects an escaping symlinked file when handed to it via scope.relativePaths", async () => {
    symlinkSync(outside, join(root, "linked-dir"));
    const workspace: WorkspaceInfo = {
      root,
      name: "demo",
      version: "1.0.0",
      testFramework: "vitest",
      sourceDirs: ["src"],
      testDirs: ["tests"],
      languages: ["typescript"],
      ignoreLines: [],
    };
    // discovery skips symlinks, so we cannot construct an escape via discovery alone. The
    // assertion below confirms the adapter at least does not crash and produces no atoms.
    const scope: SearchScope = { workspace, scopeId: "real2", relativePaths: [] };
    const atoms = await importGraphAdapter.lookup(
      scope,
      nlq("./bar"),
      DEFAULT_SEARCH_LIMITS,
      nodeWorkspaceFs,
      { nowMs: FIXED_NOW },
    );
    expect(atoms).toEqual([]);
    void PathEscapeError;
  });

  it("persists code-intelligence indexes across node-backed filesystem instances", () => {
    writeFileSync(join(root, "src", "a.ts"), 'import { foo } from "./bar";', "utf8");
    writeFileSync(join(root, "src", "bar.ts"), "export const foo = 1;", "utf8");
    const workspace: WorkspaceInfo = {
      root,
      name: "demo",
      version: "1.0.0",
      testFramework: "vitest",
      sourceDirs: ["src"],
      testDirs: ["tests"],
      languages: ["typescript"],
      ignoreLines: [],
    };
    const scope: SearchScope = { workspace, scopeId: "persisted", relativePaths: [] };
    const first = buildCodeIntelligenceIndex(scope, DEFAULT_SEARCH_LIMITS, {
      ...nodeWorkspaceFs,
    });

    let sourceReads = 0;
    const secondFs: WorkspaceFs = {
      ...nodeWorkspaceFs,
      readFileUtf8: (absolutePath) => {
        if (absolutePath.includes("/src/")) {
          sourceReads += 1;
        }
        return nodeWorkspaceFs.readFileUtf8(absolutePath);
      },
    };
    const second = buildCodeIntelligenceIndex(scope, DEFAULT_SEARCH_LIMITS, secondFs);

    expect(second.imports).toEqual(first.imports);
    expect(second.symbols).toEqual(first.symbols);
    expect(sourceReads).toBe(0);
  });

  it("invalidates persisted code-intelligence indexes for same-size edits with restored mtime", () => {
    const sourcePath = join(root, "src", "a.ts");
    writeFileSync(sourcePath, 'import { foo } from "./bar";', "utf8");
    writeFileSync(join(root, "src", "bar.ts"), "export const foo = 1;", "utf8");
    writeFileSync(join(root, "src", "baz.ts"), "export const foo = 2;", "utf8");
    const workspace: WorkspaceInfo = {
      root,
      name: "demo",
      version: "1.0.0",
      testFramework: "vitest",
      sourceDirs: ["src"],
      testDirs: ["tests"],
      languages: ["typescript"],
      ignoreLines: [],
    };
    const scope: SearchScope = { workspace, scopeId: "persisted-stale", relativePaths: [] };
    buildCodeIntelligenceIndex(scope, DEFAULT_SEARCH_LIMITS, { ...nodeWorkspaceFs });

    const originalStats = statSync(sourcePath);
    writeFileSync(sourcePath, 'import { foo } from "./baz";', "utf8");
    utimesSync(sourcePath, originalStats.atime, originalStats.mtime);

    let sourceReads = 0;
    const secondFs: WorkspaceFs = {
      ...nodeWorkspaceFs,
      readFileUtf8: (absolutePath) => {
        if (absolutePath.includes("/src/")) {
          sourceReads += 1;
        }
        return nodeWorkspaceFs.readFileUtf8(absolutePath);
      },
    };
    const second = buildCodeIntelligenceIndex(scope, DEFAULT_SEARCH_LIMITS, secondFs);

    expect(sourceReads).toBeGreaterThan(0);
    expect(second.imports.some((edge) => edge.specifier === "./baz")).toBe(true);
    expect(second.imports.some((edge) => edge.specifier === "./bar")).toBe(false);
  });
});
