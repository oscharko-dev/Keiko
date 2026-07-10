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

export function assertWindowsProductionVerificationInput(path, manifest) {
  const target = portableTargetByName(manifest.artifact?.platformTarget);
  if (target?.nodePlatform !== "win32") fail("manifest target is not Windows x64");
  const sidecars = Array.isArray(manifest.sidecarRuntimes) ? manifest.sidecarRuntimes : [];
  let input;
  try {
    input = readPortableVerificationInput(path, target, "production", sidecars);
  } catch (error) {
    if (error instanceof PortableVerificationInputError) fail(error.message);
    throw error;
  }
  if (!checksVerified(input.verificationChecks) || input.reasonCodes.length > 0) {
    fail("production native verification did not succeed");
  }
  if (
    input.sidecarRuntimes.some(
      (sidecar) => !checksVerified(sidecar.verificationChecks) || sidecar.reasonCodes.length > 0,
    )
  ) {
    fail("production sidecar verification input is incomplete");
  }
  return input;
}
