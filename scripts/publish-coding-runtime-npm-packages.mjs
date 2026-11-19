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
// under GitHub Actions OIDC (coding-runtime-publish.yml); no registry token is read. `--verify-only`
// runs the same pre-publish checks on local assets without OIDC and publishes nothing.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  loadRuntimeApproval,
  verifyCodingRuntimeNpmCandidate,
} from "./build-coding-runtime-npm-package.mjs";
import { CODING_RUNTIME_RELEASES_FILE, reviewedRelease } from "./lib/coding-runtime-releases.mjs";
import { resolveHostExecutable } from "./lib/host-executable.mjs";
import { isMainModule } from "./lib/is-main-module.mjs";
import { oidcTrustedPublishingAvailable } from "./lib/npm-publish-preflight.mjs";

export { CODING_RUNTIME_RELEASES_FILE, reviewedRelease };

const REGISTRY = "https://registry.npmjs.org";
const COMMIT = /^[a-f0-9]{40}$/u;
const VERIFY_ATTEMPTS = 30;
const VERIFY_DELAY_MS = 30_000;

/** The receipt asset name beside a tarball; both receipts are called receipt.json when packed. */
export function receiptAssetName(tarball) {
  return tarball.replace(/\.tgz$/u, ".receipt.json");
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
  // The builder's verifier binds the receipt to the bytes and to the approvals compiled into this
  // checkout; the reviewed pin must name the same OpenCode, or the product release gate
  // (lib/coding-runtime-releases.mjs) would read a version the package does not carry.
  const receipt = JSON.parse(readFileSync(join(artifactDir, "receipt.json"), "utf8"));
  if (receipt?.opencode?.version !== entry.opencodeVersion) {
    throw new Error(`${entry.target} receipt does not carry the pinned OpenCode version`);
  }
  return tarballPath;
}

function gitRunner(root) {
  return (args) =>
    spawnSync(resolveHostExecutable("git"), args, { cwd: root, stdio: "ignore" }).status;
}

/**
 * Makes each approved helper source commit available to the builder's source check, which stays
 * unchanged (PR #4064 review). A workflow checkout holds one commit, and a squash merge keeps the
 * approved commit's tree but not the commit itself in dev's history, so the check could not find
 * it. The exact commit is fetched by its SHA from the checkout's origin, only when it is absent;
 * a commit that stays absent fails the publish before npm is asked anything.
 */
export async function provideApprovedSourceCommits(entries, root, deps = {}) {
  const git = deps.git ?? gitRunner(root);
  const loadApproval = deps.loadApproval ?? loadRuntimeApproval;
  // Each target's approval is an independent read of the reviewed release metadata.
  const approvals = await Promise.all(entries.map((entry) => loadApproval(entry.target)));
  const commits = new Set(approvals.map((approval) => approval.helperSourceCommit));
  for (const commit of commits) {
    if (!COMMIT.test(commit ?? "")) throw new TypeError("invalid helper source commit");
    const present = () => git(["cat-file", "-e", `${commit}^{commit}`]) === 0;
    if (present()) continue;
    git(["fetch", "--no-tags", "--depth=1", "origin", commit]);
    if (!present()) throw new Error(`approved helper source commit ${commit} is unavailable`);
  }
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
    if (attempt < attempts) await (deps.wait ?? delay)(deps.verifyDelayMs ?? VERIFY_DELAY_MS); // NOSONAR javascript:S9382 -- a retry: the next registry read follows this delay
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

/**
 * Runs every pre-publish check on local assets and publishes nothing: the reviewed pins of the
 * version, the approved helper source commits, and for each target the tarball pin, the receipt and
 * the extracted package against the approvals compiled into this checkout. It needs no OIDC, so the
 * owner can run it on the assets before the immutable transport release is published.
 */
export async function verifyCodingRuntimePackages({ root, version, assetDir, deps = {} }) {
  const document = JSON.parse(readFileSync(join(root, CODING_RUNTIME_RELEASES_FILE), "utf8"));
  const entries = reviewedRelease(document, version);
  await provideApprovedSourceCommits(entries, root, deps);
  const tarballs = [];
  for (const entry of entries) {
    tarballs.push(await verifyDownloadedRuntime(entry, version, assetDir, deps)); // NOSONAR javascript:S9382 -- one candidate is unpacked and verified at a time; the first failure stops the rest
  }
  return { entries, tarballs };
}

/** Verifies every target first; publishes nothing unless all of them pass. */
export async function publishCodingRuntimePackages({ root, version, assetDir, env, deps = {} }) {
  if (!oidcTrustedPublishingAvailable(env)) {
    throw new Error("coding runtime packages publish only through GitHub Actions OIDC");
  }
  const { entries, tarballs } = await verifyCodingRuntimePackages({
    root,
    version,
    assetDir,
    deps,
  });
  const publishDeps = { npm: npmRunner(env), log: console.log, ...deps };
  const outcomes = [];
  for (const [index, entry] of entries.entries()) {
    outcomes.push(await publishRuntime(entry, version, tarballs[index], publishDeps)); // NOSONAR javascript:S9382 -- a publish is irreversible: a failed target stops every later one
  }
  return outcomes;
}

const USAGE =
  "usage: publish-coding-runtime-npm-packages.mjs <version> <asset-dir>\n" +
  "       publish-coding-runtime-npm-packages.mjs --verify-only <version> <asset-dir>";

/** The CLI: publish under OIDC, or `--verify-only` to run the same checks without publishing. */
export async function main(
  argv,
  { root = process.cwd(), env = process.env, deps = {}, write = console } = {},
) {
  const parsed = parsePublisherArguments(argv);
  if (parsed === undefined) {
    write.error(USAGE);
    return 2;
  }
  const { verifyOnly, version, assetDir } = parsed;
  if (!verifyOnly) {
    await publishCodingRuntimePackages({ root, version, assetDir, env, deps });
    return 0;
  }
  const { entries, tarballs } = await verifyCodingRuntimePackages({
    root,
    version,
    assetDir,
    deps,
  });
  for (const [index, entry] of entries.entries()) {
    write.log(
      `coding-runtime-verify-only: OK ${entry.name}@${version} ${entry.sha256} ${tarballs[index]}`,
    );
  }
  return 0;
}

/** `[--verify-only] <version> <asset-dir>`, or undefined when the arguments are not that. */
function parsePublisherArguments(argv) {
  const verifyOnly = argv[0] === "--verify-only";
  const [version, assetDir, ...extra] = verifyOnly ? argv.slice(1) : argv;
  if (version === undefined || assetDir === undefined || extra.length > 0) return undefined;
  return { verifyOnly, version, assetDir };
}

if (isMainModule(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
