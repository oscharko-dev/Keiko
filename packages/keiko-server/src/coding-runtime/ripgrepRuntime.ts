// The pinned ripgrep runtime Keiko ships for the OpenCode coding runtime (Epic #3897).
//
// OpenCode's `glob` and `grep` tools and its file finder run ripgrep. The runtime resolves it from
// `rg` on PATH, then `<OpenCode data dir>/bin/rg`, and otherwise DOWNLOADS the release archive from
// GitHub. Keiko runs the runtime loopback-only below Full access and customers sit behind
// firewalls, so an unprovisioned host silently loses search. Keiko therefore ships the identical
// upstream release, pinned and SHA-256 verified exactly like the USearch runtime (ADR-0164 D3):
// nothing is trusted because it is present, and nothing is downloaded at run time.
//
// Ownership: this module lives with the coding runtime, its only product consumer. It imports only
// Node builtins and no sibling module on purpose. The provisioning, staging and smoke scripts load
// this very file through Node's type stripping (`scripts/provision-ripgrep.mjs` runs in CI before
// anything is built), so a second copy of the approval table cannot exist and drift.
//
// Layouts the product verifies (the same digests apply to all):
//   - provisioned: `<repo>/.ripgrep/<version>/<target>/rg[.exe]`, written by `npm run
//     provision:ripgrep` for development checkouts and CI;
//   - portable:    `<resource root>/runtime/native/rg[.exe]`, staged by the portable build. The npm
//     runtime package (`@oscharko-dev/keiko-coding-runtime-<target>`) uses this same path under its
//     installed package root, staged by `scripts/build-coding-runtime-npm-package.mjs` with the
//     unmodified upstream bytes, so only the pinned upstream digest applies there.

import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  type Stats,
} from "node:fs";
import { dirname, join } from "node:path";

export interface RipgrepRuntimeTargetApproval {
  /** Upstream release archive format, which decides how the approved members are extracted. */
  readonly archiveKind: "tar.gz" | "zip";
  readonly archiveUrl: string;
  readonly archiveSha256: string;
  readonly archiveSizeBytes: number;
  /** The one executable member of the archive, as a `/`-separated archive path. */
  readonly binaryMember: string;
  readonly binarySha256: string;
  readonly binarySizeBytes: number;
  /** The MIT license member. Windows archives carry CRLF text, so each target pins its own. */
  readonly licenseMember: string;
  readonly licenseSha256: string;
}

export interface RipgrepRuntimeManifest {
  readonly version: string;
  /** Full commit of the upstream release tag; `rg --version` reports its first ten characters. */
  readonly sourceCommit: string;
  /** SPDX expression ripgrep is published under. Keiko redistributes and ships the MIT text. */
  readonly licenseExpression: string;
  readonly licenseFileName: string;
  readonly targets: Readonly<Record<string, Readonly<RipgrepRuntimeTargetApproval>>>;
}

