import { afterEach, describe, expect, it, vi } from "vitest";
import { Buffer } from "node:buffer";
import {
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  existsSync,
  symlinkSync,
  statSync,
  utimesSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { collectPolicyInventory, collectPolicySubject } from "../lib/code-quality-inventory.mjs";
import ts from "typescript";
import { createCompilerContext } from "../lib/code-quality-compiler.mjs";
import { declarationMapPosition } from "../lib/code-quality-provenance.mjs";
import { createSymbolResolver } from "../lib/code-quality-symbols.mjs";
import {
  createConsumerSeamFixture,
  createObservationOptionsFixture,
  createBooleanObservationFixture,
  createObjectValidatorFixture,
  createMetadataSourceFixture,
  createDirectObservationCheckerFixture,
  createPhysicalRegistrationObservationFixture,
  createResponsibilityFixture,
  createEnforcementFixture,
  createCrossOwnerEnforcementFixture,
  createForeignDiagnosticFixture,
  replaceConsumerCallFixture,
  replaceEnforcementOwner,
  createDiagnosticFixture,
  createContextDiagnosticFixture,
  createDictionaryEnforcementFixture,
  createRawHelperEnforcementFixture,
  createCollectiveParserFixture,
  createTypedRecheckFixture,
  createCanonicalDecoderFixture,
} from "./support/code-quality-responsibility-fixture.mjs";
import {
  createPublicParserFixture,
  createSymbolFixture,
  emitSymbolFixture,
  packSymbolFixture,
} from "./support/code-quality-symbol-fixture.mjs";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});

vi.mock("typescript", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    default: {
      ...actual.default,
      getPreEmitDiagnostics: vi.fn(actual.default.getPreEmitDiagnostics),
    },
  };
});

