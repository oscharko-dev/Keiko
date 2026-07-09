import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  chmodSync,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, dirname, join, posix, relative, resolve, sep } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { UpdatePortableTarget } from "@oscharko-dev/keiko-contracts";
import yauzl from "yauzl";
import {
  MAX_ARCHIVE_ENTRIES,
  MAX_ENTRY_BYTES,
  MAX_INFLATE_RATIO,
  MAX_UNCOMPRESSED_BYTES,
  PACKAGE_NAME,
  PORTABLE_PAYLOAD_ROOT,
  PORTABLE_STAGE_DIR_PREFIX,
  fieldEquals,
  parseJsonRecord,
  primaryLauncher,
  recordAt,
  runtimeFor,
  type PortablePlatformVerifier,
  type PortableUpdateStageInput,
  PortableUpdateStagingError,
} from "./update-portable-staging-shared.js";
import { type PortableSidecarRuntimeVerification } from "./update-portable-sidecar-verification.js";
import { verifyStagedSidecarPayloads } from "./update-portable-sidecar-staging-verification.js";
import { verifyPortablePlatformSignature } from "./update-portable-platform-verification.js";

interface ContainedEntry {
  readonly relativeName: string;
  readonly destination: string;
}

interface ExtractedTreeFile {
  readonly relativePath: string;
  readonly sha256: string;
}

export function managedRootFromPackageRoot(
  target: UpdatePortableTarget,
  packageRoot: string | undefined,
): string | undefined {
  if (packageRoot === undefined || basename(packageRoot) !== "app") return undefined;
  if (target === "windows-x64") return dirname(packageRoot);
  const resources = dirname(packageRoot);
  const contents = dirname(resources);
  const bundle = dirname(contents);
  return basename(resources) === "Resources" && basename(contents) === "Contents"
    ? bundle
    : undefined;
}

function assertNotSymlink(path: string): void {
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    throw new PortableUpdateStagingError(
      "portable-staging-failed",
      "portable staging path is unsafe",
    );
  }
}

function stagingRoot(
  input: PortableUpdateStageInput,
  target: UpdatePortableTarget,
  stageId: string,
): string {
  const managedRoot = managedRootFromPackageRoot(target, input.runtimeFacts?.packageRoot);
  if (
    managedRoot === undefined ||
    !existsSync(managedRoot) ||
    !statSync(managedRoot).isDirectory()
  ) {
    throw new PortableUpdateStagingError(
      "portable-preflight-ineligible",
      "managed install root is unavailable",
    );
  }
  const base = join(realpathSync(dirname(managedRoot)), PORTABLE_STAGE_DIR_PREFIX);
  assertNotSymlink(base);
  mkdirSync(base, { recursive: true, mode: 0o700 });
  chmodSync(base, 0o700);
  return join(base, stageId);
}

function normalizedEntryName(name: string): string | undefined {
  if (name.length === 0 || /[\0\r\n]/u.test(name) || /^[A-Za-z]:/u.test(name)) return undefined;
  const normalized = posix.normalize(name.replaceAll("\\", "/"));
  if (normalized === "." || normalized.startsWith("../") || normalized.startsWith("/"))
    return undefined;
  if (normalized.split("/").some((part) => part === ".." || part.length === 0)) return undefined;
  return normalized;
}

function containedEntry(root: string, name: string): ContainedEntry | undefined {
  const relativeName = normalizedEntryName(name);
  if (relativeName === undefined) return undefined;
  const destination = resolve(root, ...relativeName.split("/"));
  const resolvedRoot = resolve(root);
  if (destination === resolvedRoot || destination.startsWith(`${resolvedRoot}${sep}`)) {
    return { relativeName, destination };
  }
  return undefined;
}

function entryFileMode(entry: yauzl.Entry): number {
  const unixMode = (entry.externalFileAttributes >>> 16) & 0o777;
  return (unixMode & 0o111) !== 0 ? 0o700 : 0o600;
}

