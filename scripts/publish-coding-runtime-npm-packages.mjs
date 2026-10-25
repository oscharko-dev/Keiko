#!/usr/bin/env node
// Publishes the optional npm coding-runtime packages through npm Trusted Publishing (#3898 AC8).
//
// The product publisher (release.yml) is root-only, so the runtime packages had no governed path:
// 1.1.3 was uploaded by hand without provenance, and every product release since installs that
// engine. This publisher closes the gap without a second trust decision. The bytes it publishes are
// the reviewed tarballs prepared by build-coding-runtime-npm-package.mjs, pinned by SHA-256 and npm
// integrity in docs/release/coding-runtime-npm-packages.json, which only a reviewed change to `dev`
// can extend. The tarballs travel as assets of a GitHub prerelease, an untrusted transport: each is
// checked against its pin, extracted, and verified again against the approvals compiled into this
// checkout before npm sees it. A version npm already holds is accepted only with the pinned
// integrity, so a re-run is idempotent and a foreign upload fails closed. Publishing happens only
// under GitHub Actions OIDC (coding-runtime-publish.yml); no registry token is read.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { verifyCodingRuntimeNpmCandidate } from "./build-coding-runtime-npm-package.mjs";
import { compareStrings } from "./lib/compare-strings.mjs";
import { resolveHostExecutable } from "./lib/host-executable.mjs";
import { isMainModule } from "./lib/is-main-module.mjs";
import { oidcTrustedPublishingAvailable } from "./lib/npm-publish-preflight.mjs";

export const CODING_RUNTIME_RELEASES_FILE = "docs/release/coding-runtime-npm-packages.json";
const REGISTRY = "https://registry.npmjs.org";
const VERSION = /^\d+\.\d+\.\d+$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const INTEGRITY = /^sha512-[A-Za-z0-9+/]{86}==$/u;
const VERIFY_ATTEMPTS = 30;
const VERIFY_DELAY_MS = 30_000;

/** The receipt asset name beside a tarball; both receipts are called receipt.json when packed. */
export function receiptAssetName(tarball) {
  return tarball.replace(/\.tgz$/u, ".receipt.json");
}

function checkedEntry(target, entry, version) {
  const valid =
    typeof entry?.name === "string" &&
    entry.tarball === `${entry.name.slice(1).replace("/", "-")}-${version}.tgz` &&
    SHA256.test(entry.sha256 ?? "") &&
    INTEGRITY.test(entry.integrity ?? "") &&
    Number.isSafeInteger(entry.sizeBytes) &&
    entry.sizeBytes > 0;
  if (!valid) throw new TypeError(`reviewed ${target} entry for ${version} is malformed`);
  return { target, ...entry };
}

/** The reviewed pins of one version, by target; any other version or shape is refused. */
export function reviewedRelease(document, version) {
  if (!VERSION.test(version)) throw new TypeError(`runtime version ${version} is not x.y.z`);
  const release = document?.schemaVersion === 1 ? document.releases?.[version] : undefined;
  const targets = Object.keys(release ?? {}).sort(compareStrings);
  if (targets.length === 0) throw new TypeError(`runtime version ${version} was never reviewed`);
  return targets.map((target) => checkedEntry(target, release[target], version));
}

function fileFacts(path) {
  const bytes = readFileSync(path);
  return {
    sizeBytes: statSync(path).size,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
  };
}

/**
 * Checks one downloaded tarball against its pin, then verifies the extracted package against the
 * approvals compiled into this checkout with the builder's own verifier.
 */
