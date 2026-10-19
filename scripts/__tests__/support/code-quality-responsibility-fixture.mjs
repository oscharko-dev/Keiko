import { readFileSync, symlinkSync } from "node:fs";
import { pathToFileURL, URL } from "node:url";
import { join } from "node:path";
import {
  createSymbolFixture,
  emitSymbolFixture,
  publicParserRecord,
} from "./code-quality-symbol-fixture.mjs";

import ts from "typescript";

import { fixtureOwnedPolicy } from "./code-quality-fixture.mjs";

function assembleResponsibilityFixture(prepare, additionalOwners = []) {
  return createSymbolFixture(true, prepare, additionalOwners);
}

export function responsibilityPolicy(records = []) {
  return fixtureOwnedPolicy(records);
}

export function createCollectiveParserFixture(variant = "direct", rules = []) {
  return assembleResponsibilityFixture((own) => {
    const config = JSON.parse(readFileSync(join(own.root, "packages/alpha/tsconfig.json")));
    config.exclude = ["**/*.test.ts"];
    own.put("packages/alpha/tsconfig.json", config);
    own.put("packages/alpha/src/owner.ts", collectiveParserOwner(variant));
    own.put("packages/alpha/src/index.ts", 'export { first as parse } from "./owner.js";\n');
    own.put(
      "src/consumer.ts",
      'import { first } from "alpha/runtime"; import { parse } from "alpha"; export const value = first(1); export const alias = parse(1);\n',
    );
    own.put("packages/alpha/src/proof.test.ts", collectiveParserProof(variant));
    const records = ["first", "second"].map((name) => collectiveParserRecord(name, rules));
    if (["public-alias", "public-const-alias"].includes(variant)) {
      const alias = collectiveParserRecord("firstAlias", rules);
      for (const role of ["input", "transform", "output"])
        Object.assign(alias[role], { specifier: "alpha", exportName: "parse" });
      alias.consumer.specifier = "alpha";
      records.push(alias);
    }
    const policy = responsibilityPolicy(records);
    for (const record of records) activateResponsibilityFixtureRules(policy, record);
    own.put("scripts/code-quality-policy.json", policy);
    Object.assign(own, { records, policy });
  });
}

function collectiveParserRecord(name, rules) {
  const record = publicParserRecord();
  record.id = `fixture-${name}`;
  record.rules.push(...rules);
  for (const role of ["input", "transform", "output"]) record[role].exportName = name;
  record.consumer.exportName = `public${name}`;
  record.proofAssertions = ["healthy", "malformed"].map((kind) => ({
    path: record.consumer.consumerPath,
    testName: `${name} ${kind}`,
  }));
  return record;
}

function collectiveParserOwner(variant) {
  const helper =
    variant === "unsafe"
      ? "return finite(input.value) || true;"
      : 'return finite(input.value) && typeof input.value === "number";';
  const third =
    variant === "third-caller"
      ? "export function third(input: unknown): boolean { return isRecord(input); }\n"
      : "";
  const source = `// Multibyte coordinate control: é\n
export type ParseResult = { ok: true; value: number } | { ok: false; errors: readonly string[] };
function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}
function fields(input: Record<string, unknown>): input is Record<string, unknown> & { value: number } {
  ${helper}
}
function finite(/* é */ input: unknown): boolean { return typeof input === "number" && Number.isFinite(input); }
export function first(input: unknown): ParseResult {
  if (!isRecord(input) || !fields(input)) return { ok: false, errors: ["invalid"] };
  return { ok: true, value: input.value };
}
export function second(input: unknown): ParseResult {
  if (!isRecord(input) || !fields(input)) return { ok: false, errors: ["invalid"] };
  return { ok: true, value: input.value };
}
${third}`;
  return collectiveParserVariant(source, variant);
}

