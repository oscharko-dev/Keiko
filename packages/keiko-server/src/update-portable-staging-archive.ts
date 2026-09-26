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
  statfsSync,
  statSync,
  type Dirent,
} from "node:fs";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { UpdatePortableTarget } from "@oscharko-dev/keiko-contracts";
import { bindSecurityLogCorrelation, type SecurityLogSink } from "@oscharko-dev/keiko-security";
import { atomicPublishTreeSwap } from "@oscharko-dev/keiko-security/fs-atomic-rename";
import yauzl from "yauzl";
import {
  MAX_ARCHIVE_ENTRIES,
  MAX_ENTRY_BYTES,
  MAX_INFLATE_RATIO,
  MIN_PORTABLE_DISK_MARGIN_BYTES,
  MAX_UNCOMPRESSED_BYTES,
  PACKAGE_NAME,
  PORTABLE_PAYLOAD_ROOT,
  PORTABLE_OPERATION_TIMEOUT_MS,
  PORTABLE_STAGE_DIR_PREFIX,
  fieldEquals,
  assertAbort,
  parseJsonRecord,
  primaryLauncher,
  recordAt,
  runtimeFor,
  reportPortableProgress,
  type PortablePlatformVerifier,
  type PortableUpdateStageInput,
  PortableUpdateStagingError,
} from "./update-portable-staging-shared.js";
import { hashPortableHandoffTree } from "./update-portable-handoff-tree.js";
import {
  parseWindowsGenerationBinding,
  portablePackageLayout,
  resolveWindowsGenerationLayout,
  windowsGenerationBindingsEqual,
  type WindowsGenerationBinding,
} from "./update-portable-windows-generation.js";
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

interface ExtractionProgressState {
  completedBytes: number;
  lastReportedBytes: number;
  lastReportedAt: number;
}

interface StagedLayout {
  readonly resourceRoot: string;
  readonly appRoot: string;
  readonly runtimeNode: string;
  readonly runtimeSupervisor?: string | undefined;
  readonly launcher: string;
  readonly appBundlePath?: string | undefined;
}

const WINDOWS_SUPPORT_LAUNCHER =
  '@echo off\r\nset "SCRIPT_DIR=%~dp0"\r\n"%SCRIPT_DIR%..\\Keiko.exe" %*\r\n';

function reportExtractionProgress(
  session: PortableUpdateStageInput,
  progress: ExtractionProgressState,
): void {
  reportPortableProgress(session, {
    phase: "staging",
    completedBytes: progress.completedBytes,
    totalBytes: session.candidate.portable?.uncompressedSizeBytes,
  });
  progress.lastReportedBytes = progress.completedBytes;
  progress.lastReportedAt = Date.now();
}

export function managedRootFromPackageRoot(
  target: UpdatePortableTarget,
  packageRoot: string | undefined,
): string | undefined {
  return portablePackageLayout(target, packageRoot)?.installRoot;
}

function assertNotSymlink(path: string): void {
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    throw new PortableUpdateStagingError(
      "portable-staging-failed",
      "portable staging path is unsafe",
    );
  }
}

function stagingBase(input: PortableUpdateStageInput, target: UpdatePortableTarget): string {
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
  return base;
}

function stagingRoot(
  input: PortableUpdateStageInput,
  target: UpdatePortableTarget,
  stageId: string,
): string {
  return join(stagingBase(input, target), stageId);
}

export function createPortableDownloadRoot(
  input: PortableUpdateStageInput,
  target: UpdatePortableTarget,
): string {
  return mkdtempSync(join(stagingBase(input, target), `${input.sessionId}.download-`));
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

export function requiredPortableDiskBytes(
  currentTreeBytes: number,
  archiveBytes: number,
  uncompressedBytes: number,
): number {
  const total = currentTreeBytes + archiveBytes + uncompressedBytes;
  return (
    archiveBytes +
    uncompressedBytes +
    Math.max(MIN_PORTABLE_DISK_MARGIN_BYTES, Math.ceil(total * 0.1))
  );
}

function managedEntrySize(cursor: string, entry: Dirent, pending: string[]): number {
  const path = join(cursor, entry.name);
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) {
    throw new PortableUpdateStagingError("portable-staging-failed", "managed tree is unsafe");
  }
  if (stat.isDirectory()) {
    pending.push(path);
    return 0;
  }
  if (stat.isFile()) return stat.size;
  throw new PortableUpdateStagingError("portable-staging-failed", "managed tree is unsafe");
}

