import {
  createPortableVerificationChecks,
  findPortableMetadataRedactionFailures,
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
    if (!allowedKeys.includes(key)) fail(`unsupported verification check key: ${key}`);
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
  if (target === undefined) fail(`sidecar ${sidecar.name} platformTarget is unsupported`);
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
      fail(`unsupported sidecar verification input key: ${key}`);
    }
  }
  const name = readSidecarName(entry.name);
  const sidecar = sidecarsByName.get(name);
  if (sidecar === undefined) fail(`unknown sidecar verification input: ${name}`);
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
      fail(`duplicate sidecar verification input: ${sidecarInput.name}`);
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
      fail(`unsupported verification input key: ${key}`);
    }
  }
  const redactionFailures = findPortableMetadataRedactionFailures(input, "verificationInput");
  if (redactionFailures.length > 0) fail(redactionFailures.join("\n  - "));
  return {
    reasonCodes: readReasonCodes(input.reasonCodes),
    sidecarRuntimes: readSidecarInputs(input.sidecarRuntimes, sidecars, policy),
    verificationChecks: readVerificationChecks(input.verificationChecks, target),
  };
}

export function readPortableVerificationInput(path, target, policy, sidecars) {
  if (path === undefined) {
    return {
      reasonCodes: policy === "production" ? ["verification-input-missing"] : [],
      sidecarRuntimes: missingSidecarInputs(sidecars, policy),
      verificationChecks: createPortableVerificationChecks(target.platformTarget, false),
    };
  }
  return parsePortableVerificationInput(readPortableManifest(path), target, policy, sidecars);
}