function collectiveParserVariant(source, variant) {
  const variants = {
    cardinality: collectiveCardinalityOwner(source),
    "public-alias": source,
    "public-const-alias": source
      .replace(
        "export function first(input: unknown): ParseResult {",
        "export const first = (input: unknown): ParseResult => {",
      )
      .replace("\n}\nexport function second", "\n};\nexport function second"),
    domain:
      source +
      '\nexport function domain(input: Record<string, unknown>): boolean { return typeof input.value === "number"; }\n',
    "second-parameter": source
      .replace(
        "fields(input: Record<string, unknown>)",
        "fields(input: Record<string, unknown>, known: unknown)",
      )
      .replaceAll("fields(input)", "fields(input, 42)"),
    narrowed:
      source.replaceAll(
        "if (!isRecord(input)",
        'if (typeof input === "number") primitive(input); if (!isRecord(input)',
      ) + '\nfunction primitive(input: unknown): boolean { return typeof input === "number"; }\n',
    counterfeit: "type Record<K extends string, V> = { [P in K]: V };\n" + source,
    "alias-member":
      "type Raw = Record<string, unknown>;\n" +
      source.replace("fields(input: Record<string, unknown>)", "fields(input: Raw)"),
    "export-helper": source.replace("function isRecord", "export function isRecord"),
    "reexport-helper": source + "\nexport { isRecord };\n",
    "typed-caller":
      source + "\nexport function third(input: number): boolean { return isRecord(input); }\n",
    callback: source + "\nconst callbacks = [isRecord];\n",
    "return-escape": source + "\nexport function escaped(): typeof isRecord { return isRecord; }\n",
    "mutable-alias": source + "\nlet check = isRecord;\n",
    deferred: source + "\nconst delayed = (): boolean => isRecord({});\n",
  };
  return variants[variant] ?? collectiveParserMutation(source, variant);
}

function collectiveCardinalityOwner(source) {
  const helpers = [];
  for (const name of ["first", "second"]) {
    const checks = [];
    for (let index = 0; index < 32; index += 1) {
      const helper = `${name}Gate${String(index)}`;
      checks.push(`${helper}(input)`);
      helpers.push(`function ${helper}(input: unknown): boolean { return downstream(input); }`);
    }
    source = source.replace(
      `export function ${name}(input: unknown): ParseResult {`,
      `export function ${name}(input: unknown): ParseResult {
` + `  if (!(${checks.join(" && ")})) return { ok: false, errors: ["invalid"] };`,
    );
  }
  return (
    source +
    "\n" +
    helpers.join("\n") +
    '\nfunction downstream(input: unknown): boolean { return typeof input === "object"; }\n'
  );
}

function collectiveParserMutation(source, variant) {
  const variants = {
    "helper-write": source.replace(
      'return typeof input === "object"',
      'input = {}; return typeof input === "object"',
    ),
    "root-write": source.replace(
      "export function first(input: unknown): ParseResult {",
      "export function first(input: unknown): ParseResult { input = { value: 1 };",
    ),
    cycle:
      source.replace(
        'return typeof input === "object"',
        'return cycle(input) && typeof input === "object"',
      ) + "\nfunction cycle(input: unknown): boolean { return isRecord(input); }\n",
  };
  return variants[variant] ?? source;
}