function boundedCurrentTreeSize(root: string, signal: AbortSignal | undefined): number {
  let entries = 0;
  let bytes = 0;
  const pending = [root];
  while (pending.length > 0) {
    assertAbort(signal);
    const cursor = pending.pop();
    if (cursor === undefined) break;
    for (const entry of readdirSync(cursor, { withFileTypes: true })) {
      entries += 1;
      if (entries > MAX_ARCHIVE_ENTRIES) {
        throw new PortableUpdateStagingError(
          "portable-staging-failed",
          "managed tree exceeds limits",
        );
      }
      bytes += managedEntrySize(cursor, entry, pending);
      if (!Number.isSafeInteger(bytes)) {
        throw new PortableUpdateStagingError(
          "portable-staging-failed",
          "managed tree size is invalid",
        );
      }
    }
  }
  return bytes;
}

function availableDiskBytes(path: string): number {
  const stats = statfsSync(path);
  return stats.bavail * stats.bsize;
}

function assertManagedRootAvailable(managedRoot: string): void {
  try {
    const root = lstatSync(managedRoot);
    if (!root.isDirectory() || root.isSymbolicLink()) {
      throw new PortableUpdateStagingError(
        "portable-preflight-ineligible",
        "managed install root is unavailable",
      );
    }
  } catch (error) {
    if (error instanceof PortableUpdateStagingError) throw error;
    throw new PortableUpdateStagingError(
      "portable-preflight-ineligible",
      "managed install root is unavailable",
    );
  }
}

