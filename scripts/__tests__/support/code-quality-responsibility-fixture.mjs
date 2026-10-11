import { readFileSync, symlinkSync } from "node:fs";
import { pathToFileURL, URL } from "node:url";
import { join } from "node:path";
import { createSymbolFixture, emitSymbolFixture } from "./code-quality-symbol-fixture.mjs";

function assembleResponsibilityFixture(prepare, additionalOwners = []) {
  return createSymbolFixture(true, prepare, additionalOwners);
}

export function responsibilityPolicy(records = []) {
  const policy = JSON.parse(
    readFileSync(new URL("../../code-quality-policy.json", import.meta.url)),
  );
  return { ...policy, version: 2, responsibilities: records };
}

export function responsibilityRecord(kind = "validator") {
  const selector = (exportName) => ({
    consumerPath: "src/consumer.ts",
    specifier: "alpha/runtime",
    exportName,
  });
  return {
    id: "fixture-validator",
    owner: "alpha",
    kind,
    rules: ["anti-slop/no-unknown-parameters", "anti-slop/no-unknown-returns"],
    input: { ...selector("validate"), parameterIndex: 0 },
    transform: selector("validate"),
    output: selector("validate"),
    consumer: { ...selector("consume"), owner: "alpha" },
    proofs: ["packages/alpha/src/proof.test.ts"],
  };
}

export function createResponsibilityFixture(variant = "valid") {
  return assembleResponsibilityFixture((own) => configureResponsibilityFixture(own, variant));
}

function configureResponsibilityFixture(own, variant = "valid") {
  const validator =
    variant === "unchecked"
      ? "export function validate(input: unknown): unknown { return input; }"
      : "export function validate(input: unknown): { ok: true; value: number } | { ok: false } { return typeof input === 'number' ? { ok: true, value: input } : { ok: false }; }";
  const predicate = "export function validate(input: unknown): input is number { return true; }";
  const predicateConsumer =
    "export function consume(input: unknown): number { if (!validate(input)) throw new TypeError('invalid'); return input; }";
  const consumer =
    variant === "domain-unknown"
      ? "export function consume(input: unknown): unknown { return input; }"
      : "export function consume(input: unknown): number { const result = validate(input); if (!result.ok) throw new TypeError('invalid'); return result.value; }";
  own.put(
    "packages/alpha/src/owner.ts",
    `${variant === "lying-predicate" ? predicate : validator}\n${variant === "lying-predicate" ? predicateConsumer : variant === "unchecked" ? "export function consume(input: unknown): number { return 1; }" : consumer}\n`,
  );
  own.put(
    "src/consumer.ts",
    'import { validate, consume } from "alpha/runtime"; export const result = validate(1); export const value = consume(1);',
  );
  own.put("packages/alpha/src/proof.test.ts", "export const proof = true;\n");
  return own;
}

export async function executeResponsibilityFixture(own) {
  return import(pathToFileURL(join(own.root, "packages/alpha/dist/owner.js")).href);
}

export function createEnforcementFixture(kind = "validator", variant = "valid") {
  return assembleResponsibilityFixture((own) => configureEnforcementFixture(own, kind, variant));
}

function configureEnforcementFixture(own, kind = "validator", variant = "valid") {
  configureResponsibilityFixture(own);
  const validator =
    "export function validate(input: unknown): { ok: true; value: number } | { ok: false } { return typeof input === 'number' ? { ok: true, value: input } : { ok: false }; }";
  const consumer =
    "export function consume(input: number): number { const result = validate(input); if (!result.ok) throw new TypeError('invalid'); return result.value; }";
  const redactor = "export function validate(input: unknown): unknown { return input; }";
  const redactorConsumer =
    "export function consume(input: number): number { const result = validate(input); if (typeof result !== 'number') throw new TypeError('invalid'); return result; }";
  own.put(
    "packages/alpha/src/owner.ts",
    `${kind === "structural-redactor" || variant === "unchecked" ? redactor : validator}\n${kind === "structural-redactor" ? redactorConsumer : variant === "unchecked" ? "export function consume(input: number): number { return 1; }" : consumer}\n`,
  );
  const record = responsibilityRecord(kind);
  const policy = responsibilityPolicy([record]);
  activateResponsibilityFixtureRules(policy, record);
  own.put("scripts/code-quality-policy.json", policy);
  Object.assign(own, { record, policy });
  return own;
}

