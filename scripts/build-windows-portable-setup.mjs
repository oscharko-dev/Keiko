#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { Buffer } from "node:buffer";
import {
  closeSync,
  createReadStream,
  createWriteStream,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

import { isPortableExecutableFile } from "./lib/portable-executable.mjs";
import {
  assertSetupOverlayHeaderFitsBeforeEnd,
  assertZeroBytes,
  buildSetupOverlayHeader,
  portableExecutableOverlayBounds,
  readSetupOverlayHeaderFields,
  SETUP_OVERLAY_HEADER_BYTES,
  setupOverlayPayloadRegion,
} from "./lib/portable-setup-overlay.mjs";
import { resolveWindowsMsvcEnv, windowsToolFromPath } from "./lib/windows-msvc.mjs";

import {
  PORTABLE_TARGETS,
  portableManifestValidationFailuresForDeclaredLane,
  readPortableManifest,
  sha256File,
  WINDOWS_PORTABLE_SETUP_ASSET_NAME,
} from "./portable-runtime.mjs";

// Issue #2992: the setup companion is a Keiko-owned native bootstrap (MSVC-compiled,
// /SUBSYSTEM:CONSOLE, same lane as native/portable-launcher) with the portable ZIP appended as a
// hash-bound overlay (scripts/lib/portable-setup-overlay.mjs implements the frozen byte layout).
// IExpress/WExtract, the generated batch installer, and cmd.exe are gone from this surface
// entirely — WExtract's undocumented `/C:<command>` switch was a signature-laundering primitive
// against the Keiko Authenticode identity, and there is no SED field that disables it.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WINDOWS_TARGET = PORTABLE_TARGETS.find((target) => target.platformTarget === "windows-x64");
const DEFAULT_CATALOG_NAME = "windows-setup-signing-file.txt";
const MAX_SETUP_INPUT_BYTES = 2 * 1024 * 1024 * 1024;
const RUN_OUTPUT_BYTES = 64 * 1024 * 1024;
// 1 MiB bounded header-prefix scan window for streaming verification: large enough to cover any
// real PE's headers + section table without ever reading the whole (up to MAX_SETUP_INPUT_BYTES)
// file just to locate the overlay. Mirrors native/setup-bootstrap/keiko-setup-bootstrap.c's
// KEIKO_HEADER_SCAN_BYTES exactly -- the native stub already makes this same bounded-prefix
// assumption about its OWN running image at install time, so matching it here is parity, not a
// new risk.
const OVERLAY_HEADER_SCAN_BYTES = 1024 * 1024;
const VALUE_OPTION_FIELDS = new Map([
  ["--catalog", "catalog"],
  ["--output", "output"],
  ["--stage-root", "stageRoot"],
]);

export class WindowsPortableSetupError extends Error {}

// Split from `fail` so a rejection built OUTSIDE a throwable context (a stream "error" listener,
// where throwing would become an uncaught exception instead of failing the read) can still
// construct the identical error shape via `reject(windowsPortableSetupError(...))`.
function windowsPortableSetupError(message) {
  return new WindowsPortableSetupError(`build-windows-portable-setup: ${message}`);
}

function fail(message) {
  throw windowsPortableSetupError(message);
}

function readRequiredOptionValue(key, value) {
  if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) {
    fail(`${key} requires a value`);
  }
  return value;
}

function normalizeParsedOptions(options) {
  if (typeof options.stageRoot !== "string" || options.stageRoot.length === 0) {
    fail("--stage-root is required");
  }
  options.stageRoot = resolve(options.stageRoot);
  options.output = resolve(
    options.output ?? join(options.stageRoot, WINDOWS_PORTABLE_SETUP_ASSET_NAME),
  );
  options.catalog =
    typeof options.catalog === "string" && options.catalog.length > 0
      ? resolve(options.catalog)
      : undefined;
  if (options.catalog !== undefined) {
    if (basename(options.catalog) !== DEFAULT_CATALOG_NAME) {
      fail(`--catalog must be named ${DEFAULT_CATALOG_NAME}`);
    }
    if (dirname(options.catalog) !== dirname(options.output)) {
      fail("--catalog must be beside the staged setup companion");
    }
    assertCatalogOutputAbsent(options.catalog);
  }
  return options;
}