export function assertPortableDiskHeadroom(
  session: PortableUpdateStageInput,
  target: UpdatePortableTarget,
  availableBytes?: (path: string) => number,
): void {
  const portable = session.candidate.portable;
  const managedRoot = managedRootFromPackageRoot(target, session.runtimeFacts?.packageRoot);
  if (portable === undefined || managedRoot === undefined) {
    throw new PortableUpdateStagingError(
      "portable-preflight-ineligible",
      "portable disk facts are unavailable",
    );
  }
  assertManagedRootAvailable(managedRoot);
  const currentBytes = boundedCurrentTreeSize(managedRoot, session.signal);
  const available = availableBytes?.(managedRoot) ?? availableDiskBytes(managedRoot);
  const required = requiredPortableDiskBytes(
    currentBytes,
    portable.sizeBytes,
    portable.uncompressedSizeBytes,
  );
  if (!Number.isSafeInteger(available) || available < required) {
    throw new PortableUpdateStagingError(
      "portable-staging-failed",
      "portable staging disk headroom is insufficient",
    );
  }
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

function openZip(path: string): Promise<yauzl.ZipFile> {
  return new Promise((resolveZip, reject) => {
    yauzl.open(path, { lazyEntries: true, decodeStrings: true }, (error, zip) => {
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
    });
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

function hashingTransform(
  hash: ReturnType<typeof createHash>,
  progress: ExtractionProgressState,
  session: PortableUpdateStageInput,
): Transform {
  return new Transform({
    transform(chunk: Buffer, _encoding, callback): void {
      hash.update(chunk);
      progress.completedBytes += chunk.byteLength;
      const now = Date.now();
      if (
        progress.completedBytes - progress.lastReportedBytes >= 1024 * 1024 ||
        now - progress.lastReportedAt >= 1_000
      ) {
        reportExtractionProgress(session, progress);
      }
      callback(null, chunk);
    },
  });
}

async function writeZipEntry(
  zip: yauzl.ZipFile,
  entry: yauzl.Entry,
  destination: string,
  session: PortableUpdateStageInput,
  progress: ExtractionProgressState,
): Promise<string> {
  const mode = entryFileMode(entry);
  const hash = createHash("sha256");
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  await pipeline(
    await openEntryStream(zip, entry),
    hashingTransform(hash, progress, session),
    createWriteStream(destination, { mode }),
    { signal: session.signal },
  );
  chmodSync(destination, mode);
  return hash.digest("hex");
}

interface ArchiveExtractionContext {
  readonly zip: yauzl.ZipFile;
  readonly root: string;
  readonly state: PortableArchiveLimitState;
  readonly files: ExtractedTreeFile[];
  readonly seen: Set<string>;
  readonly session: PortableUpdateStageInput;
  readonly progress: ExtractionProgressState;
}

async function handleEntry(context: ArchiveExtractionContext, entry: yauzl.Entry): Promise<void> {
  const { zip, root, state, files, seen, session, progress } = context;
  assertAbort(session.signal);
  assertPortableArchiveEntryLimits(entry, state);
  const declaredInflated = session.candidate.portable?.uncompressedSizeBytes;
  if (declaredInflated === undefined || state.inflated > declaredInflated) {
    throw new PortableUpdateStagingError(
      "portable-staging-failed",
      "portable archive exceeds its reviewed inflated size",
    );
  }
  const contained = containedEntry(root, entry.fileName);
  const type = entryType(entry);
  if (contained === undefined || type === "unsafe") {
    throw new PortableUpdateStagingError(
      "portable-staging-failed",
      "portable archive contains unsafe entries",
    );
  }
  if (seen.has(contained.relativeName)) {
    throw new PortableUpdateStagingError(
      "portable-staging-failed",
      "portable archive contains duplicate entries",
    );
  }
  seen.add(contained.relativeName);
  if (type === "directory") {
    mkdirSync(contained.destination, { recursive: true, mode: 0o700 });
    return;
  }
  files.push({
    relativePath: contained.relativeName,
    sha256: await writeZipEntry(zip, entry, contained.destination, session, progress),
  });
  reportExtractionProgress(session, progress);
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

async function extractArchive(
  archivePath: string,
  destination: string,
  session: PortableUpdateStageInput,
): Promise<string> {
  assertAbort(session.signal);
  const zip = await openZip(archivePath);
  const state = { entries: 0, inflated: 0 };
  const progress = { completedBytes: 0, lastReportedBytes: 0, lastReportedAt: Date.now() };
  const files: ExtractedTreeFile[] = [];
  const seen = new Set<string>();
  const context = { zip, root: destination, state, files, seen, session, progress };
  let rejectAbort: (() => void) | undefined;
  try {
    await new Promise<void>((resolveDone, reject) => {
      rejectAbort = (): void => {
        reject(new PortableUpdateStagingError("cancelled", "cancelled"));
      };
      zip.on("entry", (entry: yauzl.Entry) => {
        void handleEntry(context, entry).then(() => {
          zip.readEntry();
        }, reject);
      });
      zip.once("end", resolveDone);
      zip.once("error", reject);
      session.signal?.addEventListener("abort", rejectAbort, { once: true });
      zip.readEntry();
    });
  } finally {
    if (rejectAbort !== undefined) session.signal?.removeEventListener("abort", rejectAbort);
    zip.close();
  }
  reportExtractionProgress(session, progress);
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
  if (target === "windows-x64" || target === "linux-x64") {
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
  if (!existsSync(path)) {
    throw new PortableUpdateStagingError("portable-staging-failed", "staged layout is incomplete");
  }
  const entry = lstatSync(path);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) {
    throw new PortableUpdateStagingError("portable-staging-failed", "staged layout is incomplete");
  }
}

function validateSetupManifest(
  record: Record<string, unknown>,
  target: UpdatePortableTarget,
  targetVersion: string,
  windowsGeneration: WindowsGenerationBinding | undefined,
): void {
  const runtime = recordAt(record, "runtime");
  const expected = runtimeFor(target);
  const eligible = [
    record.schemaVersion === (target === "windows-x64" ? 2 : 1),
    record.platformTarget === target,
    record.packageName === PACKAGE_NAME,
    record.packageVersion === targetVersion,
    record.stable === true,
    record.bootstrapUpdateEligible === false,
    record.primaryLauncher === primaryLauncher(target),
    fieldEquals(runtime, "nodePlatform", expected.platform),
    fieldEquals(runtime, "nodeArchitecture", expected.arch),
  ].every(Boolean);
  if (!eligible) {
    throw new PortableUpdateStagingError(
      "portable-staging-failed",
      "setup manifest is not eligible",
    );
  }
  if (target === "windows-x64") {
    validateWindowsSetupBinding(record, windowsGeneration);
  } else if (record.windowsGeneration !== undefined) {
    throw new PortableUpdateStagingError(
      "portable-staging-failed",
      "setup manifest Windows generation binding is unsupported for target",
    );
  }
}

function validateWindowsSetupBinding(
  record: Record<string, unknown>,
  expected: WindowsGenerationBinding | undefined,
): void {
  const setupGeneration = parseWindowsGenerationBinding(record.windowsGeneration);
  if (
    expected === undefined ||
    setupGeneration === undefined ||
    !windowsGenerationBindingsEqual(setupGeneration, expected)
  ) {
    throw new PortableUpdateStagingError(
      "portable-staging-failed",
      "setup manifest Windows generation binding does not match the reviewed manifest",
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
  windowsGeneration: WindowsGenerationBinding | undefined,
): StagedLayout {
  const payload = join(root, PORTABLE_PAYLOAD_ROOT);
  if (target === "windows-x64") {
    if (windowsGeneration === undefined) {
      throw new PortableUpdateStagingError(
        "portable-staging-failed",
        "reviewed Windows generation binding is unavailable",
      );
    }
    const generation = resolveWindowsGenerationLayout(payload, windowsGeneration);
    return {
      resourceRoot: generation.resourceRoot,
      appRoot: generation.appRoot,
      runtimeNode: generation.runtimeNodePath,
      runtimeSupervisor: generation.runtimeSupervisorPath,
      launcher: generation.rootLauncherPath,
    };
  }
  if (target === "linux-x64") {
    return {
      resourceRoot: payload,
      appRoot: join(payload, "app"),
      runtimeNode: join(payload, "runtime", "node", "bin", "node"),
      runtimeSupervisor: join(payload, "runtime", "native", "keiko-runtime-supervisor"),
      launcher: join(payload, "Keiko"),
    };
  }
  const bundle = join(payload, "Keiko.app");
  return {
    resourceRoot: join(bundle, "Contents", "Resources"),
    appBundlePath: bundle,
    appRoot: join(bundle, "Contents", "Resources", "app"),
    runtimeNode: join(bundle, "Contents", "Resources", "runtime", "node", "bin", "node"),
    launcher: join(bundle, "Contents", "MacOS", "Keiko"),
  };
}

async function validateStagedLayout(
  root: string,
  target: UpdatePortableTarget,
  targetVersion: string,
  windowsGeneration: WindowsGenerationBinding | undefined,
  signal: AbortSignal | undefined,
  securityLogSink: SecurityLogSink | undefined,
): Promise<StagedLayout> {
  const layout = stagedLayout(root, target, windowsGeneration);
  requiredStagedFile(layout.runtimeNode);
  requiredStagedFile(layout.launcher);
  requiredStagedFile(join(layout.appRoot, "package.json"));
  const setupPath = setupManifestPath(root, target);
  requiredStagedFile(setupPath);
  validateSetupManifest(readJsonRecord(setupPath), target, targetVersion, windowsGeneration);
  validatePackageJson(join(layout.appRoot, "package.json"), targetVersion);
  if (target === "windows-x64" && windowsGeneration !== undefined) {
    await validateWindowsGenerationArchive(
      root,
      layout,
      windowsGeneration,
      signal,
      securityLogSink,
    );
  }
  return layout;
}

async function validateWindowsGenerationArchive(
  root: string,
  layout: StagedLayout,
  binding: WindowsGenerationBinding,
  signal: AbortSignal | undefined,
  securityLogSink: SecurityLogSink | undefined,
): Promise<void> {
  const payload = join(root, PORTABLE_PAYLOAD_ROOT);
  const generationsRoot = join(payload, ".portable", "generations");
  requiredStagedFile(layout.runtimeSupervisor ?? "");
  validateWindowsGenerationDirectories(payload, generationsRoot, binding);
  validateWindowsRootFiles(payload, layout.launcher, binding);
  const treeSha256 = await stagedWindowsGenerationDigest(
    layout.resourceRoot,
    signal,
    securityLogSink,
  );
  if (treeSha256 !== binding.treeSha256) {
    throw new PortableUpdateStagingError(
      "portable-staging-failed",
      "staged Windows generation digest mismatch",
    );
  }
}

function validateWindowsGenerationDirectories(
  payload: string,
  generationsRoot: string,
  binding: WindowsGenerationBinding,
): void {
  const valid = [
    !existsSync(join(payload, "app")),
    !existsSync(join(payload, "runtime")),
    existsSync(generationsRoot),
    existsSync(generationsRoot) && lstatSync(generationsRoot).isDirectory(),
    existsSync(generationsRoot) && readdirSync(generationsRoot).join("\0") === binding.treeSha256,
  ].every(Boolean);
  if (!valid) {
    throw new PortableUpdateStagingError(
      "portable-staging-failed",
      "staged Windows generation layout is invalid",
    );
  }
}

function validateWindowsRootFiles(
  payload: string,
  launcher: string,
  binding: WindowsGenerationBinding,
): void {
  const supportLauncher = join(payload, "support", "keiko-support.cmd");
  requiredStagedFile(supportLauncher);
  if (readFileSync(supportLauncher, "utf8") !== WINDOWS_SUPPORT_LAUNCHER) {
    throw new PortableUpdateStagingError(
      "portable-staging-failed",
      "staged Windows support launcher is not canonical",
    );
  }
  if (
    createHash("sha256").update(readFileSync(launcher)).digest("hex") !== binding.launcherSha256
  ) {
    throw new PortableUpdateStagingError(
      "portable-staging-failed",
      "staged Windows root launcher digest mismatch",
    );
  }
}

async function stagedWindowsGenerationDigest(
  resourceRoot: string,
  signal: AbortSignal | undefined,
  securityLogSink: SecurityLogSink | undefined,
): Promise<string> {
  try {
    return await hashPortableHandoffTree(resourceRoot, {
      signal,
      deadline: Date.now() + PORTABLE_OPERATION_TIMEOUT_MS,
      securityLogSink,
    });
  } catch {
    throw new PortableUpdateStagingError(
      "portable-staging-failed",
      "staged Windows generation could not be attested",
    );
  }
}

function currentTrustAnchorLayout(
  target: UpdatePortableTarget,
  packageRoot: string | undefined,
):
  | { readonly currentLauncherPath: string; readonly currentAppBundlePath?: string | undefined }
  | undefined {
  const managedRoot = managedRootFromPackageRoot(target, packageRoot);
  if (managedRoot === undefined) return undefined;
  if (target === "windows-x64" || target === "linux-x64") {
    return {
      currentLauncherPath: join(managedRoot, target === "windows-x64" ? "Keiko.exe" : "Keiko"),
    };
  }
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
    ...current,
    ...(input.session.signal === undefined ? {} : { signal: input.session.signal }),
  });
}

export async function stageArchiveFile(input: {
  readonly archivePath: string;
  readonly session: PortableUpdateStageInput;
  readonly target: UpdatePortableTarget;
  readonly targetVersion: string;
  readonly stageId: string;
  readonly sidecars: readonly PortableSidecarRuntimeVerification[];
  readonly nativePlatformVerificationRequired?: boolean | undefined;
  readonly windowsGeneration?: WindowsGenerationBinding | undefined;
  readonly platformVerifier?: PortablePlatformVerifier | undefined;
  readonly securityLogSink?: SecurityLogSink | undefined;
  readonly rename?: typeof renameSync | undefined;
  readonly platform?: NodeJS.Platform | undefined;
  readonly sleep?: ((ms: number) => void) | undefined;
}): Promise<void> {
  const finalRoot = stagingRoot(input.session, input.target, input.stageId);
  const workRoot = mkdtempSync(join(dirname(finalRoot), `${input.stageId}.tmp-`));
  try {
    const extractedTreeSha256 = await extractArchive(input.archivePath, workRoot, input.session);
    assertAbort(input.session.signal);
    verifyExtractedTree(workRoot, extractedTreeSha256);
    const layout = await validateStagedLayout(
      workRoot,
      input.target,
      input.targetVersion,
      input.windowsGeneration,
      input.session.signal,
      bindSecurityLogCorrelation(input.securityLogSink, input.session.sessionId),
    );
    if (input.nativePlatformVerificationRequired !== false) {
      await verifyLocalPlatform({
        root: workRoot,
        target: input.target,
        layout,
        session: input.session,
        verifier: input.platformVerifier,
      });
    }
    verifyStagedSidecarPayloads({
      resourceRoot: layout.resourceRoot,
      sidecars: input.sidecars,
    });
    assertAbort(input.session.signal);
    rmSync(finalRoot, { recursive: true, force: true });
    publishStagedArchiveTree(workRoot, finalRoot, input);
  } catch (error) {
    rmSync(workRoot, { recursive: true, force: true });
    throw error;
  }
}

export function publishStagedArchiveTree(
  workRoot: string,
  finalRoot: string,
  input: {
    readonly stageId: string;
    readonly securityLogSink?: SecurityLogSink | undefined;
    readonly rename?: typeof renameSync | undefined;
    readonly platform?: NodeJS.Platform | undefined;
    readonly sleep?: ((ms: number) => void) | undefined;
  },
): void {
  atomicPublishTreeSwap(workRoot, finalRoot, {
    rename: input.rename ?? renameSync,
    ...(input.platform === undefined ? {} : { platform: input.platform }),
    ...(input.sleep === undefined ? {} : { sleep: input.sleep }),
    ...boundRenameSink(input.securityLogSink, input.stageId),
  });
}

function boundRenameSink(
  sink: SecurityLogSink | undefined,
  correlationId: string,
): { readonly securityLogSink: SecurityLogSink } | Record<string, never> {
  const bound = bindSecurityLogCorrelation(sink, correlationId);
  return bound === undefined ? {} : { securityLogSink: bound };
}