function activateResponsibilityFixtureRules(policy, record) {
  const scopes = [record.owner, record.consumer.owner].map((owner) => `package:${owner}`);
  for (const rule of policy.rules) {
    if (record.rules.includes(rule.id))
      rule.activeScopes = [...new Set([...rule.activeScopes, ...scopes])];
  }
}

export function replaceEnforcementOwner(own, variant) {
  const sources = {
    "lying-predicate":
      "export function validate(input: unknown): input is number { return true; }\nexport function consume(input: number): number { if (!validate(input)) throw new TypeError('invalid'); return input; }",
    "union-dictionary":
      "export function validate(input: unknown): Record<string, unknown> | number { return typeof input === 'number' ? input : { value: input }; }\nexport function consume(input: number): number { const result = validate(input); if (typeof result !== 'number') throw new TypeError('invalid'); return result; }",
    "open-dictionary":
      "export function validate(input: unknown): Record<string, unknown> { return { value: input }; }\nexport function consume(input: number): number { return validate(input).value as number; }",
    "generic-assertion":
      "export function validate(input: unknown): { ok: true; value: number } | { ok: false } { return { ok: true, value: input as number }; }\nexport function consume(input: number): number { const result = validate(input); if (!result.ok) throw new TypeError('invalid'); return result.value; }",
    "extra-slot":
      "export function validate(input: unknown, unrelated: unknown = 1): { ok: true; value: number } | { ok: false } { return typeof input === 'number' ? { ok: true, value: input } : { ok: false }; }\nexport function consume(input: number): number { const result = validate(input); if (!result.ok) throw new TypeError('invalid'); return result.value; }",
    "unknown-consumer":
      "export function validate(input: unknown): { ok: true; value: number } | { ok: false } { return typeof input === 'number' ? { ok: true, value: input } : { ok: false }; }\nexport function consume(input: unknown): unknown { return input; }",
  };
  own.put("packages/alpha/src/owner.ts", sources[variant]);
  emitSymbolFixture(own.root);
}

export function createCrossOwnerEnforcementFixture(variant = "valid") {
  return assembleResponsibilityFixture(
    (own) => configureCrossOwnerEnforcementFixture(own, variant),
    ["packages/beta"],
  );
}

function configureCrossOwnerEnforcementFixture(own, variant = "valid") {
  configureEnforcementFixture(own);
  const config = JSON.parse(readFileSync(join(own.root, "packages/alpha/tsconfig.json")));
  own.put("packages/beta/tsconfig.json", config);
  own.put("packages/beta/package.json", {
    name: "beta",
    version: "0.0.0",
    type: "module",
    files: ["dist"],
    dependencies: { alpha: "0.0.0" },
    exports: { "./runtime": { types: "./dist/owner.d.ts", import: "./dist/owner.js" } },
  });
  own.put(
    "packages/beta/src/owner.ts",
    'import { validate } from "alpha/runtime"; export function consume(input: number): number { const result = validate(input); if (!result.ok) throw new TypeError("invalid"); return result.value; }',
  );
  symlinkSync(join(own.root, "packages/beta"), join(own.root, "node_modules/beta"));
  own.put(
    "src/consumer.ts",
    'import { validate } from "alpha/runtime"; import { consume } from "beta/runtime"; export const result = validate(1); export const value = consume(1);',
  );
  own.record.consumer.specifier = "beta/runtime";
  own.record.consumer.owner = "beta";
  activateResponsibilityFixtureRules(own.policy, own.record);
  if (variant === "alias-producer")
    own.put("packages/beta/src/owner.ts", 'export { consume } from "alpha/runtime";');
  if (variant === "noncallable") {
    own.put("packages/beta/src/owner.ts", "export const consume = 42;");
    own.put(
      "src/consumer.ts",
      'import { validate } from "alpha/runtime"; import { consume } from "beta/runtime"; export const result = validate(1); export const value = consume;',
    );
  }
  own.put("scripts/code-quality-policy.json", own.policy);
  return own;
}