function parseArgs(argv) {
  const options = { verifyOnly: false };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--verify-only") {
      options.verifyOnly = true;
      continue;
    }
    const field = VALUE_OPTION_FIELDS.get(key);
    if (field === undefined) fail("invalid arguments");
    options[field] = readRequiredOptionValue(key, argv[index + 1]);
    index += 1;
  }
  return normalizeParsedOptions(options);
}

function assertRegularFile(path, label, maxBytes = MAX_SETUP_INPUT_BYTES) {
  let entry;
  try {
    entry = lstatSync(path);
  } catch {
    fail(`missing ${label}`);
  }
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) {
    fail(`${label} must be a regular unlinked file`);
  }
  if (entry.size <= 0 || entry.size > maxBytes) fail(`${label} has an invalid bounded size`);
  return entry;
}

function assertCatalogOutputAbsent(path) {
  try {
    lstatSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    fail("setup signing catalog path could not be inspected");
  }
  fail("setup signing catalog must not already exist");
}

function writeCatalogExclusive(path, content) {
  try {
    writeFileSync(path, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch {
    fail("setup signing catalog must be created as a new file");
  }
}

function contained(root, path) {
  const relativePath = relative(realpathSync(root), realpathSync(path));
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function canonicalWindowsSetupStageRoot(stageRoot) {
  if (WINDOWS_TARGET === undefined) fail("windows portable target is unavailable");
  let rootEntry;
  try {
    rootEntry = lstatSync(stageRoot);
  } catch {
    fail("missing stage root");
  }
  if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) {
    fail("stage root must be a regular directory");
  }
  return realpathSync(stageRoot);
}

function windowsSetupStageInputs(stageRoot) {
  const canonicalRoot = canonicalWindowsSetupStageRoot(stageRoot);
  const archivePath = join(canonicalRoot, WINDOWS_TARGET.assetName);
  const manifestPath = join(canonicalRoot, "manifest", "portable-manifest.json");
  const archiveStat = assertRegularFile(archivePath, "windows portable archive");
  assertRegularFile(manifestPath, "windows portable manifest", 16 * 1024 * 1024);
  if (!contained(canonicalRoot, archivePath) || !contained(canonicalRoot, manifestPath)) {
    fail("stage files must stay within the stage root");
  }
  return { archivePath, archiveStat, manifestPath, stageRoot: canonicalRoot };
}

// Asking the manifest which lane it declares is strictly stronger than the previous "pass if
// EITHER the candidate or the staging validator accepts" shape: a manifest now has to satisfy the
// rules of the exact lifecycle lane it claims.
function portableManifestValidationFailures(manifest) {
  return portableManifestValidationFailuresForDeclaredLane(manifest);
}

function validateWindowsPortableManifestIdentity(manifest) {
  if (
    manifest.artifact?.platformTarget !== WINDOWS_TARGET.platformTarget ||
    manifest.artifact?.assetName !== WINDOWS_TARGET.assetName ||
    manifest.entrypoints?.primaryLauncher !== WINDOWS_TARGET.primaryLauncher
  ) {
    fail("portable manifest does not describe the canonical windows-x64 archive");
  }
}

export async function validateWindowsSetupStage(stageRoot) {
  const {
    archivePath,
    archiveStat,
    manifestPath,
    stageRoot: canonicalRoot,
  } = windowsSetupStageInputs(stageRoot);
  const manifest = readPortableManifest(manifestPath);
  const failures = portableManifestValidationFailures(manifest);
  if (failures.length > 0) {
    fail(`portable manifest is invalid:\n  - ${failures.join("\n  - ")}`);
  }
  validateWindowsPortableManifestIdentity(manifest);
  if (archiveStat.size !== manifest.artifact?.sizeBytes) {
    fail("windows portable archive size does not match the manifest");
  }
  if ((await sha256File(archivePath)) !== manifest.artifact?.sha256) {
    fail("windows portable archive digest does not match the manifest");
  }
  return { archivePath, manifest, manifestPath, stageRoot: canonicalRoot };
}

export function validateWindowsSetupOutputPath(outputPath, stageRoot) {
  if (basename(outputPath) !== WINDOWS_PORTABLE_SETUP_ASSET_NAME) {
    fail(`--output must be named ${WINDOWS_PORTABLE_SETUP_ASSET_NAME}`);
  }
  let outputParent;
  let canonicalStageRoot;
  try {
    outputParent = realpathSync(dirname(outputPath));
    canonicalStageRoot = realpathSync(stageRoot);
  } catch {
    fail("--output parent must be the existing stage root");
  }
  if (outputParent !== canonicalStageRoot) {
    fail("--output must stay directly within the stage root");
  }
}

function requireWindowsHost() {
  if (process.platform !== "win32") fail("windows setup bootstrap build requires a Windows host");
}

// Any failure raised by the pure overlay codec (scripts/lib/portable-setup-overlay.mjs) is
// re-raised as this script's own error type, so every caller of this file sees one consistent
// failure class regardless of which layer actually detected the malformed/tampered input.
function callOverlayLib(action) {
  try {
    return action();
  } catch (error) {
    fail(error instanceof Error ? error.message : "windows setup overlay is malformed");
  }
}

function readExactAt(fd, offset, length, label) {
  const buffer = Buffer.alloc(length);
  const bytesRead = readSync(fd, buffer, 0, length, offset);
  if (bytesRead !== length) fail(`${label} is truncated or out of bounds`);
  return buffer;
}

/**
 * Streaming, bounded-memory counterpart to parseSetupOverlay
 * (scripts/lib/portable-setup-overlay.mjs): locates and validates a setup companion's overlay
 * using only a handful of small positioned reads, never the whole (up to MAX_SETUP_INPUT_BYTES)
 * file. Mirrors native/setup-bootstrap/keiko-setup-bootstrap.c's keiko_extract_verified_payload
 * ordering exactly -- a bounded header-prefix scan locates the overlay
 * (portableExecutableOverlayBounds, matching keiko_parse_overlay_bounds), a small positioned read
 * decodes the fixed-size overlay header (readSetupOverlayHeaderFields, matching
 * keiko_validate_overlay_header), and the <=7 trailing padding bytes are read and zero-checked
 * directly (setupOverlayPayloadRegion + assertZeroBytes, matching keiko_payload_region). Returns
 * the same shape as parseSetupOverlay — the header's declared digest, the declared payload size,
 * and where the payload begins — so callers hash the payload (hashSetupOverlayPayload, below)
 * only once they've confirmed it is worth hashing.
 */
function parseSetupOverlayFromFile(setupPath) {
  const fd = openSync(setupPath, "r");
  try {
    const fileSizeBytes = fstatSync(fd).size;
    const prefix = readExactAt(
      fd,
      0,
      Math.min(fileSizeBytes, OVERLAY_HEADER_SCAN_BYTES),
      "windows setup companion header prefix",
    );
    const { overlayEnd, overlayStart } = callOverlayLib(() =>
      portableExecutableOverlayBounds(prefix, fileSizeBytes),
    );
    const header = readExactAt(
      fd,
      overlayStart,
      SETUP_OVERLAY_HEADER_BYTES,
      "setup overlay header",
    );
    callOverlayLib(() => assertSetupOverlayHeaderFitsBeforeEnd(overlayStart, overlayEnd));
    const { payloadSha256Hex, payloadSize } = callOverlayLib(() =>
      readSetupOverlayHeaderFields(header),
    );
    const payloadStart = overlayStart + SETUP_OVERLAY_HEADER_BYTES;
    const { paddingBytes, payloadEnd } = callOverlayLib(() =>
      setupOverlayPayloadRegion(payloadStart, payloadSize, overlayEnd),
    );
    if (paddingBytes > 0) {
      const padding = readExactAt(fd, payloadEnd, paddingBytes, "setup overlay trailing padding");
      callOverlayLib(() => assertZeroBytes(padding, "setup overlay trailing padding"));
    }
    return { payloadSha256Hex, payloadSize, payloadStart };
  } finally {
    closeSync(fd);
  }
}

// Hashes ONLY the payload region [payloadStart, payloadStart + payloadSize) through a stream, so
// verifying a setup companion near the documented MAX_SETUP_INPUT_BYTES bound never requires a
// multi-gigabyte contiguous Buffer — the OOM this pairing (with parseSetupOverlayFromFile above)
// exists to close. Mirrors the native stub's keiko_stream_sha256: the byte count actually streamed
// is checked against the declared size before the digest is trusted, so a file that shrinks out
// from under a concurrent read fails closed instead of silently hashing a truncated payload as if
// it were complete.
function hashSetupOverlayPayload(setupPath, payloadStart, payloadSize) {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash("sha256");
    if (payloadSize === 0) {
      resolvePromise(hash.digest("hex"));
      return;
    }
    let bytesHashed = 0;
    createReadStream(setupPath, { start: payloadStart, end: payloadStart + payloadSize - 1 })
      .on("data", (chunk) => {
        bytesHashed += chunk.length;
        hash.update(chunk);
      })
      .on("error", (error) => {
        reject(
          windowsPortableSetupError(
            `windows setup companion payload could not be streamed (code=${error?.code ?? "unknown"})`,
          ),
        );
      })
      .on("end", () => {
        if (bytesHashed !== payloadSize) {
          reject(
            windowsPortableSetupError(
              "windows setup companion payload is truncated or out of bounds",
            ),
          );
          return;
        }
        resolvePromise(hash.digest("hex"));
      });
  });
}

