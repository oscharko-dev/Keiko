import {
  createPortableVerificationChecks,
  findPortableMetadataRedactionFailures,
  PORTABLE_VERIFICATION_REASON_CODES,
  portableTargetByName,
  readPortableManifest,
} from "./portable-runtime.mjs";

export class PortableVerificationInputError extends Error {}

function fail(message) {
  throw new PortableVerificationInputError(message);
}

function exactInputKeys(input) {
  return Object.keys(input).sort();
}

function readReasonCodes(value) {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string" || entry.length === 0)
  ) {
    fail("verification input reasonCodes must be a string array");
  }
  if (value.some((entry) => !PORTABLE_VERIFICATION_REASON_CODES.includes(entry))) {
    fail("verification input reasonCodes contain unsupported values");
  }
  return [...new Set(value)];
}

function readVerificationChecks(value, target) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("verification input verificationChecks must be an object");
  }
  const allowedKeys =
    target.nodePlatform === "win32"
      ? ["publisherChainVerified", "timestampVerified"]
      : ["developerIdVerified", "notarizationVerified", "stapleVerified", "assessmentVerified"];
  for (const key of exactInputKeys(value)) {
    if (!allowedKeys.includes(key)) fail("verification checks contain unsupported keys");
  }
  const checks = {};
  for (const key of allowedKeys) {
    if (typeof value[key] !== "boolean") fail(`verification input ${key} must be a boolean`);
    checks[key] = value[key];
  }
  return checks;
}

function sidecarTarget(sidecar) {
  const target = portableTargetByName(sidecar.platformTarget);
  if (target === undefined) fail("sidecar platformTarget is unsupported");
  return target;
}

function missingSidecarInput(sidecar, policy) {
  const target = sidecarTarget(sidecar);
  return {
    name: sidecar.name,
    reasonCodes: policy === "production" ? ["verification-input-missing"] : [],
    verificationChecks: createPortableVerificationChecks(target.platformTarget, false),
  };
}

function missingSidecarInputs(sidecars, policy) {
  return sidecars.map((sidecar) => missingSidecarInput(sidecar, policy));
}

function readSidecarName(value) {
  if (typeof value !== "string" || value.length === 0) {
    fail("sidecar verification input name must be a non-empty string");
  }
  return value;
}

function readSidecarInputEntry(entry, sidecarsByName) {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    fail("verification input sidecar runtime must be an object");
  }
  for (const key of exactInputKeys(entry)) {
    if (!["name", "reasonCodes", "verificationChecks"].includes(key)) {
      fail("sidecar verification input contains unsupported keys");
    }
  }
  const name = readSidecarName(entry.name);
  const sidecar = sidecarsByName.get(name);
  if (sidecar === undefined) fail("sidecar verification input is unknown");
  return {
    name,
    reasonCodes: readReasonCodes(entry.reasonCodes),
    verificationChecks: readVerificationChecks(entry.verificationChecks, sidecarTarget(sidecar)),
  };
}

function readSidecarInputs(value, sidecars, policy) {
  if (value === undefined) return missingSidecarInputs(sidecars, policy);
  if (!Array.isArray(value)) fail("verification input sidecarRuntimes must be an array");
  const sidecarsByName = new Map(sidecars.map((sidecar) => [sidecar.name, sidecar]));
  const inputsByName = new Map();
  for (const entry of value) {
    const sidecarInput = readSidecarInputEntry(entry, sidecarsByName);
    if (inputsByName.has(sidecarInput.name)) {
      fail("sidecar verification input is duplicated");
    }
    inputsByName.set(sidecarInput.name, sidecarInput);
  }
  return sidecars.map(
    (sidecar) => inputsByName.get(sidecar.name) ?? missingSidecarInput(sidecar, policy),
  );
}

export function parsePortableVerificationInput(input, target, policy, sidecars) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    fail("verification input must be a JSON object");
  }
  for (const key of exactInputKeys(input)) {
    if (!["reasonCodes", "sidecarRuntimes", "verificationChecks"].includes(key)) {
      fail("verification input contains unsupported keys");
    }
  }
  const parsed = {
    reasonCodes: readReasonCodes(input.reasonCodes),
    sidecarRuntimes: readSidecarInputs(input.sidecarRuntimes, sidecars, policy),
    verificationChecks: readVerificationChecks(input.verificationChecks, target),
  };
  const redactionFailures = findPortableMetadataRedactionFailures(input, "verificationInput");
  if (redactionFailures.length > 0) fail("verification input failed redaction policy");
  return parsed;
}

export function readPortableVerificationInput(path, target, policy, sidecars) {
  if (path === undefined) {
    return {
      reasonCodes: policy === "production" ? ["verification-input-missing"] : [],
      sidecarRuntimes: missingSidecarInputs(sidecars, policy),
      verificationChecks: createPortableVerificationChecks(target.platformTarget, false),
    };
  }
  let input;
  try {
    input = readPortableManifest(path);
  } catch {
    fail("verification input could not be read");
  }
  return parsePortableVerificationInput(input, target, policy, sidecars);
}