export function createConsumerSeamFixture(variant = "direct") {
  return assembleResponsibilityFixture(
    (own) => configureConsumerSeamFixture(own, variant),
    ["packages/beta"],
  );
}

function configureConsumerSeamFixture(own, variant = "direct") {
  configureCrossOwnerEnforcementFixture(own);
  own.put("src/public-consumer.test.mjs", 'export { consume } from "beta/runtime";\n');
  if (["alias", "callback"].includes(variant)) {
    configureConsumerCallFixture(own, variant);
    return own;
  }
  const checked =
    'const result = validate(input); if (!result.ok) throw new TypeError("invalid"); return result.value;';
  const bodies = {
    direct: `export function consume(input: number): number { ${checked} }`,
    one: `function first(input: number): number { ${checked} } export function consume(input: number): number { return first(input); }`,
    two: `function first(input: number): number { ${checked} } function second(input: number): number { return first(input); } export function consume(input: number): number { return second(input); }`,
    overloadAlias: `function handle(input: number, evidence?: number): number; function handle(input: number, ...[evidence]: [evidence?: number | undefined]): number { void evidence; ${checked} } export const consume = handle;`,
    siblingAlias: `function first(input: number): number { ${checked} } const call = first; export function consume(input: number): number { return call(input); }`,
    exported: `export function first(input: number): number { ${checked} } export function consume(input: number): number { return first(input); }`,
    exportAlias: `function first(input: number): number { ${checked} } export { first as guard }; export function consume(input: number): number { return first(input); }`,
    escaped: `function first(input: number): number { ${checked} } export const holder = { first }; export function consume(input: number): number { return first(input); }`,
    mutableSibling: `let first = (input: number): number => { ${checked} }; export function consume(input: number): number { return first(input); }`,
    destructuredSibling: `function first(input: number): number { ${checked} } const { call } = { call: first }; export function consume(input: number): number { return call(input); }`,
    computedSibling: `function first(input: number): number { ${checked} } const holder = { first }; export function consume(input: number): number { return holder["first"](input); }`,
    unusedSibling: `function first(input: number): number { ${checked} } export function consume(input: number): number { void first; return input; }`,
    nestedSibling: `export function consume(input: number): number { function first(input: number): number { ${checked} } return first(input); }`,
    classSibling: `export function consume(input: number): number { class Deferred { result = validate(input); } void Deferred; return input; }`,
    mixedOverload: `function first(input: number): number { if (input < 0) return consume(input); ${checked} } export function consume(input: number, evidence?: number): number; export function consume(input: number, ...[evidence]: [evidence?: number | undefined]): number { void evidence; return first(input); }`,
    overloadSelf: `export function consume(input: number, evidence?: number): number; export function consume(input: number, ...[evidence]: [evidence?: number | undefined]): number { void evidence; if (input < 0) return consume(input); ${checked} }`,
    mixedAlias: `function first(input: number): number { if (input < 0) return consume(input); ${checked} } function handle(input: number): number { return first(input); } export const consume = handle;`,
    mixedCycle: `function first(input: number): number { if (input < 0) return consume(input); ${checked} } export function consume(input: number): number { return first(input); }`,
    cycle: `function first(input: number): number { if (input < 0) return first(input); ${checked} } export function consume(input: number): number { return first(input); }`,
    mutual: `function first(input: number): number { if (input < 0) return second(input); ${checked} } function second(input: number): number { return first(input); } export function consume(input: number): number { return first(input); }`,
    ambiguous: `export function consume(input: number): number; export function consume(input: number, evidence: number): number; export function consume(input: number, evidence?: number): number { void evidence; ${checked} }`,
    overload: `export function consume(input: number, evidence?: number): number; export function consume(input: number, ...[evidence]: [evidence?: number | undefined]): number { void evidence; ${checked} }`,
  };
  own.put(
    "packages/beta/src/owner.ts",
    `import { validate } from "alpha/runtime"; ${bodies[variant]}`,
  );
  return own;
}

