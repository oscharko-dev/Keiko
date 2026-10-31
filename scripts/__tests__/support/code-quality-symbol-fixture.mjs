import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, symlinkSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { nativeCompilerExecutable } from "../../lib/code-quality-provenance.mjs";
import ts from "typescript";
import {
  fixtureOwnedPolicy,
  copyNativePolicyFixtureSources,
  createPolicyFixtureRepository,
} from "./code-quality-fixture.mjs";

export function createSymbolFixture(
  includeNativeHost = false,
  prepare = undefined,
  additionalOwners = [],
) {
  const root = createPolicyFixtureRepository();
  if (includeNativeHost) copyNativePolicyFixtureSources(root);
  const put = (path, value) => {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), typeof value === "string" ? value : JSON.stringify(value));
  };
  const options = {
    target: "ES2022",
    lib: ["ES2022"],
    module: "NodeNext",
    moduleResolution: "NodeNext",
    strict: true,
    types: [],
    verbatimModuleSyntax: true,
  };
  put("package.json", {
    name: "fixture",
    private: true,
    type: "module",
    workspaces: ["packages/*"],
  });
  put("tsconfig.build.json", { compilerOptions: { ...options, noEmit: true }, include: ["src"] });
  configureSymbolOwner(put, options);
  put(
    "src/consumer.ts",
    'import { parse as accepted } from "alpha"; import { validate as direct } from "alpha/runtime"; export const first = accepted(1); export const second = direct("x");\n',
  );
  put(".gitignore", "**/dist/\nnode_modules/\n");
  mkdirSync(join(root, "node_modules"));
  symlinkSync(join(root, "packages/alpha"), join(root, "node_modules/alpha"));
  const own = { root, put };
  prepare?.(own);
  emitSymbolFixture(root);
  for (const directory of additionalOwners) emitSymbolFixture(root, directory);
  return own;
}

function configureSymbolOwner(put, options) {
  put("packages/alpha/tsconfig.json", {
    compilerOptions: {
      ...options,
      composite: true,
      declaration: true,
      declarationMap: true,
      rootDir: "src",
      outDir: "dist",
    },
    include: ["src"],
  });
  put("packages/alpha/package.json", {
    name: "alpha",
    version: "0.0.0",
    type: "module",
    files: ["dist"],
    exports: {
      ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
      "./runtime": { types: "./dist/owner.d.ts", import: "./dist/owner.js" },
    },
  });
  put(
    "packages/alpha/src/owner.ts",
    "export function validate(input: unknown): { ok: true; value: number } | { ok: false } { return typeof input === 'number' ? { ok: true, value: input } : { ok: false }; }\n",
  );
  put("packages/alpha/src/index.ts", 'export { validate as parse } from "./owner.js";\n');
}

export function emitSymbolFixture(root, directory = "packages/alpha") {
  const config = ts.getParsedCommandLineOfConfigFile(
    join(root, directory, "tsconfig.json"),
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: () => {
        throw new TypeError("symbol-fixture-config");
      },
    },
  );
  const program = ts.createProgram({ rootNames: config.fileNames, options: config.options });
  if (ts.getPreEmitDiagnostics(program).length > 0) throw new TypeError("symbol-fixture-types");
  execFileSync(nativeCompilerExecutable(), ["-p", join(root, directory, "tsconfig.json")], {
    cwd: root,
    timeout: 10_000,
    killSignal: "SIGKILL",
    maxBuffer: 1024 * 1024,
  });
}

export function packSymbolFixture(root) {
  return JSON.parse(
    execFileSync(
      process.execPath,
      [process.env.npm_execpath, "pack", "--dry-run", "--ignore-scripts", "--json", "--workspaces"],
      { cwd: root, encoding: "utf8", timeout: 20_000 },
    ),
  );
}

