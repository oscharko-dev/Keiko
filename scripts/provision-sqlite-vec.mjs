// Provision the sqlite-vec loadable extension for local and CI verification (Issue #2566, #2556).
//
// Why this is not an npm dependency: sqlite-vec publishes the license string "MIT OR Apache", which
// is not valid SPDX ("Apache" is not an identifier). GitHub normalizes the whole expression to
// LicenseRef-bad-mit-or-apache and the CycloneDX SBOM ends up with no license entry at all, so BOTH
// the dependency-review policy and `check:workspace-supply-chain` reject it — the latter by design
// has no exception mechanism ("we cannot prove they are acceptable without a declaration"). The
// actual license is dual MIT / Apache-2.0, verified at the source: github.com/asg017/sqlite-vec
// carries LICENSE-MIT and LICENSE-APACHE at its root. Rather than punch a hole through two
// supply-chain gates for an upstream packaging defect, this follows the precedent already set for
// the Sonar Scanner CLI in ci.yml: fetch the artifact directly and verify it against a pinned
// SHA-256 before anything executes.
//
// The product itself never calls this. At runtime the extension is operator-provisioned through
// KEIKO_LOCAL_KNOWLEDGE_SQLITE_VEC_EXTENSION_PATH (ADR-0152 D2), and with no path configured the
// vector index stays disabled and retrieval uses the existing brute-force path. This script exists
// so local and CI verification can exercise the real binary instead of only the fallback.

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { arch, env, platform } from "node:process";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const VERSION = "0.1.9";
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TARGET_DIR = join(REPO_ROOT, ".sqlite-vec", VERSION);

// SHA-256 of each upstream release tarball, computed from the published assets at
// github.com/asg017/sqlite-vec/releases/tag/v0.1.9. A mismatch aborts before extraction.
const ASSETS = new Map([
  [
    "linux-x64",
    ["linux-x86_64", "b959baa1d8dc88861b1edb337b8587178cdcb12d60b4998f9d10b6a82052d5d7"],
  ],
  [
    "linux-arm64",
    ["linux-aarch64", "ea03d39541e478fab5974253c461e1cb5d77742f69e40cf96e3fad5bc309a37c"],
  ],
  [
    "darwin-arm64",
    ["macos-aarch64", "8282126333399ddfe98bbbcc7a1936e7252625aac49df056a98be602e46bfd29"],
  ],
  [
    "darwin-x64",
    ["macos-x86_64", "53ad76e400786515e2edcaed2f01271dda846316390b761fadbd2dcf56aa4713"],
  ],
  [
    "win32-x64",
    ["windows-x86_64", "51581189d52066b4dfc6631f6d7a3eab7dedc2260656ab09ca97ab3fb8165983"],
  ],
]);

const EXTENSION_SUFFIX = { darwin: "dylib", win32: "dll" };

