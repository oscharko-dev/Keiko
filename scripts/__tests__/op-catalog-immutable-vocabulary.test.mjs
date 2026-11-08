import { describe, expect, it } from "vitest";
import { generateTypedActivityLogRegistry } from "../generate-op-catalog.mjs";
import { withTypedRegistryFixture } from "./support/typed-registry-fixture.mjs";

const FREEZE_SOURCE = "export function deepFreeze<T>(value: T): T { return value; }\n";
const EXTRA_FILES = {
  "packages/keiko-contracts/src/deep-freeze.ts": FREEZE_SOURCE,
  "packages/keiko-contracts/src/fixture-families.ts": [
    'import { deepFreeze } from "./deep-freeze.js";',
    'export const families = deepFreeze({ issues: ["jira.issue", "jira.search"] } as const);',
    'export const mutations = Object.freeze(["jira.edit"] as const);',
  ].join("\n"),
  "packages/fixture-foreign/src/deep-freeze.ts": FREEZE_SOURCE,
};
function source(setup, values) {
  return [
    'import { defineActivityLogOperation, activityLogEvent } from "../../keiko-contracts/src/observability.js";',
    ...setup,
    "const operation = defineActivityLogOperation({",
    '  contractKind: "activity-log-operation" as const, schemaVersion: 1 as const,',
    '  op: "fixture.immutable-vocabulary", category: "process", owner: "fixture-immutable",',
    '  emitter: "fixture", causal: "correlation", lifecycle: "state", analyzerProjection: "timeline",',
    `  fields: { operation: { type: "string", dataClass: "closed-enum", required: true, values: ${values} } },`,
    '  failureClasses: ["fixture-failure"], proofIds: ["fixture-proof"], releaseImpact: "patch",',
    "});",
    'activityLogEvent(operation, {}, { operation: "jira.issue" });',
  ].join("\n");
}
function readRegistry(setup, values, check) {
  withTypedRegistryFixture("fixture-immutable", source(setup, values), (root) => {
    check(generateTypedActivityLogRegistry(root, []));
  }, EXTRA_FILES);
}