export function publicParserRecord() {
  const path = "packages/alpha/src/proof.test.ts";
  const selector = { consumerPath: path, specifier: "alpha/runtime", exportName: "validate" };
  return {
    id: "fixture-public-parser",
    owner: "alpha",
    kind: "public-parser",
    rules: ["anti-slop/no-unknown-parameters"],
    input: { ...selector, parameterIndex: 0 },
    transform: selector,
    output: selector,
    consumer: {
      kind: "public-api-proof",
      owner: "alpha",
      consumerPath: path,
      specifier: "alpha/runtime",
      exportName: "publicParse",
    },
    proofs: [path],
  };
}

export function createPublicParserFixture(variant = "direct") {
  return createSymbolFixture(
    true,
    (own) => {
      const config = JSON.parse(readFileSync(join(own.root, "packages/alpha/tsconfig.json")));
      config.exclude = ["**/*.test.ts"];
      own.put("packages/alpha/tsconfig.json", config);
      own.put("packages/alpha/src/owner.ts", publicParserOwner(variant));
      own.put("packages/alpha/src/proof.test.ts", publicParserProof(variant));
      const record = publicParserRecord();
      const policy = fixtureOwnedPolicy([record]);
      own.put("scripts/code-quality-policy.json", policy);
      Object.assign(own, { record, policy });
      configurePublicParserOwnership(own, variant, config);
    },
    variant === "foreign-proof" ? ["packages/beta"] : [],
  );
}

function configurePublicParserOwnership(own, variant, config) {
  if (variant === "type-only") {
    own.put(
      "packages/alpha/src/index.ts",
      'export type { validate as parse } from "./owner.js";\n',
    );
    own.put(
      "src/consumer.ts",
      'import { validate } from "alpha/runtime"; export const result = validate(1);\n',
    );
    const proof =
      publicParserProof("direct") + 'import type { parse as TypeOnlyParser } from "alpha";\n';
    own.put(own.record.consumer.consumerPath, proof);
    for (const role of ["input", "transform", "output"]) {
      own.record[role].specifier = "alpha";
      own.record[role].exportName = "parse";
    }
  }
  if (variant !== "foreign-proof") return;
  bindForeignBetaProof(own, config, publicParserProof("direct"), { files: ["dist"] });
}

// Moves the record's proof and consumer into a separate linked `beta` package that owns them.
export function bindForeignBetaProof(own, config, proofSource, manifestFields = {}) {
  own.put("packages/beta/tsconfig.json", config);
  own.put("packages/beta/package.json", {
    name: "beta",
    type: "module",
    version: "0.0.0",
    ...manifestFields,
    exports: { ".": { types: "./dist/owner.d.ts", import: "./dist/owner.js" } },
  });
  own.put("packages/beta/src/owner.ts", "export const healthy = true;\n");
  own.put("packages/beta/src/proof.test.ts", proofSource);
  symlinkSync(join(own.root, "packages/beta"), join(own.root, "node_modules/beta"));
  const path = "packages/beta/src/proof.test.ts";
  for (const role of ["input", "transform", "output", "consumer"])
    own.record[role].consumerPath = path;
  own.record.consumer.owner = "beta";
  own.record.proofs = [path];
}

function publicParserPayload(variant) {
  const payloads = {
    unknown: ["unknown", "input"],
    any: ["any", "input"],
    "unknown-index": ["Record<string, unknown>", "{ value: input }"],
    "any-index": ["Record<string, any>", "{ value: input }"],
    "typed-index": ["Record<string, number>", "{ value: input }"],
    recursive: ["Payload", "{ value: input }"],
    "nested-unknown": ["{ nested: unknown }", "{ nested: input }"],
    "nested-typed": ["{ nested: number }", "{ nested: input }"],
  };
  return payloads[variant] ?? ["number", "input"];
}

function publicParserOwner(variant) {
  const [payload, value] = publicParserPayload(variant);
  const prefix =
    variant === "recursive" ? "export interface Payload { value: number; next?: Payload }\n" : "";
  const failure = variant === "mutable-errors" ? "string[]" : "readonly string[]";
  const extra = variant === "extra-envelope" ? "; extra?: number" : "";
  const optional = variant === "optional-value" ? "?" : "";
  const result = publicParserResultType(variant, payload, extra, optional, failure);
  const resultName = variant.startsWith("instantiated-") ? "ParseResult<number>" : "ParseResult";
  const parameters =
    variant === "explicit-this" ? "this: unknown, input: unknown" : "input: unknown";
  const generics = variant === "generic" ? "<T = number>" : "";
  return (
    prefix +
    result +
    `export function validate${generics}(${parameters}): ${resultName} { return typeof input === "number" ? { ok: true, value: ${value} } : ${publicParserFailureValue(variant)}; }\n`
  );
}

