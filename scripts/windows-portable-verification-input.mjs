export class WindowsVerificationInputError extends Error {}

function fail(message) {
  throw new WindowsVerificationInputError(`windows-portable-signing: ${message}`);
}

function windowsChecksVerified(checks) {
  return checks?.publisherChainVerified === true && checks?.timestampVerified === true;
}

function verifiedSidecarName(sidecar) {
  if (typeof sidecar?.name !== "string" || !windowsChecksVerified(sidecar.verificationChecks)) {
    fail("production sidecar verification input is incomplete");
  }
  return sidecar.name;
}

function assertSidecars(sidecarInput, manifestSidecars) {
  const expected = (manifestSidecars ?? []).map((sidecar) => sidecar.name).sort();
  const sidecars = sidecarInput ?? [];
  if (!Array.isArray(sidecars) || sidecars.length !== expected.length) {
    fail("production sidecar verification input is incomplete");
  }
  const actual = sidecars.map(verifiedSidecarName).sort();
  if (
    JSON.stringify(actual) !== JSON.stringify(expected) ||
    new Set(actual).size !== actual.length
  ) {
    fail("production sidecar verification input is incomplete");
  }
}

export function assertWindowsProductionVerificationInput(input, manifest) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    fail("production verification input is incomplete");
  }
  if (!windowsChecksVerified(input.verificationChecks) || (input.reasonCodes?.length ?? 0) > 0) {
    fail("production native verification did not succeed");
  }
  assertSidecars(input.sidecarRuntimes, manifest.sidecarRuntimes);
}