export function replaceConsumerCallFixture(own, variant) {
  configureConsumerCallFixture(own, variant);
  emitSymbolFixture(own.root, "packages/beta");
}

function configureConsumerCallFixture(own, variant) {
  const imported = 'import { validate } from "alpha/runtime";';
  const checked =
    'const result = validate(input); if (!result.ok) throw new TypeError("invalid"); return result.value;';
  const bodies = {
    arrow: `${imported} export const consume = (input: number): number => { ${checked} };`,
    expression: `${imported} export const consume = function(input: number): number { ${checked} };`,
    alias: `${imported} function handleValidateImpl(input: number): number { ${checked} } export const consume = handleValidateImpl;`,
    callback: `${imported} function withOp(action: () => number): number { return action(); } function handleValidateImpl(input: number): number { return withOp(() => { ${checked} }); } export const consume = handleValidateImpl;`,
    namespace: `import * as ns from "alpha/runtime"; const validate = ns.validate; function handleValidateImpl(input: number): number { ${checked} } export const consume = handleValidateImpl;`,
    reexport: 'export { handleValidateImpl as consume } from "./implementation.js";',
    fake: "function validate(input: number): number { return input; } export function consume(input: number): number { return validate(input); }",
    mutable: `${imported} let selected = validate; export function consume(input: number): number { selected(input); return input; }`,
    destructured:
      'import * as ns from "alpha/runtime"; const { validate } = ns; export function consume(input: number): number { validate(input); return input; }',
    computed:
      'import * as ns from "alpha/runtime"; let key: "validate" = "validate"; const selected = ns[key]; export function consume(input: number): number { selected(input); return input; }',
    "computed-alias":
      'import * as ns from "alpha/runtime"; let key: "validate" = "validate"; const selected = ns[key]; const forwarded = selected; export function consume(input: number): number { forwarded(input); return input; }',
    unused: `${imported} export function consume(input: number): number { const unused = () => validate(input); return input; }`,
    nested: `${imported} export function consume(input: number): number { function unused(): unknown { return validate(input); } return input; }`,
    class: `${imported} export function consume(input: number): number { class Deferred { result = validate(input); } return input; }`,
    dispatch: `${imported} function dispatch(action: typeof validate, input: number): number { action(input); return input; } export function consume(input: number): number { return dispatch(validate, input); }`,
    foreign:
      'import { consume as implementation } from "alpha/runtime"; export const consume = implementation;',
    "mutable-consumer": `${imported} function handleValidateImpl(input: number): number { ${checked} } export let consume = handleValidateImpl;`,
  };
  if (variant === "reexport")
    own.put(
      "packages/beta/src/implementation.ts",
      `${imported} export function handleValidateImpl(input: number): number { ${checked} }`,
    );
  own.put("packages/beta/src/owner.ts", bodies[variant]);
}

export function createRawHelperEnforcementFixture(variant = "direct") {
  return assembleResponsibilityFixture((own) => configureRawHelperEnforcementFixture(own, variant));
}