function publicParserFailureType(variant, fallback) {
  const types = {
    "mutable-reasons": "string[]",
    "unknown-reasons": "readonly unknown[]",
    "any-reasons": "readonly any[]",
    "string-reasons": "string",
    "array-like-reasons": "{ readonly length: number; readonly [index: number]: string }",
  };
  return types[variant] ?? fallback;
}

function publicParserFailureField(variant) {
  return variant.endsWith("reasons") || variant === "both-failure-fields" ? "reasons" : "errors";
}

function publicParserFailureValue(variant) {
  const value =
    variant === "string-reasons"
      ? '"invalid"'
      : variant === "array-like-reasons"
        ? '{ 0: "invalid", length: 1 }'
        : '["invalid"]';
  const extra = variant === "both-failure-fields" ? ', errors: ["invalid"]' : "";
  return `{ ok: false, ${publicParserFailureField(variant)}: ${value}${extra} }`;
}

function publicParserResultType(variant, payload, extra, optional, failure) {
  const field = publicParserFailureField(variant);
  const optionalFailure = variant === "optional-reasons" ? "?" : "";
  const extraFailure =
    variant === "extra-reasons"
      ? "; extra?: number"
      : variant === "both-failure-fields"
        ? "; errors: readonly string[]"
        : "";
  const failureType = publicParserFailureType(variant, failure);
  const generic = variant.startsWith("instantiated-") ? "<T>" : "";
  const output = generic ? "T" : payload;
  return `export type ParseResult${generic} = { ok: true; value${optional}: ${output}${extra} } | { ok: false; ${field}${optionalFailure}: ${failureType}${extraFailure} };\n`;
}

function publicParserProof(variant) {
  const prefix = 'import { validate as parse, type ParseResult } from "alpha/runtime";\n';
  const bodies = {
    constant: "const result = parse(input); return { ok: false, errors: [] };",
    discarded: "parse(input); const result = parse(input); return result;",
    input: "const result = parse(1); return result;",
    mutable: "let result = parse(input); return result;",
    asserted: "const result = parse(input as unknown); return result;",
    nonnull: "const result = parse(input!); return result;",
    satisfies: "const result = parse(input satisfies unknown); return result;",
    nested: "const result = (() => parse(input))(); return result;",
    extra: "const result = parse(input); parse(input); return result;",
    destructured: "const [result] = [parse(input)]; return result;",
    alias: "const result = alias(input); return result;",
    counterfeit: "const result = fake(input); return result;",
    "asserted-result": "const result = parse(input) as ParseResult; return result;",
    "asserted-return": "const result = parse(input); return result as ParseResult;",
    "annotated-local": "const result: ParseResult = parse(input); return result;",
  };
  const extra =
    variant === "alias"
      ? "const alias = parse;\n"
      : variant === "counterfeit"
        ? "function fake(input: unknown): ParseResult { return { ok: false, errors: [] }; }\n"
        : "";
  const returnType = publicParserReturnType(variant);
  const counterfeit =
    variant === "result-alias"
      ? "type Forwarded = ParseResult;\n"
      : variant === "counterfeit-type"
        ? "type Counterfeit = { ok: true; value: number } | { ok: false; errors: readonly string[] };\n"
        : "";
  return (
    prefix +
    extra +
    counterfeit +
    `export function publicParse(input: unknown): ${returnType} { ${bodies[variant] ?? "const result = parse(input); return result;"} }\n`
  );
}

function publicParserReturnType(variant) {
  if (variant === "counterfeit-type") return "Counterfeit";
  if (variant.startsWith("instantiated-")) return "ParseResult<number>";
  if (variant === "result-alias") return "Forwarded";
  return "ParseResult";
}
