import { createRequire } from "node:module";

import { bundleFromJSON } from "@sigstore/bundle";
import { TrustedRoot } from "@sigstore/protobuf-specs";
import { toSignedEntity, toTrustMaterial, Verifier } from "@sigstore/verify";

const PUBLIC_TUF_MIRROR = "https://tuf-repo-cdn.sigstore.dev";
const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
const RELEASE_WORKFLOW_IDENTITY =
  /^https:\/\/github\.com\/oscharko-dev\/Keiko\/\.github\/workflows\/portable-assets\.yml@refs\/tags\/v\d+\.\d+\.\d+$/u;

export interface SigstoreBundleVerifier {
  verify(
    entity: Parameters<Verifier["verify"]>[0],
    policy: Parameters<Verifier["verify"]>[1],
  ): ReturnType<Verifier["verify"]>;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function seededTrustedRoot(): ReturnType<typeof TrustedRoot.fromJSON> {
  const require = createRequire(import.meta.url);
  const seeds = record(require("@sigstore/tuf/seeds.json"));
  const mirror = record(seeds?.[PUBLIC_TUF_MIRROR]);
  const targets = record(mirror?.targets);
  const encoded = targets?.["trusted_root.json"];
  if (typeof encoded !== "string") throw new Error("linux-sigstore-trusted-root-unavailable");
  const decoded: unknown = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  return TrustedRoot.fromJSON(decoded);
}

function publicVerifier(): SigstoreBundleVerifier {
  return new Verifier(toTrustMaterial(seededTrustedRoot()), {
    tlogThreshold: 1,
    ctlogThreshold: 1,
    timestampThreshold: 0,
  });
}

export const LINUX_QUALIFICATION_SIGSTORE_POLICY = Object.freeze({
  subjectAlternativeName: RELEASE_WORKFLOW_IDENTITY,
  extensions: Object.freeze({ issuer: GITHUB_OIDC_ISSUER }),
});

/** Verifies the exact receipt bytes offline against Sigstore's embedded public trust root. */
export function verifyLinuxQualificationBundle(
  receipt: Buffer,
  serializedBundle: unknown,
  verifier: SigstoreBundleVerifier = publicVerifier(),
): void {
  const bundle = bundleFromJSON(serializedBundle);
  verifier.verify(toSignedEntity(bundle, receipt), LINUX_QUALIFICATION_SIGSTORE_POLICY);
}
