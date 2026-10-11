import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, rmSync, unlinkSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { collectPolicyInventory, collectPolicySubject } from "../lib/code-quality-inventory.mjs";
import ts from "typescript";
import { declarationMapPosition } from "../lib/code-quality-provenance.mjs";
import { createSymbolResolver } from "../lib/code-quality-symbols.mjs";
import { createRawHelperEnforcementFixture } from "./support/code-quality-responsibility-fixture.mjs";
import {
  createSymbolFixture,
  emitSymbolFixture,
  packSymbolFixture,
} from "./support/code-quality-symbol-fixture.mjs";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});

const { execFileSync: originalExecFileSync } = await vi.importActual("node:child_process");
const fixtures = [];
afterEach(() => {
  vi.mocked(execFileSync).mockReset();
  vi.mocked(execFileSync).mockImplementation(originalExecFileSync);
  for (const { root, resolver } of fixtures.splice(0)) {
    resolver?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
async function fixture(options = {}) {
  const own = createSymbolFixture();
  fixtures.push(own);
  own.subject = await collectPolicySubject(own.root);
  own.resolver = createSymbolResolver(own.subject, options);
  return own;
}
const reference = { consumerPath: "src/consumer.ts", specifier: "alpha", exportName: "parse" };

describe("configured canonical symbol resolver interface (#3918)", () => {
  it("resolves exact raw helper checking operations through its actual compiler owner", async () => {
    const own = createRawHelperEnforcementFixture();
    fixtures.push(own);
    own.resolver = createSymbolResolver(await collectPolicySubject(own.root));
    const identity = own.resolver.resolveExport(own.record.input).identities[0];
    const slots = own.resolver.rawCheckingSlots(identity, 0);
    expect(slots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rule: "anti-slop/no-runtime-typeof", line: 2, column: 10 }),
        expect.objectContaining({ rule: "anti-slop/no-known-value-widening", line: 7, column: 15 }),
      ]),
    );
  }, 15_000);
  it("reuses guarded raw checking facts without exposing a mutable cache or surviving source changes", async () => {
    const own = createRawHelperEnforcementFixture("aliases");
    fixtures.push(own);
    own.resolver = createSymbolResolver(await collectPolicySubject(own.root));
    const identity = own.resolver.resolveExport(own.record.input).identities[0];
    const first = own.resolver.rawCheckingSlots(identity, 0);
    const before = own.resolver.stats();
    const expected = structuredClone(first);
    first[0].column = 999;
    expect(own.resolver.rawCheckingSlots(identity, 0)).toEqual(expected);
    expect(own.resolver.stats()).toEqual(before);
    own.put("packages/alpha/src/owner.ts", "export const changed = true;\n");
    expect(() => own.resolver.rawCheckingSlots(identity, 0)).toThrow("symbol-subject-changed");
  }, 15_000);

  it.each([{ aliases: 1 }, { nodes: 1 }])(
    "keeps raw checking traversal inside actual configured budgets %j",
    async (limits) => {
      const own = createRawHelperEnforcementFixture("aliases");
      fixtures.push(own);
      own.resolver = createSymbolResolver(await collectPolicySubject(own.root), limits);
      expect(() => {
        const identity = own.resolver.resolveExport(own.record.input).identities[0];
        return own.resolver.rawCheckingSlots(identity, 0);
      }).toThrow(/symbol-(alias|node)-budget/u);
    },
    15_000,
  );

  it("qualifies actual native nested/generated owner declarations without API-emitter map equivalence", async () => {
    const own = createSymbolFixture();
    fixtures.push(own);
    const fields = Array.from(
      { length: 32 },
      (_, index) =>
        `readonly item${index}: { readonly nested: readonly { readonly value: number }[] };`,
    ).join("\n");
    const values = Array.from(
      { length: 16 },
      (_, index) => `{ kind: 'kind${index}', values: [${index}, ${index + 1}] }`,
    ).join(",");
    own.put(
      "packages/alpha/src/generated/catalog.ts",
      `export interface GeneratedCatalog {\n${fields}\n}\nexport const generated = [${values}] as const;\n`,
    );
    own.put(
      "packages/alpha/src/owner.ts",
      "import { generated } from './generated/catalog.js';\nexport function validate(input: unknown): typeof generated { return generated; }\n",
    );
    emitSymbolFixture(own.root);
    own.subject = await collectPolicySubject(own.root);
    own.resolver = createSymbolResolver(own.subject);
    expect(own.resolver.resolveExport(reference).identities[0]).toMatchObject({
      owner: "alpha",
      producer: { path: "packages/alpha/src/owner.ts" },
    });
  });

  it.each(["added", "existing"])("rejects %s nonselected native mapping changes", async (mode) => {
    const own = await fixture();
    const path = join(own.root, "packages/alpha/dist/owner.d.ts.map");
    const payload = JSON.parse(readFileSync(path, "utf8"));
    const changed = structuredClone(payload);
    changed.mappings =
      mode === "added"
        ? `${payload.mappings};AAAA`
        : payload.mappings.slice(0, -1) + (payload.mappings.at(-1) === "A" ? "C" : "A");
    const declaration = ts.createSourceFile(
      "owner.d.ts",
      readFileSync(join(own.root, "packages/alpha/dist/owner.d.ts"), "utf8"),
      ts.ScriptTarget.Latest,
      true,
    ).statements[0];
    expect(declarationMapPosition(declaration, JSON.stringify(changed)).mapped).toEqual(
      declarationMapPosition(declaration, JSON.stringify(payload)).mapped,
    );
    own.put("packages/alpha/dist/owner.d.ts.map", JSON.stringify(changed));
    expect(() => own.resolver.resolveExport(reference)).toThrow("stale-declaration-provenance");
  });

  it.each(["unavailable", "nonzero", "timeout", "output"])(
    "settles actual %s compiler failures and cleans private output",
    async (mode) => {
      const own = await fixture({ emissionTimeout: 250, emissionOutputBytes: 32 });
      let scratch;
      let timedOutPid;
      let failureCode;
      vi.mocked(execFileSync).mockImplementation((_executable, args, options) => {
        if (!args.includes("--emitDeclarationOnly"))
          return originalExecFileSync(_executable, args, options);
        scratch = dirname(args[args.indexOf("--outDir") + 1]);
        if (mode === "unavailable")
          return originalExecFileSync(join(scratch, "missing-compiler"), [], options);
        const scripts = {
          nonzero: "process.exit(7)",
          timeout: "process.stdout.write(String(process.pid)); setInterval(() => {}, 1000)",
          output: "process.stdout.write('x'.repeat(4096))",
        };
        try {
          return originalExecFileSync(process.execPath, ["-e", scripts[mode]], options);
        } catch (error) {
          failureCode = error.code ?? error.status;
          if (mode === "timeout") timedOutPid = Number(error.stdout);
          throw error;
        }
      });
      expect(() => own.resolver.resolveExport(reference)).toThrow(
        "unqualified-declaration-emission",
      );
      const calls = vi
        .mocked(execFileSync)
        .mock.calls.filter(([, args]) => args.includes("--emitDeclarationOnly")).length;
      expect(() => own.resolver.resolveExport(reference)).toThrow(
        "unqualified-declaration-emission",
      );
      expect(
        vi
          .mocked(execFileSync)
          .mock.calls.filter(([, args]) => args.includes("--emitDeclarationOnly")),
      ).toHaveLength(calls);
      expect(calls).toBe(1);
      if (mode === "timeout") {
        expect(failureCode).toBe("ETIMEDOUT");
        expect(timedOutPid).toBeGreaterThan(0);
        expect(() => process.kill(timedOutPid, 0)).toThrow();
      }
      if (mode === "nonzero") expect(failureCode).toBe(7);
      if (mode === "output") expect(failureCode).toBe("ENOBUFS");
      expect(scratch).toBeTruthy();
      expect(existsSync(scratch)).toBe(false);
    },
  );

  it("reuses a real owner emission across program eviction without touching live build outputs", async () => {
    const own = await fixture({ programs: 1 });
    const path = join(own.root, "packages/alpha/tsconfig.tsbuildinfo");
    const before = readFileSync(path);
    vi.mocked(execFileSync).mockClear();
    own.resolver.resolveExport(reference);
    own.resolver.expressionFactsAt({
      path: "src/consumer.ts",
      offset: readFileSync(join(own.root, "src/consumer.ts"), "utf8").indexOf("1);"),
    });
    own.resolver.resolveExport(reference);
    expect(
      vi
        .mocked(execFileSync)
        .mock.calls.filter(([, args]) => args.includes("--emitDeclarationOnly")),
    ).toHaveLength(1);
    expect(readFileSync(path)).toEqual(before);
    expect(own.resolver.stats().created).toBeGreaterThan(2);
  });

  it.each(["source", "config"])(
    "rejects %s change during actual native emission and cleans scratch",
    async (kind) => {
      const own = await fixture();
      let scratch;
      vi.mocked(execFileSync).mockImplementation((executable, args, options) => {
        const result = originalExecFileSync(executable, args, options);
        if (args.includes("--emitDeclarationOnly")) {
          scratch = dirname(args[args.indexOf("--outDir") + 1]);
          const path =
            kind === "source" ? "packages/alpha/src/owner.ts" : "packages/alpha/tsconfig.json";
          own.put(path, readFileSync(join(own.root, path), "utf8") + "\n");
        }
        return result;
      });
      expect(() => own.resolver.resolveExport(reference)).toThrow("symbol-subject-changed");
      expect(existsSync(scratch)).toBe(false);
    },
  );

  it("cleans bounded actual native output when the retained emission budget is exceeded", async () => {
    const own = await fixture({ emitBytes: 1 });
    let scratch;
    vi.mocked(execFileSync).mockImplementation((executable, args, options) => {
      if (args.includes("--emitDeclarationOnly"))
        scratch = dirname(args[args.indexOf("--outDir") + 1]);
      return originalExecFileSync(executable, args, options);
    });
    expect(() => own.resolver.resolveExport(reference)).toThrow("symbol-emission-budget");
    expect(scratch).toBeTruthy();
    expect(existsSync(scratch)).toBe(false);
  });

  it("routes a configured declaration directory to private output without rewriting live declarations", async () => {
    const own = createSymbolFixture();
    fixtures.push(own);
    const config = JSON.parse(readFileSync(join(own.root, "packages/alpha/tsconfig.json"), "utf8"));
    config.compilerOptions.declarationDir = "types";
    own.put("packages/alpha/tsconfig.json", config);
    const manifest = JSON.parse(
      readFileSync(join(own.root, "packages/alpha/package.json"), "utf8"),
    );
    manifest.exports["."].types = "./types/index.d.ts";
    manifest.exports["./runtime"].types = "./types/owner.d.ts";
    manifest.files.push("types");
    own.put("packages/alpha/package.json", manifest);
    emitSymbolFixture(own.root);
    own.subject = await collectPolicySubject(own.root);
    own.resolver = createSymbolResolver(own.subject);
    const live = readFileSync(join(own.root, "packages/alpha/types/owner.d.ts.map"));
    vi.mocked(execFileSync).mockClear();
    expect(own.resolver.resolveExport(reference).identities[0].owner).toBe("alpha");
    const [, args] = vi
      .mocked(execFileSync)
      .mock.calls.find(([, command]) => command.includes("--emitDeclarationOnly"));
    expect(args[args.indexOf("--declarationDir") + 1]).toBe(args[args.indexOf("--outDir") + 1]);
    expect(readFileSync(join(own.root, "packages/alpha/types/owner.d.ts.map"))).toEqual(live);
  });

  it("binds exact callable annotation slots through the same canonical alias and bounded programs", async () => {
    const own = await fixture();
    const identity = own.resolver.resolveExport(reference).identities[0];
    const slots = own.resolver.callableSlots(identity);
    expect(slots.parameters[0]).toMatchObject({
      kind: "parameter",
      index: 0,
      path: "packages/alpha/src/owner.ts",
      type: { kind: "unknown" },
    });
    const text = readFileSync(join(own.root, identity.producer.path), "utf8");
    expect(text.slice(slots.parameters[0].start, slots.parameters[0].end)).toBe("unknown");
    expect(slots.result.kind).toBe("return");
    expect(() => own.resolver.callableSlots({ ...identity, owner: "foreign" })).toThrow(
      "mismatched-responsibility-producer",
    );
    expect(own.resolver.stats().created).toBeLessThanOrEqual(2);
    own.put(identity.producer.path, text.replace("unknown", "number "));
    expect(() => own.resolver.callableSlots(identity)).toThrow("symbol-subject-changed");
  });

  it("reports checker-owned open indexes and pre-assertion types without trusting casts or recursive dictionaries", async () => {
    const own = createSymbolFixture();
    fixtures.push(own);
    const path = "packages/alpha/src/unsafe.ts";
    const source =
      "export function cast(input: unknown): number { return input as number; }\nexport function dictionary(input: Record<string, unknown>): Record<string, unknown> { return input; }\ninterface Recursive { [key: string]: Recursive }\nexport function recursive(input: Recursive): Recursive { return input; }\n";
    own.put(path, source);
    emitSymbolFixture(own.root);
    own.subject = await collectPolicySubject(own.root);
    own.resolver = createSymbolResolver(own.subject);
    expect(own.resolver.expressionFactsAt({ path, offset: source.indexOf("input as") })).toEqual({
      type: { kind: "primitive" },
      beforeAssertions: { kind: "unknown" },
    });
    const dictionary = own.resolver.expressionFactsAt({
      path,
      offset: source.indexOf("return input;") + "return ".length,
    });
    expect(dictionary.type).toEqual({ kind: "object", indexes: [{ kind: "unknown" }] });
    expect(
      own.resolver.expressionFactsAt({ path, offset: source.lastIndexOf("input;") }).type,
    ).toEqual({ kind: "object", indexes: [{ kind: "typed" }] });
  });
  it("keeps the public inventory identical while reusing internal parsed contexts and emissions", async () => {
    const own = await fixture();
    expect(await collectPolicyInventory(own.root)).toEqual(own.subject.inventory);
    expect(own.subject.outputs.get("packages/alpha/dist/owner.d.ts")).toBe(
      "packages/alpha/src/owner.ts",
    );
    expect(own.resolver.stats().created).toBe(0);
  });

  it("binds non-executable proof source bytes to the same current subject", async () => {
    const own = await fixture();
    const identity = own.resolver.sourceIdentity("src/consumer.ts");
    expect(identity).toEqual({
      path: "src/consumer.ts",
      sha256: own.subject.inventory.files.find((file) => file.path === "src/consumer.ts").sha256,
    });
    expect(() => own.resolver.sourceIdentity("../escape.ts")).toThrow();
    own.put(identity.path, "export const changed = true;\n");
    expect(() => own.resolver.assertCurrent()).toThrow("symbol-subject-changed");
  });

  it("uses real ECMAScript globals without admitting unrelated browser fixture APIs", () => {
    const own = createSymbolFixture();
    fixtures.push(own);
    own.put(
      "packages/alpha/src/standard.ts",
      "export const values = new Map<string, number>(); export const ready: Promise<number> = Promise.resolve(1);",
    );
    expect(() => emitSymbolFixture(own.root)).not.toThrow();
    own.put("packages/alpha/src/browser.ts", "export const title = document.title;");
    expect(() => emitSymbolFixture(own.root)).toThrow("symbol-fixture-types");
  });

  it("resolves real built main/subpath aliases and executes the packed owner behavior", async () => {
    const own = await fixture();
    const main = own.resolver.resolveExport(reference);
    const runtime = own.resolver.resolveExport({
      ...reference,
      specifier: "alpha/runtime",
      exportName: "validate",
    });
    expect(main.identities[0].producer).toEqual(runtime.identities[0].producer);
    expect(main.identities[0]).toMatchObject({
      owner: "alpha",
      entry: { specifier: "alpha", exportName: "parse" },
      producer: { path: "packages/alpha/src/owner.ts", kind: "FunctionDeclaration" },
    });
    expect(main.signatures[0]).toMatchObject({
      parameters: [{ index: 0, type: { kind: "unknown" } }],
      result: { kind: "union", members: 2 },
    });
    expect(packSymbolFixture(own.root)[0].files.map((file) => file.path)).toContain(
      "dist/owner.d.ts.map",
    );
    const url = pathToFileURL(join(own.root, "packages/alpha/dist/index.js")).href;
    const output = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const { parse } = await import(${JSON.stringify(url)}); process.stdout.write(JSON.stringify([parse(1), parse("x")]));`,
      ],
      { encoding: "utf8", timeout: 10_000 },
    );
    expect(JSON.parse(output)).toEqual([{ ok: true, value: 1 }, { ok: false }]);
  });

  it.each(["missing", "wrong", "stale", "escape"])(
    "rejects %s declaration provenance",
    async (mode) => {
      const own = await fixture();
      const path = join(own.root, "packages/alpha/dist/owner.d.ts");
      const mapPath = `${path}.map`;
      if (mode === "missing") unlinkSync(mapPath);
      if (mode === "wrong") writeFileSync(mapPath, "{}");
      if (mode === "stale")
        writeFileSync(path, readFileSync(path, "utf8").replace("unknown", "string"));
      if (mode === "escape") {
        const map = JSON.parse(readFileSync(mapPath, "utf8"));
        map.sources = ["../../../../outside.ts"];
        writeFileSync(mapPath, JSON.stringify(map));
      }
      expect(() => own.resolver.resolveExport(reference)).toThrow(
        mode === "missing" ? "ENOENT" : "stale-declaration-provenance",
      );
    },
  );

  it("rejects unchanged-name/span declarations after a real producer type change", async () => {
    const own = createSymbolFixture();
    fixtures.push(own);
    const path = join(own.root, "packages/alpha/src/owner.ts");
    writeFileSync(path, readFileSync(path, "utf8").replace("unknown", "number "));
    own.subject = await collectPolicySubject(own.root);
    own.resolver = createSymbolResolver(own.subject);
    expect(() => own.resolver.resolveExport(reference)).toThrow("stale-declaration-provenance");
  });

  it("retains actual incoming calls through aliases and independent compiler contexts", async () => {
    const own = await fixture();
    const identity = own.resolver.resolveExport(reference).identities[0];
    const result = own.resolver.incomingUses(identity);
    expect(
      result.uses.filter((use) => use.path === "src/consumer.ts" && use.kind === "call"),
    ).toHaveLength(2);
    expect(result.partial).toBe(false);
    expect(own.resolver.stats().programs).toBeLessThanOrEqual(2);
  });

  it.each(["source", "config", "declaration"])(
    "rejects %s mutation after resolver creation",
    async (kind) => {
      const own = await fixture();
      own.resolver.resolveExport(reference);
      const paths = {
        source: "packages/alpha/src/owner.ts",
        config: "packages/alpha/tsconfig.json",
        declaration: "packages/alpha/dist/owner.d.ts",
      };
      own.put(paths[kind], readFileSync(join(own.root, paths[kind]), "utf8") + "\n");
      expect(() => own.resolver.assertCurrent()).toThrow("symbol-subject-changed");
    },
  );

  it("bounds source, node and emission qualification without accepting partial facts", async () => {
    for (const options of [{ sourceBytes: 1 }, { nodes: 1 }, { emitBytes: 1 }]) {
      const own = await fixture(options);
      expect(() => own.resolver.resolveExport(reference)).toThrow();
    }
  });

  it("refuses invalid configuration, absent exports and use after release", async () => {
    const own = await fixture();
    expect(() => createSymbolResolver(own.subject, { programs: 0 })).toThrow(
      "invalid-symbol-budget",
    );
    expect(() => own.resolver.resolveExport({ ...reference, specifier: "missing" })).toThrow(
      "unresolved-export-entry",
    );
    expect(() => own.resolver.resolveExport({ ...reference, exportName: "missing" })).toThrow(
      "unresolved-owner-symbol",
    );
    own.resolver.close();
    expect(() => own.resolver.describeAt({ path: "src/consumer.ts", offset: 0 })).toThrow(
      "symbol-resolver-closed",
    );
  });
  it("qualifies optional/rest parameters, type aliases and actual predicates", async () => {
    const own = createSymbolFixture();
    fixtures.push(own);
    own.put(
      "packages/alpha/src/extra.ts",
      `export type Dictionary = Record<string, unknown>;
export function optional(input?: unknown, ...rest: unknown[]): boolean { return input === rest[0]; }
export function predicate(input: unknown): input is number { return typeof input === "number"; }
export function asserted(input: unknown): asserts input is number { if (typeof input !== "number") throw new TypeError(); }
export function never(): never { throw new TypeError(); }
export function primitive(): string { return "x"; }
export function untyped(input: any): any { return input; }
`,
    );
    own.put(
      "packages/alpha/src/index.ts",
      'export { validate as parse } from "./owner.js"; export * from "./extra.js";',
    );
    emitSymbolFixture(own.root);
    own.subject = await collectPolicySubject(own.root);
    own.resolver = createSymbolResolver(own.subject);
    const exported = (exportName) => own.resolver.resolveExport({ ...reference, exportName });
    expect(exported("Dictionary").type).toEqual({
      kind: "object",
      indexes: [{ kind: "unknown" }],
    });
    expect(exported("optional").signatures[0].parameters).toMatchObject([
      { optional: true, rest: false },
      { optional: false, rest: true },
    ]);
    expect(exported("predicate").signatures[0].predicate).toEqual({
      kind: "Identifier",
      parameterIndex: 0,
    });
    expect(exported("asserted").signatures[0].predicate.kind).toBe("AssertsIdentifier");
    expect(exported("never").signatures[0].result.kind).toBe("never");
    expect(exported("primitive").signatures[0].result.kind).toBe("primitive");
    expect(exported("untyped").signatures[0].parameters[0].type.kind).toBe("any");
  });

  it("keeps Bundler and source-override contexts distinct from built NodeNext consumers", async () => {
    const own = createSymbolFixture();
    fixtures.push(own);
    own.put("packages/ui/package.json", { name: "ui", private: true, type: "module" });
    own.put("packages/ui/tsconfig.json", {
      compilerOptions: {
        module: "ESNext",
        moduleResolution: "Bundler",
        noEmit: true,
        strict: true,
        types: [],
        lib: ["ES2022"],
      },
      include: ["src"],
    });
    own.put(
      "packages/ui/src/index.ts",
      'import { parse } from "alpha"; export const ui = parse(1);',
    );
    own.put("packages/cli/package.json", { name: "cli", private: true, type: "module" });
    own.put("packages/cli/tsconfig.json", {
      compilerOptions: {
        module: "NodeNext",
        moduleResolution: "NodeNext",
        noEmit: true,
        strict: true,
        types: [],
        lib: ["ES2022"],
        paths: { alpha: ["../alpha/src/index.ts"] },
      },
      include: ["src"],
    });
    own.put(
      "packages/cli/src/index.ts",
      'import { parse } from "alpha"; export const cli = parse(1);',
    );
    own.subject = await collectPolicySubject(own.root);
    own.resolver = createSymbolResolver(own.subject, { programs: 1 });
    const canonical = own.resolver.resolveExport(reference).identities[0].producer;
    for (const directory of ["ui", "cli"]) {
      const facts = own.resolver.resolveExport({
        ...reference,
        consumerPath: `packages/${directory}/src/index.ts`,
      });
      expect(facts.identities[0].producer).toEqual(canonical);
    }
    expect(own.resolver.stats().programs).toBe(1);
    expect(own.resolver.stats().created).toBeGreaterThan(2);
  });

  it("uses UTF-16 spans and reports incomplete/untyped incoming coverage honestly", async () => {
    const own = createSymbolFixture();
    fixtures.push(own);
    const text =
      '/* 😀 */ import { parse } from "alpha"; export const result = parse(1); export { parse }; export type Parse = typeof parse;';
    own.put("src/consumer.ts", text);
    own.put("scripts/ordinary.mjs", "export const value = 1;");
    own.subject = await collectPolicySubject(own.root);
    own.resolver = createSymbolResolver(own.subject);
    const identity = own.resolver.describeAt({
      path: "src/consumer.ts",
      offset: text.indexOf("parse(1)"),
    }).identities[0];
    expect(identity.producer.path).toBe("packages/alpha/src/owner.ts");
    const incoming = own.resolver.incomingUses(identity);
    expect(incoming.untyped).toContain("scripts/ordinary.mjs");
    expect(incoming.complete).toBe(false);
    expect(incoming.uses.map((use) => use.kind)).toEqual(
      expect.arrayContaining(["call", "reexport", "type-reference"]),
    );
    expect(own.resolver.incomingUses(identity, ["src/consumer.ts"]).partial).toBe(true);
    expect(() => own.resolver.describeAt({ path: "src/consumer.ts", offset: -1 })).toThrow(
      "invalid-symbol-position",
    );
    expect(() => own.resolver.describeAt({ path: "absent.ts", offset: 0 })).toThrow(
      "unaccounted-symbol-source",
    );
  });

  it.each(["context", "outputs"])("rejects mutable internal %s provenance", async (mode) => {
    const own = await fixture();
    if (mode === "context") own.subject.contexts.get("").options.module = 1;
    else own.subject.outputs.set("packages/alpha/dist/owner.d.ts", "src/consumer.ts");
    expect(() => own.resolver.assertCurrent()).toThrow("symbol-context-changed");
  });
  it("validates declaration positions through the actual compiler-produced map", async () => {
    const own = await fixture();
    const path = join(own.root, "packages/alpha/dist/owner.d.ts");
    const declaration = ts.createSourceFile(
      path,
      readFileSync(path, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    ).statements[0];
    const payload = JSON.parse(readFileSync(`${path}.map`, "utf8"));
    expect(declarationMapPosition(declaration, JSON.stringify(payload)).mapped.originalLine).toBe(
      0,
    );
    for (const replacement of [{ version: 2 }, { sources: null }, { sources: [] }]) {
      expect(() =>
        declarationMapPosition(declaration, JSON.stringify({ ...payload, ...replacement })),
      ).toThrow("invalid-declaration-map");
    }
    expect(() =>
      declarationMapPosition(declaration, JSON.stringify({ ...payload, mappings: "" })),
    ).toThrow("unmapped-declaration-position");
  });

  it("refuses declarations from an unowned dependency and a diagnostic-bearing owner", async () => {
    const own = createSymbolFixture();
    fixtures.push(own);
    own.put("node_modules/foreign/package.json", {
      name: "foreign",
      type: "module",
      types: "index.d.ts",
    });
    own.put(
      "node_modules/foreign/index.d.ts",
      "export declare function validate(input: unknown): boolean;",
    );
    own.put(
      "src/consumer.ts",
      'import { validate } from "foreign"; import { parse } from "alpha"; export const result = parse(1);',
    );
    own.subject = await collectPolicySubject(own.root);
    own.resolver = createSymbolResolver(own.subject);
    expect(() =>
      own.resolver.resolveExport({ ...reference, specifier: "foreign", exportName: "validate" }),
    ).toThrow("unqualified-declaration-owner");
    own.resolver.close();
    own.put(
      "packages/alpha/src/owner.ts",
      'export function validate(input: unknown): boolean { const broken: number = "wrong"; return input === broken; }',
    );
    own.subject = await collectPolicySubject(own.root);
    own.resolver = createSymbolResolver(own.subject);
    expect(() => own.resolver.resolveExport(reference)).toThrow("unqualified-declaration-emission");
  });

  it("describes owned local source declarations without inventing a package export", async () => {
    const own = createSymbolFixture();
    fixtures.push(own);
    const text = "export function local(input: unknown): unknown { return input; }";
    own.put("src/local.ts", text);
    own.subject = await collectPolicySubject(own.root);
    own.resolver = createSymbolResolver(own.subject);
    const facts = own.resolver.describeAt({ path: "src/local.ts", offset: text.indexOf("local") });
    expect(facts.identities[0]).toMatchObject({
      owner: "root-product",
      entry: null,
      producer: { path: "src/local.ts" },
    });
  });
  it("rejects a stale public barrel even when its ultimate producer remains fresh", async () => {
    const own = createSymbolFixture();
    fixtures.push(own);
    own.put("packages/alpha/src/index.ts", 'export { validate as replacement } from "./owner.js";');
    own.subject = await collectPolicySubject(own.root);
    own.resolver = createSymbolResolver(own.subject);
    expect(() => own.resolver.resolveExport(reference)).toThrow("stale-declaration-provenance");
    own.resolver.close();
    emitSymbolFixture(own.root);
    own.put(
      "src/consumer.ts",
      'import { validate } from "alpha/runtime"; export const result = validate(1);',
    );
    own.subject = await collectPolicySubject(own.root);
    own.resolver = createSymbolResolver(own.subject);
    expect(
      own.resolver.resolveExport({
        ...reference,
        specifier: "alpha/runtime",
        exportName: "validate",
      }).identities[0].producer.path,
    ).toBe("packages/alpha/src/owner.ts");
  });
  it.each(["package-name", "package-directory", "file-scope", "production"])(
    "rejects mutated %s owner metadata",
    async (mode) => {
      const own = await fixture();
      if (mode === "package-name") own.subject.inventory.packages[0].name = "fabricated-owner";
      if (mode === "package-directory") own.subject.inventory.packages[0].directory = "src";
      if (mode === "file-scope")
        own.subject.inventory.files.find((file) => file.path === "src/consumer.ts").scope =
          "fabricated-scope";
      if (mode === "production")
        own.subject.inventory.files.find((file) => file.path === "src/consumer.ts").production =
          false;
      expect(() => own.resolver.assertCurrent()).toThrow("symbol-context-changed");
      expect(() => own.resolver.resolveExport(reference)).toThrow("symbol-context-changed");
    },
  );
  it("rejects stale intermediate reexports without losing the unchanged final producer", async () => {
    const own = createSymbolFixture();
    fixtures.push(own);
    own.put(
      "packages/alpha/src/bridge.ts",
      'export { validate as parse } from "./owner.js"; export const version = "before";',
    );
    own.put("packages/alpha/src/index.ts", 'export { parse } from "./bridge.js";');
    emitSymbolFixture(own.root);
    own.put(
      "packages/alpha/src/bridge.ts",
      'export { validate as parse } from "./owner.js"; export const version = 1;',
    );
    own.subject = await collectPolicySubject(own.root);
    own.resolver = createSymbolResolver(own.subject);
    expect(() => own.resolver.resolveExport(reference)).toThrow("stale-declaration-provenance");
    own.resolver.close();
    emitSymbolFixture(own.root);
    own.subject = await collectPolicySubject(own.root);
    own.resolver = createSymbolResolver(own.subject);
    expect(own.resolver.resolveExport(reference).identities[0].producer.path).toBe(
      "packages/alpha/src/owner.ts",
    );
  });
  it.each(["src/added.ts", "packages/alpha/src/added.ts"])(
    "rejects actual new consumer membership at %s",
    async (path) => {
      const own = await fixture();
      const identity = own.resolver.resolveExport(reference).identities[0];
      expect(() => own.resolver.assertCurrent()).not.toThrow();
      own.put(path, 'import { parse } from "alpha"; export const added = parse(1);');
      expect(() => own.resolver.assertCurrent()).toThrow("symbol-membership-changed");
      expect(() => own.resolver.incomingUses(identity)).toThrow("symbol-membership-changed");
    },
  );
  it.each([
    ["dot", "ns.parse(1)"],
    ["literal", 'ns["parse"](1)'],
    ["stable-key", "ns[key](1)"],
    ["wrapped", '(ns["parse"] as typeof ns.parse)(1)'],
    ["template", "ns[`parse`](1)"],
    ["wrapped-key", "ns[(key as string)](1)"],
    ["non-null", "ns.parse!(1)"],
    ["satisfies", "(ns.parse satisfies typeof ns.parse)(1)"],
    ["type-assertion", "(<typeof ns.parse>ns.parse)(1)"],
    ["local-alias", "alias(1)"],
  ])("records actual checker-owned %s member invocations", async (_mode, expression) => {
    const own = createSymbolFixture();
    fixtures.push(own);
    own.put(
      "src/namespace-consumer.ts",
      `import * as ns from "alpha"; const key = "parse"; const alias = ns[key]; export const result = ${expression};`,
    );
    own.subject = await collectPolicySubject(own.root);
    own.resolver = createSymbolResolver(own.subject);
    const identity = own.resolver.resolveExport(reference).identities[0];
    const result = own.resolver.incomingUses(identity);
    expect(
      result.uses.filter((use) => use.path === "src/namespace-consumer.ts" && use.kind === "call"),
    ).toHaveLength(1);
    expect(
      result.uses.filter((use) => use.path === "src/consumer.ts" && use.kind === "call"),
    ).toHaveLength(2);
  });

  it("marks unknown computed namespace calls incomplete instead of dropping consumers", async () => {
    const own = createSymbolFixture();
    fixtures.push(own);
    own.put(
      "src/namespace-consumer.ts",
      'import * as ns from "alpha"; export function invoke(key: string): unknown { return ns[key](1); }',
    );
    own.subject = await collectPolicySubject(own.root);
    own.resolver = createSymbolResolver(own.subject);
    const identity = own.resolver.resolveExport(reference).identities[0];
    expect(own.resolver.incomingUses(identity)).toMatchObject({ complete: false, partial: false });
  });
  it("retains exported const-function calls and checker-bound aliases in the producer file", async () => {
    const own = createSymbolFixture();
    fixtures.push(own);
    own.put(
      "packages/alpha/src/owner.ts",
      'export const validate = (input: unknown): boolean => typeof input === "number"; const local = validate; export const executed = local(1);',
    );
    emitSymbolFixture(own.root);
    own.subject = await collectPolicySubject(own.root);
    own.resolver = createSymbolResolver(own.subject);
    const identity = own.resolver.resolveExport(reference).identities[0];
    const facts = own.resolver.incomingUses(identity);
    expect(facts.uses.filter((use) => use.kind === "call")).toHaveLength(3);
  });

  it.each([
    "let alias = ns.parse; export const result = alias(1);",
    "const { parse: alias } = ns; export const result = alias(1);",
    "export function invoke(callback: typeof ns.parse): void { callback(1); }",
  ])("reports unsupported callable alias binding incomplete: %s", async (body) => {
    const own = createSymbolFixture();
    fixtures.push(own);
    own.put("src/namespace-consumer.ts", 'import * as ns from "alpha"; ' + body);
    own.subject = await collectPolicySubject(own.root);
    own.resolver = createSymbolResolver(own.subject);
    const identity = own.resolver.resolveExport(reference).identities[0];
    expect(own.resolver.incomingUses(identity).complete).toBe(false);
  });
  it("does not turn an asserted unknown key into a complete owner call", async () => {
    const own = createSymbolFixture();
    fixtures.push(own);
    own.put(
      "src/namespace-consumer.ts",
      'import * as ns from "alpha"; export function invoke(key: string): void { ns[key as "parse"](1); }',
    );
    own.subject = await collectPolicySubject(own.root);
    own.resolver = createSymbolResolver(own.subject);
    const identity = own.resolver.resolveExport(reference).identities[0];
    expect(own.resolver.incomingUses(identity).complete).toBe(false);
  });
  it.each([
    "const first = ns.parse; const second = first; export const result = second(1);",
    'const first = "parse"; const second = first; export const result = ns[second](1);',
  ])("bounds actual const key/callee alias traversal", async (body) => {
    const own = createSymbolFixture();
    fixtures.push(own);
    own.put("src/namespace-consumer.ts", 'import * as ns from "alpha"; ' + body);
    own.subject = await collectPolicySubject(own.root);
    own.resolver = createSymbolResolver(own.subject, { aliases: 1 });
    const identity = own.resolver.resolveExport(reference).identities[0];
    expect(() => own.resolver.incomingUses(identity)).toThrow("symbol-alias-budget");
  });
  it("retains checker-bound immutable namespace aliases", async () => {
    const own = createSymbolFixture();
    fixtures.push(own);
    own.put(
      "src/namespace-consumer.ts",
      'import * as ns from "alpha"; const first = ns; const second = first; export const result = second.parse(1);',
    );
    own.subject = await collectPolicySubject(own.root);
    own.resolver = createSymbolResolver(own.subject);
    const identity = own.resolver.resolveExport(reference).identities[0];
    const facts = own.resolver.incomingUses(identity);
    expect(
      facts.uses.filter((use) => use.path === "src/namespace-consumer.ts" && use.kind === "call"),
    ).toHaveLength(1);
    expect(facts.complete).toBe(true);
  });

  it("refuses a type-only namespace as a runtime member receiver", async () => {
    const own = createSymbolFixture();
    fixtures.push(own);
    own.put(
      "src/namespace-consumer.ts",
      'import type * as ns from "alpha"; export const invoke = (): unknown => ns.parse(1);',
    );
    own.subject = await collectPolicySubject(own.root);
    own.resolver = createSymbolResolver(own.subject);
    const identity = own.resolver.resolveExport(reference).identities[0];
    const facts = own.resolver.incomingUses(identity);
    expect(facts.complete).toBe(false);
    expect(facts.unresolved).toBeGreaterThan(0);
    expect(
      facts.uses.filter((use) => use.path === "src/namespace-consumer.ts" && use.kind === "call"),
    ).toHaveLength(0);
  });

  it("keeps an asserted opaque namespace receiver incomplete", async () => {
    const own = createSymbolFixture();
    fixtures.push(own);
    own.put(
      "src/namespace-consumer.ts",
      'export function invoke(value: unknown): unknown { const fake = value as typeof import("alpha"); return fake.parse(1); }',
    );
    own.subject = await collectPolicySubject(own.root);
    own.resolver = createSymbolResolver(own.subject);
    const identity = own.resolver.resolveExport(reference).identities[0];
    expect(own.resolver.incomingUses(identity).complete).toBe(false);
  });
});

describe("canonical consumer implementation call binding (#3918)", () => {
  async function consumerFixture(body, options = {}) {
    const own = createSymbolFixture();
    fixtures.push(own);
    own.put(
      "packages/alpha/src/owner.ts",
      readFileSync(join(own.root, "packages/alpha/src/owner.ts"), "utf8") + body,
    );
    emitSymbolFixture(own.root);
    own.subject = await collectPolicySubject(own.root);
    own.resolver = createSymbolResolver(own.subject, options);
    return own;
  }

  it("keeps a public const alias distinct from the actual inline-callback implementation", async () => {
    const own = await consumerFixture(
      "function withOp(action: () => unknown): unknown { return action(); } function handle(input: number): unknown { return withOp(() => validate(input)); } export const consume = handle;",
    );
    const producer = own.resolver.resolveExport(reference).identities[0];
    const consumer = own.resolver.resolveExport({
      ...reference,
      specifier: "alpha/runtime",
      exportName: "consume",
    }).identities[0];
    const bound = own.resolver.consumerCalls(consumer, producer, "alpha");
    expect(consumer.producer.kind).toBe("VariableDeclaration");
    expect(bound.implementation.producer.kind).toBe("FunctionDeclaration");
    expect(bound.bound).toBe(true);
    expect(bound.calls).toHaveLength(1);
    const call = bound.calls[0];
    expect(readFileSync(join(own.root, call.path), "utf8").slice(call.start, call.end)).toBe(
      "validate(input)",
    );
  });

  it("uses the actual alias budget for exported implementation chains", async () => {
    const own = await consumerFixture(
      "function handle(input: number): unknown { return validate(input); } const second = handle; const first = second; export const consume = first;",
      { aliases: 1 },
    );
    const producer = own.resolver.resolveExport(reference).identities[0];
    const consumer = own.resolver.resolveExport({
      ...reference,
      specifier: "alpha/runtime",
      exportName: "consume",
    }).identities[0];
    expect(() => own.resolver.consumerCalls(consumer, producer, "alpha")).toThrow(
      "symbol-alias-budget",
    );
  });
});