export const RIPGREP_RUNTIME_MANIFEST = Object.freeze({
  version: "15.1.0",
  sourceCommit: "af60c2de9d85e7f3d81c78601669468cf02dabab",
  licenseExpression: "Unlicense OR MIT",
  licenseFileName: "LICENSE-MIT",
  targets: Object.freeze({
    "darwin-arm64": Object.freeze({
      archiveKind: "tar.gz",
      archiveUrl:
        "https://github.com/BurntSushi/ripgrep/releases/download/15.1.0/ripgrep-15.1.0-aarch64-apple-darwin.tar.gz",
      archiveSha256: "378e973289176ca0c6054054ee7f631a065874a352bf43f0fa60ef079b6ba715",
      archiveSizeBytes: 1_777_930,
      binaryMember: "ripgrep-15.1.0-aarch64-apple-darwin/rg",
      binarySha256: "4fdf1d8365af224bc70e3c1490d8461d859c37cc70e739a11e987af0215f3e94",
      binarySizeBytes: 4_048_816,
      licenseMember: "ripgrep-15.1.0-aarch64-apple-darwin/LICENSE-MIT",
      licenseSha256: "0f96a83840e146e43c0ec96a22ec1f392e0680e6c1226e6f3ba87e0740af850f",
    }),
    "darwin-x64": Object.freeze({
      archiveKind: "tar.gz",
      archiveUrl:
        "https://github.com/BurntSushi/ripgrep/releases/download/15.1.0/ripgrep-15.1.0-x86_64-apple-darwin.tar.gz",
      archiveSha256: "64811cb24e77cac3057d6c40b63ac9becf9082eedd54ca411b475b755d334882",
      archiveSizeBytes: 1_894_127,
      binaryMember: "ripgrep-15.1.0-x86_64-apple-darwin/rg",
      binarySha256: "3bafa7e6ee51ba3ac4ed065883484a309be09b26ea6dad561ae4049bfe049c50",
      binarySizeBytes: 4_442_900,
      licenseMember: "ripgrep-15.1.0-x86_64-apple-darwin/LICENSE-MIT",
      licenseSha256: "0f96a83840e146e43c0ec96a22ec1f392e0680e6c1226e6f3ba87e0740af850f",
    }),
    "linux-arm64": Object.freeze({
      archiveKind: "tar.gz",
      archiveUrl:
        "https://github.com/BurntSushi/ripgrep/releases/download/15.1.0/ripgrep-15.1.0-aarch64-unknown-linux-gnu.tar.gz",
      archiveSha256: "2b661c6ef508e902f388e9098d9c4c5aca72c87b55922d94abdba830b4dc885e",
      archiveSizeBytes: 1_869_959,
      binaryMember: "ripgrep-15.1.0-aarch64-unknown-linux-gnu/rg",
      binarySha256: "968cabe8efed72fd8fd482cb76b6084fcb695fc5293af7fb62296b02f487fb69",
      binarySizeBytes: 4_543_848,
      licenseMember: "ripgrep-15.1.0-aarch64-unknown-linux-gnu/LICENSE-MIT",
      licenseSha256: "0f96a83840e146e43c0ec96a22ec1f392e0680e6c1226e6f3ba87e0740af850f",
    }),
    "linux-x64": Object.freeze({
      archiveKind: "tar.gz",
      archiveUrl:
        "https://github.com/BurntSushi/ripgrep/releases/download/15.1.0/ripgrep-15.1.0-x86_64-unknown-linux-musl.tar.gz",
      archiveSha256: "1c9297be4a084eea7ecaedf93eb03d058d6faae29bbc57ecdaf5063921491599",
      archiveSizeBytes: 2_263_077,
      binaryMember: "ripgrep-15.1.0-x86_64-unknown-linux-musl/rg",
      binarySha256: "ebeaf56f8a25e102e9419933423738b3a2a613a444fd749d695e15eba53f71f2",
      binarySizeBytes: 5_445_512,
      licenseMember: "ripgrep-15.1.0-x86_64-unknown-linux-musl/LICENSE-MIT",
      licenseSha256: "0f96a83840e146e43c0ec96a22ec1f392e0680e6c1226e6f3ba87e0740af850f",
    }),
    "win32-arm64": Object.freeze({
      archiveKind: "zip",
      archiveUrl:
        "https://github.com/BurntSushi/ripgrep/releases/download/15.1.0/ripgrep-15.1.0-aarch64-pc-windows-msvc.zip",
      archiveSha256: "00d931fb5237c9696ca49308818edb76d8eb6fc132761cb2a1bd616b2df02f8e",
      archiveSizeBytes: 1_675_460,
      binaryMember: "ripgrep-15.1.0-aarch64-pc-windows-msvc/rg.exe",
      binarySha256: "f7799d737b520e00b10dfa72def23904fe66fb03315636a7b78549845ee9609c",
      binarySizeBytes: 3_930_112,
      licenseMember: "ripgrep-15.1.0-aarch64-pc-windows-msvc/LICENSE-MIT",
      licenseSha256: "970813655a1bf777d2ead189cef71ab73ab92ce04dc864027d61a45de03e6728",
    }),
    "win32-x64": Object.freeze({
      archiveKind: "zip",
      archiveUrl:
        "https://github.com/BurntSushi/ripgrep/releases/download/15.1.0/ripgrep-15.1.0-x86_64-pc-windows-msvc.zip",
      archiveSha256: "124510b94b6baa3380d051fdf4650eaa80a302c876d611e9dba0b2e18d87493a",
      archiveSizeBytes: 1_810_687,
      binaryMember: "ripgrep-15.1.0-x86_64-pc-windows-msvc/rg.exe",
      binarySha256: "decdd4992f3f1b9a5ef9898f1b40ab16886d579d6516b4efd3d5eaa19364e408",
      binarySizeBytes: 4_266_496,
      licenseMember: "ripgrep-15.1.0-x86_64-pc-windows-msvc/LICENSE-MIT",
      licenseSha256: "970813655a1bf777d2ead189cef71ab73ab92ce04dc864027d61a45de03e6728",
    }),
  }),
}) satisfies Readonly<RipgrepRuntimeManifest>;

