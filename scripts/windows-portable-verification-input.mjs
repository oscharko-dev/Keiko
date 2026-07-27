import { portableTargetByName } from "./portable-runtime.mjs";
import {
  PortableVerificationInputError,
  readPortableVerificationInput,
} from "./portable-verification-input.mjs";

export class WindowsVerificationInputError extends Error {}

function fail(message) {
  throw new WindowsVerificationInputError(`windows-portable-signing: ${message}`);
}

function checksVerified(checks) {
  return checks.publisherChainVerified === true && checks.timestampVerified === true;
}

const SHA256 = /^[a-f0-9]{64}$/u;

function sidecarsVerified(sidecars) {
  return sidecars.every(
    (sidecar) =>
      checksVerified(sidecar.verificationChecks) &&
      sidecar.reasonCodes.length === 0 &&
      SHA256.test(sidecar.payloadSha256),
  );
}

function readWindowsVerificationInput(path, target, sidecars) {
  try {
    return readPortableVerificationInput(path, target, "production", sidecars);
  } catch (error) {
    if (error instanceof PortableVerificationInputError) fail(error.message);
    throw error;
  }
}

export function assertWindowsProductionVerificationInput(path, manifest) {
  const target = portableTargetByName(manifest.artifact?.platformTarget);
  if (target?.nodePlatform !== "win32") fail("manifest target is not Windows x64");
  const sidecars = Array.isArray(manifest.sidecarRuntimes) ? manifest.sidecarRuntimes : [];
  const input = readWindowsVerificationInput(path, target, sidecars);
  if (!checksVerified(input.verificationChecks) || input.reasonCodes.length > 0) {
    fail("production native verification did not succeed");
  }
  if (!SHA256.test(input.peInventorySha256)) {
    fail("production PE inventory binding is incomplete");
  }
  if (!sidecarsVerified(input.sidecarRuntimes)) {
    fail("production sidecar verification input is incomplete");
  }
  return input;
}