function collectiveParserProof(variant) {
  const hasAlias = ["public-alias", "public-const-alias"].includes(variant);
  const alias = hasAlias ? 'import { parse as firstAlias } from "alpha";\n' : "";
  const proof = `import { first, second, type ParseResult } from "alpha/runtime";
${alias}
export function publicfirst(input: unknown): ParseResult { const result = first(input); return result; }
export function publicsecond(input: unknown): ParseResult { const result = second(input); return result; }
`;
  return hasAlias
    ? proof +
        "export function publicfirstAlias(input: unknown): ParseResult { const result = firstAlias(input); return result; }\n"
    : proof;
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

// One actual native-emitted owner shared by typed-origin resolver/evaluator controls.
// Existing raw fixture defaults and their assembly path remain unchanged.
export function createTypedRecheckFixture(variant = "direct") {
  return assembleResponsibilityFixture((own) => {
    const config = JSON.parse(readFileSync(join(own.root, "packages/alpha/tsconfig.json")));
    config.exclude = ["**/*.test.ts"];
    own.put("packages/alpha/tsconfig.json", config);
    own.put("packages/alpha/src/owner.ts", typedRecheckOwner(variant));
    if (variant === "foreign")
      own.put(
        "packages/alpha/src/foreign.ts",
        'import type { State } from "./owner.js"; export function foreign(value: unknown): value is State { return value === "ready" || value === "done"; }\n',
      );
    own.put("packages/alpha/src/index.ts", 'export * from "./owner.js";\n');
    own.put(
      "src/consumer.ts",
      'import { transition } from "alpha/runtime"; export const value = transition("ready", "done");\n',
    );
    own.put("packages/alpha/src/proof.test.ts", typedRecheckProof(variant));
    const records = [
      ["transition", 0],
      ["transition", 1],
      ["next", 0],
      ["eligible", 0],
    ].map(([name, index]) => typedRecheckRecord(name, index));
    const policy = responsibilityPolicy(records);
    for (const record of records) activateResponsibilityFixtureRules(policy, record);
    own.put("scripts/code-quality-policy.json", policy);
    Object.assign(own, { records, policy });
  });
}

function typedRecheckRecord(name, index) {
  const path = "packages/alpha/src/proof.test.ts";
  const selector = { consumerPath: path, specifier: "alpha/runtime", exportName: name };
  return {
    id: `typed-${name}-${index}`,
    owner: "alpha",
    kind: "typed-parameter-recheck",
    rules: ["anti-slop/no-known-value-widening"],
    input: { ...selector, parameterIndex: index },
    transform: selector,
    output: selector,
    consumer: {
      ...selector,
      exportName: `public${name}`,
      kind: "public-api-proof",
      owner: "alpha",
    },
    proofs: [path],
    proofAssertions: [{ path, testName: "typed public finite admission" }],
  };
}

function typedRecheckOwner(variant) {
  const source = `export type State = "ready" | "done";
export function isState(value: unknown): value is State { return value === "ready" || value === "done"; }
const TABLE: Readonly<Record<State, readonly State[]>> = { ready: ["done"], done: [] };
const ELIGIBLE: readonly State[] = ["done"];
export function transition(from: State, to: State): boolean {
  if (!isState(from) || !isState(to)) return false;
  return TABLE[from].includes(to);
}
export function next(from: State): readonly State[] {
  if (!isState(from)) return [];
  return TABLE[from];
}
export function eligible(value: State): boolean {
  return isState(value) && ELIGIBLE.includes(value);
}
`;
  return typedRecheckOwnerMutation(source, variant);
}

function typedRecheckOwnerMutation(source, variant) {
  const start = "if (!isState(from) || !isState(to)) return false;";
  const replacements = {
    removed: "if (!isState(to)) return false;",
    "removed-to": "if (!isState(from)) return false;",
    inert: "isState(from); if (!isState(to)) return false;",
    alias: "const alias = from; if (!isState(alias) || !isState(to)) return false;",
    written: 'from = "ready"; ' + start,
    deferred:
      "const later = (): boolean => isState(from); if (!later() || !isState(to)) return false;",
    duplicate: "if (!isState(from) || !isState(from) || !isState(to)) return false;",

    asserted: "if (!isState(from as State) || !isState(to)) return false;",
    rebound: "if (!check(from) || !isState(to)) return false;",
  };
  if (replacements[variant]) source = source.replace(start, replacements[variant]);
  if (variant === "forwarding")
    source =
      source.replace("return TABLE[from].includes(to);", "return consume(from);") +
      'function consume(value: unknown): boolean { return value === "ready"; }\n';
  if (variant === "captured-tail")
    source = source.replace(
      "return TABLE[from].includes(to);",
      "return (() => TABLE[from].includes(to))();",
    );
  if (variant === "asserted-tail")
    source = source.replace(
      "return TABLE[from].includes(to);",
      "return TABLE[from as State].includes(to);",
    );
  if (variant === "mutated-tail")
    source = source.replace(
      "return TABLE[from].includes(to);",
      'return TABLE[(from = "ready")].includes(to);',
    );
  if (variant === "rebound") source += "const check = isState;\n";
  return typedRecheckPredicateMutation(source, variant);
}

function typedRecheckPredicateMutation(source, variant) {
  if (variant === "foreign-domain")
    source =
      source.replace("value is State", "value is OtherState") + "\ntype OtherState = State;\n";
  if (variant === "lying")
    source = source.replace('return value === "ready" || value === "done";', "return true;");
  if (variant === "foreign")
    source =
      'import { foreign } from "./foreign.js";\n' +
      source.replaceAll("!isState(from)", "!foreign(from)");
  if (variant === "wrong-index")
    source =
      source.replace(
        "if (!isState(from) || !isState(to))",
        'if (!second("ready", from) || !isState(to))',
      ) +
      "\nfunction second(other: State, value: unknown): value is State { return other === value; }\n";
  if (variant === "overloaded")
    source = source.replace(
      "export function isState(value: unknown): value is State {",
      "export function isState(value: unknown): value is State;\nexport function isState(value: unknown): value is State {",
    );
  if (variant === "generic")
    source = source.replace("isState(value: unknown)", "isState<T>(value: unknown)");
  return source;
}

function typedRecheckProof(variant) {
  const source = `import { transition, next, eligible, type State } from "alpha/runtime";
export function publictransition(from: State, to: State): boolean { const result = transition(from, to); return result; }
export function publicnext(from: State): readonly State[] { const result = next(from); return result; }
export function publiceligible(value: State): boolean { const result = eligible(value); return result; }
`;
  const replacements = {
    "proof-swapped": source.replace("transition(from, to)", "transition(to, from)"),
    "proof-constant": source.replace("transition(from, to)", 'transition("ready", to)'),
    "proof-result": source.replace("return result;", "return true;"),
    "proof-wide-result": source.replace("to: State): boolean", "to: State): unknown"),
    "proof-clone": source.replace(
      "const result = next(from); return result;",
      "const result = next(from); return [...result];",
    ),
    "proof-alias": source.replace(
      "const result = transition",
      "const original = from; const result = transition",
    ),
    "proof-wide": source
      .replace("publictransition(from: State", "publictransition(from: State | undefined")
      .replace("transition(from, to)", 'transition(from ?? "ready", to)'),
    "proof-counterfeit":
      source.replace("type State }", "type State as ImportedState }") +
      '\ntype State = "ready" | "done";\n',
  };
  return replacements[variant] ?? source;
}

// Preserve the actual producer and its constants in the native-emitted fixture; do not copy its
// canonicalization or budget formulas into test expectations.
export function createCanonicalDecoderFixture(variant = "direct") {
  return assembleResponsibilityFixture((own) => {
    const config = JSON.parse(readFileSync(join(own.root, "packages/alpha/tsconfig.json")));
    config.exclude = ["**/*.test.ts"];
    config.compilerOptions.lib.push("DOM");
    own.put("packages/alpha/tsconfig.json", config);
    const original = readFileSync(
      new URL("../../../packages/keiko-contracts/src/support-report-json.ts", import.meta.url),
      "utf8",
    );
    own.put("packages/alpha/src/owner.ts", canonicalDecoderVariant(original, variant));
    own.put("packages/alpha/src/support-report.ts", canonicalDecoderConstants());
    own.put("packages/alpha/src/index.ts", 'export * from "./owner.js";\n');
    own.put(
      "src/consumer.ts",
      'import { parseCanonicalSupportJson } from "alpha/runtime"; export const value = parseCanonicalSupportJson("null", 4);\n',
    );
    own.put("packages/alpha/src/proof.test.ts", canonicalDecoderProof(variant));
    const record = canonicalDecoderRecord();
    const policy = responsibilityPolicy([record]);
    activateResponsibilityFixtureRules(policy, record);
    own.put("scripts/code-quality-policy.json", policy);
    Object.assign(own, { records: [record], policy });
  });
}

function canonicalDecoderConstants() {
  const path = new URL("../../../packages/keiko-contracts/src/support-report.ts", import.meta.url);
  const text = readFileSync(path, "utf8");
  const source = ts.createSourceFile(path.pathname, text, ts.ScriptTarget.Latest, true);
  const names = new Set([
    "MAX_SUPPORT_REPORT_BYTES",
    "MAX_SUPPORT_REPORT_CONTAINERS",
    "MAX_SUPPORT_REPORT_DEPTH",
    "MAX_SUPPORT_REPORT_OBJECT_KEYS",
    "MAX_SUPPORT_REPORT_RECORDS",
    "MAX_SUPPORT_REPORT_VALUES",
    "SUPPORT_REPORT_FAILURES",
    "SupportReportFailure",
  ]);
  const selected = source.statements.filter((statement) => {
    if (ts.isTypeAliasDeclaration(statement)) return names.has(statement.name.text);
    return (
      ts.isVariableStatement(statement) &&
      statement.declarationList.declarations.some(
        (declaration) => ts.isIdentifier(declaration.name) && names.has(declaration.name.text),
      )
    );
  });
  if (selected.length !== names.size) throw new TypeError("canonical-decoder-fixture-constants");
  return selected.map((statement) => statement.getText(source)).join("\n");
}

function canonicalDecoderReplacement(variant) {
  return {
    "decoder-generic": [
      "function parseCanonicalSupportJson(",
      "function parseCanonicalSupportJson<T>(",
    ],
    "decoder-default": ["text: string, maxBytes: number", "text: string, maxBytes: number = 64"],
    "canonicalizer-generic": [
      "function canonicalSupportJson(",
      "function canonicalSupportJson<T>(",
    ],
    "coerced-parse": ["JSON.parse(text)", "JSON.parse(String(text))"],
    "removed-preflight": ["  checkJsonShape(text);\n", ""],
    "removed-byte-budget": [
      "text.length > maxBytes || new TextEncoder().encode(text).byteLength > maxBytes",
      "text.length > maxBytes",
    ],
    "bypassed-canonicality": [
      '  if (canonicalSupportJson(value) !== text) throw new SupportReportError("corrupt-report");',
      "",
    ],
    "lying-decoder": ["    value = JSON.parse(text);", "    value = null;"],
  }[variant];
}

function canonicalDecoderPreflightStatement(statement) {
  return (
    ts.isExpressionStatement(statement) &&
    ts.isCallExpression(statement.expression) &&
    ts.isIdentifier(statement.expression.expression) &&
    statement.expression.expression.text === "checkJsonShape"
  );
}

function canonicalDecoderControlNodes(source) {
  const parsed = ts.createSourceFile("owner.ts", source, ts.ScriptTarget.Latest, true);
  const declarations = parsed.statements.filter(
    (statement) =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === "parseCanonicalSupportJson",
  );
  if (declarations.length !== 1 || !declarations[0].body)
    throw new TypeError("canonical-decoder-fixture-declaration");
  const decoder = declarations[0];
  const statements = decoder.body.statements;
  const returned = statements.at(-1);
  const preflights = statements.filter(canonicalDecoderPreflightStatement);
  if (statements.length !== 6 || !ts.isReturnStatement(returned) || !returned.expression)
    throw new TypeError("canonical-decoder-fixture-return");
  if (preflights.length !== 1) throw new TypeError("canonical-decoder-fixture-preflight");
  return { parsed, decoder, statements, returned, preflight: preflights[0] };
}

function canonicalDecoderControlText(before, source, variant) {
  const start = before.decoder.getStart(before.parsed);
  const text = source.slice(start, before.decoder.end);
  const relative = (node) => node.getStart(before.parsed) - start;
  if (variant === "reordered-preflight") {
    return (
      text.slice(0, relative(before.preflight)) +
      text.slice(before.preflight.end - start, relative(before.returned)) +
      before.preflight.getText(before.parsed) +
      "\n  " +
      text.slice(relative(before.returned))
    );
  }
  const expression = before.returned.expression;
  const raw = expression.getText(before.parsed);
  const replacement = variant === "captured-return" ? `(() => ${raw})()` : `{ ${raw} }`;
  return text.slice(0, relative(expression)) + replacement + text.slice(expression.end - start);
}

function canonicalDecoderControlShape(before, after, variant) {
  const original = before.statements.map((statement) => statement.getText(before.parsed));
  const changed = after.statements.map((statement) => statement.getText(after.parsed));
  if (variant === "reordered-preflight") {
    const expected = [original[0], original[2], original[3], original[4], original[1], original[5]];
    return JSON.stringify(changed) === JSON.stringify(expected);
  }
  if (JSON.stringify(changed.slice(0, -1)) !== JSON.stringify(original.slice(0, -1))) return false;
  const raw = before.returned.expression.getText(before.parsed);
  const expression = after.returned.expression;
  const expected = variant === "captured-return" ? `(() => ${raw})()` : `{ ${raw} }`;
  const expectedKind =
    variant === "captured-return"
      ? ts.SyntaxKind.CallExpression
      : ts.SyntaxKind.ObjectLiteralExpression;
  return expression?.kind === expectedKind && expression.getText(after.parsed) === expected;
}

function canonicalDecoderControlVariant(source, variant) {
  const before = canonicalDecoderControlNodes(source);
  if (!ts.isIdentifier(before.returned.expression) || before.statements[1] !== before.preflight)
    throw new TypeError("canonical-decoder-fixture-original-shape");
  const start = before.decoder.getStart(before.parsed);
  const replacement = canonicalDecoderControlText(before, source, variant);
  const prefix = source.slice(0, start);
  const suffix = source.slice(before.decoder.end);
  const changed = prefix + replacement + suffix;
  const after = canonicalDecoderControlNodes(changed);
  if (
    changed === source ||
    changed.slice(0, after.decoder.getStart(after.parsed)) !== prefix ||
    changed.slice(after.decoder.end) !== suffix ||
    !canonicalDecoderControlShape(before, after, variant)
  )
    throw new TypeError("canonical-decoder-fixture-mutation-target");
  return changed;
}

function canonicalDecoderBudgetVariant(source, variant) {
  const parsed = ts.createSourceFile("owner.ts", source, ts.ScriptTarget.Latest, true);
  const name = variant === "budget-outer-return" ? "parseCanonicalSupportJson" : "budgetExceeded";
  const declarations = parsed.statements.filter(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === name,
  );
  if (declarations.length !== 1 || !declarations[0].body)
    throw new TypeError("canonical-decoder-budget-fixture-owner");
  const owner = declarations[0];
  const original = owner.body.getText(parsed);
  const replacements = {
    "budget-helper-throws": '{ throw new SupportReportError("report-budget-exceeded"); }',
    "budget-helper-wrong-reason": '{ return new SupportReportError("corrupt-report"); }',
    "budget-helper-extra-statement":
      '{ void 0; return new SupportReportError("report-budget-exceeded"); }',
    "budget-outer-return": original.replace("throw budgetExceeded();", "return budgetExceeded();"),
  };
  const replacement = replacements[variant];
  if (!replacement || replacement === original)
    throw new TypeError("canonical-decoder-budget-fixture-unchanged");
  return canonicalDecoderBudgetTarget(source, parsed, owner, replacement);
}

function canonicalDecoderBudgetTarget(source, parsed, owner, replacement) {
  const name = owner.name.text;
  const start = owner.body.getStart(parsed);
  const prefix = source.slice(0, start);
  const suffix = source.slice(owner.body.end);
  const changed = prefix + replacement + suffix;
  const after = ts.createSourceFile("owner.ts", changed, ts.ScriptTarget.Latest, true);
  const updated = after.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === name,
  );
  if (
    !updated?.body ||
    updated.body.getText(after) !== replacement ||
    changed.slice(0, updated.body.getStart(after)) !== prefix ||
    changed.slice(updated.body.end) !== suffix
  )
    throw new TypeError("canonical-decoder-budget-fixture-target");
  return changed;
}