function configureRawHelperEnforcementFixture(own, variant = "direct") {
  configureEnforcementFixture(own);
  own.put("packages/alpha/src/owner.ts", rawHelperSource(variant));
  if (["nonzero", "unicode-extra-slot"].includes(variant)) {
    own.record.input.parameterIndex = 1;
    own.put(
      "src/consumer.ts",
      'import { validate, consume } from "alpha/runtime"; export const result = validate(0, 1); export const value = consume(1);',
    );
  }
  if (variant === "other-api")
    own.put(
      "packages/alpha/src/other.ts",
      'export function other(input: unknown): boolean { return typeof input === "number"; }',
    );
  own.record.rules.push("anti-slop/no-runtime-typeof", "anti-slop/no-known-value-widening");
  activateResponsibilityFixtureRules(own.policy, own.record);
  own.put("scripts/code-quality-policy.json", own.policy);
  return own;
}

function directRawHelperSource() {
  return [
    "function finite(input: unknown): input is number {",
    '  return typeof input === "number" && Number.isFinite(input);',
    "}",
    "export function validate(input: unknown): { ok: true; value: number } | { ok: false } {",
    "  if (!finite(input)) return { ok: false };",
    "  const narrowed: number = input;",
    "  if (!finite(narrowed)) return { ok: false };",
    "  return { ok: true, value: narrowed };",
    "}",
    "export function consume(input: number): number {",
    "  const result = validate(input);",
    '  if (!result.ok) throw new TypeError("invalid");',
    "  return result.value;",
    "}",
    "",
  ].join("\n");
}

function rawHelperSource(variant) {
  const source = directRawHelperSource();
  const variants = {
    wrapper: () => rawWrapperSource(),
    "unicode-wrapper": () => rawWrapperSource().replaceAll("input", "είσοδος"),
    property: () => rawPropertySource(),
    "partially-narrowed": () =>
      rawPropertySource().replace(
        'typeof input !== "object" || input === null',
        'input === null || typeof input !== "object"',
      ),
    nonzero: () => nonzeroRawSource(source),
    "unicode-extra-slot": () =>
      source
        .replace("validate(input: unknown)", "validate(λλλλλλλλλλλλλλλλ: unknown, input: unknown)")
        .replace("validate(input)", "validate(0, input)"),
    "parameter-write": () =>
      source.replace("  if (!finite(input))", "  input = 42;\n  if (!finite(input))"),
    "helper-write": () =>
      source.replace("  return typeof input", "  input = 42; return typeof input"),
    "extra-slot": () =>
      source.replace(
        "validate(input: unknown)",
        "validate(input: unknown, unrelated: unknown = 42)",
      ),
    "other-api": () => source,
    "literal-erasure": () => source + "const known = 42; const erased: unknown = known;\n",
    "unrelated-typeof": () => source + "const unrelated = typeof 42;\n",
    unicode: () => "/* λ boundary */\n" + source.replaceAll("finite", "πεπερασμένο"),
  };
  return variants[variant]?.() ?? rawHelperVariant(source, variant);
}

function rawPropertySource() {
  return [
    'function finite(input: unknown): input is number { return typeof input === "number" && Number.isFinite(input); }',
    "function checked(input: unknown): boolean { return finite(input); }",
    "export function validate(input: unknown): { ok: true; value: number } | { ok: false } {",
    '  if (typeof input !== "object" || input === null || !("etag" in input)) return {ok:false};',
    '  const raw = input["etag"]; if (!checked(raw) || !finite(raw)) return {ok:false};',
    "  if (!finite(raw)) return {ok:false}; return {ok:true,value:raw};",
    "}",
    'export function consume(input: number): number { const result = validate({etag:input}); if(!result.ok) throw new TypeError("invalid"); return result.value; }',
    "",
  ].join("\n");
}

function nonzeroRawSource(source) {
  return source
    .replace("finite(input: unknown)", "finite(prefix: number, input: unknown)")
    .replace("validate(input: unknown)", "validate(prefix: number, input: unknown)")
    .replaceAll("finite(input)", "finite(0, input)")
    .replace("finite(narrowed)", "finite(0, narrowed)")
    .replace("validate(input)", "validate(0, input)");
}