function entryType(entry: yauzl.Entry): "directory" | "file" | "unsafe" {
  if (entry.fileName.endsWith("/")) return "directory";
  const type = (entry.externalFileAttributes >>> 16) & 0o170000;
  if (type === 0 || type === 0o100000) return "file";
  if (type === 0o040000) return "directory";
  return "unsafe";
}

export interface PortableArchiveLimitState {
  entries: number;
  inflated: number;
}

export function assertPortableArchiveEntryLimits(
  entry: { readonly uncompressedSize: number; readonly compressedSize: number },
  state: PortableArchiveLimitState,
): void {
  state.entries += 1;
  state.inflated += entry.uncompressedSize;
  if (state.entries > MAX_ARCHIVE_ENTRIES || state.inflated > MAX_UNCOMPRESSED_BYTES) {
    throw new PortableUpdateStagingError(
      "portable-staging-failed",
      "portable archive exceeds limits",
    );
  }
  if (entry.uncompressedSize > MAX_ENTRY_BYTES) {
    throw new PortableUpdateStagingError(
      "portable-staging-failed",
      "portable archive entry is too large",
    );
  }
  if (
    entry.compressedSize > 0 &&
    entry.uncompressedSize / entry.compressedSize > MAX_INFLATE_RATIO
  ) {
    throw new PortableUpdateStagingError(
      "portable-staging-failed",
      "portable compression ratio is unsafe",
    );
  }
}

function openZip(bytes: Uint8Array): Promise<yauzl.ZipFile> {
  return new Promise((resolveZip, reject) => {
    yauzl.fromBuffer(
      Buffer.from(bytes),
      { lazyEntries: true, decodeStrings: true },
      (error, zip) => {
        if (error !== null) {
          reject(
            new PortableUpdateStagingError(
              "portable-staging-failed",
              "portable archive is malformed",
            ),
          );
          return;
        }
        resolveZip(zip);
      },
    );
  });
}

function openEntryStream(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolveStream, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error !== null) {
        reject(
          new PortableUpdateStagingError("portable-staging-failed", "portable entry is unreadable"),
        );
        return;
      }
      resolveStream(stream);
    });
  });
}

function hashingTransform(hash: ReturnType<typeof createHash>): Transform {
  return new Transform({
    transform(chunk: Buffer, _encoding, callback): void {
      hash.update(chunk);
      callback(null, chunk);
    },
  });
}

async function writeZipEntry(
  zip: yauzl.ZipFile,
  entry: yauzl.Entry,
  destination: string,
): Promise<string> {
  const mode = entryFileMode(entry);
  const hash = createHash("sha256");
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  await pipeline(
    await openEntryStream(zip, entry),
    hashingTransform(hash),
    createWriteStream(destination, { mode }),
  );
  chmodSync(destination, mode);
  return hash.digest("hex");
}

async function handleEntry(
  zip: yauzl.ZipFile,
  entry: yauzl.Entry,
  root: string,
  state: PortableArchiveLimitState,
  files: ExtractedTreeFile[],
): Promise<void> {
  assertPortableArchiveEntryLimits(entry, state);
  const contained = containedEntry(root, entry.fileName);
  const type = entryType(entry);
  if (contained === undefined || type === "unsafe") {
    throw new PortableUpdateStagingError(
      "portable-staging-failed",
      "portable archive contains unsafe entries",
    );
  }
  if (type === "directory") {
    mkdirSync(contained.destination, { recursive: true, mode: 0o700 });
    return;
  }
  files.push({
    relativePath: contained.relativeName,
    sha256: await writeZipEntry(zip, entry, contained.destination),
  });
}

function hashTreeRecords(files: readonly ExtractedTreeFile[]): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort((left, right) =>
    left.relativePath < right.relativePath ? -1 : 1,
  )) {
    hash.update(`${file.relativePath}\0${file.sha256}\0`);
  }
  return hash.digest("hex");
}