function canonicalDecoderVariant(source, variant) {
  if (variant.startsWith("budget-")) return canonicalDecoderBudgetVariant(source, variant);
  if (["captured-return", "cloned-return", "reordered-preflight"].includes(variant))
    return canonicalDecoderControlVariant(source, variant);
  if (variant === "lying-canonicalizer") {
    const parsed = ts.createSourceFile("owner.ts", source, ts.ScriptTarget.Latest, true);
    const canonicalizer = parsed.statements.find(
      (statement) =>
        ts.isFunctionDeclaration(statement) && statement.name?.text === "canonicalSupportJson",
    );
    if (!canonicalizer?.body) throw new TypeError("canonical-decoder-fixture-canonicalizer");
    return (
      source.slice(0, canonicalizer.body.getStart(parsed)) +
      '{ return "null"; }' +
      source.slice(canonicalizer.body.end)
    );
  }

  if (variant === "shadowed-json")
    source =
      "const JSON = { parse: (text: string): unknown => globalThis.JSON.parse(text), stringify: globalThis.JSON.stringify };\n" +
      source;
  if (variant === "shadowed-encoder")
    source =
      "class TextEncoder { encode(text: string): Uint8Array { return new globalThis.TextEncoder().encode(text); } }\n" +
      source;
  const replacement = canonicalDecoderReplacement(variant);
  if (replacement) source = source.replace(...replacement);
  return source;
}

