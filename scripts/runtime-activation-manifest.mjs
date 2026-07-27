import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const RUNTIME_ACTIVATION_RELATIVE_PATH = ".portable/runtime-activation.json";
export const RUNTIME_QUALIFICATION_SUITE = "runtime-tree-qualification-v1";

function clone(value) {
  return structuredClone(value);
}

export function runtimeActivationManifest(manifest) {
  const security = clone(manifest.security);
  return {
    schemaVersion: 1,
    suiteVersion: RUNTIME_QUALIFICATION_SUITE,
    product: {
      packageName: manifest.product.packageName,
      packageVersion: manifest.product.packageVersion,
    },
    sourceCommitSha: manifest.release.commitSha,
    platformTarget: manifest.artifact.platformTarget,
    artifact: {
      platformTarget: manifest.artifact.platformTarget,
    },
    runtime: {
      nodePlatform: manifest.runtime.nodePlatform,
      nodeArchitecture: manifest.runtime.nodeArchitecture,
    },
    security,
    nativeHelpers: clone(manifest.nativeHelpers),
    sidecarRuntimes: clone(manifest.sidecarRuntimes ?? []),
    releaseImpact: {
      reviewedBinding: {
        verificationPolicy: security.verificationPolicy,
        verificationStatus: security.verificationStatus,
        verificationReasonCodes: clone(security.verificationReasonCodes),
        platformSignatureLocallyVerified:
          manifest.releaseImpact.reviewedBinding.platformSignatureLocallyVerified,
        signatureKind: security.signatureKind,
        signatureVerified: security.signatureVerified,
        notarizationRequired: security.notarizationRequired,
        notarizationVerified: security.notarizationVerified,
        verificationChecks: clone(security.verificationChecks),
        nativeHelpers: clone(manifest.nativeHelpers),
      },
    },
  };
}

export function writeRuntimeActivationManifest(resourceRoot, manifest) {
  const path = join(resourceRoot, ...RUNTIME_ACTIVATION_RELATIVE_PATH.split("/"));
  writeFileSync(path, `${JSON.stringify(runtimeActivationManifest(manifest), null, 2)}\n`, {
    mode: 0o644,
  });
  const sha256 = createHash("sha256").update(readFileSync(path)).digest("hex");
  manifest.runtimeActivation = {
    schemaVersion: 1,
    path: RUNTIME_ACTIVATION_RELATIVE_PATH,
    sha256,
    trustAnchor: "unverified-staging",
  };
  return { path, sha256 };
}
