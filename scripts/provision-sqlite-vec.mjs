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
import { arch, platform } from "node:process";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

function fail(message) {
  console.error(`provision-sqlite-vec: ${message}`);
  process.exit(1);
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
  execFileSync("curl", ["--proto", "=https", "-sSfL", "-o", destination, url], {
    stdio: ["ignore", "ignore", "inherit"],
  });
}

function verify(file, expectedSha256) {
  const actual = createHash("sha256").update(readFileSync(file)).digest("hex");
  if (actual !== expectedSha256) {
    rmSync(file, { force: true });
    fail(`checksum mismatch: expected ${expectedSha256}, got ${actual}`);
  }
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
    console.log(`provision-sqlite-vec: already provisioned at ${extensionPath}`);
    return;
  }
  mkdirSync(TARGET_DIR, { recursive: true });
  const tarball = join(TARGET_DIR, `sqlite-vec-${VERSION}-loadable-${assetPlatform}.tar.gz`);
  const url = `https://github.com/asg017/sqlite-vec/releases/download/v${VERSION}/sqlite-vec-${VERSION}-loadable-${assetPlatform}.tar.gz`;
  download(url, tarball);
  verify(tarball, expectedSha256);
  execFileSync("tar", ["-xzf", tarball, "-C", TARGET_DIR], {
    stdio: ["ignore", "ignore", "inherit"],
  });
  rmSync(tarball, { force: true });
  if (!existsSync(extensionPath)) fail(`extracted archive did not contain ${extensionPath}`);
  chmodSync(extensionPath, 0o755);
  writeFileSync(join(TARGET_DIR, "PROVENANCE.txt"), `${url}\nsha256=${expectedSha256}\n`, "utf8");
  console.log(`provision-sqlite-vec: verified and extracted to ${extensionPath}`);
}

if (process.argv[1] !== undefined && import.meta.url === `file://${resolve(process.argv[1])}`) {
  main();
}
