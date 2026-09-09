import { join } from "node:path";

export const TOOL_CATALOG_QUALIFICATION_DIR_ENV = "KEIKO_TOOL_CATALOG_QUALIFICATION_DIR";
export const TOOL_CATALOG_QUALIFICATION_HEAD_ENV = "KEIKO_TOOL_CATALOG_QUALIFICATION_HEAD";

export const TOOL_CATALOG_QUALIFICATION_COMPONENTS = Object.freeze({
  "native-harness-gateway": Object.freeze(["native-harness-gateway"]),
  "cli-server-sdk": Object.freeze(["cli", "server", "sdk"]),
  "managed-opencode": Object.freeze(["managed-opencode"]),
  "read-only-child": Object.freeze(["read-only-child"]),
  editor: Object.freeze(["editor"]),
});
export const TOOL_CATALOG_QUALIFICATION_PACKAGES = Object.freeze({
  "native-harness-gateway": Object.freeze([
    "@oscharko-dev/keiko-harness",
    "@oscharko-dev/keiko-model-gateway",
    "@oscharko-dev/keiko-tool-catalog",
    "@oscharko-dev/keiko-tools",
  ]),
  "cli-server-sdk": Object.freeze([
    "@oscharko-dev/keiko-cli",
    "@oscharko-dev/keiko-server",
    "@oscharko-dev/keiko-sdk",
    "@oscharko-dev/keiko-harness",
    "@oscharko-dev/keiko-tool-catalog",
    "@oscharko-dev/keiko-tools",
  ]),
  "managed-opencode": Object.freeze([
    "@oscharko-dev/keiko-server",
    "@oscharko-dev/keiko-harness",
    "@oscharko-dev/keiko-model-gateway",
    "@oscharko-dev/keiko-tool-catalog",
  ]),
  "read-only-child": Object.freeze([
    "@oscharko-dev/keiko-server",
    "@oscharko-dev/keiko-harness",
    "@oscharko-dev/keiko-tool-catalog",
  ]),
  editor: Object.freeze([
    "@oscharko-dev/keiko-server",
    "@oscharko-dev/keiko-harness",
    "@oscharko-dev/keiko-tools",
    "@oscharko-dev/keiko-tool-catalog",
  ]),
});

const DIGEST = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const EXPECTED_OUTCOMES = Object.freeze({
  "native-harness-gateway": Object.freeze({
    terminalStatus: "completed",
    proofKind: "single-settlement",
  }),
  cli: Object.freeze({ terminalStatus: "unavailable", proofKind: "closed-unavailable" }),
  server: Object.freeze({ terminalStatus: "unavailable", proofKind: "closed-unavailable" }),
  sdk: Object.freeze({ terminalStatus: "unavailable", proofKind: "closed-unavailable" }),
  "managed-opencode": Object.freeze({
    terminalStatus: "completed",
    proofKind: "managed-search-read",
  }),
  "read-only-child": Object.freeze({
    terminalStatus: "completed",
    proofKind: "single-settlement",
  }),
  editor: Object.freeze({ terminalStatus: "completed", proofKind: "single-settlement" }),
});

function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function validBinding(binding) {
  return (
    exactKeys(binding, ["catalogRevision", "profile", "projectionDigest", "handlerSetDigest"]) &&
    DIGEST.test(binding.catalogRevision) &&
    DIGEST.test(binding.projectionDigest) &&
    DIGEST.test(binding.handlerSetDigest) &&
    exactKeys(binding.profile, ["id", "version"]) &&
    typeof binding.profile?.id === "string" &&
    /^[a-z][a-z0-9-]{0,63}$/u.test(binding.profile.id) &&
    Number.isSafeInteger(binding.profile.version) &&
    binding.profile.version > 0
  );
}

/** Returns a closed body-free copy, or undefined when untrusted evidence is not canonical. */
export function captureToolCatalogQualificationBinding(binding) {
  if (!validBinding(binding)) return undefined;
  return {
    catalogRevision: binding.catalogRevision,
    profile: { id: binding.profile.id, version: binding.profile.version },
    projectionDigest: binding.projectionDigest,
    handlerSetDigest: binding.handlerSetDigest,
  };
}

function requireObservation(condition) {
  if (!condition) throw new TypeError("Invalid tool catalog qualification observation");
}

const PROOF_VALIDATORS = Object.freeze({
  "closed-unavailable": (proof, settlementCount) =>
    exactKeys(proof, ["kind"]) && settlementCount === 0,
  "single-settlement": (proof, settlementCount) =>
    exactKeys(proof, ["kind"]) && settlementCount === 1,
  "managed-search-read": (proof, settlementCount) =>
    exactKeys(proof, ["kind", "searchSettled", "boundedReadSettled", "causalHandoff"]) &&
    proof.searchSettled === true &&
    proof.boundedReadSettled === true &&
    proof.causalHandoff === true &&
    settlementCount >= 2,
});

function validToolCatalogQualificationProof(proof, settlementCount) {
  if (proof === null || typeof proof !== "object" || Array.isArray(proof)) return false;
  const validate = PROOF_VALIDATORS[proof.kind];
  return validate?.(proof, settlementCount) === true;
}

export function validToolCatalogQualificationOutcome(
  component,
  terminalStatus,
  settlementCount,
  proof,
) {
  const expected = EXPECTED_OUTCOMES[component];
  return (
    expected?.terminalStatus === terminalStatus &&
    expected.proofKind === proof?.kind &&
    validToolCatalogQualificationProof(proof, settlementCount)
  );
}

function validObservation(input, sourceHead, components) {
  return (
    COMMIT.test(sourceHead ?? "") &&
    components?.includes(input.component) === true &&
    validBinding(input.binding) &&
    Number.isSafeInteger(input.settlementCount) &&
    input.settlementCount >= 0 &&
    validToolCatalogQualificationOutcome(
      input.component,
      input.terminalStatus,
      input.settlementCount,
      input.proof,
    ) &&
    validManagedRunBinding(input, sourceHead)
  );
}

function validManagedRunBinding(input, sourceHead) {
  if (input.component !== "managed-opencode") return input.runBinding === undefined;
  const binding = input.runBinding;
  return (
    exactKeys(binding, ["correlationId", "activityLogSha256"]) &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(binding.correlationId) &&
    DIGEST.test(binding.activityLogSha256) &&
    COMMIT.test(sourceHead ?? "")
  );
}

/** Tests call this only after the actual production composition has reached its asserted terminal. */
export function writeToolCatalogQualificationObservation(input) {
  const directory = process.env[TOOL_CATALOG_QUALIFICATION_DIR_ENV];
  if (directory === undefined) return;
  const sourceHead = process.env[TOOL_CATALOG_QUALIFICATION_HEAD_ENV];
  const components = TOOL_CATALOG_QUALIFICATION_COMPONENTS[input.consumer];
  requireObservation(validObservation(input, sourceHead, components));
  // Qualification can be enabled while exercising the CLI's production no-write pin, whose
  // Vitest sandbox deliberately mocks node:fs. This opt-in external receipt is the test runner's
  // evidence channel, so obtain the real host primitive only after the explicit env gate.
  const { mkdirSync, writeFileSync } = process.getBuiltinModule("node:fs");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const observation = {
    schemaVersion: 1,
    sourceHead,
    ...input,
  };
  writeFileSync(
    join(directory, `${input.consumer}.${input.component}.observation.json`),
    `${JSON.stringify(observation, null, 2)}\n`,
    {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    },
  );
}