async function extractArchive(bytes: Uint8Array, destination: string): Promise<string> {
  const zip = await openZip(bytes);
  const state = { entries: 0, inflated: 0 };
  const files: ExtractedTreeFile[] = [];
  try {
    await new Promise<void>((resolveDone, reject) => {
      zip.on("entry", (entry: yauzl.Entry) => {
        void handleEntry(zip, entry, destination, state, files).then(() => {
          zip.readEntry();
        }, reject);
      });
      zip.once("end", resolveDone);
      zip.once("error", reject);
      zip.readEntry();
    });
  } finally {
    zip.close();
  }
  return hashTreeRecords(files);
}

function readJsonRecord(path: string): Record<string, unknown> {
  const record = parseJsonRecord(readFileSync(path, "utf8"));
  if (record === undefined) {
    throw new PortableUpdateStagingError("portable-staging-failed", "staged JSON is malformed");
  }
  return record;
}

function treeFiles(root: string, cursor = root): readonly ExtractedTreeFile[] {
  const files: ExtractedTreeFile[] = [];
  for (const entry of readdirSync(cursor, { withFileTypes: true })) {
    const fullPath = join(cursor, entry.name);
    if (entry.isDirectory() && !lstatSync(fullPath).isSymbolicLink()) {
      files.push(...treeFiles(root, fullPath));
    } else if (entry.isFile() && !lstatSync(fullPath).isSymbolicLink()) {
      files.push({
        relativePath: relative(root, fullPath).split(sep).join("/"),
        sha256: createHash("sha256").update(readFileSync(fullPath)).digest("hex"),
      });
    } else {
      throw new PortableUpdateStagingError(
        "portable-staging-failed",
        "staged tree contains unsupported entries",
      );
    }
  }
  return files;
}

function verifyExtractedTree(root: string, expectedSha256: string): void {
  if (hashTreeRecords(treeFiles(root)) !== expectedSha256) {
    throw new PortableUpdateStagingError(
      "portable-staging-failed",
      "staged tree digest did not match the archive stream",
    );
  }
}

function setupManifestPath(root: string, target: UpdatePortableTarget): string {
  if (target === "windows-x64") {
    return join(root, PORTABLE_PAYLOAD_ROOT, ".portable", "setup-manifest.json");
  }
  return join(
    root,
    PORTABLE_PAYLOAD_ROOT,
    "Keiko.app",
    "Contents",
    "Resources",
    ".portable",
    "setup-manifest.json",
  );
}

function requiredStagedFile(path: string): void {
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new PortableUpdateStagingError("portable-staging-failed", "staged layout is incomplete");
  }
}

function validateSetupManifest(
  record: Record<string, unknown>,
  target: UpdatePortableTarget,
  targetVersion: string,
): void {
  const runtime = recordAt(record, "runtime");
  const expected = runtimeFor(target);
  if (
    record.schemaVersion !== 1 ||
    record.platformTarget !== target ||
    record.packageName !== PACKAGE_NAME ||
    record.packageVersion !== targetVersion ||
    record.stable !== true ||
    record.bootstrapUpdateEligible !== false ||
    record.primaryLauncher !== primaryLauncher(target) ||
    !fieldEquals(runtime, "nodePlatform", expected.platform) ||
    !fieldEquals(runtime, "nodeArchitecture", expected.arch)
  ) {
    throw new PortableUpdateStagingError(
      "portable-staging-failed",
      "setup manifest is not eligible",
    );
  }
}

function validatePackageJson(path: string, targetVersion: string): void {
  const record = readJsonRecord(path);
  if (record.name !== PACKAGE_NAME || record.version !== targetVersion) {
    throw new PortableUpdateStagingError(
      "portable-staging-failed",
      "staged package metadata is invalid",
    );
  }
}

function stagedLayout(
  root: string,
  target: UpdatePortableTarget,
): {
  readonly appRoot: string;
  readonly runtimeNode: string;
  readonly launcher: string;
  readonly appBundlePath?: string | undefined;
} {
  const payload = join(root, PORTABLE_PAYLOAD_ROOT);
  if (target === "windows-x64") {
    return {
      appRoot: join(payload, "app"),
      runtimeNode: join(payload, "runtime", "node", "node.exe"),
      launcher: join(payload, "Keiko.exe"),
    };
  }
  const bundle = join(payload, "Keiko.app");
  return {
    appBundlePath: bundle,
    appRoot: join(bundle, "Contents", "Resources", "app"),
    runtimeNode: join(bundle, "Contents", "Resources", "runtime", "node", "bin", "node"),
    launcher: join(bundle, "Contents", "MacOS", "Keiko"),
  };
}