function canonicalDecoderRecord() {
  const path = "packages/alpha/src/proof.test.ts";
  const decoder = {
    consumerPath: path,
    specifier: "alpha/runtime",
    exportName: "parseCanonicalSupportJson",
  };
  return {
    id: "canonical-json-decoder",
    owner: "alpha",
    kind: "raw-canonical-json-decoder",
    rules: ["anti-slop/no-unknown-returns"],
    input: { ...decoder, parameterIndex: 0 },
    transform: decoder,
    output: { ...decoder, exportName: "canonicalSupportJson" },
    consumer: {
      ...decoder,
      kind: "public-api-proof",
      owner: "alpha",
      exportName: "publicCanonicalDecoderWitness",
    },
    proofs: [path],
    proofAssertions: [{ path, testName: "actual public canonical decoder admission" }],
  };
}

function canonicalDecoderProof(variant) {
  const rawCall =
    variant === "wrong-argument"
      ? 'publicDecode("null", maxBytes)'
      : "publicDecode(text, maxBytes)";
  const resultCall = variant === "raw-alias" ? "publicCanonical({ raw })" : "publicCanonical(raw)";
  const result = variant === "wrong-result" ? '"null"' : "result";
  const declaration = variant === "mutable-raw" ? "let" : "const";
  return `import { parseCanonicalSupportJson as publicDecode, canonicalSupportJson as publicCanonical } from "alpha/runtime";
export function publicCanonicalDecoderWitness(text: string, maxBytes: number): string {
  ${declaration} raw = ${rawCall};
  const result = ${resultCall};
  return ${result};
}
`;
}

