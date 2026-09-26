import {
  createPortableReleaseTrust,
  verifyPortableReleaseTrust,
} from "@oscharko-dev/keiko-security/portable-release-trust";

// scripts/release-publish.mjs first uses the portable release signing key while binding archives it
// has already uploaded to the created GitHub release, so a key the bundled trust roots reject would
// strand a half-published release. The publisher proves the key here before its first side effect.
// The decision lives in this module because the publisher only ever runs as a spawned CLI.
const PROBE_RELEASE_ID = 1;
const PROBE_LIFETIME_MS = 60_000;

function probeVerification(privateKeyPem, trustedKeys, now) {
  const probe = createPortableReleaseTrust(
    { release: { releaseId: PROBE_RELEASE_ID } },
    {
      expiresAt: new Date(now.valueOf() + PROBE_LIFETIME_MS).toISOString(),
      metadataVersion: PROBE_RELEASE_ID,
      privateKeyPem,
      signedAt: now.toISOString(),
    },
  );
  return verifyPortableReleaseTrust(probe, { now, trustedKeys });
}

/**
 * Signs and verifies a probe manifest with the configured key through the same trust module the
 * publisher and the installed updater use. Does nothing when the run uploads no portable assets.
 *
 * @param portableAssetCount  portable assets this run would upload
 * @param uploadEnabled       false for dry runs and runs that skip the GitHub release
 * @param signingKey          () => the private key PEM; read only when the run would sign
 * @param trustedKeys         () => the trusted public keys
 * @param fail                (message) => never; the run's failure sink
 * @param log                 (message) => void
 * @param now                 the probe's signing instant
 */
export function proveReleaseSigningKeyBeforePublishing({
  fail,
  log,
  now = new Date(),
  portableAssetCount,
  signingKey,
  trustedKeys,
  uploadEnabled,
}) {
  if (portableAssetCount === 0 || !uploadEnabled) return;
  let verification;
  try {
    verification = probeVerification(signingKey(), trustedKeys(), now);
  } catch {
    // The error text is not echoed: Node's argument errors may quote the offending value, and that
    // value is the secret.
    fail(
      "portable release signing key is not a usable Ed25519 private key; nothing was published.",
    );
    return;
  }
  if (!verification.ok) {
    fail(
      `portable release signing key is not trusted (${verification.reason}); nothing was published.`,
    );
    return;
  }
  log(`release-publish: portable release signing key ${verification.keyId} is trusted.`);
}
