import { compareStrings } from "./compare-strings.mjs";

export const SYMBOL_LIMITS = Object.freeze({
  programs: 2,
  // Owner decision 2026-10-30 (ADR-0167 D4).
  sourceBytes: 96 * 1024 * 1024,
  nodes: 5_000_000,
  aliases: 64,
  collectiveStates: 256,
  emitBytes: 16 * 1024 * 1024,
  emissionTimeout: 10_000,
  emissionOutputBytes: 1024 * 1024,
});

export function symbolLimits(options = {}) {
  const limits = { ...SYMBOL_LIMITS, ...options };
  if (
    Object.keys(limits).some(
      (key) => !(key in SYMBOL_LIMITS) || !Number.isSafeInteger(limits[key]) || limits[key] < 1,
    )
  )
    throw new TypeError("invalid-symbol-budget");
  return limits;
}

export function chargeSymbolVisits(state, count = 1) {
  if (!Number.isSafeInteger(count) || count < 0) throw new TypeError("invalid-symbol-budget");
  state.nodes += count;
  if (state.nodes > state.limits.nodes) throw new TypeError("symbol-node-budget");
}

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
export const NATIVE_EFFECT_RULES = Object.freeze([
  "anti-slop-effect/no-manual-effect-error-tag",
  "anti-slop-effect/no-manual-tag-comparison",
  "anti-slop-effect/no-manual-tagged-construction",
  "anti-slop-effect/no-service-constructor-imports",
  "anti-slop-effect/prefer-effect-match",
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
    exactKeys(rule, policyRuleKeys(rule)) &&
    NON_COSMETIC_RULES.includes(rule.id) &&
    DISPOSITIONS.has(rule.disposition) &&
    Number.isSafeInteger(rule.migrationIssue) &&
    rule.migrationIssue > 0 &&
    typeof rule.reason === "string" &&
    rule.reason.length > 0 &&
    validScopes(rule.activeScopes) &&
    validRetiredRuleScopes(rule)
  );
}

function policyRuleKeys(rule) {
  const keys = ["id", "disposition", "migrationIssue", "reason", "activeScopes"];
  if (rule && Object.hasOwn(rule, "retiredScopes")) keys.push("retiredScopes");
  return keys;
}

function validRetiredRuleScopes(rule) {
  if (!Object.hasOwn(rule, "retiredScopes")) return true;
  return (
    NATIVE_EFFECT_RULES.includes(rule.id) &&
    rule.disposition === "Effect-host-only" &&
    rule.activeScopes.length === 0 &&
    Array.isArray(rule.retiredScopes) &&
    rule.retiredScopes.length === 1 &&
    rule.retiredScopes[0] === "native-host"
  );
}

function validRetirementCohort(policy) {
  const retired = policy.rules.filter((rule) => Object.hasOwn(rule, "retiredScopes"));
  return (
    retired.length === 0 || (policy.version === 2 && retired.length === NATIVE_EFFECT_RULES.length)
  );
}

function obligationScopes(rule) {
  return [...rule.activeScopes, ...(rule.retiredScopes ?? [])];
}