export function createContextDiagnosticFixture(variant = "direct") {
  return assembleResponsibilityFixture((own) => {
    configureDiagnosticFixture(own);
    if (variant === "foreign-alias") configureForeignContextResult(own);
    own.put("packages/alpha/src/owner.ts", contextDiagnosticOwner(variant));
    own.put("packages/alpha/src/proof.test.ts", contextDiagnosticProof(variant));
    own.record.proofAssertions = ["healthy", "malformed"].map((kind) => ({
      path: own.record.consumer.consumerPath,
      testName: `context diagnostics ${kind}`,
    }));
    own.put("scripts/code-quality-policy.json", own.policy);
  });
}

function contextDiagnosticType(variant) {
  const types = {
    direct: "{ readonly ok: true } | { readonly ok: false; readonly reasons: readonly string[] }",
    erased: "any",
    "unknown-reasons":
      "{ readonly ok: true } | { readonly ok: false; readonly reasons: readonly unknown[] }",
    "mutable-array": "{ readonly ok: true } | { readonly ok: false; readonly reasons: string[] }",
    "mutable-property":
      "{ readonly ok: true } | { readonly ok: false; reasons: readonly string[] }",
    "mutable-ok": "{ ok: true } | { ok: false; readonly reasons: readonly string[] }",
    "nonstring-reasons":
      "{ readonly ok: true } | { readonly ok: false; readonly reasons: readonly number[] }",
    "optional-reasons":
      "{ readonly ok: true } | { readonly ok: false; readonly reasons?: readonly string[] }",
    "optional-ok":
      "{ readonly ok?: true } | { readonly ok: false; readonly reasons: readonly string[] }",
    index:
      "{ readonly ok: true; readonly [key: string]: unknown } | { readonly ok: false; readonly reasons: readonly string[]; readonly [key: string]: unknown }",
    "success-value":
      "{ readonly ok: true; readonly value: number } | { readonly ok: false; readonly reasons: readonly string[] }",
    unrelated:
      "{ readonly valid: true } | { readonly valid: false; readonly reasons: readonly string[] }",
  };
  return types[variant] ?? types.direct;
}