export type RipgrepRuntimeTargetKey = keyof typeof RIPGREP_RUNTIME_MANIFEST.targets;

/**
 * Names the executable an operator or a qualification run wants the launcher to use. It is never
 * trusted: the file must still verify against the pinned digest, in the same way as any other
 * location, and a packaged release-qualified runtime ignores it altogether.
 */
export const RIPGREP_OVERRIDE_ENV = "KEIKO_RIPGREP_BINARY_PATH";

export type RipgrepPortableTarget = "linux-x64" | "windows-x64" | "macos-arm64" | "macos-x64";

// Total over the four portable targets; scripts/__tests__/stage-portable-ripgrep.test.mjs pins it
// to the platform/architecture pair the portable producer declares for each target.
const PORTABLE_TARGET_KEYS: Readonly<Record<RipgrepPortableTarget, RipgrepRuntimeTargetKey>> =
  Object.freeze({
    "linux-x64": "linux-x64",
    "windows-x64": "win32-x64",
    "macos-arm64": "darwin-arm64",
    "macos-x64": "darwin-x64",
  });

/** The approval-table key of a portable runtime target (`macos-arm64` -> `darwin-arm64`). */
export function ripgrepTargetKeyForPortableTarget(
  target: RipgrepPortableTarget,
): RipgrepRuntimeTargetKey {
  return PORTABLE_TARGET_KEYS[target];
}

/** The development and CI cache directory, relative to the repository root and gitignored. */
export const RIPGREP_PROVISIONED_DIRECTORY = ".ripgrep";
/** Portable payload locations, relative to the resource root and `/`-separated. */
export const RIPGREP_PORTABLE_NATIVE_DIRECTORY = "runtime/native";
export const RIPGREP_PORTABLE_LICENSE_PATH = `runtime/licenses/ripgrep/${RIPGREP_RUNTIME_MANIFEST.licenseFileName}`;

// A release archive is a few megabytes; the cap bounds what a hostile or corrupted file can make a
// verifier read before its digest is known to be wrong.
export const RIPGREP_BINARY_MAX_BYTES = 32 * 1024 * 1024;
export const RIPGREP_LICENSE_MAX_BYTES = 64 * 1024;
export const RIPGREP_ARCHIVE_MAX_BYTES = 16 * 1024 * 1024;

export function ripgrepRuntimeTargetKey(
  platform: string,
  architecture: string,
): RipgrepRuntimeTargetKey | undefined {
  const key = `${platform}-${architecture}`;
  return Object.hasOwn(RIPGREP_RUNTIME_MANIFEST.targets, key)
    ? (key as RipgrepRuntimeTargetKey)
    : undefined;
}

export function ripgrepBinaryName(targetKey: string): "rg" | "rg.exe" {
  return targetKey.startsWith("win32-") ? "rg.exe" : "rg";
}

export interface RipgrepRuntimeApproval extends RipgrepRuntimeTargetApproval {
  readonly version: string;
  readonly sourceCommit: string;
  readonly licenseExpression: string;
  readonly licenseFileName: string;
  readonly targetKey: string;
  readonly binaryName: "rg" | "rg.exe";
}