// Resolve the two helper binaries from fixed system locations rather than letting the OS search
// PATH for them. This runs before the checksum below has proven anything, so a writable PATH entry
// shadowing `curl` or `tar` would execute attacker-chosen code with the developer's privileges at
// the one moment nothing has been verified yet. Both binaries ship with every platform this script
// provisions for — Windows has carried curl.exe and bsdtar since 10 1803 — so pinning the path
// costs no portability. Node's own fetch() is deliberately not used: it does not pick up
// system/proxy trust stores the way curl does, and fails with UNABLE_TO_GET_ISSUER_CERT_LOCALLY
// behind a TLS-inspecting corporate proxy.
const SYSTEM_BINARIES =
  platform === "win32"
    ? {
        curl: join(env.SystemRoot ?? "C:\\Windows", "System32", "curl.exe"),
        tar: join(env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe"),
      }
    : { curl: "/usr/bin/curl", tar: "/usr/bin/tar" };

function fail(message) {
  console.error(`provision-sqlite-vec: ${message}`);
  process.exit(1);
}

function systemBinary(name) {
  const binaryPath = SYSTEM_BINARIES[name];
  // Fail closed rather than falling back to a PATH lookup: an absent system binary is a broken
  // host, and silently searching PATH would reintroduce exactly the shadowing this guards against.
  if (!existsSync(binaryPath)) fail(`required system binary not found at ${binaryPath}`);
  return binaryPath;
}

export function assetFor(hostPlatform, hostArch) {
  return ASSETS.get(`${hostPlatform}-${hostArch}`);
}

export function extensionPathFor(targetDir, hostPlatform) {
  const suffix = EXTENSION_SUFFIX[hostPlatform] ?? "so";
  return join(targetDir, `vec0.${suffix}`);
}

function download(url, destination) {
  // curl over an explicitly pinned https scheme, matching the Sonar Scanner step in ci.yml.
  execFileSync(systemBinary("curl"), ["--proto", "=https", "-sSfL", "-o", destination, url], {
    stdio: ["ignore", "ignore", "inherit"],
  });
}

function sha256Of(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function verify(file, expectedSha256) {
  const actual = sha256Of(file);
  if (actual !== expectedSha256) {
    rmSync(file, { force: true });
    fail(`checksum mismatch: expected ${expectedSha256}, got ${actual}`);
  }
}

const PROVENANCE_PATH = () => join(TARGET_DIR, "PROVENANCE.txt");
const EXTENSION_DIGEST_PREFIX = "extension-sha256=";

// The pinned digest covers the downloaded tarball, so it says nothing about the file left on disk
// afterwards. Recording the extracted binary's own digest lets a later run re-verify the cache
// instead of trusting it because the path exists.
function recordedExtensionDigest() {
  const file = PROVENANCE_PATH();
  if (!existsSync(file)) return undefined;
  const line = readFileSync(file, "utf8")
    .split(/\r?\n/u)
    .find((candidate) => candidate.startsWith(EXTENSION_DIGEST_PREFIX));
  return line?.slice(EXTENSION_DIGEST_PREFIX.length);
}

function main() {
  const asset = assetFor(platform, arch);
  if (asset === undefined) {
    // Not an error: unsupported hosts simply do not get the real binary, and the verification that
    // depends on it asserts the fallback instead of skipping.
    console.log(`provision-sqlite-vec: no published asset for ${platform}-${arch}; skipping.`);
    return;
  }
  const [assetPlatform, expectedSha256] = asset;
  const extensionPath = extensionPathFor(TARGET_DIR, platform);
  if (existsSync(extensionPath)) {
    // Existence is not provenance. Re-verify against the digest recorded when this binary was first
    // checksummed, so a tampered, truncated or half-extracted cache is replaced rather than loaded
    // into the process as a native extension.
    const recorded = recordedExtensionDigest();
    if (recorded !== undefined && recorded === sha256Of(extensionPath)) {
      console.log(`provision-sqlite-vec: already provisioned at ${extensionPath}`);
      return;
    }
    console.log("provision-sqlite-vec: cached extension failed re-verification; re-provisioning.");
    rmSync(extensionPath, { force: true });
  }
  mkdirSync(TARGET_DIR, { recursive: true });
  const tarball = join(TARGET_DIR, `sqlite-vec-${VERSION}-loadable-${assetPlatform}.tar.gz`);
  const url = `https://github.com/asg017/sqlite-vec/releases/download/v${VERSION}/sqlite-vec-${VERSION}-loadable-${assetPlatform}.tar.gz`;
  download(url, tarball);
  verify(tarball, expectedSha256);
  execFileSync(systemBinary("tar"), ["-xzf", tarball, "-C", TARGET_DIR], {
    stdio: ["ignore", "ignore", "inherit"],
  });
  rmSync(tarball, { force: true });
  if (!existsSync(extensionPath)) fail(`extracted archive did not contain ${extensionPath}`);
  chmodSync(extensionPath, 0o755);
  writeFileSync(
    PROVENANCE_PATH(),
    `${url}\nsha256=${expectedSha256}\n${EXTENSION_DIGEST_PREFIX}${sha256Of(extensionPath)}\n`,
    "utf8",
  );
  console.log(`provision-sqlite-vec: verified and extracted to ${extensionPath}`);
}

// pathToFileURL, not a `file://` template: on Windows a resolved path is `C:\...`, which yields
// `file://C:\...` instead of the `file:///C:/...` form import.meta.url actually carries, so the
// comparison was always false there and the script silently did nothing when run directly.
const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(resolve(entryPoint)).href) {
  main();
}
