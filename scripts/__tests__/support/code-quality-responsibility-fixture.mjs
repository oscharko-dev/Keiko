import { readFileSync, symlinkSync } from "node:fs";
import { pathToFileURL, URL } from "node:url";
import { join } from "node:path";
import { createSymbolFixture, emitSymbolFixture } from "./code-quality-symbol-fixture.mjs";

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
  const own = createSymbolFixture();
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
  emitSymbolFixture(own.root);
  return own;
}

export async function executeResponsibilityFixture(own) {
  return import(pathToFileURL(join(own.root, "packages/alpha/dist/owner.js")).href);
}

export function createEnforcementFixture(kind = "validator", variant = "valid") {
  const own = createResponsibilityFixture();
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
  for (const rule of policy.rules) {
    if (record.rules.includes(rule.id)) rule.activeScopes = ["production"];
  }
  own.put("scripts/code-quality-policy.json", policy);
  emitSymbolFixture(own.root);
  return { ...own, record, policy };
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
  const own = createEnforcementFixture();
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
  emitSymbolFixture(own.root, "packages/beta");
  return own;
}

export function replaceConsumerCallFixture(own, variant) {
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
  emitSymbolFixture(own.root, "packages/beta");
}