describe("immutable canonical Activity Log vocabularies", () => {
  it("reads imported own literal properties and trusted freeze wrappers without executing them", () => {
    readRegistry([
      'import { families, mutations } from "../../keiko-contracts/src/fixture-families.js";',
    ], "[...families.issues, ...mutations]", (registry) => {
      expect(registry.operations).toHaveLength(1);
      expect(registry.operations[0].fields.operation.values).toEqual(["jira.issue", "jira.search", "jira.edit"]);
      expect(registry.violations.filter(({ code }) => /registration|emission/u.test(code))).toEqual([]);
    });
  });

  it("accepts the imported canonical function under a local import name and a constant table alias", () => {
    readRegistry([
      'import { deepFreeze as canonicalFreeze } from "../../keiko-contracts/src/deep-freeze.js";',
      'const frozen = canonicalFreeze({ nested: { issues: ["jira.issue"] } } as const);',
      "const table = frozen;",
    ], "table.nested.issues", (registry) => {
      expect(registry.operations).toHaveLength(1);
      expect(registry.operations[0].fields.operation.values).toEqual(["jira.issue"]);
    });
  });

  it.each([
    { name: "shadowed Object", setup: ['const Object = { freeze: <T>(value: T): T => value };'], values: 'Object.freeze(["jira.issue"])' },
    { name: "local deepFreeze", setup: [FREEZE_SOURCE], values: 'deepFreeze(["jira.issue"])' },
    { name: "foreign deepFreeze import", setup: ['import { deepFreeze } from "../../fixture-foreign/src/deep-freeze.js";'], values: 'deepFreeze(["jira.issue"])' },
    { name: "typed wrapper masquerading as deepFreeze", setup: [
      'import { deepFreeze } from "../../keiko-contracts/src/deep-freeze.js";',
      "const disguise: typeof deepFreeze = (value) => value;",
    ], values: 'disguise(["jira.issue"])' },
    { name: "prototype lookup", setup: ['const table = { issues: ["jira.issue"] };'], values: "table.constructor" },
    { name: "own prototype key", setup: ['const table = { prototype: ["jira.issue"] };'], values: "table.prototype" },
    { name: "getter", setup: ['const table = { get issues() { return ["jira.issue"]; } };'], values: "table.issues" },
    { name: "computed member", setup: ['const table = { issues: ["jira.issue"] };'], values: 'table["issues"]' },
    { name: "dynamic member", setup: ['const table = { issues: ["jira.issue"] };', 'const member = "issues";'], values: "table[member]" },
    { name: "computed object key", setup: ['const table = { ["issues"]: ["jira.issue"] };'], values: "table.issues" },
    { name: "arbitrary call", setup: ['function values() { return ["jira.issue"]; }'], values: "values()" },
    { name: "frozen dynamic call", setup: ['function values() { return ["jira.issue"]; }'], values: "Object.freeze(values())" },
    { name: "optional lookup", setup: ['const table = { issues: ["jira.issue"] };'], values: "table?.issues" },
    { name: "missing own property", setup: ['const table = { issues: ["jira.issue"] };'], values: "table.missing" },
    { name: "local alias of global freeze", setup: ["const freeze = Object.freeze;"], values: 'freeze(["jira.issue"])' },
    { name: "mutable own property", setup: ['const table = { issues: ["jira.issue"] };', 'table.issues = ["jira.edit"];'], values: "table.issues" },
    { name: "shallow-frozen nested array", setup: ['const table = Object.freeze({ issues: ["jira.issue"] });', 'table.issues.push("jira.edit");'], values: "table.issues" },
    { name: "shallow-frozen array of arrays", setup: [], values: 'Object.freeze([["jira.issue"]])' },
    { name: "borrowed array changed before freeze", setup: ['const raw = ["jira.issue"];', 'raw.push("jira.edit");'], values: "Object.freeze(raw)" },
    { name: "borrowed table changed before deep freeze", setup: [
      'import { deepFreeze } from "../../keiko-contracts/src/deep-freeze.js";',
      'const raw = { issues: ["jira.issue"] }; raw.issues.push("jira.edit");',
      "const table = deepFreeze(raw);",
    ], values: "table.issues" },
    { name: "optional freeze call", setup: [], values: 'Object.freeze?.(["jira.issue"])' },
    { name: "namespace freeze call", setup: [
      'import * as canonical from "../../keiko-contracts/src/deep-freeze.js";',
    ], values: 'canonical.deepFreeze(["jira.issue"])' },
    { name: "constant cycle", setup: ["const first = second; const second = first;"], values: "first" },
  ])("refuses $name", ({ setup, values }) => {
    readRegistry(setup, values, (registry) => {
      expect(registry.operations).toEqual([]);
      expect(registry.violations).toContainEqual(expect.objectContaining({ code: "registration-not-literal" }));
    });
  });

  it("retains the 64-value bound even for a verified immutable source", () => {
    const values = Array.from({ length: 65 }, (_, index) => `"closed-${index}"`).join(",");
    readRegistry([], `Object.freeze([${values}] as const)`, (registry) => {
      expect(registry.operations).toEqual([]);
      expect(registry.violations).toContainEqual(expect.objectContaining({ code: "registration-invalid", detail: "fields.operation" }));
    });
  });

  it("refuses a shallow-frozen schema whose nested field changed before registration", () => {
    const declaration = source([
      'const fields = Object.freeze({ operation: { type: "string", dataClass: "closed-enum", required: true, values: ["jira.issue"] } });',
      'fields.operation.values = ["jira.edit"];',
    ], '["jira.issue"]').replace(
      '  fields: { operation: { type: "string", dataClass: "closed-enum", required: true, values: ["jira.issue"] } },',
      "  fields: fields,",
    );
    withTypedRegistryFixture("fixture-immutable", declaration, (root) => {
      const registry = generateTypedActivityLogRegistry(root, []);
      expect(registry.operations).toEqual([]);
      expect(registry.violations).toContainEqual(expect.objectContaining({ code: "registration-not-literal" }));
    });
  });

  it.each([
    { name: "getter beneath canonical freeze", value: '{ get issues() { return ["jira.issue"]; } }', path: "table.issues" },
    { name: "computed key beneath canonical freeze", value: '{ ["issues"]: ["jira.issue"] }', path: "table.issues" },
    { name: "missing own property beneath canonical freeze", value: '{ issues: ["jira.issue"] }', path: "table.missing" },
    { name: "inherited property beneath canonical freeze", value: '{ issues: ["jira.issue"] }', path: "table.constructor" },
    { name: "computed lookup beneath canonical freeze", value: '{ issues: ["jira.issue"] }', path: 'table["issues"]' },
  ])("refuses $name after examining the immutable root", ({ value, path }) => {
    readRegistry([
      'import { deepFreeze } from "../../keiko-contracts/src/deep-freeze.js";',
      `const table = deepFreeze(${value});`,
    ], path, (registry) => {
      expect(registry.operations).toEqual([]);
      expect(registry.violations).toContainEqual(expect.objectContaining({ code: "registration-not-literal" }));
    });
  });

  it("still refuses dynamic registration selection at the emission site", () => {
    const declaration = source([], '["jira.issue"]').replace(
      'activityLogEvent(operation, {}, { operation: "jira.issue" });',
      'const registrations = { operation }; activityLogEvent(registrations.operation, {}, { operation: "jira.issue" });',
    );
    withTypedRegistryFixture("fixture-immutable", declaration, (root) => {
      const registry = generateTypedActivityLogRegistry(root, []);
      expect(registry.violations).toContainEqual(expect.objectContaining({ code: "emission-unregistered" }));
    });
  });
});