/**
 * Non-executing, cross-platform verification: confirms the setup companion's name and PE shape,
 * locates its overlay, and proves the embedded payload is byte-identical to the staged archive —
 * both via the header's declared digest AND an independent re-hash of the bytes actually present
 * in the file, so a header that lies about its own payload cannot pass. No host requirement: this
 * used to require running the (Windows-only, LOLBin-capable) extractor; parsing an appended,
 * hash-bound overlay needs nothing platform-specific. Verification is streamed
 * (parseSetupOverlayFromFile + hashSetupOverlayPayload) rather than buffering the whole setup
 * companion, so a valid artifact near the documented MAX_SETUP_INPUT_BYTES bound never needs a
 * multi-gigabyte contiguous allocation just to verify.
 */
export async function verifyWindowsPortableSetup(setupPath, archivePath) {
  assertRegularFile(setupPath, "windows setup companion");
  if (basename(setupPath) !== WINDOWS_PORTABLE_SETUP_ASSET_NAME) {
    fail(`windows setup companion must be named ${WINDOWS_PORTABLE_SETUP_ASSET_NAME}`);
  }
  if (!isPortableExecutableFile(setupPath)) fail("windows setup companion is not a PE file");
  const archiveStat = assertRegularFile(archivePath, "windows portable archive");
  const overlay = parseSetupOverlayFromFile(setupPath);
  if (overlay.payloadSize !== archiveStat.size) {
    fail("windows setup companion payload size does not match the staged archive");
  }
  const archiveSha256 = await sha256File(archivePath);
  const embeddedSha256 = await hashSetupOverlayPayload(
    setupPath,
    overlay.payloadStart,
    overlay.payloadSize,
  );
  if (overlay.payloadSha256Hex !== archiveSha256 || embeddedSha256 !== archiveSha256) {
    fail("windows setup companion payload digest does not match the staged archive");
  }
}