export function ripgrepRuntimeApproval(
  targetKey: string | undefined,
  runtimeManifest: Readonly<RipgrepRuntimeManifest> = RIPGREP_RUNTIME_MANIFEST,
): Readonly<RipgrepRuntimeApproval> | undefined {
  // Own keys only: a caller-supplied key such as "constructor" must not resolve to an inherited
  // member and be mistaken for an approval.
  if (targetKey === undefined || !Object.hasOwn(runtimeManifest.targets, targetKey)) {
    return undefined;
  }
  const target = runtimeManifest.targets[targetKey];
  if (target === undefined) return undefined;
  return Object.freeze({
    ...target,
    version: runtimeManifest.version,
    sourceCommit: runtimeManifest.sourceCommit,
    licenseExpression: runtimeManifest.licenseExpression,
    licenseFileName: runtimeManifest.licenseFileName,
    targetKey,
    binaryName: ripgrepBinaryName(targetKey),
  });
}

/** `runtime/native/rg` or `runtime/native/rg.exe` inside a portable resource root. */
export function ripgrepPortableExecutablePath(targetKey: string): string {
  return `${RIPGREP_PORTABLE_NATIVE_DIRECTORY}/${ripgrepBinaryName(targetKey)}`;
}

export function ripgrepProvisionedDirectory(
  root: string,
  targetKey: string,
  runtimeManifest: Readonly<RipgrepRuntimeManifest> = RIPGREP_RUNTIME_MANIFEST,
): string {
  return join(root, RIPGREP_PROVISIONED_DIRECTORY, runtimeManifest.version, targetKey);
}

export function ripgrepProvisionedBinaryPath(
  root: string,
  targetKey: string,
  runtimeManifest: Readonly<RipgrepRuntimeManifest> = RIPGREP_RUNTIME_MANIFEST,
): string {
  return join(
    ripgrepProvisionedDirectory(root, targetKey, runtimeManifest),
    ripgrepBinaryName(targetKey),
  );
}

export const RIPGREP_VERIFICATION_REASONS = [
  "unsupported-target",
  "missing",
  "not-regular-file",
  "untrusted-parent",
  "untrusted-owner-or-mode",
  "oversized",
  "unreadable",
  "changed-during-verification",
  "digest-mismatch",
] as const;

/** Closed, body-free vocabulary. Never carries a path, an errno message or file bytes. */
export type RipgrepVerificationReason = (typeof RIPGREP_VERIFICATION_REASONS)[number];

export type PinnedFileVerification =
  | { readonly ok: true; readonly sha256: string }
  | { readonly ok: false; readonly reason: RipgrepVerificationReason };

export interface PinnedFileOptions {
  readonly maxBytes?: number;
  /** Test seam; defaults to the process owner. Absent on Windows, where POSIX bits do not apply. */
  readonly currentUid?: number;
}

class RipgrepFileRefusal extends Error {
  readonly reason: RipgrepVerificationReason;

  constructor(reason: RipgrepVerificationReason) {
    super(reason);
    this.name = "RipgrepFileRefusal";
    this.reason = reason;
  }
}

// Same-uid POSIX mutation and Windows ACL evaluation remain outside Node's mode-bit model. This
// establishes the portable minimum the USearch loader also enforces: regular bytes, no symlink,
// current-user or root ownership, and no group/world write authority on the file or its directory.
function ownerAndModeAreTrusted(entry: Stats, currentUid: number | undefined): boolean {
  if (currentUid === undefined) return true;
  return (entry.uid === currentUid || entry.uid === 0) && (entry.mode & 0o022) === 0;
}

function hostUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function requireTrustedParent(path: string, currentUid: number | undefined): void {
  const parent = lstatSync(dirname(path));
  if (
    parent.isSymbolicLink() ||
    !parent.isDirectory() ||
    !ownerAndModeAreTrusted(parent, currentUid)
  ) {
    throw new RipgrepFileRefusal("untrusted-parent");
  }
}

function requireRegularFile(path: string, maxBytes: number, currentUid: number | undefined): Stats {
  const entry = lstatSync(path, { throwIfNoEntry: false });
  if (entry === undefined) throw new RipgrepFileRefusal("missing");
  if (entry.isSymbolicLink() || !entry.isFile()) throw new RipgrepFileRefusal("not-regular-file");
  if (!ownerAndModeAreTrusted(entry, currentUid)) {
    throw new RipgrepFileRefusal("untrusted-owner-or-mode");
  }
  if (entry.size > maxBytes) throw new RipgrepFileRefusal("oversized");
  return entry;
}