function contextDiagnosticOwner(variant) {
  const type = contextDiagnosticType(variant);
  const declaration =
    variant === "foreign-alias"
      ? 'import type { ContextValidationResult } from "beta";'
      : `export type ContextValidationResult = ${type};`;
  const discriminant = variant === "unrelated" ? "valid" : "ok";
  const extra = variant === "success-value" ? ", value: 1" : "";
  const reason = variant === "nonstring-reasons" ? "1" : '"invalid"';
  const annotation = variant === "unaliased" ? type : "ContextValidationResult";
  return `${declaration}
export function validate(input: unknown): ${annotation} {
  ${variant === "unsafe-body" ? "return { ok: true };" : `return typeof input === "number" ? { ${discriminant}: true${extra} } : { ${discriminant}: false, reasons: [${reason}] };`}
}
${variant === "wrong-producer" ? "export function other(input: unknown): ContextValidationResult { return validate(input); }" : ""}
`;
}

function contextDiagnosticProof(variant) {
  const prefix = 'import { parse as check } from "alpha";\n';
  const normal =
    "const diagnostics = check(input); return diagnostics.ok ? 0 : diagnostics.reasons.length;";
  const bodies = {
    constant: "const diagnostics = check(input); return 0;",
    polarity:
      "const diagnostics = check(input); return diagnostics.ok ? 1 : diagnostics.reasons.length;",
    fabricated: "const diagnostics = check(input); return diagnostics.ok ? 0 : 1;",
    negated:
      "const diagnostics = check(input); return !diagnostics.ok ? diagnostics.reasons.length : 0;",
    input: "const diagnostics = check(1); return diagnostics.ok ? 0 : diagnostics.reasons.length;",
    local: "const diagnostics = check(input); return other.ok ? 0 : other.reasons.length;",
    "optional-reasons":
      "const diagnostics = check(input); return diagnostics.ok ? 0 : (diagnostics.reasons?.length ?? 0);",
    "optional-ok":
      "const diagnostics = check(input); return diagnostics.ok === false ? diagnostics.reasons.length : 0;",
    unrelated:
      "const diagnostics = check(input); return diagnostics.valid ? 0 : diagnostics.reasons.length;",
    "wrong-producer":
      "const diagnostics = otherCheck(input); return diagnostics.ok ? 0 : diagnostics.reasons.length;",
    annotated:
      "const diagnostics: ReturnType<typeof check> = check(input); return diagnostics.ok ? 0 : diagnostics.reasons.length;",
  };
  const extra =
    variant === "local"
      ? 'const other = { ok: false, reasons: ["invalid"] };\n'
      : variant === "wrong-producer"
        ? 'import { other as otherCheck } from "alpha/runtime";\n'
        : "";
  const returnType = variant === "numeric-erasure" ? "any" : "number";
  return (
    prefix +
    extra +
    `export function countDiagnostics(input: unknown): ${returnType} { ${bodies[variant] ?? normal} }\n`
  );
}