function rawWrapperSource() {
  return [
    "type Result = { ok: true; value: number } | { ok: false };",
    'function finite(input: unknown): input is number { return typeof input === "number" && Number.isFinite(input); }',
    "function checked(input: unknown): Result { if (!finite(input)) return {ok:false}; return {ok:true,value:input}; }",
    "export function validate(input: unknown): Result { return checked(input); }",
    'export function consume(input: number): number { const result=validate(input); if(!result.ok) throw new TypeError("invalid"); return result.value; }',
    "",
  ].join("\n");
}

function rawHelperVariant(source, variant) {
  const additions = {
    direct: "",
    export: "export { finite };",
    "export-alias": "export { finite as guard };",
    trusted: "function unrelated(input: number): boolean { return finite(input); }",
    "exported-trusted":
      "export function unrelated(input: number): boolean { return finite(input); }",
    returned: "export function escape(): typeof finite { return finite; }",
    callback: "const unused = (): boolean => finite(42);",
    "mutable-callee": "let guard = finite; guard(42);",
    "destructured-callee": "const { guard } = { guard: finite }; guard(42);",
    "computed-callee": "const holder = { guard: finite }; holder['guard'](42);",
  };
  if (Object.hasOwn(additions, variant)) return source + additions[variant] + "\n";
  const insertions = {
    "nested-unused": "function unused(): boolean { return finite(input); }",
    "deferred-class": "class Deferred { value = finite(input); }",
    "asserted-origin": "finite(input as unknown);",
    "nonnull-origin": "finite(input!);",
    "satisfies-origin": "finite(input satisfies number);",
    "erased-origin": "const erased: unknown = input; finite(erased);",
    "mutable-origin": "let raw = input; finite(raw);",
    "reassigned-origin": "let raw = input; raw = 42; finite(raw);",
    "destructured-origin": "const { value: raw } = { value: input }; finite(raw);",
    aliases:
      "const first = input; const second: number = first; const guard = finite; guard(second);",
  };
  if (Object.hasOwn(insertions, variant))
    return source.replace(
      "  const narrowed: number = input;",
      insertions[variant] + "\n  const narrowed: number = input;",
    );
  if (variant === "self-cycle")
    return source.replace("return typeof input", "finite(input); return typeof input");
  if (variant === "mutual-cycle")
    return (
      source.replace("return typeof input", "other(input); return typeof input") +
      "function other(input: unknown): boolean { return finite(input); }\n"
    );
  throw new TypeError("unknown raw helper fixture variant");
}

export function createDiagnosticFixture(variant = "direct") {
  return assembleResponsibilityFixture((own) => configureDiagnosticFixture(own, variant));
}

function configureDiagnosticFixture(own, variant = "direct") {
  const config = JSON.parse(readFileSync(join(own.root, "packages/alpha/tsconfig.json")));
  config.exclude = ["**/*.test.ts"];
  own.put("packages/alpha/tsconfig.json", config);
  own.put(
    "packages/alpha/src/owner.ts",
    'export function validate(input: unknown): readonly string[] { return typeof input === "number" ? [] : ["invalid"]; }\n',
  );
  own.put("src/consumer.ts", 'import { parse } from "alpha"; export const result = parse(1);');
  own.put("packages/alpha/src/proof.test.ts", diagnosticProofSource(variant));
  const path = "packages/alpha/src/proof.test.ts";
  const selector = { consumerPath: path, specifier: "alpha", exportName: "parse" };
  const record = {
    ...responsibilityRecord(),
    kind: "diagnostic-checker",
    input: { ...selector, parameterIndex: 0 },
    transform: selector,
    output: selector,
    consumer: {
      kind: "public-api-proof",
      owner: "alpha",
      consumerPath: path,
      specifier: "alpha",
      exportName: "countDiagnostics",
    },
    proofs: [path],
  };
  Object.assign(own, { record, policy: responsibilityPolicy([record]) });
  return own;
}