function stagedResourceRoot(root: string, target: UpdatePortableTarget): string {
  const payload = join(root, PORTABLE_PAYLOAD_ROOT);
  if (target === "windows-x64") return payload;
  return join(payload, "Keiko.app", "Contents", "Resources");
}

function validateStagedLayout(
  root: string,
  target: UpdatePortableTarget,
  targetVersion: string,
): ReturnType<typeof stagedLayout> {
  const layout = stagedLayout(root, target);
  requiredStagedFile(layout.runtimeNode);
  requiredStagedFile(layout.launcher);
  requiredStagedFile(join(layout.appRoot, "package.json"));
  validateSetupManifest(readJsonRecord(setupManifestPath(root, target)), target, targetVersion);
  validatePackageJson(join(layout.appRoot, "package.json"), targetVersion);
  return layout;
}

function currentTrustAnchorLayout(
  target: UpdatePortableTarget,
  packageRoot: string | undefined,
):
  | { readonly currentLauncherPath: string; readonly currentAppBundlePath?: string | undefined }
  | undefined {
  const managedRoot = managedRootFromPackageRoot(target, packageRoot);
  if (managedRoot === undefined) return undefined;
  if (target === "windows-x64") return { currentLauncherPath: join(managedRoot, "Keiko.exe") };
  return {
    currentLauncherPath: join(managedRoot, "Contents", "MacOS", "Keiko"),
    currentAppBundlePath: managedRoot,
  };
}

async function verifyLocalPlatform(input: {
  readonly root: string;
  readonly target: UpdatePortableTarget;
  readonly layout: ReturnType<typeof stagedLayout>;
  readonly session: PortableUpdateStageInput;
  readonly verifier?: PortablePlatformVerifier | undefined;
}): Promise<void> {
  const verifier = input.verifier ?? verifyPortablePlatformSignature;
  const current = currentTrustAnchorLayout(input.target, input.session.runtimeFacts?.packageRoot);
  await verifier({
    target: input.target,
    stagedRoot: input.root,
    launcherPath: input.layout.launcher,
    ...(input.layout.appBundlePath === undefined
      ? {}
      : { appBundlePath: input.layout.appBundlePath }),
    ...(current ?? {}),
    ...(input.session.signal === undefined ? {} : { signal: input.session.signal }),
  });
}

export async function stageArchiveBytes(input: {
  readonly bytes: Uint8Array;
  readonly session: PortableUpdateStageInput;
  readonly target: UpdatePortableTarget;
  readonly targetVersion: string;
  readonly stageId: string;
  readonly sidecars: readonly PortableSidecarRuntimeVerification[];
  readonly platformVerifier?: PortablePlatformVerifier | undefined;
}): Promise<void> {
  const finalRoot = stagingRoot(input.session, input.target, input.stageId);
  const workRoot = mkdtempSync(join(dirname(finalRoot), `${input.stageId}.tmp-`));
  try {
    const extractedTreeSha256 = await extractArchive(input.bytes, workRoot);
    verifyExtractedTree(workRoot, extractedTreeSha256);
    const layout = validateStagedLayout(workRoot, input.target, input.targetVersion);
    await verifyLocalPlatform({
      root: workRoot,
      target: input.target,
      layout,
      session: input.session,
      verifier: input.platformVerifier,
    });
    verifyStagedSidecarPayloads({
      resourceRoot: stagedResourceRoot(workRoot, input.target),
      sidecars: input.sidecars,
    });
    rmSync(finalRoot, { recursive: true, force: true });
    renameSync(workRoot, finalRoot);
  } catch (error) {
    rmSync(workRoot, { recursive: true, force: true });
    throw error;
  }
}