/* v8 ignore next -- MSVC subprocess boundary is exercised by the Windows smoke job. */
function run(command, args, label, options = {}) {
  // Compilation and the streamed archive append can process the full 2 GiB accepted input; the
  // owning workflow job provides the bounded timeout without imposing a size-inconsistent
  // subprocess cap here.
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: RUN_OUTPUT_BYTES,
    ...options,
  });
  if (result.error !== undefined || result.status !== 0) {
    const outputBytes = [result.stdout, result.stderr]
      .filter((text) => typeof text === "string")
      .reduce((total, text) => total + Buffer.byteLength(text, "utf8"), 0);
    fail(
      `${label} failed (status=${result.status ?? "none"} signal=${result.signal ?? "none"} outputBytes=${outputBytes})`,
    );
  }
}

function setupBootstrapSourcePath() {
  return join(repoRoot, "native", "setup-bootstrap", "keiko-setup-bootstrap.c");
}

function setupBootstrapResourcePath() {
  return join(repoRoot, "native", "setup-bootstrap", "keiko-setup-bootstrap.rc");
}

// Defence in depth for a SHIPPED, SIGNED installer: the digest and size are baked into the stub as
// C preprocessor tokens, and the stub compares the streamed payload against the baked digest with a
// fixed-length read. A malformed digest (wrong length/charset) or a non-positive size would produce
// an installer that can never accept its own payload. Reject it here — at build time — rather than
// discovering it only when a customer's install fails closed. Kept pure + exported so it is covered
// cross-platform, independent of the Windows-only compile below.
export function assertBakedPayloadIdentity(payloadSha256Hex, payloadSizeBytes) {
  if (typeof payloadSha256Hex !== "string" || !/^[0-9a-f]{64}$/u.test(payloadSha256Hex)) {
    fail("setup bootstrap payload digest must be 64 lowercase hex characters");
  }
  if (!Number.isSafeInteger(payloadSizeBytes) || payloadSizeBytes <= 0) {
    fail("setup bootstrap payload size must be a positive safe integer");
  }
}