function configureForeignContextResult(own) {
  const config = JSON.parse(readFileSync(join(own.root, "packages/alpha/tsconfig.json")));
  own.put("packages/beta/tsconfig.json", config);
  own.put("packages/beta/package.json", {
    name: "beta",
    version: "0.0.0",
    type: "module",
    exports: { ".": { types: "./dist/owner.d.ts", import: "./dist/owner.js" } },
  });
  own.put(
    "packages/beta/src/owner.ts",
    `export type ContextValidationResult = ${contextDiagnosticType("direct")};\n`,
  );
  symlinkSync(join(own.root, "packages/beta"), join(own.root, "node_modules/beta"));
  emitSymbolFixture(own.root, "packages/beta");
}

export function createCollectiveContextDiagnosticFixture(variant = "direct") {
  const own = createCollectiveParserFixture(variant === "cardinality" ? variant : "direct", [
    "anti-slop/no-runtime-typeof",
  ]);
  const path = "packages/alpha/src/owner.ts";
  let source = readFileSync(join(own.root, path), "utf8");
  source = source
    .replace(
      "{ ok: true; value: number } | { ok: false; errors: readonly string[] }",
      contextDiagnosticType("direct"),
    )
    .replaceAll('errors: ["invalid"]', 'reasons: ["invalid"]')
    .replaceAll("{ ok: true, value: input.value }", "{ ok: true }");
  source =
    source.replaceAll(
      "if (!isRecord(input)",
      'if (diagnosticIssues(input).length !== 0) return { ok: false, reasons: ["invalid"] }; if (!isRecord(input)',
    ) +
    '\nfunction diagnosticIssues(input: unknown): string[] { return typeof input === "object" && input !== null ? [] : ["invalid"]; }\n';
  own.put(path, source);
  own.put(
    "packages/alpha/src/proof.test.ts",
    `import { first, second } from "alpha/runtime";
export function publicfirst(input: unknown): number { const result = first(input); return result.ok ? 0 : result.reasons.length; }
export function publicsecond(input: unknown): number { const result = second(input); return result.ok ? 0 : result.reasons.length; }
`,
  );
  for (const record of own.records) record.kind = "diagnostic-checker";
  own.put("scripts/code-quality-policy.json", own.policy);
  emitSymbolFixture(own.root);
  return own;
}

export function createObservationOptionsFixture(options = {}) {
  const own = createResponsibilityFixture();
  own.put(
    "packages/alpha/src/owner.ts",
    `
function runtimeProperty(value: object, key: PropertyKey): unknown {
  const property: unknown = Reflect.get(value, key);
  return property;
}
function exactKeys(left: object, right: object): boolean {
  const leftKeys = Reflect.ownKeys(left);
  const rightKeys = new Set(Reflect.ownKeys(right));
  return leftKeys.length === rightKeys.size && leftKeys.every((key) => rightKeys.has(key));
}
export interface Observation { readonly admitted: boolean; }
export function validate(event: object): Observation {
  return { admitted: runtimeProperty(event, "value") === 1 && exactKeys(event, {value: 1}) };
}
`,
  );
  own.put(
    "src/consumer.ts",
    'import { validate } from "alpha/runtime"; export const result = validate({value: 1});',
  );
  const path = "packages/alpha/src/proof.test.ts";
  own.put(
    path,
    `import { validate, type Observation } from "alpha/runtime";
export function observe(event: object): Observation { const result = validate(event); return result; }
`,
  );
  own.record = observationFixtureRecord(path, options);
  own.policy = responsibilityPolicy([own.record]);
  own.put("scripts/code-quality-policy.json", own.policy);
  emitSymbolFixture(own.root);
  return own;
}

function observationFixtureRecord(path, options) {
  const selector = { consumerPath: path, specifier: "alpha/runtime", exportName: "validate" };
  return {
    ...responsibilityRecord(),
    kind: "raw-property-observation",
    input: { ...selector, parameterIndex: 0 },
    transform: selector,
    output: selector,
    consumer: { kind: "public-api-proof", owner: "alpha", ...selector, exportName: "observe" },
    rules: [
      "anti-slop/no-object-parameters",
      "anti-slop/no-unknown-returns",
      "anti-slop/no-reflect-get",
    ],
    proofs: [path],
    proofAssertions: [{ path, testName: "observation preservation" }],
    ...options,
  };
}