function sameObject(left: Stats, right: Stats): boolean {
  // Windows reports file indexes that Node cannot always carry exactly; the symlink check, the
  // digest and the post-read size/mtime comparison below remain its identity proof.
  return process.platform === "win32" || (left.dev === right.dev && left.ino === right.ino);
}

function openFlags(): number {
  return process.platform === "win32"
    ? constants.O_RDONLY
    : constants.O_RDONLY | constants.O_NOFOLLOW;
}

function hashHeldFile(path: string, before: Stats): string {
  const descriptor = openSync(path, openFlags());
  try {
    const held = fstatSync(descriptor);
    if (!held.isFile() || !sameObject(before, held)) {
      throw new RipgrepFileRefusal("changed-during-verification");
    }
    const digest = createHash("sha256").update(readFileSync(descriptor)).digest("hex");
    const after = lstatSync(path);
    if (
      after.isSymbolicLink() ||
      !sameObject(before, after) ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs
    ) {
      throw new RipgrepFileRefusal("changed-during-verification");
    }
    return digest;
  } finally {
    closeSync(descriptor);
  }
}

// Filesystem errors that mean "this file cannot be used", mapped to the closed vocabulary. Any
// other error is a defect, not a verdict about the file, and is rethrown by the caller.
const FILESYSTEM_REFUSALS: Readonly<Record<string, RipgrepVerificationReason>> = Object.freeze({
  ENOENT: "missing",
  ENOTDIR: "missing",
  ELOOP: "not-regular-file",
  EACCES: "unreadable",
  EPERM: "unreadable",
  EISDIR: "unreadable",
  EIO: "unreadable",
  EBUSY: "unreadable",
  EMFILE: "unreadable",
  ENFILE: "unreadable",
});

function refusalFor(error: unknown): RipgrepVerificationReason | undefined {
  if (error instanceof RipgrepFileRefusal) return error.reason;
  const code =
    typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  return typeof code === "string" ? FILESYSTEM_REFUSALS[code] : undefined;
}

/**
 * Verifies one runtime file against pinned digests: a regular file (never a symlink) in a regular
 * directory, owned by the current user or root with no group/world write bit on POSIX, bounded in
 * size, whose bytes - read through the descriptor that was identity-checked against the path -
 * hash to one of the accepted digests. Fails closed with a closed reason; only a defect (a
 * non-filesystem error) is rethrown.
 */
export function verifyPinnedRuntimeFile(
  path: string,
  acceptedSha256: readonly string[],
  options: PinnedFileOptions = {},
): PinnedFileVerification {
  const currentUid = options.currentUid ?? hostUid();
  const maxBytes = options.maxBytes ?? RIPGREP_BINARY_MAX_BYTES;
  try {
    requireTrustedParent(path, currentUid);
    const before = requireRegularFile(path, maxBytes, currentUid);
    const sha256 = hashHeldFile(path, before);
    if (!acceptedSha256.includes(sha256)) throw new RipgrepFileRefusal("digest-mismatch");
    return { ok: true, sha256 };
  } catch (error) {
    const reason = refusalFor(error);
    if (reason === undefined) throw error;
    return { ok: false, reason };
  }
}

export type RipgrepLayout = "portable" | "provisioned";

export interface RipgrepVerificationOptions extends PinnedFileOptions {
  /** `portable` (default) is `<rootDir>/runtime/native/rg[.exe]`; `provisioned` is `.ripgrep/...`. */
  readonly layout?: RipgrepLayout;
  /**
   * Digests accepted in addition to the pinned upstream one. A platform signature rewrites the
   * executable's bytes, so the portable activation manifest binds the signed `shippedSha256`;
   * the caller passes exactly that value here. Absent, only the pinned upstream bytes verify.
   */
  readonly acceptedSha256?: readonly string[];
  readonly manifest?: Readonly<RipgrepRuntimeManifest>;
}