/* v8 ignore start -- native compile, overlay append, and catalog write run only on the Windows
   build host; exercised end to end by the protected Windows workflow's setup-bootstrap smoke. */
function requireSetupBootstrapNativeSources() {
  assertRegularFile(setupBootstrapSourcePath(), "setup bootstrap native source");
  assertRegularFile(setupBootstrapResourcePath(), "setup bootstrap native resource script");
}

/**
 * Compiles the Keiko-owned native setup bootstrap stub (native/setup-bootstrap): a console
 * executable with the expected payload identity baked in via preprocessor defines (frozen SPEC v1
 * section 2), mirroring how stage-portable-runtime.mjs's `compileWindowsLauncher` builds the
 * portable launcher — same rc.exe + cl.exe pattern, same MSVC environment resolution
 * (scripts/lib/windows-msvc.mjs). Unlike the launcher, the stub is `/SUBSYSTEM:CONSOLE` with NO
 * `/ENTRY` override: the console CRT resolves `wmainCRTStartup` from the source's `wmain`
 * automatically, so a double-click still gets a visible progress console.
 */
export function compileSetupBootstrap({ payloadSha256Hex, payloadSizeBytes, outputPath }) {
  assertBakedPayloadIdentity(payloadSha256Hex, payloadSizeBytes);
  requireSetupBootstrapNativeSources();
  const env = resolveWindowsMsvcEnv();
  const tempRoot = mkdtempSync(join(tmpdir(), "keiko-setup-bootstrap-resource-"));
  try {
    const resourcePath = join(tempRoot, "keiko-setup-bootstrap.res");
    // /Fo keeps the intermediate object OUT of the checkout (review 3887051433): without it
    // cl.exe writes keiko-setup-bootstrap.obj into the working directory — the repository root on
    // the signing runner — leaving an untracked artifact a signing job then inventories.
    const objectPath = join(tempRoot, "keiko-setup-bootstrap.obj");
    run(
      windowsToolFromPath(env.PATH, "rc.exe"),
      ["/nologo", `/fo${resourcePath}`, setupBootstrapResourcePath()],
      "setup bootstrap resource compile",
      { env },
    );
    run(
      windowsToolFromPath(env.PATH, "cl.exe"),
      [
        "/nologo",
        "/O2",
        // Static CRT. An installer is by construction the FIRST Keiko code to run on a machine with
        // nothing installed yet, so it must not depend on a VC runtime redistributable being
        // present — and, security-wise, it removes the plantable CRT DLLs from the set of implicit
        // imports the loader resolves out of the application directory before wmain runs.
        "/MT",
        "/DUNICODE",
        "/D_UNICODE",
        `/DKEIKO_SETUP_TARGET="windows-x64"`,
        `/DKEIKO_SETUP_PAYLOAD_SHA256_HEX="${payloadSha256Hex}"`,
        `/DKEIKO_SETUP_PAYLOAD_SIZE_BYTES=${String(payloadSizeBytes)}ULL`,
        `/Fo:${objectPath}`,
        `/Fe:${outputPath}`,
        setupBootstrapSourcePath(),
        resourcePath,
        "/link",
        "/SUBSYSTEM:CONSOLE",
        // LOAD_LIBRARY_SEARCH_SYSTEM32 for STATICALLY-LINKED imports. wmain's own
        // SetDefaultDllDirectories/SetDllDirectoryW calls only affect later LoadLibraryEx-style
        // loads; this binary's implicit imports (bcrypt.dll) are resolved by the loader BEFORE the
        // first instruction of wmain, with the application directory searched first for anything
        // that is not a KnownDLL. That is precisely the launched-from-Downloads DLL-plant scenario,
        // and this flag is the only thing that closes it.
        "/DEPENDENTLOADFLAG:0x800",
      ],
      "setup bootstrap compile",
      { env },
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}
/* v8 ignore stop */

function fsyncFile(path) {
  const fd = openSync(path, "r+");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

// Streamed the same way as verifyWindowsPortableSetup above (parseSetupOverlayFromFile +
// hashSetupOverlayPayload) rather than buffering the just-written setup companion whole, so
// confirming a freshly appended overlay never needs a multi-gigabyte contiguous allocation either.
async function verifyAppendedSetupOverlay(outputPath, expectedSizeBytes, expectedSha256Hex) {
  const overlay = parseSetupOverlayFromFile(outputPath);
  if (overlay.payloadSize !== expectedSizeBytes || overlay.payloadSha256Hex !== expectedSha256Hex) {
    fail("appended setup overlay header does not match the intended payload");
  }
  const actualPayloadHash = await hashSetupOverlayPayload(
    outputPath,
    overlay.payloadStart,
    overlay.payloadSize,
  );
  if (actualPayloadHash !== expectedSha256Hex) {
    fail("appended setup overlay payload bytes do not match the intended digest");
  }
}

/**
 * Appends the portable archive to a compiled stub as a hash-bound overlay (frozen SPEC v1 section
 * 1): `[stub][64-byte header][payload]`. Cross-platform and independently testable — the stub only
 * needs to be a valid PE32+ image, not an executable one, so this can be exercised with a synthetic
 * fixture on any host. Writes through a same-directory temp file and an atomic rename so a reader
 * never observes a partially-written setup companion; a failure anywhere in that sequence removes
 * the temp file rather than leaving a partial artifact behind in the stage root.
 *
 * `expectedPayload` is the identity `validateWindowsSetupStage` already proved the staged archive
 * satisfies — the SAME `manifest.artifact.sha256`/`sizeBytes` baked into the compiled stub. The
 * overlay header is built from THAT validated identity, never from an independent fresh re-hash of
 * `archivePath`, so a mutation between stage validation and this call is caught as a drift failure
 * instead of silently being trusted and baked into the shipped installer.
 */
export async function appendSetupOverlay(stubPath, archivePath, outputPath, expectedPayload) {
  const { payloadSha256Hex, payloadSizeBytes } = expectedPayload;
  assertBakedPayloadIdentity(payloadSha256Hex, payloadSizeBytes);
  assertRegularFile(stubPath, "compiled setup stub");
  const stubBuffer = readFileSync(stubPath);
  const { overlayStart } = callOverlayLib(() => portableExecutableOverlayBounds(stubBuffer));
  if (overlayStart !== stubBuffer.length) {
    fail("compiled setup stub unexpectedly carries trailing data before the overlay is appended");
  }
  const archiveStat = assertRegularFile(archivePath, "windows portable archive payload");
  if (archiveStat.size !== payloadSizeBytes) {
    fail("windows portable archive no longer matches the validated manifest identity (size drift)");
  }
  if ((await sha256File(archivePath)) !== payloadSha256Hex) {
    fail(
      "windows portable archive no longer matches the validated manifest identity (digest drift)",
    );
  }
  const header = callOverlayLib(() =>
    buildSetupOverlayHeader({ payloadSha256Hex, payloadSizeBytes }),
  );
  const temporaryPath = `${outputPath}.tmp-${process.pid}`;
  rmSync(temporaryPath, { force: true });
  try {
    writeFileSync(temporaryPath, Buffer.concat([stubBuffer, header]), { flag: "wx", mode: 0o600 });
    // Streamed rather than buffered: the portable archive is roughly 130 MB, and the stub + header
    // prefix above is written first so this append only ever holds one archive-sized chunk in
    // flight at a time (the internal stream highWaterMark), not the whole payload in memory.
    await pipeline(createReadStream(archivePath), createWriteStream(temporaryPath, { flags: "a" }));
    fsyncFile(temporaryPath);
    // renameSync replaces an existing destination atomically on both POSIX (rename) and Windows
    // (MoveFileExW with MOVEFILE_REPLACE_EXISTING), so an explicit unlink first would only open a
    // window where outputPath does not exist at all — a strictly weaker guarantee.
    renameSync(temporaryPath, outputPath);
  } catch (error) {
    // A failure anywhere above (disk full mid-pipeline, a read error on the archive, an fsync or
    // rename failure) must not leave `${outputPath}.tmp-${process.pid}` behind in the stage root:
    // the rename above is the only step that moves ownership of temporaryPath's bytes to
    // outputPath, so up to that point temporaryPath is this call's alone to clean up. The original
    // error is rethrown unchanged — never swallowed.
    rmSync(temporaryPath, { force: true });
    throw error;
  }
  await verifyAppendedSetupOverlay(outputPath, payloadSizeBytes, payloadSha256Hex);
  return outputPath;
}

// The Azure signing action's files-catalog names the file to sign RELATIVE to the catalog's own
// directory. The catalog and the setup companion are always siblings (validateWindowsSetupOutputPath
// plus the "--catalog beside the output" rule), so this reduces to the companion's basename — hence
// separator-independent and unit-testable cross-platform even though the catalog is written only on
// the Windows build host. Kept pure + exported so a wrong catalog target fails a local test, not
// only the Azure signing step on CI.
export function setupCatalogContent(catalogPath, outputPath) {
  return `${relative(dirname(catalogPath), outputPath)}\n`;
}

/* v8 ignore start -- native compile, overlay append, and catalog write run only on the Windows
   build host; exercised end to end by the protected Windows workflow's setup-bootstrap smoke. */
function writeWindowsSetupCatalog(options) {
  if (options.catalog === undefined) return;
  mkdirSync(dirname(options.catalog), { recursive: true });
  assertCatalogOutputAbsent(options.catalog);
  writeCatalogExclusive(options.catalog, setupCatalogContent(options.catalog, options.output));
}

async function performWindowsPortableSetupBuild(options, archivePath, manifest) {
  requireWindowsHost();
  mkdirSync(dirname(options.output), { recursive: true });
  const workRoot = mkdtempSync(join(tmpdir(), "keiko-setup-build-"));
  try {
    const stubPath = join(workRoot, "keiko-setup-bootstrap-stub.exe");
    compileSetupBootstrap({
      outputPath: stubPath,
      payloadSha256Hex: manifest.artifact.sha256,
      payloadSizeBytes: manifest.artifact.sizeBytes,
    });
    await appendSetupOverlay(stubPath, archivePath, options.output, {
      payloadSha256Hex: manifest.artifact.sha256,
      payloadSizeBytes: manifest.artifact.sizeBytes,
    });
    await verifyWindowsPortableSetup(options.output, archivePath);
    writeWindowsSetupCatalog(options);
  } finally {
    rmSync(workRoot, { force: true, recursive: true });
  }
}
/* v8 ignore stop */

export async function buildWindowsPortableSetup(argv, deps = {}) {
  const options = parseArgs(argv);
  const validateStageFn = deps.validateStageFn ?? validateWindowsSetupStage;
  const { archivePath, manifest, stageRoot } = await validateStageFn(options.stageRoot);
  validateWindowsSetupOutputPath(options.output, stageRoot);
  if (options.verifyOnly) {
    await verifyWindowsPortableSetup(options.output, archivePath);
    return options.output;
  }
  await performWindowsPortableSetupBuild(options, archivePath, manifest);
  return options.output;
}

/* v8 ignore start -- CLI error plumbing is covered by the protected Windows workflow. */
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const setupPath = await buildWindowsPortableSetup(process.argv.slice(2));
    console.log(`build-windows-portable-setup: ready ${setupPath}`);
  } catch (error) {
    console.error(
      error instanceof WindowsPortableSetupError
        ? error.message
        : "build-windows-portable-setup: redacted failure",
    );
    process.exit(1);
  }
}
/* v8 ignore stop */