function diagnosticProofSource(variant) {
  const prefix = 'import { parse as check } from "alpha";\n';
  const bodies = {
    direct: "const diagnostics = check(input); return diagnostics.length;",
    constant: "const diagnostics = check(input); return 0;",
    discarded:
      "check(input); const diagnostics: readonly string[] = []; return diagnostics.length;",
    receiver:
      "const diagnostics = check(input); const other: readonly string[] = []; return other.length;",
    input: "const diagnostics = check(1); return diagnostics.length;",
    mutable: "let diagnostics = check(input); return diagnostics.length;",
    asserted: "const diagnostics = check(input as unknown); return diagnostics.length;",
    nonnull: "const diagnostics = check(input!); return diagnostics.length;",
    satisfies: "const diagnostics = check(input satisfies unknown); return diagnostics.length;",
    nested: "const diagnostics = (() => check(input))(); return diagnostics.length;",
    extra: "const diagnostics = check(input); check(input); return diagnostics.length;",
    wrapper: "const diagnostics = helper(input); return diagnostics.length;",
    destructured: "const [diagnostics] = [check(input)]; return diagnostics.length;",
    dynamic:
      "const diagnostics = Reflect.apply(check, undefined, [input]); return diagnostics.length;",
    overload: "const diagnostics = check(input); return diagnostics.length;",
    counterfeit: "const diagnostics = fake(input); return diagnostics.length;",
  };
  const extra =
    variant === "wrapper"
      ? "function helper(input: unknown): readonly string[] { return check(input); }\n"
      : variant === "counterfeit"
        ? "function fake(input: unknown): readonly string[] { return []; }\n"
        : "";
  if (!(variant in bodies)) throw new TypeError("invalid diagnostic fixture variant");
  return (
    prefix +
    extra +
    (variant === "overload" ? "export function countDiagnostics(input: number): number;\n" : "") +
    `export function countDiagnostics(input: unknown): number { ${bodies[variant]} }\n`
  );
}

export function createForeignDiagnosticFixture() {
  return assembleResponsibilityFixture(
    (own) => configureForeignDiagnosticFixture(own),
    ["packages/beta"],
  );
}

function configureForeignDiagnosticFixture(own) {
  configureDiagnosticFixture(own);
  const config = JSON.parse(readFileSync(join(own.root, "packages/alpha/tsconfig.json")));
  own.put("packages/beta/tsconfig.json", config);
  own.put("packages/beta/package.json", {
    name: "beta",
    type: "module",
    version: "0.0.0",
    exports: { ".": { types: "./dist/owner.d.ts", import: "./dist/owner.js" } },
  });
  own.put("packages/beta/src/owner.ts", "export const healthy = true;\n");
  own.put("packages/beta/src/proof.test.ts", diagnosticProofSource("direct"));
  symlinkSync(join(own.root, "packages/beta"), join(own.root, "node_modules/beta"));
  const path = "packages/beta/src/proof.test.ts";
  for (const role of ["input", "transform", "output", "consumer"])
    own.record[role].consumerPath = path;
  own.record.consumer.owner = "beta";
  own.record.proofs = [path];
  return own;
}

export function createDictionaryEnforcementFixture(variant = "direct") {
  return assembleResponsibilityFixture((own) =>
    configureDictionaryEnforcementFixture(own, variant),
  );
}

function configureDictionaryEnforcementFixture(own, variant = "direct") {
  configureEnforcementFixture(own);
  const source = dictionaryCheckingSource();
  const sources = {
    ...dictionarySignatureVariants(source),
    ...dictionaryOwnershipVariants(source),
    ...dictionaryDispatchVariants(source),
  };
  own.put("packages/alpha/src/owner.ts", sources[variant]);
  own.record.rules.push("anti-slop/no-unsafe-dictionary-type", "anti-slop/no-known-value-widening");
  activateResponsibilityFixtureRules(own.policy, own.record);
  own.put("scripts/code-quality-policy.json", own.policy);
  return own;
}