export async function verifyDownloadedRuntime(entry, version, assetDir, deps = {}) {
  const tarballPath = join(assetDir, entry.tarball);
  const facts = fileFacts(tarballPath);
  for (const key of ["sizeBytes", "sha256", "integrity"]) {
    if (facts[key] !== entry[key]) throw new Error(`${entry.target} tarball ${key} is not pinned`);
  }
  const work = mkdtempSync(join(tmpdir(), "keiko-runtime-publish-"));
  const artifactDir = join(work, "artifacts");
  const extractDir = join(work, "extracted");
  mkdirSync(artifactDir);
  mkdirSync(extractDir);
  copyFileSync(tarballPath, join(artifactDir, entry.tarball));
  copyFileSync(join(assetDir, receiptAssetName(entry.tarball)), join(artifactDir, "receipt.json"));
  (deps.run ?? execFileSync)(resolveHostExecutable("tar"), ["-xzf", tarballPath, "-C", extractDir]);
  await (deps.verifyCandidate ?? verifyCodingRuntimeNpmCandidate)({
    target: entry.target,
    version,
    packageDir: join(extractDir, "package"),
    artifactDir,
  });
  return tarballPath;
}

/** The integrity npm holds for name@version, or undefined when npm has no such version. */
export function registryIntegrity(name, version, run) {
  try {
    const output = run(["view", `${name}@${version}`, "dist.integrity", "--json"]);
    return JSON.parse(output);
  } catch (error) {
    const output = String(error?.stdout ?? "");
    if (output.includes('"E404"')) return undefined;
    throw new Error(`npm could not answer for ${name}@${version}`, { cause: error });
  }
}

async function awaitRegistryIntegrity(entry, version, deps) {
  const attempts = deps.verifyAttempts ?? VERIFY_ATTEMPTS;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (registryIntegrity(entry.name, version, deps.npm) === entry.integrity) return;
    if (attempt < attempts) await (deps.wait ?? delay)(deps.verifyDelayMs ?? VERIFY_DELAY_MS);
  }
  throw new Error(`npm does not serve the pinned ${entry.name}@${version}`);
}

/** Publishes one verified tarball, or accepts the identical version npm already holds. */
export async function publishRuntime(entry, version, tarballPath, deps) {
  const held = registryIntegrity(entry.name, version, deps.npm);
  if (held === entry.integrity) {
    deps.log(`coding-runtime-publish: SKIP ${entry.name}@${version} already holds the pin`);
    return "already-published";
  }
  if (held !== undefined) throw new Error(`npm holds a different ${entry.name}@${version}`);
  deps.npm(["publish", tarballPath, "--access", "public", "--tag", "latest", "--provenance"]);
  await awaitRegistryIntegrity(entry, version, deps);
  deps.log(`coding-runtime-publish: PUBLISHED ${entry.name}@${version} ${entry.integrity}`);
  return "published";
}

function npmRunner(env) {
  return (args) =>
    execFileSync(resolveHostExecutable("npm"), [...args, "--registry", REGISTRY], {
      encoding: "utf8",
      env,
      stdio: ["ignore", "pipe", "inherit"],
    });
}

/** Verifies every target first; publishes nothing unless all of them pass. */
export async function publishCodingRuntimePackages({ root, version, assetDir, env, deps = {} }) {
  if (!oidcTrustedPublishingAvailable(env)) {
    throw new Error("coding runtime packages publish only through GitHub Actions OIDC");
  }
  const document = JSON.parse(readFileSync(join(root, CODING_RUNTIME_RELEASES_FILE), "utf8"));
  const entries = reviewedRelease(document, version);
  const tarballs = [];
  for (const entry of entries) {
    tarballs.push(await verifyDownloadedRuntime(entry, version, assetDir, deps));
  }
  const publishDeps = { npm: npmRunner(env), log: console.log, ...deps };
  const outcomes = [];
  for (const [index, entry] of entries.entries()) {
    outcomes.push(await publishRuntime(entry, version, tarballs[index], publishDeps));
  }
  return outcomes;
}

if (isMainModule(import.meta.url)) {
  const [version, assetDir] = process.argv.slice(2);
  if (version === undefined || assetDir === undefined) {
    console.error("usage: publish-coding-runtime-npm-packages.mjs <version> <asset-dir>");
    process.exitCode = 2;
  } else {
    await publishCodingRuntimePackages({
      root: process.cwd(),
      version,
      assetDir,
      env: process.env,
    });
  }
}