export type RipgrepVerification =
  | {
      readonly ok: true;
      readonly path: string;
      readonly sha256: string;
      readonly version: string;
    }
  | { readonly ok: false; readonly reason: RipgrepVerificationReason };

function ripgrepPathFor(
  rootDir: string,
  targetKey: string,
  layout: RipgrepLayout,
  runtimeManifest: Readonly<RipgrepRuntimeManifest>,
): string {
  return layout === "provisioned"
    ? ripgrepProvisionedBinaryPath(rootDir, targetKey, runtimeManifest)
    : join(rootDir, ...ripgrepPortableExecutablePath(targetKey).split("/"));
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The `shippedSha256` a portable activation manifest binds for the ripgrep tool, or `undefined`
 * unless that manifest binds exactly the pinned tool for `target`: one `ripgrep` entry at the fixed
 * executable path whose `unsignedSha256` is the approved upstream digest. A platform signature
 * rewrites the executable, so a signed payload ships bytes whose digest only this entry knows; pass
 * the result as `acceptedSha256`. It is trusted only as far as the activation manifest itself, so
 * call it on a manifest already verified against the attested tree, never on raw disk bytes.
 */
export function ripgrepActivationDigest(
  activation: unknown,
  target: string,
  runtimeManifest: Readonly<RipgrepRuntimeManifest> = RIPGREP_RUNTIME_MANIFEST,
): string | undefined {
  const approval = ripgrepRuntimeApproval(target, runtimeManifest);
  const tool = approval === undefined ? undefined : onlyActivationTool(activation);
  if (approval === undefined || tool === undefined) return undefined;
  const bound =
    tool.name === "ripgrep" &&
    tool.executablePath === ripgrepPortableExecutablePath(target) &&
    tool.unsignedSha256 === approval.binarySha256;
  return bound ? shaOrUndefined(tool.shippedSha256) : undefined;
}

function onlyActivationTool(activation: unknown): Record<string, unknown> | undefined {
  if (!isRecord(activation)) return undefined;
  const tools = activation.nativeTools;
  const tool: unknown = Array.isArray(tools) && tools.length === 1 ? tools[0] : undefined;
  return isRecord(tool) ? tool : undefined;
}

function shaOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && SHA256_PATTERN.test(value) ? value : undefined;
}

/**
 * Verifies the ripgrep executable at an explicit absolute `path` (for example one a development
 * checkout or a qualification run supplies through its environment) for a target key such as
 * `darwin-arm64`. Same checks and same closed reasons as `resolveVerifiedRipgrep`; nothing about
 * where the file lives is trusted, only what it is.
 */
export function verifyRipgrepExecutable(
  path: string,
  target: string,
  options: RipgrepVerificationOptions = {},
): RipgrepVerification {
  const approval = ripgrepRuntimeApproval(target, options.manifest ?? RIPGREP_RUNTIME_MANIFEST);
  if (approval === undefined) return { ok: false, reason: "unsupported-target" };
  const verified = verifyPinnedRuntimeFile(
    path,
    [approval.binarySha256, ...(options.acceptedSha256 ?? [])],
    options,
  );
  return verified.ok
    ? { ok: true, path, sha256: verified.sha256, version: approval.version }
    : verified;
}

/**
 * Resolves the pinned ripgrep executable under `rootDir` for a target key such as `darwin-arm64`
 * and verifies it. The launch path must prepend the returned directory to the runtime's PATH only
 * on `ok: true`; on `ok: false` it must report the closed `reason` and not start search tools
 * against an unverified binary.
 */
export function resolveVerifiedRipgrep(
  rootDir: string,
  target: string,
  options: RipgrepVerificationOptions = {},
): RipgrepVerification {
  const runtimeManifest = options.manifest ?? RIPGREP_RUNTIME_MANIFEST;
  if (ripgrepRuntimeApproval(target, runtimeManifest) === undefined) {
    return { ok: false, reason: "unsupported-target" };
  }
  const path = ripgrepPathFor(rootDir, target, options.layout ?? "portable", runtimeManifest);
  return verifyRipgrepExecutable(path, target, options);
}