function dictionaryCheckingSource() {
  return [
    'function record(input: unknown): input is Record<string, unknown> { return typeof input === "object" && input !== null && !Array.isArray(input); }',
    'function fields(input: Record<string, unknown>): input is Record<string, unknown> & { value: number } { return typeof input.value === "number" && Number.isFinite(input.value); }',
    "export function validate(input: unknown): { ok: true; value: number } | { ok: false } { if (!record(input) || !fields(input)) return { ok: false }; return { ok: true, value: input.value }; }",
    'export function consume(input: number): number { const result = validate({ value: input }); if (!result.ok) throw new TypeError("invalid"); return result.value; }',
    "export function unrelated(input: Record<string, unknown>): Record<string, unknown> { return input; }",
    "",
  ].join("\n");
}

function dictionarySignatureVariants(source) {
  return {
    direct: source,
    unicode: source.replaceAll("input", "είσοδος"),
    erasure: source
      .replace(
        "if (!record(input) || !fields(input)) return { ok: false };",
        "if (!record(input)) return { ok: false }; const erased: Record<string, unknown> & { tag?: boolean } = input; if (!fields(erased)) return { ok: false };",
      )
      .replace("value: input.value", "value: erased.value"),
    "typed-index": source.replaceAll("Record<string, unknown>", "Record<string, number>"),
    "any-index": source.replaceAll("Record<string, unknown>", "Record<string, any>"),
    counterfeit: "type Record<K extends string, V> = { [P in K]: V };\n" + source,
    "alias-member":
      "type Bag = Record<string, unknown>;\n" + source.replaceAll("Record<string, unknown>", "Bag"),
  };
}

function dictionaryOwnershipVariants(source) {
  return {
    "export-helper": source.replace("function fields", "export function fields"),
    "reexport-helper": source + "export { fields };\n",
    "second-caller":
      source +
      "export function trusted(input: Record<string, unknown>): boolean { return fields(input); }\n",
    callback: source + "const callbacks = [fields];\n",
    "return-escape": source + "export function expose() { return fields; }\n",
    "helper-write": source.replace(
      "return typeof input.value",
      "input = {}; return typeof input.value",
    ),
    "root-write": source.replace("if (!record(input)", "input = { value: 1 }; if (!record(input)"),
  };
}

function dictionaryDispatchVariants(source) {
  return {
    unused: source.replace("!fields(input)", 'typeof input.value !== "number"'),
    deferred: source
      .replace("!fields(input)", 'typeof input.value !== "number"')
      .replace(
        "return { ok: true, value: input.value };",
        "const later = () => fields(input); return { ok: true, value: input.value };",
      ),
    computed: source.replace("fields(input)", "({ check: fields }).check(input)"),
    reflective: source.replace(
      "!fields(input)",
      '!Reflect.apply(fields, null, [input]) || typeof input.value !== "number"',
    ),
    destructured: source
      .replace(
        "export function validate",
        "const { check } = { check: fields }; export function validate",
      )
      .replace("fields(input)", "check(input)"),
    "mutable-alias": source
      .replace("export function validate", "let check = fields; export function validate")
      .replace("fields(input)", "check(input)"),
    cycle: source.replace(
      "return typeof input.value",
      "if (!fields(input)) return false; return typeof input.value",
    ),
    "parameter-intersection": source.replace(
      "fields(input: Record<string, unknown>)",
      "fields(input: Record<string, unknown> & { tag?: boolean })",
    ),
    "other-predicate-parameter": source
      .replace(
        "fields(input: Record<string, unknown>): input is",
        "fields(input: Record<string, unknown>, other: unknown = input): other is",
      )
      .replace("!fields(input)", '!fields(input) || typeof input.value !== "number"'),
    intersection: [
      "export function validate(input: unknown): Record<string, unknown> & { value: number } { return { value: 1 }; }",
      "export function consume(input: number): number { return validate(input).value; }",
    ].join("\n"),
  };
}