function activationShrank(policy, previous) {
  return previous.some((baseline) =>
    baseline.rules.some((rule) => {
      const current = policy.rules.find((entry) => entry.id === rule.id);
      return obligationScopes(rule).some((scope) => !obligationScopes(current).includes(scope));
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

function validSelector(selector, input = false) {
  const keys = ["consumerPath", "specifier", "exportName"];
  if (input) keys.push("parameterIndex");
  return (
    exactKeys(selector, keys) &&
    (!input || (Number.isSafeInteger(selector.parameterIndex) && selector.parameterIndex >= 0)) &&
    validPath(selector.consumerPath) &&
    boundedText(selector.specifier, 256) &&
    boundedText(selector.exportName, 128)
  );
}

function validDiagnosticConsumer(selector) {
  if (!exactKeys(selector, ["kind", "owner", "consumerPath", "specifier", "exportName"]))
    return false;
  const { kind, ...legacy } = selector;
  return kind === "public-api-proof" && validConsumerSelector(legacy);
}

function validConsumerSelector(selector) {
  if (!exactKeys(selector, ["consumerPath", "specifier", "exportName", "owner"])) return false;
  const { owner, ...exportSelector } = selector;
  return boundedText(owner, 256) && validSelector(exportSelector);
}

function boundedText(value, limit) {
  return typeof value === "string" && value.length > 0 && value.length <= limit;
}

function validPath(value) {
  return (
    boundedText(value, 1024) &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value.split("/").some((part) => part === ".." || part === "")
  );
}

function validPublicParserRules(record) {
  const allowed = new Set([
    "anti-slop/no-unknown-parameters",
    "anti-slop/no-runtime-typeof",
    "anti-slop/no-unsafe-dictionary-type",
    "anti-slop/no-object-parameters",
  ]);
  return (
    record.kind !== "public-parser" ||
    (record.rules.includes("anti-slop/no-unknown-parameters") &&
      record.rules.every((rule) => allowed.has(rule)) &&
      record.input?.parameterIndex === 0 &&
      (record.rules.length === 1 || record.proofAssertions?.length > 0))
  );
}

function validRawReaderRules(record) {
  return (
    record.kind !== "raw-own-property-reader" ||
    (record.rules.length === 1 &&
      record.rules[0] === "anti-slop/no-unknown-returns" &&
      record.input?.parameterIndex === 0 &&
      record.proofAssertions?.length > 0)
  );
}

function validCanonicalDecoderRules(record) {
  return (
    record.kind !== "raw-canonical-json-decoder" ||
    (record.rules.length === 1 &&
      record.rules[0] === "anti-slop/no-unknown-returns" &&
      record.input?.parameterIndex === 0 &&
      record.proofAssertions?.length > 0)
  );
}

function validObservationFormOption(record) {
  if (!Object.hasOwn(record, "additionalObservationForms")) return true;
  return (
    Array.isArray(record.additionalObservationForms) &&
    record.additionalObservationForms.length === 1 &&
    record.additionalObservationForms[0] === "own-key-identity"
  );
}

function validDirectCheckerOption(record) {
  return !Object.hasOwn(record, "directRawCheckerInputs") || record.directRawCheckerInputs === true;
}

function validObjectValidatorOption(record) {
  return (
    record.rawObjectInput === true &&
    !Object.hasOwn(record, "additionalObservationForms") &&
    !Object.hasOwn(record, "directRawCheckerInputs") &&
    !Object.hasOwn(record, "metadataSourceInput") &&
    record.rules.length === 1 &&
    record.rules[0] === "anti-slop/no-object-parameters" &&
    record.input?.parameterIndex === 0 &&
    record.proofAssertions?.length > 0
  );
}

function validMetadataSourceRules(record) {
  return (
    record.rules.length === 1 &&
    record.rules[0] === "anti-slop/no-object-parameters" &&
    record.input?.parameterIndex === 0 &&
    record.proofAssertions?.length > 0
  );
}

function validMetadataSourceOption(record) {
  const option = record.metadataSourceInput;
  return (
    record.kind === "raw-property-observation" &&
    exactKeys(option, ["companion"]) &&
    validConsumerSelector(option.companion) &&
    option.companion.owner === record.owner &&
    record.consumer?.owner === record.owner &&
    !["rawObjectInput", "additionalObservationForms", "directRawCheckerInputs"].some((key) =>
      Object.hasOwn(record, key),
    ) &&
    validMetadataSourceRules(record)
  );
}

function validOwnedMarkerOption(record) {
  return (
    record.ownedMarkerPair === true &&
    !Object.hasOwn(record, "ownedPredicateStage") &&
    validMetadataSourceOption(record)
  );
}

function validOwnedRegistrationTransportOption(record) {
  return (
    record.ownedRegistrationTransport === true &&
    (!Object.hasOwn(record, "ownedMarkerPair") || record.ownedMarkerPair === true) &&
    !Object.hasOwn(record, "ownedPredicateStage") &&
    validMetadataSourceOption(record)
  );
}

function validOwnedPredicateOption(record) {
  return (
    record.kind === "validator" &&
    record.ownedPredicateStage === true &&
    validObjectValidatorOption(record)
  );
}

function validObservationOptions(record) {
  if (Object.hasOwn(record, "ownedRegistrationTransport"))
    return validOwnedRegistrationTransportOption(record);
  if (Object.hasOwn(record, "ownedMarkerPair")) return validOwnedMarkerOption(record);
  if (Object.hasOwn(record, "ownedPredicateStage")) return validOwnedPredicateOption(record);
  if (Object.hasOwn(record, "metadataSourceInput")) return validMetadataSourceOption(record);
  return validLegacyObservationOptions(record);
}

function validLegacyObservationOptions(record) {
  if (record.kind === "validator" && Object.hasOwn(record, "rawObjectInput"))
    return validObjectValidatorOption(record);
  const present = ["rawObjectInput", "additionalObservationForms", "directRawCheckerInputs"].some(
    (key) => Object.hasOwn(record, key),
  );
  if (present && record.kind !== "raw-property-observation") return false;
  return (
    (!Object.hasOwn(record, "rawObjectInput") || record.rawObjectInput === true) &&
    validObservationFormOption(record) &&
    validDirectCheckerOption(record)
  );
}

export function isObjectObservationRecord(record) {
  return (
    record.kind === "raw-property-observation" &&
    record.rawObjectInput === true &&
    record.input?.parameterIndex === 0 &&
    record.rules.length === 1 &&
    record.rules[0] === "anti-slop/no-object-parameters" &&
    ![
      "metadataSourceInput",
      "directRawCheckerInputs",
      "additionalObservationForms",
      "ownedPredicateStage",
      "ownedMarkerPair",
      "ownedRegistrationTransport",
    ].some((key) => Object.hasOwn(record, key))
  );
}

function validObservationRules(record) {
  if (isObjectObservationRecord(record)) return record.proofAssertions?.length > 0;
  if (Object.hasOwn(record, "metadataSourceInput")) return validMetadataSourceOption(record);
  const rules = [
    "anti-slop/no-object-parameters",
    "anti-slop/no-unknown-returns",
    "anti-slop/no-reflect-get",
  ];
  return (
    record.kind !== "raw-property-observation" ||
    (record.input?.parameterIndex === 0 &&
      record.proofAssertions?.length > 0 &&
      record.rules.length === rules.length &&
      rules.every((rule) => record.rules.includes(rule)))
  );
}

function validTypedRecheckRules(record) {
  return (
    record.kind !== "typed-parameter-recheck" ||
    (record.rules.length === 1 &&
      record.rules[0] === "anti-slop/no-known-value-widening" &&
      record.proofAssertions?.length > 0)
  );
}

function validResponsibilityConsumer(record) {
  if (Object.hasOwn(record, "metadataSourceInput")) return validConsumerSelector(record.consumer);
  return [
    "diagnostic-checker",
    "public-parser",
    "raw-own-property-reader",
    "raw-property-observation",
    "typed-parameter-recheck",
    "raw-canonical-json-decoder",
  ].includes(record.kind)
    ? validDiagnosticConsumer(record.consumer)
    : validConsumerSelector(record.consumer);
}

function responsibilityKeys(record) {
  const keys = [
    "id",
    "owner",
    "kind",
    "rules",
    "input",
    "transform",
    "output",
    "consumer",
    "proofs",
  ];
  if (record !== null && typeof record === "object" && Object.hasOwn(record, "proofAssertions"))
    keys.push("proofAssertions");
  for (const option of [
    "rawObjectInput",
    "ownedPredicateStage",
    "ownedMarkerPair",
    "ownedRegistrationTransport",
    "additionalObservationForms",
    "directRawCheckerInputs",
    "metadataSourceInput",
  ])
    if (record !== null && typeof record === "object" && Object.hasOwn(record, option))
      keys.push(option);
  return keys;
}

function validResponsibilityIdentity(record) {
  return (
    boundedText(record.id, 128) &&
    boundedText(record.owner, 256) &&
    [
      "validator",
      "structural-redactor",
      "diagnostic-checker",
      "public-parser",
      "raw-own-property-reader",
      "raw-property-observation",
      "typed-parameter-recheck",
      "raw-canonical-json-decoder",
    ].includes(record.kind) &&
    validResponsibilityRules(record.rules) &&
    validPublicParserRules(record) &&
    validRawReaderRules(record) &&
    validCanonicalDecoderRules(record) &&
    validObservationRules(record) &&
    validObservationOptions(record) &&
    validTypedRecheckRules(record)
  );
}

function validResponsibilitySelectors(record) {
  return (
    validSelector(record.input, true) &&
    [record.transform, record.output].every((selector) => validSelector(selector)) &&
    validResponsibilityConsumer(record)
  );
}

function validResponsibility(record) {
  return (
    exactKeys(record, responsibilityKeys(record)) &&
    validResponsibilityIdentity(record) &&
    validResponsibilitySelectors(record) &&
    validProofs(record.proofs) &&
    (!Object.hasOwn(record, "proofAssertions") || validProofAssertions(record))
  );
}

function validProofAssertions(record) {
  const assertions = record.proofAssertions;
  return (
    Array.isArray(assertions) &&
    assertions.length > 0 &&
    assertions.length <= 16 &&
    assertions.every(
      (entry) =>
        exactKeys(entry, ["path", "testName"]) &&
        record.proofs.includes(entry.path) &&
        boundedText(entry.testName, 1024),
    ) &&
    new Set(assertions.map((entry) => JSON.stringify([entry.path, entry.testName]))).size ===
      assertions.length
  );
}

function validResponsibilityRules(rules) {
  return (
    validScopes(rules) &&
    rules.length > 0 &&
    rules.every((rule) => NON_COSMETIC_RULES.includes(rule))
  );
}

function validProofs(proofs) {
  return validScopes(proofs) && proofs.length > 0 && proofs.length <= 16 && proofs.every(validPath);
}

function validResponsibilities(records) {
  return (
    Array.isArray(records) &&
    records.length <= 256 &&
    records.every(validResponsibility) &&
    new Set(records.map((record) => record.id)).size === records.length
  );
}

function canonicalIdentity(value) {
  if (typeof value === "string") return value;
  if (value.kind === "public-api-proof")
    return JSON.stringify([value.kind, canonicalIdentity({ ...value, kind: undefined })]);
  return JSON.stringify([
    value.consumerPath,
    value.specifier,
    value.exportName,
    value.parameterIndex ?? null,
    value.owner ?? null,
  ]);
}

function retainsProofAssertion(record, proof) {
  return record.proofAssertions?.some(
    (entry) => entry.path === proof.path && entry.testName === proof.testName,
  );
}

function observationOptionShrank(current, record) {
  return (
    (Object.hasOwn(record, "metadataSourceInput") &&
      canonicalIdentity(current.metadataSourceInput) !==
        canonicalIdentity(record.metadataSourceInput)) ||
    [
      "rawObjectInput",
      "ownedPredicateStage",
      "ownedMarkerPair",
      "ownedRegistrationTransport",
      "directRawCheckerInputs",
    ].some((key) => record[key] === true && current[key] !== true) ||
    (record.additionalObservationForms ?? []).some(
      (form) => !(current.additionalObservationForms ?? []).includes(form),
    )
  );
}

function responsibilityShrank(policy, previous) {
  return previous.some((baseline) =>
    (baseline.responsibilities ?? []).some((record) => {
      const current = (policy.responsibilities ?? []).find((entry) => entry.id === record.id);
      if (!current) return true;
      const identity = ["owner", "kind", "input", "transform", "output", "consumer"];
      return (
        identity.some(
          (key) => canonicalIdentity(current[key]) !== canonicalIdentity(record[key]),
        ) ||
        observationOptionShrank(current, record) ||
        record.rules.some((rule) => !current.rules.includes(rule)) ||
        record.proofs.some((proof) => !current.proofs.includes(proof)) ||
        (record.proofAssertions ?? []).some((proof) => !retainsProofAssertion(current, proof))
      );
    }),
  );
}

function validPolicyRuleInventory(policy) {
  return validRuleInventory(policy.rules) && validRetirementCohort(policy);
}

function validateCurrentPolicy(policy) {
  const keys = ["version", "upstream", "runner", "rules"];
  if (policy?.version === 2) keys.push("responsibilities");
  if (!exactKeys(policy, keys)) return ["invalid-policy"];
  const identity = [
    policy.version === 1 || policy.version === 2,
    policy.upstream === UPSTREAM_COMMIT,
    policy.runner === RUNNER_VERSION,
  ];
  if (!identity.every(Boolean)) return ["invalid-policy-identity"];
  if (!validPolicyRuleInventory(policy)) return ["invalid-rule-inventory"];
  if (policy.version === 2 && !validResponsibilities(policy.responsibilities))
    return ["invalid-responsibilities"];
  const guards = policy.rules.filter((rule) => INITIAL_GUARDS.has(rule.id));
  if (guards.some((rule) => !rule.activeScopes.includes("production")))
    return ["initial-guard-disabled"];
  return [];
}

export function validatePolicy(policy, previous = []) {
  const errors = validateCurrentPolicy(policy);
  if (errors.length) return errors;
  if (previous.some((baseline) => validateCurrentPolicy(baseline).length > 0))
    return ["invalid-baseline-policy"];
  if (activationShrank(policy, previous)) return ["activation-shrank"];
  if (previous.some((baseline) => baseline.version === 2) && policy.version !== 2)
    return ["responsibility-downgrade"];
  return responsibilityShrank(policy, previous) ? ["responsibility-shrank"] : [];
}

function isRuleActive(rule, file) {
  return rule.activeScopes.some(
    (scope) =>
      scope === "repository" || scope === file.scope || (scope === "production" && file.production),
  );
}

function orderedDiagnostics(assessed) {
  return assessed.sort(
    (left, right) =>
      left.inventoryIndex - right.inventoryIndex ||
      left.diagnostic.line - right.diagnostic.line ||
      left.diagnostic.column - right.diagnostic.column ||
      compareStrings(left.diagnostic.rule, right.diagnostic.rule),
  );
}

export function assessPolicyDiagnostics(diagnostics, files, policy) {
  const inventory = new Map(files.map((file, index) => [file.path, { file, index }]));
  const rules = new Map(policy.rules.map((rule) => [rule.id, rule]));
  const assessed = [];
  for (const diagnostic of diagnostics) {
    const entry = inventory.get(diagnostic.path);
    const rule = rules.get(diagnostic.rule);
    if (entry === undefined || rule === undefined) throw new TypeError("unknown-diagnostic");
    assessed.push({
      diagnostic,
      inventoryIndex: entry.index,
      active: isRuleActive(rule, entry.file),
    });
  }
  const census = [];
  const violations = [];
  for (const { diagnostic, active } of orderedDiagnostics(assessed)) {
    census.push(diagnostic);
    if (active) violations.push(diagnostic);
  }
  return { census, violations };
}

// Optional gate progress is closed, bounded stderr metadata, never part of a policy verdict.
export const POLICY_PROGRESS_LIMITS = Object.freeze({ frames: 32, line: 256, tail: 8192 });
const POLICY_PROGRESS_PREFIX = "keiko-policy-progress:";
const POLICY_PROGRESS_PHASES = new Set([
  "policy-validation",
  "semantic-build",
  "tool-identity",
  "subject-inventory",
  "package-inventory",
  "native-scan",
  "raw-assessment",
  "responsibilities",
  "diagnostic-adaptation",
  "final-currentness",
  "report-serialization",
]);

function validPolicyProgressFields(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const fields = Object.keys(value);
  return (
    fields.length === 4 &&
    fields.every((key) => ["version", "phase", "state", "elapsedMs"].includes(key))
  );
}

function validPolicyProgress(value) {
  return (
    validPolicyProgressFields(value) &&
    value.version === 1 &&
    POLICY_PROGRESS_PHASES.has(value.phase) &&
    ["started", "completed"].includes(value.state) &&
    Number.isSafeInteger(value.elapsedMs) &&
    value.elapsedMs >= 0 &&
    value.elapsedMs <= 2_147_483_647
  );
}

export function policyProgressLine(value) {
  if (!validPolicyProgress(value)) return null;
  const { version, phase, state, elapsedMs } = value;
  const line = `${POLICY_PROGRESS_PREFIX}${JSON.stringify({ version, phase, state, elapsedMs })}\n`;
  return line.length <= POLICY_PROGRESS_LIMITS.line ? line : null;
}

function parsePolicyProgressLine(line) {
  if (line.length > POLICY_PROGRESS_LIMITS.line || !line.startsWith(POLICY_PROGRESS_PREFIX))
    return null;
  try {
    const value = JSON.parse(line.slice(POLICY_PROGRESS_PREFIX.length));
    // Only the producer's exact ASCII representation is eligible for projection.
    return policyProgressLine(value) === `${line}\n` ? value : null;
  } catch {
    return null;
  }
}

export function lastPolicyProgress(stderr) {
  if (typeof stderr !== "string") return null;
  const tail = stderr.slice(-POLICY_PROGRESS_LIMITS.tail);
  const lines = tail.split("\n");
  if (tail.length !== stderr.length) lines.shift();
  lines.pop(); // A partial final line is not a complete frame.
  let last = null;
  for (const line of lines.slice(-POLICY_PROGRESS_LIMITS.frames)) {
    const parsed = parsePolicyProgressLine(line);
    if (parsed) last = parsed;
  }
  return last;
}
