export const PINNED_YARN_NAME = "yarn";
export const PINNED_YARN_VERSION = "4.9.1";
export const PINNED_YARN_SHA512 =
  "f95ce356460e05be48d66401c1ae64ef84d163dd689964962c6888a9810865e39097a5e9de748876c2e0bf89b232d583c33982773e9903ae7a76257270986538";
export const PINNED_YARN_SOURCE_URL =
  "https://repo.yarnpkg.com/4.9.1/packages/yarnpkg-cli/bin/yarn.js";

// Provenance for Issue #3134: Corepack 0.35.0 emitted this locator via
// `corepack use yarn@4.9.1`, and the SHA-512 was cross-checked on 2026-08-15
// against the JavaScript file Corepack's Yarn >=2 spec downloads from
// PINNED_YARN_SOURCE_URL. Do not replace it with the `@yarnpkg/cli-dist`
// npm tarball integrity; Corepack validates the downloaded JS bytes.
export const PINNED_YARN = `${PINNED_YARN_NAME}@${PINNED_YARN_VERSION}+sha512.${PINNED_YARN_SHA512}`;

const PINNED_YARN_LOCATOR_PATTERN = /^yarn@(?<version>\d+\.\d+\.\d+)(?:\+sha512\.[a-f0-9]{128})?$/u;

export function pinnedYarnVersionFromLocator(locator) {
  const match = PINNED_YARN_LOCATOR_PATTERN.exec(locator);
  const version = match?.groups?.version;
  if (version === undefined) {
    throw new TypeError("pinned Yarn locator must be yarn@<version>[+sha512.<128-hex>]");
  }
  return version;
}
