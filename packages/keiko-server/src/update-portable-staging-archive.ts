import { Buffer } from "node:buffer";
import {
  chmodSync,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, dirname, join, posix, resolve, sep } from "node:path";
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
  type PortableUpdateStageInput,
  PortableUpdateStagingError,
} from "./update-portable-staging-shared.js";

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

function containedEntryPath(root: string, name: string): string | undefined {
  if (name.length === 0 || /[\0\r\n]/u.test(name) || /^[A-Za-z]:/u.test(name)) return undefined;
  const normalized = posix.normalize(name.replaceAll("\\", "/"));
  if (normalized === "." || normalized.startsWith("../") || normalized.startsWith("/"))
    return undefined;
  if (normalized.split("/").some((part) => part === ".." || part.length === 0)) return undefined;
  const destination = resolve(root, ...normalized.split("/"));
  const resolvedRoot = resolve(root);
  return destination === resolvedRoot || destination.startsWith(`${resolvedRoot}${sep}`)
    ? destination
    : undefined;
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

function assertEntryLimits(entry: yauzl.Entry, state: { entries: number; inflated: number }): void {
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

async function writeZipEntry(
  zip: yauzl.ZipFile,
  entry: yauzl.Entry,
  destination: string,
): Promise<void> {
  const mode = entryFileMode(entry);
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  await pipeline(await openEntryStream(zip, entry), createWriteStream(destination, { mode }));
  chmodSync(destination, mode);
}

async function handleEntry(
  zip: yauzl.ZipFile,
  entry: yauzl.Entry,
  root: string,
  state: { entries: number; inflated: number },
): Promise<void> {
  assertEntryLimits(entry, state);
  const destination = containedEntryPath(root, entry.fileName);
  const type = entryType(entry);
  if (destination === undefined || type === "unsafe") {
    throw new PortableUpdateStagingError(
      "portable-staging-failed",
      "portable archive contains unsafe entries",
    );
  }
  if (type === "directory") {
    mkdirSync(destination, { recursive: true, mode: 0o700 });
    return;
  }
  await writeZipEntry(zip, entry, destination);
}

async function extractArchive(bytes: Uint8Array, destination: string): Promise<void> {
  const zip = await openZip(bytes);
  const state = { entries: 0, inflated: 0 };
  try {
    await new Promise<void>((resolveDone, reject) => {
      zip.on("entry", (entry: yauzl.Entry) => {
        void handleEntry(zip, entry, destination, state).then(() => {
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
}

function readJsonRecord(path: string): Record<string, unknown> {
  const record = parseJsonRecord(readFileSync(path, "utf8"));
  if (record === undefined) {
    throw new PortableUpdateStagingError("portable-staging-failed", "staged JSON is malformed");
  }
  return record;
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
    appRoot: join(bundle, "Contents", "Resources", "app"),
    runtimeNode: join(bundle, "Contents", "Resources", "runtime", "node", "bin", "node"),
    launcher: join(bundle, "Contents", "MacOS", "Keiko"),
  };
}

function validateStagedLayout(
  root: string,
  target: UpdatePortableTarget,
  targetVersion: string,
): void {
  const layout = stagedLayout(root, target);
  requiredStagedFile(layout.runtimeNode);
  requiredStagedFile(layout.launcher);
  requiredStagedFile(join(layout.appRoot, "package.json"));
  validateSetupManifest(readJsonRecord(setupManifestPath(root, target)), target, targetVersion);
  validatePackageJson(join(layout.appRoot, "package.json"), targetVersion);
}

export async function stageArchiveBytes(input: {
  readonly bytes: Uint8Array;
  readonly session: PortableUpdateStageInput;
  readonly target: UpdatePortableTarget;
  readonly targetVersion: string;
  readonly stageId: string;
}): Promise<void> {
  const finalRoot = stagingRoot(input.session, input.target, input.stageId);
  const workRoot = mkdtempSync(join(dirname(finalRoot), `${input.stageId}.tmp-`));
  try {
    await extractArchive(input.bytes, workRoot);
    validateStagedLayout(workRoot, input.target, input.targetVersion);
    rmSync(finalRoot, { recursive: true, force: true });
    renameSync(workRoot, finalRoot);
  } catch (error) {
    rmSync(workRoot, { recursive: true, force: true });
    throw error;
  }
}