const { execFileSync: originalExecFileSync } = await vi.importActual("node:child_process");
const fixtures = [];
afterEach(() => {
  vi.mocked(ts.getPreEmitDiagnostics).mockClear();
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
  it.each([
    ["symbol", createSymbolFixture, ["alpha"]],
    ["responsibility", createResponsibilityFixture, ["alpha"]],
    ["enforcement", createEnforcementFixture, ["alpha"]],
    ["raw-helper", createRawHelperEnforcementFixture, ["alpha"]],
    ["dictionary", createDictionaryEnforcementFixture, ["alpha"]],
    ["diagnostic", createDiagnosticFixture, ["alpha"]],
    ["foreign-diagnostic", createForeignDiagnosticFixture, ["alpha", "beta"]],
    ["cross-owner", createCrossOwnerEnforcementFixture, ["alpha", "beta"]],
    ["consumer", createConsumerSeamFixture, ["alpha", "beta"]],
    ["consumer-callback", () => createConsumerSeamFixture("callback"), ["alpha", "beta"]],
  ])("finalizes %s assembly once per actual owner", async (_name, create, owners) => {
    const own = create();
    fixtures.push(own);
    const calls = vi.mocked(execFileSync).mock.calls.filter(([, args]) => args[0] === "-p");
    const checked = vi.mocked(ts.getPreEmitDiagnostics).mock.calls.length;
    for (const owner of owners) {
      const directory = join(own.root, "packages", owner);
      const declaration = readFileSync(join(directory, "dist/owner.d.ts"), "utf8");
      expect(declaration.length).toBeGreaterThan(0);
      const map = JSON.parse(readFileSync(join(directory, "dist/owner.d.ts.map"), "utf8"));
      expect(map.sources).toContain("../src/owner.ts");
      expect(map.mappings.length).toBeGreaterThan(0);
      const runtime = await import(pathToFileURL(join(directory, "dist/owner.js")).href);
      if (owner === "alpha") {
        expect(runtime.validate(_name === "dictionary" ? { value: 1 } : 1)).toEqual(
          _name.includes("diagnostic") ? [] : { ok: true, value: 1 },
        );
        expect(runtime.validate(null)).toEqual(
          _name.includes("diagnostic") ? ["invalid"] : { ok: false },
        );
      } else if (_name === "foreign-diagnostic") expect(runtime.healthy).toBe(true);
      else expect(runtime.consume(1)).toBe(1);
    }
    expect(calls.map(([, args]) => args[1])).toEqual(
      owners.map((owner) => join(own.root, "packages", owner, "tsconfig.json")),
    );
    expect(checked).toBe(owners.length);
    for (const [, , options] of calls)
      expect(options).toMatchObject({
        timeout: 10_000,
        killSignal: "SIGKILL",
        maxBuffer: 1024 * 1024,
      });
  });

  it("keeps returned-fixture mutation compilation eager and roots independent", async () => {
    const first = createEnforcementFixture();
    fixtures.push(first);
    const second = createConsumerSeamFixture();
    fixtures.push(second);
    expect(first.root).not.toBe(second.root);
    vi.mocked(execFileSync).mockClear();
    vi.mocked(ts.getPreEmitDiagnostics).mockClear();
    replaceEnforcementOwner(first, "lying-predicate");
    replaceConsumerCallFixture(second, "alias");
    expect(vi.mocked(ts.getPreEmitDiagnostics)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(execFileSync).mock.calls.map(([, args]) => args[1])).toEqual([
      join(first.root, "packages/alpha/tsconfig.json"),
      join(second.root, "packages/beta/tsconfig.json"),
    ]);
    const runtime = await import(
      pathToFileURL(join(second.root, "packages/beta/dist/owner.js")).href
    );
    expect(runtime.consume(42)).toBe(42);
    second.resolver = createSymbolResolver(await collectPolicySubject(second.root));
    expect(second.resolver.resolveExport(second.record.consumer).identities).toHaveLength(1);
  });

  it("reuses detached export facts for an exact repeated selector without compiler traversal", async () => {
    const own = await fixture();
    const selector = { ...reference };
    const first = own.resolver.resolveExport(selector);
    const expected = structuredClone(first);
    const before = own.resolver.stats();
    first.identities[0].owner = "caller-mutation";
    const repeated = own.resolver.resolveExport({ ...reference });
    expect(repeated).toEqual(expected);
    expect(repeated).not.toBe(first);
    expect(own.resolver.stats()).toEqual(before);
    selector.exportName = "caller-selector-mutation";
    repeated.identities[0].owner = "second-caller-mutation";
    expect(own.resolver.resolveExport({ ...reference })).toEqual(expected);
    expect(own.resolver.stats()).toEqual(before);
  });

  it("keeps changing accessor export entries out of the data-selector cache", async () => {
    const own = await fixture();
    const expected = own.resolver.resolveExport(reference);
    own.resolver.resolveExport({
      ...reference,
      specifier: "alpha/runtime",
      exportName: "validate",
    });
    let specifierReads = 0;
    let exportReads = 0;
    const request = {
      get consumerPath() {
        return reference.consumerPath;
      },
      get specifier() {
        return ++specifierReads === 1 ? "alpha" : "alpha/runtime";
      },
      get exportName() {
        return ++exportReads === 1 ? "parse" : "validate";
      },
    };
    const cold = own.resolver.resolveExport(request);
    expect(cold.identities[0].entry).toEqual({
      specifier: "alpha/runtime",
      exportName: "validate",
    });
    expect(own.resolver.resolveExport(reference)).toEqual(expected);
  });

  it.each(["accessor", "inherited", "proxy"])(
    "preserves the original cold property schedule for %s selectors",
    async (kind) => {
      const own = await fixture();
      const expected = own.resolver.resolveExport(reference);
      const reads = [];
      const descriptors = Object.fromEntries(
        Object.entries(reference).map(([name, value]) => [
          name,
          {
            get() {
              reads.push(name);
              expect(this).toBe(request);
              return value;
            },
          },
        ]),
      );
      let request;
      if (kind === "proxy")
        request = new Proxy(
          { ...reference },
          {
            get(target, name, receiver) {
              reads.push(name);
              return Reflect.get(target, name, receiver);
            },
            getOwnPropertyDescriptor() {
              throw new Error("unexpected-descriptor-trap");
            },
          },
        );
      else
        request =
          kind === "inherited"
            ? Object.create(Object.defineProperties({}, descriptors))
            : Object.defineProperties({}, descriptors);
      const before = own.resolver.stats();
      expect(own.resolver.resolveExport(request)).toEqual(expected);
      expect(reads).toEqual([
        "consumerPath",
        "specifier",
        "specifier",
        "exportName",
        "specifier",
        "exportName",
      ]);
      expect(own.resolver.stats().nodes).toBeGreaterThan(before.nodes);
    },
  );

  it.each(["accessor", "proxy"])("preserves the first cold %s error", async (kind) => {
    const own = await fixture();
    own.resolver.resolveExport(reference);
    const error = new Error("selector-read-failure");
    const reads = [];
    const request =
      kind === "proxy"
        ? new Proxy(
            { ...reference },
            {
              get(_target, name) {
                reads.push(name);
                throw error;
              },
              getOwnPropertyDescriptor() {
                throw new Error("unexpected-descriptor-trap");
              },
            },
          )
        : {
            get consumerPath() {
              reads.push("consumerPath");
              throw error;
            },
            get specifier() {
              throw new Error("unexpected-specifier-read");
            },
            get exportName() {
              throw new Error("unexpected-export-read");
            },
          };
    expect(() => own.resolver.resolveExport(request)).toThrow(error);
    expect(reads).toEqual(["consumerPath"]);
    expect(own.resolver.resolveExport(reference).identities[0].entry).toEqual({
      specifier: "alpha",
      exportName: "parse",
    });
  });

  it.each(["array", "function"])("reuses own data selectors on a %s request", async (kind) => {
    const own = await fixture();
    const expected = own.resolver.resolveExport(reference);
    const before = own.resolver.stats();
    const request = Object.assign(
      kind === "array"
        ? []
        : function selector() {
            return undefined;
          },
      reference,
    );
    expect(own.resolver.resolveExport(request)).toEqual(expected);
    expect(own.resolver.stats()).toEqual(before);
  });

  it.each([
    { ...reference, consumerPath: "packages/alpha/src/owner.ts" },
    { ...reference, specifier: "missing" },
    { ...reference, exportName: "missing" },
    { ...reference, specifier: { toString: () => reference.specifier } },
  ])("keeps export fact keys exact and nonstring selectors cold %j", async (selector) => {
    const own = await fixture();
    own.resolver.resolveExport(reference);
    expect(() => own.resolver.resolveExport(selector)).toThrow();
    expect(own.resolver.resolveExport(reference).identities).toHaveLength(1);
  });

  it("retains only one successful export selector and releases it on close", async () => {
    const own = await fixture();
    own.resolver.resolveExport(reference);
    const first = own.resolver.stats();
    own.resolver.resolveExport({
      ...reference,
      specifier: "alpha/runtime",
      exportName: "validate",
    });
    const second = own.resolver.stats();
    expect(second.nodes).toBeGreaterThan(first.nodes);
    own.resolver.resolveExport(reference);
    expect(own.resolver.stats().nodes).toBeGreaterThan(second.nodes);
    own.resolver.close();
    expect(() => own.resolver.resolveExport(reference)).toThrow("symbol-resolver-closed");
  });

  it.each(["source", "config", "manifest", "membership"])(
    "keeps complete %s currentness validation on export fact hits",
    async (kind) => {
      const own = await fixture();
      own.resolver.resolveExport(reference);
      const paths = {
        source: "packages/alpha/src/owner.ts",
        config: "packages/alpha/tsconfig.json",
        manifest: "packages/alpha/package.json",
        membership: "packages/alpha/src/added.ts",
      };
      const path = paths[kind];
      own.put(
        path,
        kind === "membership"
          ? "export const added = 1;"
          : readFileSync(join(own.root, path), "utf8") + "\n",
      );
      expect(() => own.resolver.resolveExport(reference)).toThrow(
        kind === "membership" ? "symbol-membership-changed" : "symbol-subject-changed",
      );
    },
  );

  it.each(["owner.d.ts", "owner.d.ts.map"])(
    "refuses same-byte generated %s symlinks on export fact hits",
    async (name) => {
      const own = await fixture();
      own.resolver.resolveExport(reference);
      const path = join(own.root, "packages/alpha/dist", name);
      const replacement = `${path}.retained`;
      writeFileSync(replacement, readFileSync(path));
      unlinkSync(path);
      symlinkSync(replacement, path);
      expect(() => own.resolver.resolveExport(reference)).toThrow("unsafe-symbol-source");
    },
  );

  it("keeps proof roles distinct and rechecks same-byte public runtime symlinks on hits", async () => {
    const own = createDiagnosticFixture();
    fixtures.push(own);
    own.resolver = createSymbolResolver(await collectPolicySubject(own.root), {}, [
      { owner: "packages/alpha", paths: own.record.proofs },
    ]);
    const expected = own.resolver.resolveProofExport(own.record.input);
    const before = own.resolver.stats();
    expect(own.resolver.resolveProofExport({ ...own.record.input })).toEqual(expected);
    expect(own.resolver.stats()).toEqual(before);
    expect(() => own.resolver.resolveExport(own.record.input)).toThrow("untyped-symbol-source");
    const path = join(own.root, "packages/alpha/dist/index.js");
    const replacement = `${path}.retained`;
    writeFileSync(replacement, readFileSync(path));
    unlinkSync(path);
    symlinkSync(replacement, path);
    expect(() => own.resolver.resolveProofExport(own.record.input)).toThrow("unsafe-symbol-source");
  });

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
  it.each(["direct", "one", "two", "overload"])(
    "resolves the actual implementation of public consumer seam %s",
    async (variant) => {
      const own = createConsumerSeamFixture(variant);
      fixtures.push(own);
      const runtime = await import(
        pathToFileURL(join(own.root, "src/public-consumer.test.mjs")).href
      );
      expect(runtime.consume(1)).toBe(1);
      own.subject = await collectPolicySubject(own.root);
      own.resolver = createSymbolResolver(own.subject);
      const producer = own.resolver.resolveExport(own.record.transform).identities[0];
      const consumerFacts = own.resolver.resolveExport(own.record.consumer);
      expect(consumerFacts.identities).toHaveLength(1);
      expect(consumerFacts.signatures).toHaveLength(1);
      const consumer = consumerFacts.identities[0];
      const binding = own.resolver.consumerCalls(consumer, producer, "beta");
      expect(binding.implementation.owner).toBe("beta");
      expect(binding.bound).toBe(true);
      expect(binding.calls).toHaveLength(1);
      const call = binding.calls[0];
      expect(readFileSync(join(own.root, call.path), "utf8").slice(call.start, call.end)).toBe(
        "validate(input)",
      );
    },
    15_000,
  );

  it("keeps the overload public signature distinct and rechecks source currentness", async () => {
    const own = createConsumerSeamFixture("overload");
    fixtures.push(own);
    own.resolver = createSymbolResolver(await collectPolicySubject(own.root));
    const producer = own.resolver.resolveExport(own.record.transform).identities[0];
    const consumer = own.resolver.resolveExport(own.record.consumer).identities[0];
    const binding = own.resolver.consumerCalls(consumer, producer, "beta");
    expect(binding.implementation.producer.start).not.toBe(consumer.producer.start);
    expect(binding.implementation.producer.path).toBe(consumer.producer.path);
    own.put("packages/beta/src/owner.ts", "export const changed = true;\n");
    expect(() => own.resolver.consumerCalls(consumer, producer, "beta")).toThrow(
      "symbol-subject-changed",
    );
  }, 15_000);

  it("bounds the private sibling walk with the existing alias budget", async () => {
    const own = createConsumerSeamFixture("two");
    fixtures.push(own);
    own.resolver = createSymbolResolver(await collectPolicySubject(own.root), { aliases: 1 });
    const producer = own.resolver.resolveExport(own.record.transform).identities[0];
    const consumer = own.resolver.resolveExport(own.record.consumer).identities[0];
    expect(() => own.resolver.consumerCalls(consumer, producer, "beta")).toThrow(
      "symbol-alias-budget",
    );
  }, 15_000);

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

  it("binds a short canonical witness without budgeting unrelated logging descendants", async () => {
    const helpers = Array.from(
      { length: 70 },
      (_, index) => `function noise${index}(input: number): unknown { return input; }`,
    ).join("\n");
    const calls = Array.from({ length: 70 }, (_, index) => `noise${index}(input);`).join(" ");
    const own = await consumerFixture(
      `function checked(input: number): unknown { return validate(input); } ${helpers}
      export function consume(input: number): unknown { ${calls} return checked(input); }`,
    );
    const runtime = await import(
      pathToFileURL(join(own.root, "packages/alpha/dist/owner.js")).href
    );
    expect(runtime.consume(1)).toEqual({ ok: true, value: 1 });
    const producer = own.resolver.resolveExport(reference).identities[0];
    const consumer = own.resolver.resolveExport({
      ...reference,
      specifier: "alpha/runtime",
      exportName: "consume",
    }).identities[0];
    const binding = own.resolver.consumerCalls(consumer, producer, "alpha");
    expect(binding.bound).toBe(true);
    expect(binding.calls).toHaveLength(1);
  }, 15_000);

  function witnessBinding(own) {
    const producer = own.resolver.resolveExport(reference).identities[0];
    const consumer = own.resolver.resolveExport({
      ...reference,
      specifier: "alpha/runtime",
      exportName: "consume",
    }).identities[0];
    return own.resolver.consumerCalls(consumer, producer, "alpha");
  }

  function witnessChain(prefix, count) {
    return Array.from({ length: count }, (_, index) => {
      const next = index + 1 === count ? "validate(input)" : `${prefix}${index + 1}(input)`;
      return `function ${prefix}${index}(input: number): unknown { return ${next}; }`;
    }).join("\n");
  }

  it("keeps exactly64 contributing states inside the unchanged consumer budget", async () => {
    const own = await consumerFixture(
      `${witnessChain("hop", 63)} export function consume(input: number): unknown { return hop0(input); }`,
    );
    expect(witnessBinding(own).calls).toHaveLength(1);
  }, 15_000);

  it("refuses an actual65-state contributing consumer witness", async () => {
    const own = await consumerFixture(
      `${witnessChain("hop", 64)} export function consume(input: number): unknown { return hop0(input); }`,
    );
    expect(() => witnessBinding(own)).toThrow("symbol-alias-budget");
  }, 15_000);

  it("counts the union of contributing branches once rather than granting64 per branch", async () => {
    const own = await consumerFixture(
      `${witnessChain("left", 32)} ${witnessChain("right", 32)}
      export function consume(input: number): unknown { left0(input); return right0(input); }`,
    );
    expect(() => witnessBinding(own)).toThrow("symbol-alias-budget");
  }, 15_000);

  it("includes both real caller branches of one shared canonical witness", async () => {
    const own = await consumerFixture(
      `function checked(input: number): unknown { return validate(input); }
      function left(input: number): unknown { return checked(input); }
      function right(input: number): unknown { return checked(input); }
      export function consume(input: number): unknown { left(input); return right(input); }`,
    );
    expect(witnessBinding(own).calls).toHaveLength(1);
  }, 15_000);

  it.each([
    ["private-outside", "function outside(input: number): unknown { return checked(input); }"],
    [
      "exported-outside",
      "export function outside(input: number): unknown { return checked(input); }",
    ],
    ["returned", "function outside(): unknown { return checked; }"],
    ["container", "const holder = { checked };"],
    [
      "callback",
      "function invoke(action: (input: number) => unknown): unknown { return action(1); } const outcome = invoke(checked);",
    ],
  ])(
    "refuses incomplete incoming witness references: %s",
    async (_variant, outside) => {
      const own = await consumerFixture(
        `function checked(input: number): unknown { return validate(input); } ${outside}
      export function consume(input: number): unknown { return checked(input); }`,
      );
      expect(witnessBinding(own).bound).toBe(false);
    },
    15_000,
  );

  it.each([
    ["mutable", "let call = checked;"],
    ["opaque", "const call = checked as (input: number) => unknown;"],
  ])(
    "keeps %s callee aliases outside a closed consumer witness",
    async (_variant, alias) => {
      const own = await consumerFixture(
        `function checked(input: number): unknown { return validate(input); } ${alias}
      export function consume(input: number): unknown { return call(input); }`,
      );
      expect(witnessBinding(own).bound).toBe(false);
    },
    15_000,
  );

  it("retains an independent qualified witness without claiming a separate escaped helper", async () => {
    const own = await consumerFixture(
      `function first(input: number): unknown { return validate(input); }
      function escaped(input: number): unknown { return validate(input); }
      const holder = { escaped };
      export function consume(input: number): unknown { escaped(input); return first(input); }`,
    );
    const binding = witnessBinding(own);
    expect(binding.bound).toBe(true);
    expect(binding.calls).toHaveLength(1);
    expect(
      readFileSync(join(own.root, binding.calls[0].path), "utf8").slice(
        binding.calls[0].start,
        binding.calls[0].end,
      ),
    ).toBe("validate(input)");
  }, 15_000);

  it("refuses a contributing cycle even when a canonical producer call is present", async () => {
    const own = await consumerFixture(
      `function first(input: number): unknown { if (input < 0) return second(input); return validate(input); }
      function second(input: number): unknown { return first(input); }
      export function consume(input: number): unknown { return first(input); }`,
    );
    expect(() => witnessBinding(own)).toThrow("unsupported-consumer-helper-cycle");
  }, 15_000);

  it("refuses a counterfeit producer in an otherwise direct consumer", async () => {
    const own = await consumerFixture(
      `export function consume(input: number): unknown {
        const validate = (value: number): unknown => value;
        return validate(input);
      }`,
    );
    expect(witnessBinding(own).bound).toBe(false);
  }, 15_000);

  it("rechecks the current config before reusing a target-directed witness", async () => {
    const own = await consumerFixture(
      "function checked(input: number): unknown { return validate(input); } export function consume(input: number): unknown { return checked(input); }",
    );
    expect(witnessBinding(own).bound).toBe(true);
    const path = "packages/alpha/tsconfig.json";
    own.put(path, readFileSync(join(own.root, path), "utf8") + "\n");
    expect(() => witnessBinding(own)).toThrow("symbol-subject-changed");
  }, 15_000);

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

describe("public diagnostic declaration entry (#3918)", () => {
  it.each(["missing", "nonselected"])(
    "rejects %s barrel entry map with a fresh final producer",
    async (mode) => {
      const own = createDiagnosticFixture();
      fixtures.push(own);
      const final = readFileSync(join(own.root, "packages/alpha/dist/owner.d.ts.map"));
      const map = join(own.root, "packages/alpha/dist/index.d.ts.map");
      if (mode === "missing") unlinkSync(map);
      else {
        const payload = JSON.parse(readFileSync(map));
        payload.mappings += ";AAAA";
        writeFileSync(map, JSON.stringify(payload));
      }
      const subject = await collectPolicySubject(own.root);
      own.resolver = createSymbolResolver(subject, {}, [
        { owner: "packages/alpha", paths: own.record.proofs },
      ]);
      expect(readFileSync(join(own.root, "packages/alpha/dist/owner.d.ts.map"))).toEqual(final);
      expect(() => own.resolver.resolveProofExport(own.record.input)).toThrow();
    },
  );
});

describe("shared public proof compiler state (#3918)", () => {
  it("shares roots, two retained roles and one Native emission across eviction", async () => {
    const own = createDiagnosticFixture();
    fixtures.push(own);
    const subject = await collectPolicySubject(own.root);
    const paths = [...own.record.proofs];
    const compiler = createCompilerContext(subject, {}, [{ owner: "packages/alpha", paths }]);
    try {
      const original = compiler.program("packages/alpha/src/owner.ts");
      const proof = compiler.proofProgram(paths[0]);
      expect(proof.config.fileNames).toEqual(
        [...new Set([...original.config.fileNames, join(subject.root, paths[0])])].sort(),
      );
      expect(proof.config.options).toEqual({ ...original.config.options, noEmit: true });
      expect(compiler.proofProgram(paths[0])).toBe(proof);
      expect(compiler.state.programs.size).toBe(2);
      compiler.program("src/consumer.ts");
      expect(compiler.state.programs.size).toBe(2);
      expect(compiler.state.created).toBe(3);
      paths.push("packages/alpha/src/unselected.test.ts");
      expect(() => compiler.assertCurrent()).toThrow("symbol-proof-context-changed");
    } finally {
      compiler.close();
    }
    expect(compiler.state.programs.size).toBe(0);
    expect(() => compiler.proofProgram(paths[0])).toThrow("symbol-resolver-closed");
    own.resolver = createSymbolResolver(subject, { programs: 1 }, [
      { owner: "packages/alpha", paths: own.record.proofs },
    ]);
    vi.mocked(execFileSync).mockClear();
    own.resolver.resolveProofExport(own.record.input);
    own.resolver.resolveExport(reference);
    own.resolver.resolveProofExport(own.record.input);
    expect(
      vi
        .mocked(execFileSync)
        .mock.calls.filter(([, args]) => args.includes("--emitDeclarationOnly")),
    ).toHaveLength(1);
  });
  it.each(["packages/alpha/src/owner.ts", "src/consumer.ts", "packages/beta/src/proof.test.ts"])(
    "rejects undeclared or unowned proof root %s",
    async (path) => {
      const own = createDiagnosticFixture();
      fixtures.push(own);
      const subject = await collectPolicySubject(own.root);
      expect(() =>
        createSymbolResolver(subject, {}, [{ owner: "packages/alpha", paths: [path] }]),
      ).toThrow("invalid-proof-root");
    },
  );
  it.each(["proof", "config", "export"])(
    "rejects observed %s mutation across proof and production",
    async (mode) => {
      const own = createDiagnosticFixture();
      fixtures.push(own);
      const subject = await collectPolicySubject(own.root);
      own.resolver = createSymbolResolver(subject, {}, [
        { owner: "packages/alpha", paths: own.record.proofs },
      ]);
      own.resolver.resolveProofExport(own.record.input);
      const path =
        mode === "proof"
          ? own.record.proofs[0]
          : mode === "config"
            ? "packages/alpha/tsconfig.json"
            : "packages/alpha/package.json";
      own.put(path, readFileSync(join(own.root, path), "utf8") + "\n");
      expect(() => own.resolver.resolveProofExport(own.record.input)).toThrow(
        "symbol-subject-changed",
      );
    },
  );
  it.each([{ sourceBytes: 1 }, { nodes: 1 }, { emitBytes: 1 }, { aliases: 1 }])(
    "keeps proof contexts within shared budget %j",
    async (limits) => {
      const own = createDiagnosticFixture();
      fixtures.push(own);
      own.resolver = createSymbolResolver(await collectPolicySubject(own.root), limits, [
        { owner: "packages/alpha", paths: own.record.proofs },
      ]);
      expect(() => own.resolver.resolveProofExport(own.record.input)).toThrow();
    },
  );
  it("rejects an intermediate full-map mutation with the final owner fresh", async () => {
    const own = createDiagnosticFixture();
    fixtures.push(own);
    own.put("packages/alpha/src/bridge.ts", 'export { validate as parse } from "./owner.js";');
    own.put("packages/alpha/src/index.ts", 'export { parse } from "./bridge.js";');
    emitSymbolFixture(own.root);
    const map = join(own.root, "packages/alpha/dist/bridge.d.ts.map");
    const payload = JSON.parse(readFileSync(map));
    payload.mappings += ";AAAA";
    writeFileSync(map, JSON.stringify(payload));
    own.resolver = createSymbolResolver(await collectPolicySubject(own.root), {}, [
      { owner: "packages/alpha", paths: own.record.proofs },
    ]);
    expect(() => own.resolver.resolveProofExport(own.record.input)).toThrow(
      "stale-declaration-provenance",
    );
  });
});

describe("closed public entry selection (#3918)", () => {
  it.each([
    "runtime-producer",
    "missing-runtime",
    "extra-condition",
    "nested-condition",
    "wildcard",
    "dist-override",
    "require-mode",
  ])("refuses %s public entry", async (mode) => {
    const own = createDiagnosticFixture();
    fixtures.push(own);
    const manifest = JSON.parse(readFileSync(join(own.root, "packages/alpha/package.json")));
    const config = JSON.parse(readFileSync(join(own.root, "packages/alpha/tsconfig.json")));
    if (mode === "runtime-producer") manifest.exports["."].import = "./dist/owner.js";
    if (mode === "extra-condition") manifest.exports["."].default = "./dist/index.js";
    if (mode === "nested-condition") manifest.exports["."].import = { default: "./dist/index.js" };
    if (mode === "wildcard") {
      manifest.exports["./*"] = manifest.exports["."];
      own.put(
        own.record.proofs[0],
        readFileSync(join(own.root, own.record.proofs[0]), "utf8").replace(
          'from "alpha"',
          'from "alpha/index"',
        ),
      );
      own.record.input.specifier = "alpha/index";
    }
    if (mode === "dist-override") config.compilerOptions.paths = { alpha: ["./dist/index.d.ts"] };
    if (mode === "require-mode") {
      manifest.type = "commonjs";
      config.compilerOptions.verbatimModuleSyntax = false;
    }
    own.put("packages/alpha/package.json", manifest);
    own.put("packages/alpha/tsconfig.json", config);
    if (mode === "require-mode") emitSymbolFixture(own.root);
    if (mode === "missing-runtime") unlinkSync(join(own.root, "packages/alpha/dist/index.js"));
    own.resolver = createSymbolResolver(await collectPolicySubject(own.root), {}, [
      { owner: "packages/alpha", paths: own.record.proofs },
    ]);
    expect(() => own.resolver.resolveProofExport(own.record.input)).toThrow();
  });
});

describe("diagnostic proof guard challenges (#3918)", () => {
  it("rejects a local ReadonlyArray impersonation after qualifying the actual producer", async () => {
    const own = createDiagnosticFixture();
    fixtures.push(own);
    own.resolver = createSymbolResolver(await collectPolicySubject(own.root), {}, [
      { owner: "packages/alpha", paths: own.record.proofs },
    ]);
    const healthy = own.resolver.resolveProofExport(own.record.input).identities[0];
    expect(own.resolver.diagnosticBinding(own.record.consumer, healthy).bound).toBe(true);
    own.resolver.close();
    own.put(
      "packages/alpha/src/owner.ts",
      'interface ReadonlyArray<T> { readonly length: number; readonly value: T; }\nexport function validate(input: unknown): ReadonlyArray<string> { return { length: typeof input === "number" ? 0 : 1, value: "invalid" }; }\n',
    );
    emitSymbolFixture(own.root);
    own.resolver = createSymbolResolver(await collectPolicySubject(own.root), {}, [
      { owner: "packages/alpha", paths: own.record.proofs },
    ]);
    const actual = own.resolver.resolveProofExport(own.record.input).identities[0];
    expect(actual.producer.path).toBe("packages/alpha/src/owner.ts");
    expect(own.resolver.diagnosticBinding(own.record.consumer, actual).bound).toBe(false);
  });
  it("rejects stale original input before returning a cached proof Program", async () => {
    const own = createDiagnosticFixture();
    fixtures.push(own);
    const subject = await collectPolicySubject(own.root);
    const compiler = createCompilerContext(subject, {}, [
      { owner: "packages/alpha", paths: own.record.proofs },
    ]);
    try {
      const path = own.record.proofs[0];
      const proof = compiler.proofProgram(path);
      expect(compiler.proofProgram(path)).toBe(proof);
      own.put(path, readFileSync(join(own.root, path), "utf8") + "\n");
      expect(() => compiler.proofProgram(path)).toThrow("symbol-subject-changed");
    } finally {
      compiler.close();
    }
  });
  it("detaches immutable derived configuration from original compiler options", async () => {
    const own = createDiagnosticFixture();
    fixtures.push(own);
    const subject = await collectPolicySubject(own.root);
    const original = subject.contexts.get("packages/alpha");
    const libraries = [...original.options.lib];
    const compiler = createCompilerContext(subject, {}, [
      { owner: "packages/alpha", paths: own.record.proofs },
    ]);
    try {
      const proof = compiler.proofProgram(own.record.proofs[0]);
      expect(proof.config.options).toEqual({ ...original.options, noEmit: true });
      const mutations = [
        () => proof.config.fileNames.push(join(subject.root, "unselected.ts")),
        () => {
          proof.config.options.strict = false;
        },
        () => proof.config.options.lib.push("lib.dom.d.ts"),
      ];
      const errors = [];
      for (const mutate of mutations) {
        try {
          mutate();
        } catch (error) {
          if (!(error instanceof TypeError)) throw error;
          errors.push(error);
        }
      }
      expect(original.options.lib).toEqual(libraries);
      expect(errors).toHaveLength(mutations.length);
      expect(compiler.proofProgram(own.record.proofs[0])).toBe(proof);
    } finally {
      compiler.close();
    }
  });
  it.each([
    { type: "ReadonlyArray<string>", bound: true },
    { type: "string[]", bound: false },
  ])("preserves the intrinsic result contract for $type", async ({ type, bound }) => {
    const own = createDiagnosticFixture();
    fixtures.push(own);
    own.put(
      "packages/alpha/src/owner.ts",
      `export function validate(input: unknown): ${type} { return typeof input === "number" ? [] : ["invalid"]; }\n`,
    );
    emitSymbolFixture(own.root);
    own.resolver = createSymbolResolver(await collectPolicySubject(own.root), {}, [
      { owner: "packages/alpha", paths: own.record.proofs },
    ]);
    const actual = own.resolver.resolveProofExport(own.record.input).identities[0];
    expect(actual.producer.path).toBe("packages/alpha/src/owner.ts");
    expect(own.resolver.diagnosticBinding(own.record.consumer, actual).bound).toBe(bound);
  });
  it("detaches nested paths and rootDirs without freezing the original AST", async () => {
    const own = createDiagnosticFixture();
    fixtures.push(own);
    const config = JSON.parse(readFileSync(join(own.root, "packages/alpha/tsconfig.json")));
    config.compilerOptions.paths = { "unused/*": ["./src/*"] };
    config.compilerOptions.rootDirs = ["./src"];
    own.put("packages/alpha/tsconfig.json", config);
    emitSymbolFixture(own.root);
    const subject = await collectPolicySubject(own.root);
    const original = subject.contexts.get("packages/alpha");
    const paths = structuredClone(original.options.paths);
    const rootDirs = [...original.options.rootDirs];
    const configFile = Object.getOwnPropertyDescriptor(original.options, "configFile");
    const compiler = createCompilerContext(subject, {}, [
      { owner: "packages/alpha", paths: own.record.proofs },
    ]);
    try {
      const proof = compiler.proofProgram(own.record.proofs[0]);
      expect(() => proof.config.options.paths["unused/*"].push("./other/*")).toThrow(TypeError);
      expect(() => proof.config.options.rootDirs.push(join(subject.root, "other"))).toThrow(
        TypeError,
      );
      expect(original.options.paths).toEqual(paths);
      expect(original.options.rootDirs).toEqual(rootDirs);
      expect(Object.isFrozen(original.options)).toBe(false);
      expect(proof.config.options.configFile).toBe(original.options.configFile);
      expect(Object.getOwnPropertyDescriptor(proof.config.options, "configFile").enumerable).toBe(
        false,
      );
      expect(Object.getOwnPropertyDescriptor(proof.config.options, "configFile").value).toBe(
        original.options.configFile,
      );
      expect(Object.getOwnPropertyDescriptor(original.options, "configFile")).toEqual(configFile);
      expect(Object.isFrozen(original.options.configFile)).toBe(false);
      expect(proof.config.projectReferences).toBe(original.projectReferences);
    } finally {
      compiler.close();
    }
  });
});

describe("captured unknown predicate arguments (#3918)", () => {
  it("adds only actual captured unknown call arguments without growing the raw helper graph", async () => {
    const own = createRawHelperEnforcementFixture("captured");
    fixtures.push(own);
    own.resolver = createSymbolResolver(await collectPolicySubject(own.root));
    const identity = own.resolver.resolveExport(own.record.input).identities[0];
    const source = readFileSync(join(own.root, identity.producer.path), "utf8");
    const legacy = own.resolver.rawCheckingSlots(identity, 0);
    const slots = own.resolver.rawCheckingSlots(identity, 0, true);
    const captured = slots.filter((slot) => slot.capturedUnknownPredicate);
    expect(captured.map(({ start, end, origin }) => [source.slice(start, end), origin])).toEqual([
      ["first", ["first"]],
      ["second", ["second"]],
    ]);
    expect(slots.filter((slot) => !slot.capturedUnknownPredicate)).toEqual(legacy);
    expect(own.resolver.rawCheckingSlots(identity, 0)).toEqual(legacy);
  });

  it.each(["typed-capture", "unchecked-capture"])(
    "withholds captured grants from %s",
    async (variant) => {
      const own = createRawHelperEnforcementFixture(variant);
      fixtures.push(own);
      own.resolver = createSymbolResolver(await collectPolicySubject(own.root));
      const identity = own.resolver.resolveExport(own.record.input).identities[0];
      const legacy = own.resolver.rawCheckingSlots(identity, 0);
      expect(own.resolver.rawCheckingSlots(identity, 0, true)).toEqual(legacy);
    },
  );
});

describe("optional callback captured unknown predicates (#3918)", () => {
  async function optionalFixture(variant = "optional-capture", options = {}) {
    const own = createRawHelperEnforcementFixture(variant);
    fixtures.push(own);
    own.resolver = createSymbolResolver(await collectPolicySubject(own.root), options);
    own.identity = own.resolver.resolveExport(own.record.input).identities[0];
    return own;
  }

  it("adds only captured arguments through the exact optional edge and preserves legacy slots", async () => {
    const own = await optionalFixture();
    const source = readFileSync(join(own.root, own.identity.producer.path), "utf8");
    const legacy = own.resolver.rawCheckingSlots(own.identity, 0);
    const slots = own.resolver.rawCheckingSlots(own.identity, 0, true);
    expect(
      slots
        .filter((slot) => slot.capturedUnknownPredicate)
        .map(({ start, end, origin }) => [source.slice(start, end), origin]),
    ).toEqual([
      ["first", ["first"]],
      ["second", ["second"]],
    ]);
    expect(slots.filter((slot) => !slot.capturedUnknownPredicate)).toEqual(legacy);
    expect(own.resolver.rawCheckingSlots(own.identity, 0, false)).toEqual(legacy);
    expect(legacy.every((slot) => !slot.capturedUnknownPredicate)).toBe(true);
  });

  it.each([
    "wrong-value",
    "altered-body",
    "exported",
    "escape",
    "reference",
    "write",
    "shadow",
    "shadow-undefined",
    "extra-argument",
    "optional-call",
    "default",
    "predicate-write",
    "wrapper-export-alias",
    "wrapper-export-default",
  ])("withholds supplemental authority from %s", async (variant) => {
    const own = await optionalFixture(`optional-capture-${variant}`);
    const legacy = own.resolver.rawCheckingSlots(own.identity, 0);
    expect(own.resolver.rawCheckingSlots(own.identity, 0, true)).toEqual(legacy);
  });

  it("retains cycle refusal on a newly reachable callback", async () => {
    const own = await optionalFixture("optional-capture-cycle");
    expect(() => own.resolver.rawCheckingSlots(own.identity, 0, true)).toThrow(
      "unsupported-raw-helper-cycle",
    );
  });

  it("bounds supplemental states with the configured alias budget", async () => {
    const own = await optionalFixture("optional-capture", { aliases: 4 });
    expect(() => own.resolver.rawCheckingSlots(own.identity, 0, true)).toThrow(
      "symbol-alias-budget",
    );
  });

  it("keeps supplemental cache facts immutable and rejects changed source", async () => {
    const own = await optionalFixture();
    const slots = own.resolver.rawCheckingSlots(own.identity, 0, true);
    const slot = slots.find((entry) => entry.capturedUnknownPredicate);
    expect(slot).toBeDefined();
    slot.origin.push("untrusted");
    expect(own.resolver.rawCheckingSlots(own.identity, 0, true)).not.toEqual(slots);
    const path = own.identity.producer.path;
    own.put(path, readFileSync(join(own.root, path), "utf8") + "\n// changed source\n");
    expect(() => own.resolver.rawCheckingSlots(own.identity, 0, true)).toThrow();
  });
});

describe("dictionary exact-member before controls (#3918)", () => {
  it.each(["direct", "unicode"])(
    "binds only exact %s dictionary members",
    async (variant) => {
      const own = createDictionaryEnforcementFixture(variant);
      fixtures.push(own);
      own.resolver = createSymbolResolver(await collectPolicySubject(own.root));
      const identity = own.resolver.resolveExport(own.record.input).identities[0];
      const source = readFileSync(join(own.root, identity.producer.path), "utf8");
      const slots = own.resolver.rawCheckingSlots(identity, 0);
      expect(own.resolver.callableSlots(identity).parameters[0].type.kind).toBe("unknown");
      const dictionaries = slots.filter(
        ({ rule }) => rule === "anti-slop/no-unsafe-dictionary-type",
      );
      expect(dictionaries).toHaveLength(3);
      expect(dictionaries.map(({ start, end }) => source.slice(start, end))).toEqual([
        "Record<string, unknown>",
        "Record<string, unknown>",
        "Record<string, unknown>",
      ]);
      expect(
        dictionaries.every(({ start }) => start < source.indexOf("export function unrelated")),
      ).toBe(true);
    },
    30_000,
  );

  it("exposes shallow intersection indexes without treating the output as primitive", async () => {
    const own = createDictionaryEnforcementFixture("intersection");
    fixtures.push(own);
    own.resolver = createSymbolResolver(await collectPolicySubject(own.root));
    const identity = own.resolver.resolveExport(own.record.output).identities[0];
    const facts = own.resolver.callableSlots(identity);
    expect(facts.parameters[0].type.kind).toBe("unknown");
    expect(facts.result.type.indexes).toEqual([{ kind: "unknown" }]);
  }, 30_000);

  it("withdraws predicate recheck after explicit intersection raw erasure", async () => {
    const own = createDictionaryEnforcementFixture("erasure");
    fixtures.push(own);
    own.resolver = createSymbolResolver(await collectPolicySubject(own.root));
    const identity = own.resolver.resolveExport(own.record.input).identities[0];
    const source = readFileSync(join(own.root, identity.producer.path), "utf8");
    const offset = source.indexOf("fields(erased)") + "fields(".length;
    expect(own.resolver.callableSlots(identity).parameters[0].type.kind).toBe("unknown");
    const slots = own.resolver.rawCheckingSlots(identity, 0);
    expect(
      slots.filter(
        ({ rule, start }) => rule === "anti-slop/no-known-value-widening" && start === offset,
      ),
    ).toEqual([]);
  }, 30_000);
});

describe("dictionary bounded refusal controls (#3918)", () => {
  it("keeps dictionary helper cycles rejected by the existing raw closure", async () => {
    const own = createDictionaryEnforcementFixture("cycle");
    fixtures.push(own);
    own.resolver = createSymbolResolver(await collectPolicySubject(own.root));
    const identity = own.resolver.resolveExport(own.record.input).identities[0];
    expect(() => own.resolver.rawCheckingSlots(identity, 0)).toThrow(
      "unsupported-raw-helper-cycle",
    );
  }, 30_000);

  it.each([
    ["typed-index", 0],
    ["any-index", 0],
    ["counterfeit", 0],
    ["alias-member", 0],
    ["export-helper", 1],
    ["reexport-helper", 1],
    ["second-caller", 1],
    ["callback", 1],
    ["return-escape", 1],
    ["helper-write", 1],
    ["root-write", 0],
    ["unused", 1],
    ["deferred", 1],
    ["computed", 1],
    ["reflective", 1],
    ["destructured", 1],
    ["mutable-alias", 1],
    ["parameter-intersection", 2],
    ["other-predicate-parameter", 2],
  ])(
    "retains dictionary enforcement for %s",
    async (variant, count) => {
      const own = createDictionaryEnforcementFixture(variant);
      fixtures.push(own);
      own.resolver = createSymbolResolver(await collectPolicySubject(own.root));
      const identity = own.resolver.resolveExport(own.record.input).identities[0];
      expect(own.resolver.callableSlots(identity).parameters[0].type.kind).toBe("unknown");
      const slots = own.resolver.rawCheckingSlots(identity, 0);
      expect(
        slots.filter(({ rule }) => rule === "anti-slop/no-unsafe-dictionary-type"),
      ).toHaveLength(count);
    },
    30_000,
  );
});

describe("public parser symbol and runtime binding (#3918)", () => {
  it.each(["direct", "reasons", "instantiated-reasons"])(
    "binds the actual %s named public subpath and unchanged runtime results",
    async (variant) => {
      const own = createPublicParserFixture(variant);
      fixtures.push(own);
      const subject = await collectPolicySubject(own.root);
      own.resolver = createSymbolResolver(subject, {}, [
        { owner: "packages/alpha", paths: own.record.proofs },
      ]);
      const producer = own.resolver.resolveProofExport(own.record.input).identities[0];
      const binding = own.resolver.parserBinding(own.record.consumer, producer);
      expect(binding).toMatchObject({ bound: true, status: "ready" });
      const runtime = await import(
        pathToFileURL(join(own.root, "packages/alpha/src/proof.test.ts")).href
      );
      expect(runtime.publicParse(7)).toEqual({ ok: true, value: 7 });
      expect(runtime.publicParse(null)).toEqual({
        ok: false,
        [variant.endsWith("reasons") ? "reasons" : "errors"]: ["invalid"],
      });
    },
  );
  it.each([{ nodes: 1 }, { sourceBytes: 1 }, { emitBytes: 1 }])(
    "retains actual configured parser budgets %j",
    async (options) => {
      const own = createPublicParserFixture();
      fixtures.push(own);
      const subject = await collectPolicySubject(own.root);
      own.resolver = createSymbolResolver(subject, options, [
        { owner: "packages/alpha", paths: own.record.proofs },
      ]);
      expect(() => own.resolver.resolveProofExport(own.record.input)).toThrow();
    },
  );
  it("rechecks proof/runtime snapshots and never shares mutable binding facts", async () => {
    const own = createPublicParserFixture();
    fixtures.push(own);
    const subject = await collectPolicySubject(own.root);
    own.resolver = createSymbolResolver(subject, {}, [
      { owner: "packages/alpha", paths: own.record.proofs },
    ]);
    const producer = own.resolver.resolveProofExport(own.record.input).identities[0];
    const first = own.resolver.parserBinding(own.record.consumer, producer);
    first.bound = false;
    expect(own.resolver.parserBinding(own.record.consumer, producer).bound).toBe(true);
    own.put(
      own.record.consumer.consumerPath,
      readFileSync(join(own.root, own.record.consumer.consumerPath), "utf8") + "\n",
    );
    expect(() => own.resolver.parserBinding(own.record.consumer, producer)).toThrow();
  });
});

describe("public parser separate executed controls (#3918)", () => {
  it.each(["unknown", "any"])(
    "rejects declaration-only nested %s weakening through the strict owning proof",
    async (erasure) => {
      const own = createPublicParserFixture("nested-typed");
      fixtures.push(own);
      const proof =
        readFileSync(join(own.root, own.record.consumer.consumerPath), "utf8") +
        `
      type Nested = Extract<ParseResult, { ok: true }>["value"]["nested"];
      type IsAny<T> = 0 extends (1 & T) ? true : false;
      export const retainedType: IsAny<Nested> = false;
      export function nestedNumber(result: ParseResult): number {
        if (!result.ok) throw new TypeError("invalid");
        return result.value.nested;
      }
    `;
      own.put(own.record.consumer.consumerPath, proof);
      let subject = await collectPolicySubject(own.root);
      let resolver = createSymbolResolver(subject, {}, [
        { owner: "packages/alpha", paths: own.record.proofs },
      ]);
      try {
        expect(resolver.resolveProofConsumer(own.record.consumer).signatures).toHaveLength(1);
      } finally {
        resolver.close();
      }
      const owner = readFileSync(join(own.root, "packages/alpha/src/owner.ts"), "utf8");
      own.put("packages/alpha/src/owner.ts", owner.replace("nested: number", `nested: ${erasure}`));
      emitSymbolFixture(own.root);
      const runtime = await import(
        pathToFileURL(join(own.root, "packages/alpha/dist/owner.js")).href
      );
      expect(runtime.validate(7)).toEqual({ ok: true, value: { nested: 7 } });
      subject = await collectPolicySubject(own.root);
      resolver = createSymbolResolver(subject, {}, [
        { owner: "packages/alpha", paths: own.record.proofs },
      ]);
      try {
        expect(() => resolver.resolveProofConsumer(own.record.consumer)).toThrow(
          "unqualified-proof-context",
        );
      } finally {
        resolver.close();
      }
    },
  );
  it.each(["direct", "reasons"])(
    "rejects a same-signature unchecked %s body through actual public runtime assertions",
    async (variant) => {
      const own = createPublicParserFixture(variant);
      fixtures.push(own);
      const owner = readFileSync(join(own.root, "packages/alpha/src/owner.ts"), "utf8");
      own.put(
        "packages/alpha/src/owner.ts",
        owner.replace(
          `{ ok: false, ${variant === "reasons" ? "reasons" : "errors"}: ["invalid"] }`,
          "{ ok: true, value: 0 }",
        ),
      );
      emitSymbolFixture(own.root);
      const runtime = await import(
        pathToFileURL(join(own.root, "packages/alpha/dist/owner.js")).href
      );
      expect(runtime.validate(7)).toEqual({ ok: true, value: 7 });
      expect(() =>
        expect(runtime.validate(null)).toEqual({
          ok: false,
          [variant === "reasons" ? "reasons" : "errors"]: ["invalid"],
        }),
      ).toThrow();
      const subject = await collectPolicySubject(own.root);
      const resolver = createSymbolResolver(subject, {}, [
        { owner: "packages/alpha", paths: own.record.proofs },
      ]);
      try {
        const producer = resolver.resolveProofExport(own.record.input).identities[0];
        expect(resolver.parserBinding(own.record.consumer, producer).status).toBe("ready");
      } finally {
        resolver.close();
      }
    },
  );
});

async function currentnessFixture(prepare, options = {}) {
  const own = createSymbolFixture(false, prepare);
  fixtures.push(own);
  const subject = await collectPolicySubject(own.root);
  const compiler = createCompilerContext(subject, options);
  own.resolver = compiler;
  return { ...own, compiler };
}

function currentnessTargetBufferAllocations(compiler, byteLength) {
  const allocate = Buffer.allocUnsafe;
  let allocations = 0;
  const traced = vi.spyOn(Buffer, "allocUnsafe").mockImplementation((size) => {
    if (size === byteLength) allocations += 1;
    return Reflect.apply(allocate, Buffer, [size]);
  });
  try {
    compiler.assertCurrent();
    compiler.assertCurrent();
  } finally {
    traced.mockRestore();
  }
  return allocations;
}

// Work regression controls, not a newly discovered content-admission defect. The tracer delegates
// every allocation to Node and observes only the byte length of the actual admitted fixture.
async function collectiveSymbolFixture(variant = "direct", options = {}) {
  const own = createCollectiveParserFixture(variant);
  fixtures.push(own);
  own.subject = await collectPolicySubject(own.root);
  own.resolver = createSymbolResolver(own.subject, options, [
    {
      owner: "packages/alpha",
      paths: ["packages/alpha/src/proof.test.ts"],
    },
  ]);
  own.rawRoots = own.records.map((record) => ({
    identity: own.resolver.resolveProofExport(record.input).identities[0],
    index: 0,
    recordId: record.id,
  }));
  return own;
}

describe("collective exact raw symbol closure (#3918)", () => {
  it("preserves existing const callable producer coordinates without public-proof certification", async () => {
    const own = createCollectiveParserFixture("public-const-alias");
    fixtures.push(own);
    own.resolver = createSymbolResolver(await collectPolicySubject(own.root));
    const roots = own.records.map((record) => ({
      identity: own.resolver.resolveExport({ ...record.input, consumerPath: "src/consumer.ts" })
        .identities[0],
      index: 0,
      recordId: record.id,
    }));
    expect(roots[0].identity.producer.kind).toBe("VariableDeclaration");
    expect(roots[2].identity.producer).toEqual(roots[0].identity.producer);
    const slots = own.resolver.collectiveRawCheckingSlots(roots, "anti-slop/no-unknown-parameters");
    const variable = slots.filter(
      (slot) => slot.producerIdentity.producer.kind === "VariableDeclaration",
    );
    expect(variable).toHaveLength(1);
    expect(variable[0].producerIdentity.producer).toEqual(roots[0].identity.producer);
  }, 30_000);

  it("withholds empty, typed and written roots and bounds the incoming root set", async () => {
    const own = await collectiveSymbolFixture("domain");
    expect(own.resolver.collectiveRawCheckingSlots([], "anti-slop/no-runtime-typeof")).toEqual([]);
    const domain = own.resolver.resolveProofExport({
      ...own.records[0].input,
      exportName: "domain",
    }).identities[0];
    expect(
      own.resolver.collectiveRawCheckingSlots(
        [{ identity: domain, index: 0, recordId: "domain" }],
        "anti-slop/no-runtime-typeof",
      ),
    ).toEqual([]);
    expect(() =>
      own.resolver.collectiveRawCheckingSlots(
        Array(65).fill(own.rawRoots[0]),
        "anti-slop/no-runtime-typeof",
      ),
    ).toThrow("symbol-alias-budget");
    const written = await collectiveSymbolFixture("root-write");
    expect(
      written.resolver.collectiveRawCheckingSlots(
        [written.rawRoots[0]],
        "anti-slop/no-runtime-typeof",
      ),
    ).toEqual([]);
  }, 30_000);

  it("preserves legacy second-caller refusal and closes only canonical registered roots", async () => {
    const own = await collectiveSymbolFixture();
    const legacy = own.resolver.rawCheckingSlots(own.rawRoots[0].identity, 0);
    expect(legacy.filter(({ rule }) => rule === "anti-slop/no-unknown-parameters")).toHaveLength(1);
    const slots = own.resolver.collectiveRawCheckingSlots(
      own.rawRoots,
      "anti-slop/no-unknown-parameters",
    );
    expect(slots).toHaveLength(4);
    expect(
      slots.filter(
        ({ contributingResponsibilityIds }) => contributingResponsibilityIds.length === 2,
      ),
    ).toHaveLength(2);
    expect(
      own.resolver
        .collectiveRawCheckingSlots([...own.rawRoots].reverse(), "anti-slop/no-unknown-parameters")
        .sort((a, b) => a.start - b.start),
    ).toEqual(slots.sort((a, b) => a.start - b.start));
  }, 30_000);

  it.each(["counterfeit", "alias-member"])(
    "does not grant intrinsic dictionary slots to %s members",
    async (variant) => {
      const own = await collectiveSymbolFixture(variant);
      const slots = own.resolver.collectiveRawCheckingSlots(
        own.rawRoots,
        "anti-slop/no-unsafe-dictionary-type",
      );
      if (variant === "counterfeit") expect(slots).toEqual([]);
      else expect(slots).toHaveLength(2);
    },
    30_000,
  );

  it("keeps narrowed call operands and nonraw second parameters outside the closure", async () => {
    const own = await collectiveSymbolFixture("narrowed");
    const source = readFileSync(join(own.root, "packages/alpha/src/owner.ts"), "utf8");
    const start = source.indexOf("input: unknown", source.indexOf("function primitive")) + 7;
    const slots = own.resolver.collectiveRawCheckingSlots(
      own.rawRoots,
      "anti-slop/no-unknown-parameters",
    );
    expect(slots.some((slot) => slot.start === start)).toBe(false);
    const second = await collectiveSymbolFixture("second-parameter");
    expect(
      second.resolver
        .collectiveRawCheckingSlots(second.rawRoots, "anti-slop/no-unknown-parameters")
        .some((slot) => slot.index === 1),
    ).toBe(false);
  }, 30_000);

  it("rejects collective cycles, existing alias budget exhaustion and fresh source mutation", async () => {
    const cycle = await collectiveSymbolFixture("cycle");
    expect(() =>
      cycle.resolver.collectiveRawCheckingSlots(cycle.rawRoots, "anti-slop/no-runtime-typeof"),
    ).toThrow("unsupported-raw-helper-cycle");
    const bounded = await collectiveSymbolFixture("direct", { aliases: 2 });
    expect(() =>
      bounded.resolver.collectiveRawCheckingSlots(bounded.rawRoots, "anti-slop/no-runtime-typeof"),
    ).toThrow("symbol-alias-budget");
    const changed = await collectiveSymbolFixture();
    const path = join(changed.root, "packages/alpha/src/owner.ts");
    writeFileSync(path, readFileSync(path, "utf8") + "\n");
    expect(() =>
      changed.resolver.collectiveRawCheckingSlots(changed.rawRoots, "anti-slop/no-runtime-typeof"),
    ).toThrow("symbol-subject-changed");
  }, 30_000);
});

describe("compiler lossless canonical currentness work", () => {
  it.each(["plain", "é🙂"])(
    "freshly observes admitted %s without allocating raw target buffers",
    async (label) => {
      const path = "src/currentness.ts";
      const text = `export const label = "${label.repeat(10_007)}";\n`;
      const own = await currentnessFixture(({ put }) => put(path, text));
      const observed = own.compiler.read(path);
      expect(observed).toBe(text);
      expect(currentnessTargetBufferAllocations(own.compiler, Buffer.byteLength(observed))).toBe(0);
      const absolute = join(own.root, path);
      writeFileSync(absolute, Buffer.concat([Buffer.from(observed), Buffer.from([0x80])]));
      expect(readFileSync(absolute, "utf8")).toContain("\uFFFD");
      expect(() => own.compiler.assertCurrent()).toThrow("symbol-subject-changed");
    },
  );

  it.each(["input", "snapshot-only"])(
    "keeps literal U+FFFD %s text on the fresh raw-byte fallback",
    async (mode) => {
      const input = "src/currentness.ts";
      const text = `export const label = "${"\uFFFD".repeat(4_017)}";\n`;
      const own = await currentnessFixture(({ put }) => put(input, text));
      const path = mode === "input" ? input : "packages/alpha/dist/owner.d.ts";
      const absolute = join(own.root, path);
      if (mode === "snapshot-only") writeFileSync(absolute, text);
      const observed = own.compiler.read(path);
      expect(observed).toBe(text);
      expect(
        currentnessTargetBufferAllocations(own.compiler, Buffer.byteLength(observed)),
      ).toBeGreaterThan(0);
      writeFileSync(absolute, text.replace("\uFFFD", "\uFFFE"));
      expect(() => own.compiler.assertCurrent()).toThrow("symbol-subject-changed");
    },
  );
});

describe("fresh compiler content observations (#3918)", () => {
  it.each(["plain", "é🙂"])("preserves unchanged %s text and repeated admission", async (label) => {
    const path = "src/currentness.ts";
    const text = `export const label = "${label}";\n`;
    const own = await currentnessFixture(({ put }) => put(path, text));
    expect(own.compiler.read(path)).toBe(text);
    const admittedBytes = own.compiler.state.bytes;
    expect(() => own.compiler.assertCurrent()).not.toThrow();
    expect(own.compiler.read(path)).toBe(text);
    expect(own.compiler.state.bytes).toBe(admittedBytes);
    expect(() => own.compiler.assertCurrent()).not.toThrow();
  });

  it.each(["admitted", "input-only"])(
    "refuses a same-size %s rewrite with restored timestamps",
    async (mode) => {
      const path = "src/currentness.ts";
      const text = 'export const label = "first";\n';
      const timestamp = new Date("2020-01-01T00:00:00.000Z");
      const own = await currentnessFixture(({ root, put }) => {
        put(path, text);
        utimesSync(join(root, path), timestamp, timestamp);
      });
      const absolute = join(own.root, path);
      if (mode === "admitted") expect(own.compiler.read(path)).toBe(text);
      else expect(own.compiler.state.snapshots.has(absolute)).toBe(false);
      expect(() => own.compiler.assertCurrent()).not.toThrow();
      const original = statSync(absolute);
      writeFileSync(absolute, text.replace("first", "other"));
      utimesSync(absolute, original.atime, original.mtime);
      expect(statSync(absolute).size).toBe(original.size);
      expect(statSync(absolute).mtimeMs).toBe(original.mtimeMs);
      expect(() => own.compiler.assertCurrent()).toThrow("symbol-subject-changed");
    },
  );

  it("refuses a changed snapshot-only generated output", async () => {
    const own = await currentnessFixture();
    const path = "packages/alpha/dist/owner.d.ts";
    const absolute = join(own.root, path);
    const text = readFileSync(absolute, "utf8");
    expect(own.compiler.state.inputs.has(path)).toBe(false);
    expect(own.compiler.read(path)).toBe(text);
    expect(() => own.compiler.assertCurrent()).not.toThrow();
    writeFileSync(absolute, text + "\n");
    expect(() => own.compiler.assertCurrent()).toThrow("symbol-subject-changed");
  });

  it("freshly refuses mutation after the complete input pass", async () => {
    const path = "src/currentness.ts";
    const text = 'export const label = "first";\n';
    const own = await currentnessFixture(({ put }) => put(path, text));
    expect(own.compiler.read(path)).toBe(text);
    expect(() => own.compiler.assertCurrent()).not.toThrow();
    const inputs = own.compiler.state.inputs;
    const originalIterator = inputs[Symbol.iterator].bind(inputs);
    let visits = 0;
    let inputPassCompleted = false;
    inputs[Symbol.iterator] = function* () {
      for (const entry of originalIterator()) {
        visits += 1;
        yield entry;
      }
      inputPassCompleted = true;
      writeFileSync(join(own.root, path), text.replace("first", "other"));
    };
    expect(() => own.compiler.assertCurrent()).toThrow("symbol-subject-changed");
    expect(visits).toBe(inputs.size);
    expect(inputPassCompleted).toBe(true);
  });

  it.each(["input", "snapshot-only"])(
    "refuses malformed %s bytes even when decoded text is identical",
    async (mode) => {
      const input = "src/currentness.ts";
      const text = 'export const label = "\uFFFD";\n';
      const own = await currentnessFixture(({ put }) => put(input, text));
      const path = mode === "input" ? input : "packages/alpha/dist/owner.d.ts";
      const absolute = join(own.root, path);
      if (mode === "snapshot-only") writeFileSync(absolute, text);
      expect(own.compiler.read(path)).toBe(text);
      expect(() => own.compiler.assertCurrent()).not.toThrow();
      const raw = Buffer.concat([
        Buffer.from('export const label = "'),
        Buffer.from([0x80]),
        Buffer.from('";\n'),
      ]);
      expect(raw.toString("utf8")).toBe(text);
      expect(raw).not.toEqual(Buffer.from(text));
      writeFileSync(absolute, raw);
      expect(() => own.compiler.assertCurrent()).toThrow("symbol-subject-changed");
    },
  );

  it("preserves digest refusal for malformed admitted text and equivalent decoding", async () => {
    const own = await currentnessFixture();
    const path = "packages/alpha/dist/owner.d.ts";
    const absolute = join(own.root, path);
    writeFileSync(absolute, Buffer.from([0x80]));
    expect(own.compiler.read(path)).toBe("\uFFFD");
    expect(() => own.compiler.assertCurrent()).toThrow("symbol-subject-changed");
    writeFileSync(absolute, Buffer.from([0x81]));
    expect(readFileSync(absolute, "utf8")).toBe("\uFFFD");
    expect(() => own.compiler.assertCurrent()).toThrow("symbol-subject-changed");
  });

  it("bounds multibyte snapshot storage and clears it on close", async () => {
    const own = await currentnessFixture(undefined, { sourceBytes: 6 });
    const path = "packages/alpha/dist/owner.d.ts";
    writeFileSync(join(own.root, path), "é🙂");
    expect(own.compiler.read(path)).toBe("é🙂");
    expect(own.compiler.state.bytes).toBe(6);
    expect(own.compiler.read(path)).toBe("é🙂");
    expect(own.compiler.state.bytes).toBe(6);
    expect(() => own.compiler.read("src/consumer.ts")).toThrow("symbol-source-budget");
    expect(own.compiler.state.snapshots.size).toBe(1);
    own.compiler.close();
    expect(own.compiler.state.snapshots.size).toBe(0);
    expect(() => own.compiler.read(path)).toThrow("symbol-resolver-closed");
    expect(() => own.compiler.assertCurrent()).toThrow("symbol-resolver-closed");
  });
});

// Candidate representation proof, not an original runtime defect: private mutable byte storage
// must not let the exposed metadata rewrite the admitted witness.
describe("compiler private canonical byte witness", () => {
  it("keeps currentness refusal after attempting to rewrite reachable byte storage", async () => {
    const path = "src/currentness.ts";
    const original = 'export const label = "first";\n';
    const changed = Buffer.from(original.replace("first", "other"));
    const own = await currentnessFixture(({ put }) => put(path, original));
    expect(own.compiler.read(path)).toBe(original);
    const previous = own.compiler.state.snapshots.get(join(own.compiler.state.subject.root, path));
    for (const value of Object.values(previous)) {
      if (Buffer.isBuffer(value)) changed.copy(value);
    }
    writeFileSync(join(own.root, path), changed);
    expect(() => own.compiler.assertCurrent()).toThrow("symbol-subject-changed");
  });
});

// Preservation controls for the proposed Linux native path-resolution fastpath.
describe("compiler canonical source path preservation", () => {
  it("repeatedly admits a canonical nested Unicode source path", async () => {
    const path = "src/é🙂/currentness.ts";
    const text = "export const current = 1;\n";
    const own = await currentnessFixture(({ put }) => put(path, text));
    expect(own.compiler.read(path)).toBe(text);
    expect(own.compiler.read(path)).toBe(text);
    expect(() => own.compiler.assertCurrent()).not.toThrow();
  });

  it("refuses a same-byte parent redirect after source admission", async () => {
    const path = "src/currentness.ts";
    const text = "export const current = 1;\n";
    const own = await currentnessFixture(({ put }) => put(path, text));
    expect(own.compiler.read(path)).toBe(text);
    const source = join(own.compiler.state.subject.root, "src");
    const retained = `${source}.retained`;
    renameSync(source, retained);
    symlinkSync(retained, source, "junction");
    expect(readFileSync(join(source, "currentness.ts"), "utf8")).toBe(text);
    expect(() => own.compiler.read(path)).toThrow("unsafe-symbol-source");
  });
});

// Candidate-only fallback branch controls; these do not claim an original runtime defect.
describe.skipIf(process.platform !== "linux")("compiler native path compatibility fallback", () => {
  it.each(["exception", "different-spelling"])(
    "uses ordinary resolution for a healthy source after native %s",
    async (mode) => {
      const path = "src/currentness.ts";
      const text = "export const current = 1;\n";
      const own = await currentnessFixture(({ put }) => put(path, text));
      const native = vi.spyOn(realpathSync, "native").mockImplementation(() => {
        if (mode === "exception") throw new TypeError("fixture-native-unavailable");
        return "fixture-different-spelling";
      });
      try {
        expect(own.compiler.read(path)).toBe(text);
        expect(native).toHaveBeenCalledTimes(1);
      } finally {
        native.mockRestore();
      }
    },
  );

  it.each(["exception", "different-spelling"])(
    "retains ordinary parent-redirect refusal after native %s",
    async (mode) => {
      const path = "src/currentness.ts";
      const text = "export const current = 1;\n";
      const own = await currentnessFixture(({ put }) => put(path, text));
      expect(own.compiler.read(path)).toBe(text);
      const source = join(own.compiler.state.subject.root, "src");
      const retained = `${source}.retained`;
      renameSync(source, retained);
      symlinkSync(retained, source, "junction");
      const native = vi.spyOn(realpathSync, "native").mockImplementation(() => {
        if (mode === "exception") throw new TypeError("fixture-native-unavailable");
        return "fixture-different-spelling";
      });
      try {
        expect(() => own.compiler.read(path)).toThrow("unsafe-symbol-source");
        expect(native).toHaveBeenCalledTimes(1);
      } finally {
        native.mockRestore();
      }
    },
  );

  it("propagates the real ordinary error after native resolution becomes unavailable", async () => {
    const path = "src/currentness.ts";
    const own = await currentnessFixture(({ put }) => put(path, "export const current = 1;\n"));
    const absolute = join(own.compiler.state.subject.root, path);
    const native = vi.spyOn(realpathSync, "native").mockImplementation(() => {
      unlinkSync(absolute);
      throw new TypeError("fixture-native-unavailable");
    });
    try {
      expect(() => own.compiler.read(path)).toThrow(expect.objectContaining({ code: "ENOENT" }));
      expect(native).toHaveBeenCalledTimes(1);
    } finally {
      native.mockRestore();
    }
  });
});

// Work regression control: every observed subprocess still executes the real Git executable.
describe("one-query fresh currentness membership (#3918)", () => {
  it("executes one bounded membership query on each currentness invocation", async () => {
    const own = await currentnessFixture();
    const observations = [];
    for (let invocation = 0; invocation < 2; invocation += 1) {
      vi.mocked(execFileSync).mockClear();
      own.compiler.assertCurrent();
      observations.push(
        vi.mocked(execFileSync).mock.calls.filter(([, args]) => args[0] === "ls-files"),
      );
    }
    expect(observations.map((calls) => calls.length)).toEqual([1, 1]);
    for (const calls of observations) {
      expect(calls[0][1]).toEqual([
        "ls-files",
        "-z",
        "-t",
        "--cached",
        "--others",
        "--exclude-standard",
      ]);
      expect(calls[0][2]).toMatchObject({ timeout: 20_000, maxBuffer: 16 * 1024 * 1024 });
    }
  });
});

async function typedSymbolFixture(variant = "direct", options = {}) {
  const own = createTypedRecheckFixture(variant);
  fixtures.push(own);
  own.subject = await collectPolicySubject(own.root);
  own.resolver = createSymbolResolver(own.subject, options, [
    { owner: "packages/alpha", paths: own.records[0].proofs },
  ]);
  return own;
}

// These controls use native-emitted public declarations, not fabricated checker facts.
describe("typed finite public recheck symbols (#3918)", () => {
  it("admits only each actual guarded argument and immutable full-argument public forwarding", async () => {
    const own = await typedSymbolFixture();
    const source = readFileSync(join(own.root, "packages/alpha/src/owner.ts"), "utf8");
    for (const record of own.records) {
      const identity = own.resolver.resolveProofExport(record.input).identities[0];
      const facts = own.resolver.typedRecheckFacts(identity, record.input.parameterIndex);
      expect(facts.slots).toHaveLength(1);
      const [slot] = facts.slots;
      expect(slot).toMatchObject({
        kind: "argument",
        rule: record.rules[0],
        parameterIndex: record.input.parameterIndex,
      });
      expect(source.slice(slot.start, slot.end)).toBe(
        record.input.exportName === "eligible"
          ? "value"
          : record.input.parameterIndex
            ? "to"
            : "from",
      );
      expect(source.slice(facts.predicate.producer.start, facts.predicate.producer.end)).toContain(
        "function isState",
      );
      expect(own.resolver.typedRecheckBinding(record.consumer, identity)).toMatchObject({
        bound: true,
        status: "ready",
      });
    }
  }, 30_000);

  it.each([
    "removed",
    "inert",
    "alias",
    "written",
    "deferred",
    "duplicate",
    "forwarding",
    "captured-tail",
    "asserted-tail",
    "mutated-tail",
    "asserted",
    "rebound",
    "generic",
    "foreign",
    "foreign-domain",
    "wrong-index",
    "overloaded",
  ])(
    "refuses the actual %s selected-argument guard",
    async (variant) => {
      const own = await typedSymbolFixture(variant);
      const identity = own.resolver.resolveProofExport(own.records[0].input).identities[0];
      expect(() => own.resolver.typedRecheckFacts(identity, 0)).toThrow(/typed-recheck/);
    },
    30_000,
  );

  it.each([
    "proof-swapped",
    "proof-constant",
    "proof-result",
    "proof-wide-result",
    "proof-alias",
    "proof-wide",
    "proof-counterfeit",
  ])(
    "refuses %s public forwarding without granting a typed slot",
    async (variant) => {
      const own = await typedSymbolFixture(variant);
      const record = own.records[0];
      const identity = own.resolver.resolveProofExport(record.input).identities[0];
      expect(own.resolver.typedRecheckBinding(record.consumer, identity)).toEqual({
        bound: false,
        status: "incomplete",
      });
    },
    30_000,
  );

  it("does not certify predicate truth and still revalidates source on every public operation", async () => {
    const own = await typedSymbolFixture("lying");
    const identity = own.resolver.resolveProofExport(own.records[0].input).identities[0];
    expect(own.resolver.typedRecheckFacts(identity, 0).slots).toHaveLength(1);
    own.put(
      "packages/alpha/src/owner.ts",
      readFileSync(join(own.root, "packages/alpha/src/owner.ts"), "utf8") + "\n",
    );
    expect(() => own.resolver.typedRecheckFacts(identity, 0)).toThrow("symbol-subject-changed");
    expect(() => own.resolver.typedRecheckBinding(own.records[0].consumer, identity)).toThrow(
      "symbol-subject-changed",
    );
  }, 30_000);
});

describe("typed recheck shared resolver refusal bounds (#3918)", () => {
  it.each([{ sourceBytes: 1 }, { nodes: 1 }, { emitBytes: 1 }, { aliases: 1 }])(
    "retains the existing shared bound %j",
    async (limits) => {
      const own = await typedSymbolFixture("direct", limits);
      if (limits.aliases) {
        own.resolver.close();
        own.put(
          "src/namespace-alias.ts",
          'import * as ns from "alpha/runtime"; const first = ns.transition; const second = first; export const result = second("ready", "done");\n',
        );
        own.subject = await collectPolicySubject(own.root);
        own.resolver = createSymbolResolver(own.subject, limits);
        const identity = own.resolver.resolveExport({
          ...own.records[0].input,
          consumerPath: "src/namespace-alias.ts",
        }).identities[0];
        expect(() => own.resolver.incomingUses(identity)).toThrow("symbol-alias-budget");
        own.resolver.close();
        own.resolver = createSymbolResolver(own.subject);
        expect(
          own.resolver
            .incomingUses(identity)
            .uses.filter((use) => use.path === "src/namespace-alias.ts" && use.kind === "call"),
        ).toHaveLength(1);
        return;
      }
      expect(() => own.resolver.resolveProofExport(own.records[0].input)).toThrow();
    },
    30_000,
  );

  it("refuses a producer identity rebound to a different owner", async () => {
    const own = await typedSymbolFixture();
    const identity = own.resolver.resolveProofExport(own.records[0].input).identities[0];
    expect(() => own.resolver.typedRecheckFacts({ ...identity, owner: "foreign" }, 0)).toThrow(
      "mismatched-responsibility-producer",
    );
  }, 30_000);
});

describe("selected typed parameter guard identity (#3918)", () => {
  it("withholds a missing second guard even when includes still refuses malformed values", async () => {
    const own = await typedSymbolFixture("removed-to");
    const identity = own.resolver.resolveProofExport(own.records[1].input).identities[0];
    expect(() => own.resolver.typedRecheckFacts(identity, 1)).toThrow(
      "ambiguous-typed-recheck-guard",
    );
    expect(own.resolver.typedRecheckFacts(identity, 0).slots).toHaveLength(1);
  }, 30_000);
});

describe("canonical typed list forwarding result (#3918)", () => {
  it("refuses a type-correct cloned list rather than certifying unchanged result identity", async () => {
    const own = await typedSymbolFixture("proof-clone");
    const record = own.records[2];
    const identity = own.resolver.resolveProofExport(record.input).identities[0];
    expect(own.resolver.typedRecheckBinding(record.consumer, identity)).toEqual({
      bound: false,
      status: "incomplete",
    });
  }, 30_000);
});

async function canonicalDecoderSymbolFixture(variant = "direct", options = {}) {
  const own = createCanonicalDecoderFixture(variant);
  fixtures.push(own);
  if (["public-any", "public-concrete"].includes(variant)) {
    const path = "packages/alpha/dist/owner.d.ts";
    const text = readFileSync(join(own.root, path), "utf8");
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    const declaration = source.statements.find(
      (node) => ts.isFunctionDeclaration(node) && node.name?.text === "parseCanonicalSupportJson",
    );
    const replacement = variant === "public-any" ? "any" : "string";
    own.put(
      path,
      text.slice(0, declaration.type.getStart(source)) +
        replacement +
        text.slice(declaration.type.end),
    );
  }
  own.subject = await collectPolicySubject(own.root);
  own.resolver = createSymbolResolver(own.subject, options, [
    { owner: "packages/alpha", paths: own.records[0].proofs },
  ]);
  const record = own.records[0];
  own.decoder = own.resolver.resolveProofExport(record.input).identities[0];
  own.canonicalizer = own.resolver.resolveProofExport(record.output).identities[0];
  return own;
}

describe("raw canonical JSON decoder symbols (#3918)", () => {
  it("binds the actual ordered preflight raw identity and exact unknown return", async () => {
    const own = await canonicalDecoderSymbolFixture();
    const facts = own.resolver.canonicalDecoderFacts(own.decoder, own.canonicalizer);
    const source = readFileSync(join(own.root, facts.slot.path), "utf8");
    expect(source.slice(facts.slot.start, facts.slot.end)).toBe("unknown");
    expect(facts.slot).toMatchObject({ kind: "return", rule: "anti-slop/no-unknown-returns" });
    expect(facts.preflight).toEqual([
      "text-length",
      "utf8-bytes",
      "json-shape",
      "builtin-json-parse",
      "canonical-comparison",
    ]);
    expect(
      own.resolver.canonicalDecoderBinding(own.records[0].consumer, own.decoder, own.canonicalizer),
    ).toMatchObject({ bound: true, status: "ready" });
  }, 30_000);

  it.each([
    "budget-helper-throws",
    "budget-helper-wrong-reason",
    "budget-helper-extra-statement",
    "budget-outer-return",
    "removed-preflight",
    "reordered-preflight",
    "removed-byte-budget",
    "bypassed-canonicality",
    "cloned-return",
    "lying-decoder",
    "decoder-generic",
    "decoder-default",
    "canonicalizer-generic",
    "coerced-parse",
    "captured-return",
    "shadowed-json",
    "shadowed-encoder",
  ])(
    "refuses %s rather than granting a return-shaped waiver",
    async (variant) => {
      const own = await canonicalDecoderSymbolFixture(variant);
      expect(() => own.resolver.canonicalDecoderFacts(own.decoder, own.canonicalizer)).toThrow(
        "unsupported-raw-canonical-json-decoder",
      );
    },
    30_000,
  );

  it.each(["wrong-argument", "raw-alias", "wrong-result", "mutable-raw"])(
    "refuses the actual %s public witness",
    async (variant) => {
      const own = await canonicalDecoderSymbolFixture(variant);
      expect(
        own.resolver.canonicalDecoderBinding(
          own.records[0].consumer,
          own.decoder,
          own.canonicalizer,
        ),
      ).toEqual({ bound: false, status: "incomplete" });
    },
    30_000,
  );

  it("refuses a canonicalizer rebound to the decoder or a foreign owner", async () => {
    const own = await canonicalDecoderSymbolFixture();
    expect(() => own.resolver.canonicalDecoderFacts(own.decoder, own.decoder)).toThrow(
      "unsupported-raw-canonical-json-decoder",
    );
    expect(() =>
      own.resolver.canonicalDecoderFacts(own.decoder, { ...own.canonicalizer, owner: "foreign" }),
    ).toThrow();
    expect(
      own.resolver.canonicalDecoderBinding(own.records[0].consumer, own.decoder, own.decoder),
    ).toEqual({ bound: false, status: "incomplete" });
  }, 30_000);

  it.each(["public-any", "public-concrete"])(
    "refuses stale %s public declarations before witness admission",
    async (variant) => {
      await expect(canonicalDecoderSymbolFixture(variant)).rejects.toThrow(
        "stale-declaration-provenance",
      );
    },
    30_000,
  );

  it.each(["source", "public", "proof"])(
    "rechecks %s currentness on both public operations",
    async (changed) => {
      const own = await canonicalDecoderSymbolFixture();
      own.resolver.canonicalDecoderFacts(own.decoder, own.canonicalizer);
      const path =
        changed === "source"
          ? "packages/alpha/src/owner.ts"
          : changed === "public"
            ? "packages/alpha/dist/owner.d.ts"
            : own.records[0].proofs[0];
      own.put(path, readFileSync(join(own.root, path), "utf8") + "\n");
      expect(() => own.resolver.canonicalDecoderFacts(own.decoder, own.canonicalizer)).toThrow(
        "symbol-subject-changed",
      );
      expect(() =>
        own.resolver.canonicalDecoderBinding(
          own.records[0].consumer,
          own.decoder,
          own.canonicalizer,
        ),
      ).toThrow("symbol-subject-changed");
    },
    30_000,
  );
});

describe("raw canonical JSON decoder shared qualification bounds (#3918)", () => {
  it.each([{ sourceBytes: 1 }, { nodes: 1 }, { emitBytes: 1 }])(
    "refuses partial public qualification under the existing bound %j",
    async (options) => {
      const own = createCanonicalDecoderFixture();
      fixtures.push(own);
      own.subject = await collectPolicySubject(own.root);
      own.resolver = createSymbolResolver(own.subject, options, [
        { owner: "packages/alpha", paths: own.records[0].proofs },
      ]);
      expect(() => own.resolver.resolveProofExport(own.records[0].input)).toThrow();
    },
    30_000,
  );
});

function publicStarFixture(mode = "single") {
  const own = createSymbolFixture(false, (fixture) => {
    fixture.put(
      "src/consumer.ts",
      'import { parse } from "alpha"; export const result = parse(1);',
    );
    fixture.put(
      "packages/alpha/src/proof.test.ts",
      'import { parse } from "alpha"; export const result = parse(1);',
    );
    const config = JSON.parse(readFileSync(join(fixture.root, "packages/alpha/tsconfig.json")));
    config.exclude = ["**/*.test.ts"];
    fixture.put("packages/alpha/tsconfig.json", config);
    fixture.put(
      "packages/alpha/src/owner.ts",
      "export function parse(input: unknown): boolean { return input === 1; }",
    );
    fixture.put("packages/alpha/src/bridge.ts", 'export { parse } from "./owner.js";');
    fixture.put("packages/alpha/src/alternate.ts", 'export { parse } from "./owner.js";');
    fixture.put("packages/alpha/src/side.ts", "export const unrelated = true;");
    fixture.put("packages/alpha/src/nested.ts", 'export * from "./side.js";');
    fixture.put("packages/alpha/src/other.ts", "export const other = true;");
    fixture.put("packages/alpha/src/last.ts", "export const last = true;");
    const entries = {
      single: 'export * from "./bridge.js";',
      nested:
        'export * from "./bridge.js"; export * from "./nested.js"; export * from "./other.js"; export * from "./last.js";',
      explicit: 'export { parse } from "./owner.js"; export * from "./nested.js";',
      direct:
        'export function parse(input: unknown): boolean { return input === 1; } export * from "./nested.js";',
      zero: 'export * from "./side.js";',
      duplicate: 'export * from "./bridge.js"; export * from "./alternate.js";',
      typeonly: 'export type { parse } from "./owner.js"; export * from "./bridge.js";',
      typestar: 'export type * from "./owner.js";',
      namespace: 'export * as parse from "./owner.js"; export * from "./bridge.js";',
      variable:
        'export const parse = (input: unknown): boolean => input === 1; export * from "./bridge.js";',
      cycle: 'export * from "./cycle.js";',
    };
    fixture.put("packages/alpha/src/cycle.ts", 'export * from "./index.js";');
    fixture.put("packages/alpha/src/index.ts", entries[mode] ?? entries.nested);
  });
  fixtures.push(own);
  return own;
}

async function publicStarResolver(own, options = {}) {
  own.subject = await collectPolicySubject(own.root);
  own.resolver = createSymbolResolver(own.subject, options, [
    { owner: "packages/alpha", paths: ["packages/alpha/src/proof.test.ts"] },
  ]);
  return own.resolver;
}

const starRequest = {
  consumerPath: "packages/alpha/src/proof.test.ts",
  specifier: "alpha",
  exportName: "parse",
};

describe("qualified value-star public declaration entries (#3918)", () => {
  it.each(["single", "nested", "explicit", "direct"])(
    "resolves actual native %s entries with exact explicit precedence",
    async (mode) => {
      const own = publicStarFixture(mode);
      const resolver = await publicStarResolver(own);
      expect(resolver.resolveProofExport(starRequest).identities[0].producer.path).toBe(
        mode === "direct" ? "packages/alpha/src/index.ts" : "packages/alpha/src/owner.ts",
      );
    },
    30_000,
  );

  it.each(["zero", "duplicate", "typeonly", "typestar", "namespace", "variable", "cycle"])(
    "refuses actual native %s entries rather than guessing a value route",
    async (mode) => {
      const own = publicStarFixture(mode);
      const resolver = await publicStarResolver(own);
      expect(() => resolver.resolveProofExport(starRequest)).toThrow();
    },
    30_000,
  );

  it("shares the existing alias budget across all branches", async () => {
    const own = publicStarFixture("nested");
    const resolver = await publicStarResolver(own, { aliases: 3 });
    expect(() => resolver.resolveProofExport(starRequest)).toThrow("symbol-alias-budget");
  }, 30_000);

  it.each(["runtime", "declaration", "map", "forged-map", "stale-source", "source-override"])(
    "refuses %s on a traversed intermediate branch with a fresh ultimate producer",
    async (mode) => {
      const own = publicStarFixture("nested");
      const base = "packages/alpha/dist/nested";
      if (mode === "runtime") unlinkSync(join(own.root, `${base}.js`));
      if (mode === "declaration") unlinkSync(join(own.root, `${base}.d.ts`));
      if (mode === "map") unlinkSync(join(own.root, `${base}.d.ts.map`));
      if (mode === "forged-map") {
        const payload = JSON.parse(readFileSync(join(own.root, `${base}.d.ts.map`)));
        payload.mappings += ";AAAA";
        own.put(`${base}.d.ts.map`, payload);
      }
      if (mode === "stale-source")
        own.put("packages/alpha/src/nested.ts", "export const replaced = true;");
      if (mode === "source-override") {
        const path = "packages/alpha/tsconfig.json";
        const config = JSON.parse(readFileSync(join(own.root, path)));
        config.compilerOptions.paths = { "./nested.js": ["packages/alpha/src/nested.ts"] };
        own.put(path, config);
      }
      const resolver = await publicStarResolver(own);
      expect(() => resolver.resolveProofExport(starRequest)).toThrow();
    },
    30_000,
  );

  it("rejects an observed intermediate change before returning a cached public entry", async () => {
    const own = publicStarFixture("nested");
    const resolver = await publicStarResolver(own);
    expect(resolver.resolveProofExport(starRequest).identities).toHaveLength(1);
    own.put("packages/alpha/src/nested.ts", "export const replaced = true;");
    expect(() => resolver.resolveProofExport(starRequest)).toThrow("symbol-subject-changed");
  }, 30_000);
});

describe("owner-tagged collective cardinality errors (#3918)", () => {
  it("preserves low-level TypeError refusal and exposes only copied factory-owned counts", async () => {
    const own = await collectiveSymbolFixture("cardinality");
    const { collectiveHelperBudgetDetails } = await import("../lib/code-quality-symbols.mjs");
    let refusal;
    try {
      own.resolver.collectiveRawCheckingSlots(own.rawRoots, "anti-slop/no-unknown-parameters");
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(TypeError);
    expect(refusal.message).toBe("symbol-alias-budget");
    expect(collectiveHelperBudgetDetails(refusal)).toEqual({ limit: 64, observedCount: 65 });
    const copy = collectiveHelperBudgetDetails(refusal);
    copy.limit = 999;
    expect(collectiveHelperBudgetDetails(refusal)).toEqual({ limit: 64, observedCount: 65 });
    expect(() =>
      own.resolver.collectiveRawCheckingSlots(
        Array(65).fill(own.rawRoots[0]),
        "anti-slop/no-unknown-parameters",
      ),
    ).toThrow("symbol-alias-budget");
  }, 30_000);

  it("does not inspect counterfeit exception properties or confuse source and cycle errors", async () => {
    const { collectiveHelperBudgetDetails } = await import("../lib/code-quality-symbols.mjs");
    const counterfeit = new Proxy(new TypeError("symbol-alias-budget"), {
      get: () => {
        throw new Error("exception property inspected");
      },
      getPrototypeOf: () => {
        throw new Error("exception prototype inspected");
      },
    });
    for (const error of [
      counterfeit,
      new TypeError("symbol-alias-budget"),
      null,
      "symbol-alias-budget",
    ])
      expect(collectiveHelperBudgetDetails(error)).toBeNull();
    const cycle = await collectiveSymbolFixture("cycle");
    try {
      cycle.resolver.collectiveRawCheckingSlots(cycle.rawRoots, "anti-slop/no-unknown-parameters");
      throw new Error("cycle unexpectedly accepted");
    } catch (error) {
      expect(error.message).toBe("unsupported-raw-helper-cycle");
      expect(collectiveHelperBudgetDetails(error)).toBeNull();
    }
  }, 30_000);
});

async function contextEnvelopeSymbolFixture(variant = "direct") {
  const own = createContextDiagnosticFixture(variant);
  fixtures.push(own);
  own.resolver = createSymbolResolver(await collectPolicySubject(own.root), {}, [
    { owner: "packages/alpha", paths: own.record.proofs },
  ]);
  own.producer = own.resolver.resolveProofExport(own.record.input).identities[0];
  return own;
}

describe("closed context diagnostic envelope binding (#3918)", () => {
  it("binds the exact owned closed diagnostic envelope without inventing a value", async () => {
    const own = await contextEnvelopeSymbolFixture();
    const binding = own.resolver.diagnosticBinding(own.record.consumer, own.producer);
    expect(binding.bound).toBe(true);
    expect(binding.calls).toHaveLength(1);
    expect(binding.implementation.owner).toBe("alpha");
    const legacy = createDiagnosticFixture();
    fixtures.push(legacy);
    legacy.resolver = createSymbolResolver(await collectPolicySubject(legacy.root), {}, [
      { owner: "packages/alpha", paths: legacy.record.proofs },
    ]);
    const producer = legacy.resolver.resolveProofExport(legacy.record.input).identities[0];
    expect(legacy.resolver.diagnosticBinding(legacy.record.consumer, producer).bound).toBe(true);
  }, 30_000);

  it.each([
    "erased",
    "unknown-reasons",
    "mutable-array",
    "mutable-property",
    "mutable-ok",
    "nonstring-reasons",
    "optional-reasons",
    "optional-ok",
    "index",
    "success-value",
    "unrelated",
    "unaliased",
    "foreign-alias",
    "constant",
    "polarity",
    "fabricated",
    "negated",
    "input",
    "local",
    "wrong-producer",
    "annotated",
    "numeric-erasure",
  ])(
    "rejects the noncanonical diagnostic envelope or flow: %s",
    async (variant) => {
      const own = await contextEnvelopeSymbolFixture(variant);
      expect(own.resolver.diagnosticBinding(own.record.consumer, own.producer).bound).toBe(false);
    },
    30_000,
  );

  it("refuses source drift before reusing a closed envelope proof binding", async () => {
    const own = await contextEnvelopeSymbolFixture();
    expect(own.resolver.diagnosticBinding(own.record.consumer, own.producer).bound).toBe(true);
    const path = join(own.root, own.record.consumer.consumerPath);
    writeFileSync(path, readFileSync(path, "utf8") + "\n");
    expect(() => own.resolver.diagnosticBinding(own.record.consumer, own.producer)).toThrow(
      "symbol-subject-changed",
    );
  }, 30_000);
});

const JSON_BYTE_MEASUREMENT_OWNER =
  'type CodingWorkbenchRuntimeQuestionRequest = { readonly id: string; readonly questions: readonly unknown[] };\nexport const CODING_WORKBENCH_RUNTIME_QUESTIONS_MAX_UTF8_BYTES = 64 * 1_024;\nconst CODING_WORKBENCH_RUNTIME_QUESTION_REQUEST_MAX_COUNT = 256;\nconst CODING_WORKBENCH_RUNTIME_QUESTION_ANSWERS_MAX_COUNT = 32;\nconst CODING_WORKBENCH_RUNTIME_QUESTION_SELECTIONS_MAX_COUNT = 32;\nconst CODING_WORKBENCH_RUNTIME_QUESTION_TEXT_MAX_CHARS = 4_096;\nfunction isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }\nexport function first(value: unknown): boolean { if (!isRecord(value)) return false; const errors: string[] = []; return checkQuestionsResponse(value, errors) && errors.length === 0; }\nexport function second(value: unknown): boolean { if (!isRecord(value)) return false; const errors: string[] = []; return checkQuestionsChannel(value, errors) && errors.length === 0; }\nexport function third(value: unknown): boolean { if (!isRecord(value)) return false; const errors: string[] = []; return validateAnswers(value.answers, errors) && errors.length === 0; }\nfunction checkQuestionsResponse(value: Record<string, unknown>, errors: string[]): boolean { return checkBoundedQuestionRequests(value.questions, value, errors); }\nfunction checkQuestionsChannel(value: Record<string, unknown>, errors: string[]): boolean { const session = value.session === "active"; const admitted = checkBoundedQuestionRequests(value.questions, value, errors); return session && admitted; }\nfunction validateQuestionRequests(value: readonly unknown[], _errors: string[]): value is readonly CodingWorkbenchRuntimeQuestionRequest[] { return value.every(item => typeof item === "object" && item !== null); }\nfunction validText(value: unknown, max: number): value is string { return typeof value === "string" && value.length > 0 && value.length <= max; }\nfunction checkBoundedQuestionRequests(\n  questions: unknown,\n  container: object,\n  errors: string[],\n): questions is readonly CodingWorkbenchRuntimeQuestionRequest[] {\n  if (\n    !Array.isArray(questions) ||\n    questions.length > CODING_WORKBENCH_RUNTIME_QUESTION_REQUEST_MAX_COUNT\n  ) {\n    errors.push("questions must be a bounded array");\n    return false;\n  }\n  const admitted = validateQuestionRequests(questions, errors);\n  if (\n    errors.length === 0 &&\n    serializedBytes(container) > CODING_WORKBENCH_RUNTIME_QUESTIONS_MAX_UTF8_BYTES\n  )\n    errors.push("questions response exceeds the aggregate UTF-8 byte budget");\n  return admitted;\n}\nfunction validateAnswers(\n  value: unknown,\n  errors: string[],\n): value is readonly (readonly string[])[] {\n  if (\n    !Array.isArray(value) ||\n    value.length < 1 ||\n    value.length > CODING_WORKBENCH_RUNTIME_QUESTION_ANSWERS_MAX_COUNT\n  ) {\n    errors.push("answers must be a bounded non-empty array");\n    return false;\n  }\n  const count = value.length;\n  let admitted = true;\n  for (let index = 0; index < count; index += 1) {\n    const answer: unknown = value[index];\n    if (!validAnswerMembers(answer)) {\n      errors.push(`answers[${String(index)}] must contain bounded strings`);\n      admitted = false;\n      if (!(index in value)) return false;\n    } else if (new Set(answer).size !== answer.length) {\n      errors.push(`answers[${String(index)}] must not contain duplicate selections`);\n    }\n  }\n  // Per-array caps above bound each answer individually (32 arrays x 32 selections x 4096 chars),\n  // but not their sum: matches the aggregate budget checkBoundedQuestionRequests already enforces\n  // on the outbound side, gated on no per-item error the same way that function gates its own check.\n  if (\n    errors.length === 0 &&\n    serializedBytes({ answers: value }) > CODING_WORKBENCH_RUNTIME_QUESTIONS_MAX_UTF8_BYTES\n  )\n    errors.push("answers exceed the aggregate UTF-8 byte budget");\n  return admitted;\n}\nfunction validAnswerMembers(value: unknown): value is readonly string[] {\n  if (\n    !Array.isArray(value) ||\n    value.length > CODING_WORKBENCH_RUNTIME_QUESTION_SELECTIONS_MAX_COUNT\n  )\n    return false;\n  const count = value.length;\n  for (let index = 0; index < count; index += 1) {\n    const selection: unknown = value[index];\n    if (!validText(selection, CODING_WORKBENCH_RUNTIME_QUESTION_TEXT_MAX_CHARS)) return false;\n  }\n  return true;\n}\nfunction serializedBytes(value: object): number {\n  try {\n    return new TextEncoder().encode(JSON.stringify(value)).length;\n  } catch {\n    return Number.POSITIVE_INFINITY;\n  }\n}';

async function jsonByteMeasurementFixture(variant = "direct") {
  const own = createSymbolFixture(false, (fixture) => {
    const config = JSON.parse(readFileSync(join(fixture.root, "packages/alpha/tsconfig.json")));
    config.compilerOptions.lib = ["ES2022", "DOM"];
    fixture.put("packages/alpha/tsconfig.json", config);
    fixture.put("packages/alpha/src/owner.ts", numericOwnerVariant(variant));
    fixture.put("packages/alpha/src/index.ts", 'export { first as parse } from "./owner.js";\n');
    fixture.put(
      "src/consumer.ts",
      'import { first, second, third } from "alpha/runtime"; export const value = [first(1), second(1), third(1)];\n',
    );
  });
  fixtures.push(own);
  own.resolver = createSymbolResolver(await collectPolicySubject(own.root));
  own.rawRoots = ["first", "second", "third"]
    .filter((name) => variant !== "missing-answer" || name !== "third")
    .filter((name) => variant !== "missing-channel" || name !== "second")
    .map((exportName) => ({
      identity: own.resolver.resolveExport({
        consumerPath: "src/consumer.ts",
        specifier: "alpha/runtime",
        exportName,
      }).identities[0],
      index: 0,
      recordId: "fixture-" + exportName,
    }));
  return own;
}

describe("exact numeric JSON byte object form (#3918)", () => {
  it("recognizes only the two closed measurement annotations across all three real incoming roots", async () => {
    const own = await jsonByteMeasurementFixture();
    const result = own.resolver.collectiveJsonByteMeasurement(own.rawRoots);
    expect(result.status).toBe("recognized");
    expect(result.form).toBe("json-utf8-byte-measurement");
    expect(result.slots).toHaveLength(2);
    expect(
      result.slots
        .map((slot) => ({ index: slot.index, contributors: slot.contributingResponsibilityIds }))
        .sort((a, b) => a.index - b.index),
    ).toEqual([
      { index: 0, contributors: ["fixture-first", "fixture-second", "fixture-third"] },
      { index: 1, contributors: ["fixture-first", "fixture-second"] },
    ]);
  });
});

function numericOwnerVariant(variant) {
  const source = JSON_BYTE_MEASUREMENT_OWNER;
  if (variant === "one-parameter-caller")
    return source
      .replace("checkQuestionsResponse(value, errors)", "checkQuestionsResponse(value)")
      .replace(
        "function checkQuestionsResponse(value: Record<string, unknown>, errors: string[]): boolean { return checkBoundedQuestionRequests(value.questions, value, errors); }",
        "function checkQuestionsResponse(value: Record<string, unknown>): boolean { const errors: string[] = []; return checkBoundedQuestionRequests(value.questions, value, errors); }",
      );
  const replacements = {
    "byte-length": [
      ".encode(JSON.stringify(value)).length",
      ".encode(JSON.stringify(value)).byteLength",
    ],
    "stringify-args": ["JSON.stringify(value)", "JSON.stringify(value, null)"],
    fallback: ["return Number.POSITIVE_INFINITY;", "return 0;"],
    "catch-binding": ["} catch {", "} catch (_error) {"],
    finally: [
      "return Number.POSITIVE_INFINITY;\n  }",
      "return Number.POSITIVE_INFINITY;\n  } finally { void 0; }",
    ],
    "projected-container": [
      "serializedBytes(container)",
      "serializedBytes({ questions: container })",
    ],
    "answers-key": ["serializedBytes({ answers: value })", "serializedBytes({ other: value })"],
    "answers-origin": [
      "validateAnswers(value.answers, errors)",
      "validateAnswers(value.other, errors)",
    ],
    "parameter-mutation": [
      "const admitted = validateQuestionRequests(questions, errors);",
      "container = {}; const admitted = validateQuestionRequests(questions, errors);",
    ],
    "zero-gate": [
      "errors.length === 0 &&\n    serializedBytes(container)",
      "serializedBytes(container)",
    ],
    comparison: ["serializedBytes(container) >", "serializedBytes(container) >="],
    cap: ["MAX_UTF8_BYTES = 64 * 1_024", "MAX_UTF8_BYTES = 32 * 1_024"],
    early: [
      "const admitted = validateQuestionRequests(questions, errors);",
      "const measured = serializedBytes(container); const admitted = validateQuestionRequests(questions, errors);",
    ],
    duplicate: ["new Set(answer).size !== answer.length", "false"],
  };
  if (replacements[variant]) {
    const [before, after] = replacements[variant];
    if (!source.includes(before)) throw new TypeError("numeric-fixture-mutation-missing");
    return source.replace(before, after);
  }
  const additions = {
    "JSON-shadow": "const JSON = globalThis.JSON;\n",
    "encoder-shadow": "const TextEncoder = globalThis.TextEncoder;\n",
    "encoder-foreign": "declare global { interface TextEncoder { foreignMarker(): void; } }\n",
    "Number-shadow": "const Number = globalThis.Number;\n",
    "leaf-export": "export { serializedBytes };\n",
    "leaf-escape": "const escape = { serializedBytes };\n",
    "extra-incoming":
      "function outside(value: object): number { return serializedBytes(value); }\n",
    "forwarder-export": "export { checkBoundedQuestionRequests };\n",
    "unrelated-object": "function unrelated(value: object): object { return value; }\n",
  };
  return additions[variant] ? source + additions[variant] : source;
}

describe("numeric object closed-form refusals (#3918)", () => {
  it.each([
    "JSON-shadow",
    "encoder-shadow",
    "encoder-foreign",
    "Number-shadow",
    "byte-length",
    "stringify-args",
    "fallback",
    "catch-binding",
    "finally",
    "leaf-export",
    "leaf-escape",
    "extra-incoming",
    "one-parameter-caller",
    "missing-answer",
    "missing-channel",
    "projected-container",
    "answers-key",
    "answers-origin",
    "forwarder-export",
    "parameter-mutation",
    "zero-gate",
    "comparison",
    "cap",
    "early",
    "duplicate",
  ])("refuses unsupported numeric form: %s", async (variant) => {
    const own = await jsonByteMeasurementFixture(variant);
    const result = own.resolver.collectiveJsonByteMeasurement(own.rawRoots);
    expect(result).toEqual({
      form: "json-utf8-byte-measurement",
      status: "withheld",
      reason: "unsupported-json-byte-form",
      slots: [],
    });
  });
  it("does not grant an unrelated object annotation beside the closed two-slot form", async () => {
    const own = await jsonByteMeasurementFixture("unrelated-object");
    const result = own.resolver.collectiveJsonByteMeasurement(own.rawRoots);
    expect(result.status).toBe("recognized");
    expect(result.slots).toHaveLength(2);
    expect(
      result.slots.every((slot) =>
        JSON_BYTE_MEASUREMENT_OWNER.slice(
          slot.producerIdentity.producer.start,
          slot.producerIdentity.producer.end,
        ).includes("serializedBytes"),
      ),
    ).toBe(true);
  });
});

describe("separate collective slot result contracts (#3918)", () => {
  it("returns closed withheld numeric descriptors for empty and nonraw roots", async () => {
    const own = await collectiveSymbolFixture("domain");
    const domain = own.resolver.resolveProofExport({
      ...own.records[0].input,
      exportName: "domain",
    }).identities[0];
    const withheld = {
      form: "json-utf8-byte-measurement",
      status: "withheld",
      reason: "unsupported-json-byte-form",
      slots: [],
    };
    expect(own.resolver.collectiveJsonByteMeasurement([])).toEqual(withheld);
    expect(
      own.resolver.collectiveJsonByteMeasurement([
        { identity: domain, index: 0, recordId: "domain" },
      ]),
    ).toEqual(withheld);
  });

  it("propagates actual numeric collective capacity errors", async () => {
    const own = await collectiveSymbolFixture();
    expect(() =>
      own.resolver.collectiveJsonByteMeasurement(Array(65).fill(own.rawRoots[0])),
    ).toThrow("symbol-alias-budget");
  });

  it("propagates actual numeric collective cycles", async () => {
    const cycle = await collectiveSymbolFixture("cycle");
    expect(() => cycle.resolver.collectiveJsonByteMeasurement(cycle.rawRoots)).toThrow(
      "unsupported-raw-helper-cycle",
    );
  });

  it("propagates actual numeric source currentness errors", async () => {
    const changed = await collectiveSymbolFixture();
    const path = join(changed.root, "packages/alpha/src/owner.ts");
    writeFileSync(path, readFileSync(path, "utf8") + "\n");
    expect(() => changed.resolver.collectiveJsonByteMeasurement(changed.rawRoots)).toThrow(
      "symbol-subject-changed",
    );
  });

  it("keeps the legacy object-rule operation array-valued for empty and supported roots", async () => {
    const own = await jsonByteMeasurementFixture();
    expect(own.resolver.collectiveRawCheckingSlots([], "anti-slop/no-object-parameters")).toEqual(
      [],
    );
    expect(
      own.resolver.collectiveRawCheckingSlots(own.rawRoots, "anti-slop/no-object-parameters"),
    ).toEqual([]);
  });
});

describe("closed optional observation compiler facts", () => {
  it("adds exactly the two own-key and one owning-input coordinates to legacy facts", async () => {
    const own = createObservationOptionsFixture();
    fixtures.push(own);
    own.subject = await collectPolicySubject(own.root);
    own.resolver = createSymbolResolver(own.subject, {}, [
      { owner: "packages/alpha", paths: own.record.proofs },
    ]);
    const roles = own.resolver.resolveProofExport(own.record.input);
    const identity = roles.identities[0];
    const before = own.resolver.propertyObservationFacts(identity);
    const after = own.resolver.propertyObservationFacts(identity, {
      rawObjectInput: true,
      additionalObservationForms: ["own-key-identity"],
    });
    expect(before.slots).toHaveLength(3);
    expect(after.slots.slice(0, 3)).toStrictEqual(before.slots);
    expect(after.slots).toHaveLength(6);
    expect(after.identity).toStrictEqual(before.identity);
    expect(after.root).toStrictEqual(before.root);
    expect(
      after.slots.slice(3).every((slot) => slot.rule === "anti-slop/no-object-parameters"),
    ).toBe(true);
    expect(after.additionalObservations.map(({ form }) => form)).toEqual([
      "raw-object-input",
      "own-key-identity",
    ]);
    const path = "packages/alpha/src/owner.ts";
    own.put(path, readFileSync(join(own.root, path), "utf8") + "\n// source changed\n");
    expect(() =>
      own.resolver.propertyObservationFacts(identity, { rawObjectInput: true }),
    ).toThrow();
  });
});

describe("direct whole-receiver observation checker facts", () => {
  it("adds four direct checker inputs without granting shared carriers or other parameters", async () => {
    const own = createDirectObservationCheckerFixture();
    fixtures.push(own);
    const subject = await collectPolicySubject(own.root);
    own.resolver = createSymbolResolver(subject, {}, [
      { owner: "packages/alpha", paths: own.record.proofs },
    ]);
    const identity = own.resolver.resolveProofExport(own.record.input).identities[0];
    const legacy = { rawObjectInput: true, additionalObservationForms: ["own-key-identity"] };
    const before = own.resolver.propertyObservationFacts(identity, legacy);
    expect(before.slots).toHaveLength(6);
    const after = own.resolver.propertyObservationFacts(identity, {
      ...legacy,
      directRawCheckerInputs: true,
    });
    expect(after.slots.slice(0, 6)).toStrictEqual(before.slots);
    expect(after.slots).toHaveLength(10);
    expect(
      after.slots
        .slice(6)
        .every((slot) => slot.index === 0 && slot.rule === "anti-slop/no-object-parameters"),
    ).toBe(true);
    expect(
      after.slots
        .slice(6)
        .every(
          (slot) =>
            slot.observationRoots.length === 1 &&
            slot.observationRoots[0].identity.producer.start === identity.producer.start,
        ),
    ).toBe(true);
  });
});

describe("owned optional object validator facts (#3918)", () => {
  it("binds only the exact public input without granting private raw call-result helpers", async () => {
    const own = createObjectValidatorFixture();
    fixtures.push(own);
    own.resolver = createSymbolResolver(await collectPolicySubject(own.root));
    const identity = own.resolver.resolveExport(own.record.input).identities[0];
    const source = readFileSync(join(own.root, identity.producer.path), "utf8");
    const facts = own.resolver.objectValidatorFacts(identity);
    expect(facts.slots).toHaveLength(1);
    expect(facts.slots[0]).toMatchObject({ index: 0, rawObjectValidatorInput: true });
    const slot = facts.slots[0];
    expect(source.slice(slot.start, slot.end)).toBe("object");
    expect(slot.start).toBeGreaterThan(source.indexOf("export function validate"));
    expect(facts.identity).toEqual(identity);
  });

  it.each([
    "wrong-input",
    "aliased-input",
    "optional-input",
    "unknown-result",
    "foreign-result",
    "anonymous-result",
    "extra-arm",
    "generic",
  ])("withholds unsupported %s boundary facts", async (variant) => {
    const own = createObjectValidatorFixture(variant);
    fixtures.push(own);
    own.resolver = createSymbolResolver(await collectPolicySubject(own.root));
    const identity = own.resolver.resolveExport(own.record.input).identities[0];
    expect(() => own.resolver.objectValidatorFacts(identity)).toThrow(
      "unsupported-object-validator-boundary",
    );
  });
});

describe("optional raw typeof operands (#3918)", () => {
  it("adds only intrinsic nullish residues while retaining domain and erasure refusals", async () => {
    const own = createRawHelperEnforcementFixture("optional-typeof");
    fixtures.push(own);
    own.resolver = createSymbolResolver(await collectPolicySubject(own.root));
    const identity = own.resolver.resolveExport(own.record.input).identities[0];
    const source = readFileSync(join(own.root, identity.producer.path), "utf8");
    const start = source.indexOf("function fields(");
    const end = source.indexOf("export function validate(");
    const slots = own.resolver
      .rawCheckingSlots(identity, 0)
      .filter(
        (slot) =>
          slot.rule === "anti-slop/no-runtime-typeof" && slot.start > start && slot.end < end,
      );
    const markers = ["direct", "optional", "nullish", "not-null", "alias", "primitive-guard"];
    expect(slots.map((slot) => slot.start)).toEqual(
      markers.map((marker) => source.indexOf("typeof", source.indexOf(`/* ${marker} */`))),
    );
    own.resolver.assertCurrent();
  });
});

describe("raw metadata source facts and bounded consumers (#3918)", () => {
  it("binds the source root only and requires both real incoming public consumers", async () => {
    const own = createMetadataSourceFixture();
    fixtures.push(own);
    own.resolver = createSymbolResolver(await collectPolicySubject(own.root));
    const producer = own.resolver.resolveExport(own.record.input).identities[0];
    const first = own.resolver.metadataSourceConsumer(own.record.consumer).identities[0];
    const second = own.resolver.metadataSourceConsumer(own.record.metadataSourceInput.companion)
      .identities[0];
    const facts = own.resolver.metadataSourceFacts(producer);
    expect(facts.slots).toHaveLength(1);
    expect(facts.slots[0]).toMatchObject({
      index: 0,
      rule: "anti-slop/no-object-parameters",
      rawMetadataSourceInput: true,
    });
    const text = readFileSync(join(own.root, producer.producer.path), "utf8");
    expect(text.slice(facts.slots[0].start, facts.slots[0].end)).toBe("object");
    expect(own.resolver.consumerCalls(first, producer, "alpha").bound).toBe(false);
    const binding = own.resolver.metadataSourceBinding(first, second, producer, "alpha");
    expect(binding).toMatchObject({
      bound: true,
      status: "ready",
      implementations: [first, second],
    });
    expect(binding.calls).toHaveLength(1);
    expect(() => own.resolver.metadataSourceBinding(first, first, producer, "alpha")).toThrow(
      "unsupported-metadata-source-consumers",
    );
  });

  it.each(["wrong-source", "wrong-target"])(
    "withholds an unsupported %s signature",
    async (variant) => {
      const own = createMetadataSourceFixture(variant);
      fixtures.push(own);
      own.resolver = createSymbolResolver(await collectPolicySubject(own.root));
      const producer = own.resolver.resolveExport(own.record.input).identities[0];
      expect(() => own.resolver.metadataSourceFacts(producer)).toThrow(
        "unsupported-metadata-source-boundary",
      );
    },
  );

  it.each(["third-caller", "callback-escape", "unbound-second"])(
    "keeps %s outside the closed pair",
    async (variant) => {
      const own = createMetadataSourceFixture(variant);
      fixtures.push(own);
      own.resolver = createSymbolResolver(await collectPolicySubject(own.root));
      const producer = own.resolver.resolveExport(own.record.input).identities[0];
      const first = own.resolver.metadataSourceConsumer(own.record.consumer).identities[0];
      const second = own.resolver.metadataSourceConsumer(own.record.metadataSourceInput.companion)
        .identities[0];
      expect(own.resolver.metadataSourceBinding(first, second, producer, "alpha").bound).toBe(
        false,
      );
    },
  );
});

describe("owned structural predicate stage facts (#3918)", () => {
  it("adds only the private owned predicate input under explicit opt-in", async () => {
    const own = createObjectValidatorFixture("valid", true);
    fixtures.push(own);
    own.resolver = createSymbolResolver(await collectPolicySubject(own.root));
    const identity = own.resolver.resolveExport(own.record.input).identities[0];
    const original = own.resolver.objectValidatorFacts(identity);
    expect(original.slots).toHaveLength(1);
    const expanded = own.resolver.objectValidatorFacts(identity, true);
    expect(expanded.slots).toHaveLength(2);
    expect(expanded.slots[0]).toEqual(original.slots[0]);
    expect(expanded.slots[1]).toMatchObject({
      index: 0,
      rule: "anti-slop/no-object-parameters",
      rawObjectValidatorInput: true,
      ownedPredicateStageInput: true,
    });
    const source = readFileSync(join(own.root, identity.producer.path), "utf8");
    expect(expanded.slots[1].start).toBe(source.indexOf("view: object") + "view: ".length);
    expect(source.slice(expanded.slots[1].start, expanded.slots[1].end)).toBe("object");
  });

  it.each([
    [
      "different owned predicate target",
      (source) =>
        source.replace("view is View", "view is OtherView") +
        '\ninterface OtherView { readonly owner: string; readonly lifecycle: "loss" | "state" }',
      "unsupported-owned-predicate-stage",
    ],
    [
      "unchecked raw return",
      (source) =>
        source.replace(
          "export function validate(input: object): View | undefined { const view = raw(input); return view !== undefined && complete(view) ? view : undefined; }",
          "export function validate(input: object): object | undefined { return raw(input); }",
        ),
      "unsupported-object-validator-boundary",
    ],
    [
      "private predicate escape",
      (source) => source + "\nconst callbacks = [complete]; void callbacks;",
      "unsupported-owned-predicate-stage",
    ],
  ])("withholds the new stage for %s", async (_name, mutate, reason) => {
    const own = createObjectValidatorFixture("valid", true);
    fixtures.push(own);
    const path = "packages/alpha/src/owner.ts";
    const original = readFileSync(join(own.root, path), "utf8");
    const changed = mutate(original);
    expect(changed).not.toBe(original);
    own.put(path, changed);
    emitSymbolFixture(own.root);
    own.resolver = createSymbolResolver(await collectPolicySubject(own.root));
    const identity = own.resolver.resolveExport(own.record.input).identities[0];
    expect(() => own.resolver.objectValidatorFacts(identity, true)).toThrow(reason);
  });

  it("refuses currentness drift before returning an owned predicate fact", async () => {
    const own = createObjectValidatorFixture("valid", true);
    fixtures.push(own);
    own.resolver = createSymbolResolver(await collectPolicySubject(own.root));
    const identity = own.resolver.resolveExport(own.record.input).identities[0];
    const path = join(own.root, identity.producer.path);
    writeFileSync(path, readFileSync(path, "utf8") + "\n");
    expect(() => own.resolver.objectValidatorFacts(identity, true)).toThrow(
      "symbol-subject-changed",
    );
  });
});

describe("owned refusal marker pair facts (#3918)", () => {
  it("keeps the source default and adds only the canonical marker identity parameters", async () => {
    const own = createMetadataSourceFixture("valid", true);
    fixtures.push(own);
    own.resolver = createSymbolResolver(await collectPolicySubject(own.root));
    const producer = own.resolver.resolveExport(own.record.input).identities[0];
    const original = own.resolver.metadataSourceFacts(producer);
    expect(original.slots).toHaveLength(1);
    const opted = own.resolver.metadataSourceFacts(producer, true);
    expect(opted.slots.slice(0, 1)).toEqual(original.slots);
    expect(opted.slots).toHaveLength(3);
    const source = readFileSync(join(own.root, producer.producer.path), "utf8");
    expect(opted.slots.slice(1).map((slot) => source.slice(slot.start, slot.end))).toEqual([
      "object",
      "object",
    ]);
    expect(
      opted.slots.slice(1).every((slot) => slot.ownedMarkerPairInput && slot.index === 0),
    ).toBe(true);
    expect(() => own.resolver.metadataSourceFacts(producer, "true")).toThrow(
      "unsupported-owned-marker-pair-option",
    );
    own.resolver.assertCurrent();
  });

  it.each(["direct-caller", "key-type"])(
    "accounts for %s without certifying another caller",
    async (variant) => {
      const own = createMetadataSourceFixture(variant, true);
      fixtures.push(own);
      own.resolver = createSymbolResolver(await collectPolicySubject(own.root));
      const producer = own.resolver.resolveExport(own.record.input).identities[0];
      expect(own.resolver.metadataSourceFacts(producer, true).slots).toHaveLength(3);
    },
  );

  it.each([
    "wrong-key",
    "mutable-descriptor",
    "wrong-builtin",
    "helper-escape",
    "key-escape",
    "default-parameter",
    "foreign-domain",
    "shadowed-builtin",
  ])("withholds the whole optional pair for %s", async (variant) => {
    const own = createMetadataSourceFixture(variant, true);
    fixtures.push(own);
    own.resolver = createSymbolResolver(await collectPolicySubject(own.root));
    const producer = own.resolver.resolveExport(own.record.input).identities[0];
    expect(own.resolver.metadataSourceFacts(producer).slots).toHaveLength(1);
    expect(() => own.resolver.metadataSourceFacts(producer, true)).toThrow(
      "unsupported-owned-marker-pair",
    );
  });

  it("retains the existing alias budget and current source guard", async () => {
    const own = createMetadataSourceFixture("valid", true);
    fixtures.push(own);
    const subject = await collectPolicySubject(own.root);
    own.resolver = createSymbolResolver(subject);
    const producer = own.resolver.resolveExport(own.record.input).identities[0];
    own.resolver.close();
    own.resolver = createSymbolResolver(subject, { aliases: 2 });
    expect(() => own.resolver.metadataSourceFacts(producer, true)).toThrow("symbol-alias-budget");
    own.resolver.close();
    own.resolver = createSymbolResolver(subject);
    const current = own.resolver.resolveExport(own.record.input).identities[0];
    expect(own.resolver.metadataSourceFacts(current, true).slots).toHaveLength(3);
    own.put(
      current.producer.path,
      readFileSync(join(own.root, current.producer.path), "utf8") + "\n",
    );
    expect(() => own.resolver.metadataSourceFacts(current, true)).toThrow("symbol-subject-changed");
  });
});

describe("owned raw-registration transport facts (#3918)", () => {
  it("retains defaults and adds exactly the raw-registration transport parameters", async () => {
    const own = createMetadataSourceFixture("valid", true, true);
    fixtures.push(own);
    // Keep the original-engine FIRST independent of new policy-schema admission.
    delete own.record.ownedRegistrationTransport;
    own.put("scripts/code-quality-policy.json", own.policy);
    own.resolver = createSymbolResolver(await collectPolicySubject(own.root));
    const identity = own.resolver.resolveExport(own.record.input).identities[0];
    const original = own.resolver.metadataSourceFacts(identity);
    expect(original.slots).toHaveLength(1);
    const marker = own.resolver.metadataSourceFacts(identity, true);
    expect(marker.slots).toHaveLength(3);
    const combined = own.resolver.metadataSourceFacts(identity, true, true);
    expect(combined.slots.slice(0, 3)).toEqual(marker.slots);
    expect(combined.slots).toHaveLength(6);
    expect(combined.slots.slice(3).map((slot) => slot.index)).toEqual([0, 1, 0]);
    expect(combined.slots.slice(3).every((slot) => slot.ownedRegistrationTransportInput)).toBe(
      true,
    );
    const transport = own.resolver.metadataSourceFacts(identity, false, true);
    expect(transport.slots).toEqual([...original.slots, ...combined.slots.slice(3)]);
  });

  it.each([
    "registration-key",
    "registration-copy",
    "registration-default",
    "registration-side-call",
    "registration-escape",
  ])("withholds the closed transport for %s", async (variant) => {
    const own = createMetadataSourceFixture(variant, true, true);
    fixtures.push(own);
    own.resolver = createSymbolResolver(await collectPolicySubject(own.root));
    const identity = own.resolver.resolveExport(own.record.input).identities[0];
    expect(own.resolver.metadataSourceFacts(identity).slots).toHaveLength(1);
    expect(own.resolver.metadataSourceFacts(identity, true).slots).toHaveLength(3);
    expect(() => own.resolver.metadataSourceFacts(identity, true, true)).toThrow(
      "unsupported-owned-registration-transport",
    );
  });

  it("retains shared identity capacity and currentness for the new form", async () => {
    const own = createMetadataSourceFixture("valid", true, true);
    fixtures.push(own);
    const subject = await collectPolicySubject(own.root);
    own.resolver = createSymbolResolver(subject, { aliases: 4 });
    const identity = own.resolver.resolveExport(own.record.input).identities[0];
    expect(own.resolver.metadataSourceFacts(identity, true).slots).toHaveLength(3);
    expect(() => own.resolver.metadataSourceFacts(identity, true, true)).toThrow(
      "symbol-alias-budget",
    );
    own.resolver.close();
    own.resolver = createSymbolResolver(subject);
    expect(own.resolver.metadataSourceFacts(identity, true, true).slots).toHaveLength(6);
    expect(() => own.resolver.metadataSourceFacts(identity, true, "true")).toThrow(
      "unsupported-owned-registration-transport-option",
    );
    const path = identity.producer.path;
    own.put(path, readFileSync(join(own.root, path), "utf8") + "\n");
    expect(() => own.resolver.metadataSourceFacts(identity, true, true)).toThrow(
      "symbol-subject-changed",
    );
  });
});

describe("physical raw registration comparison inputs (#3918)", () => {
  it("retains legacy slots and adds only the two original attachment inputs", async () => {
    const own = createPhysicalRegistrationObservationFixture();
    fixtures.push(own);
    own.resolver = createSymbolResolver(await collectPolicySubject(own.root));
    const identity = own.resolver.resolveExport({
      ...own.record.input,
      consumerPath: "src/consumer.ts",
    }).identities[0];
    const options = { rawObjectInput: true, additionalObservationForms: ["own-key-identity"] };
    const original = own.resolver.propertyObservationFacts(identity, options);
    expect(original.slots).toHaveLength(6);
    const expanded = own.resolver.propertyObservationFacts(identity, {
      ...options,
      directRawCheckerInputs: true,
    });
    expect(expanded.slots).toHaveLength(10);
    expect(expanded.slots.slice(0, 6)).toEqual(original.slots);
    const added = expanded.slots.filter((slot) => slot.physicalRegistrationInput);
    expect(added).toHaveLength(2);
    const source = readFileSync(join(own.root, identity.producer.path), "utf8");
    const starts = ["function checkRegistration(", "function matchesRegistration("].map(
      (name) =>
        source.indexOf("registration: object", source.indexOf(name)) + "registration: ".length,
    );
    expect(added.map((slot) => slot.start)).toEqual(starts);
    expect(added.map((slot) => slot.index)).toEqual([1, 0]);
    expect(added.every((slot) => slot.observationRoots[0].identity === identity)).toBe(true);
  });

  it.each([
    "missing-refusal",
    "copied-registration",
    "receiver-escape",
    "outside-caller",
    "foreign-key",
  ])("withholds original attachment inputs for %s", async (variant) => {
    const own = createPhysicalRegistrationObservationFixture(variant);
    fixtures.push(own);
    own.resolver = createSymbolResolver(await collectPolicySubject(own.root));
    const identity = own.resolver.resolveExport({
      ...own.record.input,
      consumerPath: "src/consumer.ts",
    }).identities[0];
    const facts = own.resolver.propertyObservationFacts(identity, {
      rawObjectInput: true,
      additionalObservationForms: ["own-key-identity"],
      directRawCheckerInputs: true,
    });
    expect(facts.slots.filter((slot) => slot.physicalRegistrationInput)).toEqual([]);
  });
});

describe("boolean raw object observation facts (#3918)", () => {
  it("accounts only the declared root while retaining the default observer facts", async () => {
    const own = createBooleanObservationFixture();
    fixtures.push(own);
    own.resolver = createSymbolResolver(await collectPolicySubject(own.root));
    const identity = own.resolver.resolveExport({
      ...own.record.input,
      consumerPath: "src/consumer.ts",
    }).identities[0];
    const original = own.resolver.propertyObservationFacts(identity);
    expect(original.slots).toHaveLength(3);
    const selected = own.resolver.propertyObservationFacts(identity, { rawObjectInput: true });
    expect(selected.slots).toHaveLength(1);
    expect(selected.slots[0]).toMatchObject({
      kind: "parameter",
      index: 0,
      rule: "anti-slop/no-object-parameters",
      observationRoots: [{ identity, index: 0 }],
    });
    expect(selected.slots[0].start).toBeGreaterThan(original.slots[0].start);
    expect(() =>
      own.resolver.propertyObservationFacts(identity, {
        rawObjectInput: true,
        directRawCheckerInputs: true,
      }),
    ).toThrow("unsupported-object-observation-boundary");
    own.put(
      "packages/alpha/src/owner.ts",
      readFileSync(join(own.root, "packages/alpha/src/owner.ts"), "utf8") +
        "\n// currentness changed",
    );
    expect(() =>
      own.resolver.propertyObservationFacts(identity, { rawObjectInput: true }),
    ).toThrow();
  });
});
