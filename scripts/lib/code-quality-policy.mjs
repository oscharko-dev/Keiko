export const UPSTREAM_COMMIT = "c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b";
export const RUNNER_VERSION = "1.78.0";
export const UPSTREAM_VERSION = "0.1.2";
const INITIAL_GUARDS = new Set([
  "anti-slop/no-reduce-accumulator-copy",
  "anti-slop/no-widen-then-assert",
  "anti-slop/no-reflect-apply",
]);
export const NON_COSMETIC_RULES = Object.freeze([
  "anti-slop/no-array-filter-map",
  "anti-slop/no-reduce-accumulator-copy",
  "anti-slop/no-chained-type-assertions",
  "anti-slop/no-conditional-empty-object-spread",
  "anti-slop/no-known-value-widening",
  "anti-slop/no-module-mocking",
  "anti-slop/no-object-parameters",
  "anti-slop/no-reflect-apply",
  "anti-slop/no-reflect-get",
  "anti-slop/no-runtime-typeof",
  "anti-slop/no-unknown-parameters",
  "anti-slop/no-unknown-returns",
  "anti-slop/no-unknown-type-aliases",
  "anti-slop/no-unsafe-dictionary-type",
  "anti-slop/no-widen-then-assert",
  "anti-slop/require-safety-comment-for-type-assertion",
  "anti-slop-effect/no-manual-effect-error-tag",
  "anti-slop-effect/no-manual-tag-comparison",
  "anti-slop-effect/no-manual-tagged-construction",
  "anti-slop-effect/no-service-constructor-imports",
  "anti-slop-effect/prefer-effect-match",
  "oxc/no-accumulating-spread",
]);
const DISPOSITIONS = new Set([
  "production-required",
  "boundary-scoped",
  "test-scoped",
  "Effect-host-only",
  "existing-equivalent",
  "targeted-review",
]);

function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value)
      .sort((left, right) => left.localeCompare(right))
      .join(",") === [...keys].sort((left, right) => left.localeCompare(right)).join(",")
  );
}

function validScopes(scopes) {
  return (
    Array.isArray(scopes) &&
    new Set(scopes).size === scopes.length &&
    scopes.every((scope) => typeof scope === "string" && scope.length > 0)
  );
}

function validRule(rule) {
  return (
    exactKeys(rule, ["id", "disposition", "migrationIssue", "reason", "activeScopes"]) &&
    NON_COSMETIC_RULES.includes(rule.id) &&
    DISPOSITIONS.has(rule.disposition) &&
    Number.isSafeInteger(rule.migrationIssue) &&
    rule.migrationIssue > 0 &&
    typeof rule.reason === "string" &&
    rule.reason.length > 0 &&
    validScopes(rule.activeScopes)
  );
}

function activationShrank(policy, previous) {
  return previous.some((baseline) =>
    baseline.rules.some((rule) => {
      const current = policy.rules.find((entry) => entry.id === rule.id);
      return rule.activeScopes.some((scope) => !current?.activeScopes.includes(scope));
    }),
  );
}

function validRuleInventory(rules) {
  return (
    Array.isArray(rules) &&
    rules.length === NON_COSMETIC_RULES.length &&
    rules.every(validRule) &&
    new Set(rules.map((rule) => rule.id)).size === rules.length
  );
}

export function validatePolicy(policy, previous = []) {
  if (!exactKeys(policy, ["version", "upstream", "runner", "rules"])) return ["invalid-policy"];
  const identity = [
    policy.version === 1,
    policy.upstream === UPSTREAM_COMMIT,
    policy.runner === RUNNER_VERSION,
  ];
  if (!identity.every(Boolean)) return ["invalid-policy-identity"];
  if (!validRuleInventory(policy.rules)) return ["invalid-rule-inventory"];
  const guards = policy.rules.filter((rule) => INITIAL_GUARDS.has(rule.id));
  if (guards.some((rule) => !rule.activeScopes.includes("production")))
    return ["initial-guard-disabled"];
  if (previous.some((baseline) => validatePolicy(baseline).length > 0))
    return ["invalid-baseline-policy"];
  return activationShrank(policy, previous) ? ["activation-shrank"] : [];
}

function isRuleActive(rule, file) {
  return rule.activeScopes.some(
    (scope) =>
      scope === "repository" || scope === file.scope || (scope === "production" && file.production),
  );
}

export function assessPolicyDiagnostics(diagnostics, files, policy) {
  const inventory = new Map(files.map((file) => [file.path, file]));
  const rules = new Map(policy.rules.map((rule) => [rule.id, rule]));
  const violations = [];
  for (const diagnostic of diagnostics) {
    const file = inventory.get(diagnostic.path);
    const rule = rules.get(diagnostic.rule);
    if (file === undefined || rule === undefined) throw new TypeError("unknown-diagnostic");
    if (isRuleActive(rule, file)) violations.push(diagnostic);
  }
  return { census: diagnostics, violations };
}
