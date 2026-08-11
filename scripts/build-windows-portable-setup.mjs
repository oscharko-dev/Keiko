#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { Buffer } from "node:buffer";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isPortableExecutableFile } from "./lib/portable-executable.mjs";

import {
  PORTABLE_TARGETS,
  portableManifestValidationFailuresForDeclaredLane,
  readPortableManifest,
  sha256File,
  WINDOWS_PORTABLE_SETUP_ASSET_NAME,
} from "./portable-runtime.mjs";

const WINDOWS_TARGET = PORTABLE_TARGETS.find((target) => target.platformTarget === "windows-x64");
const INSTALL_SCRIPT_NAME = "install-keiko.cmd";
const COMMAND_PROCESSOR_SUFFIX = String.raw`System32\cmd.exe`;
const DEFAULT_CATALOG_NAME = "windows-setup-signing-file.txt";
const MAX_SETUP_INPUT_BYTES = 2 * 1024 * 1024 * 1024;
const RUN_OUTPUT_BYTES = 64 * 1024 * 1024;
const SYSTEM_TAR = String.raw`"%SystemRoot%\System32\tar.exe"`;
const VALUE_OPTION_FIELDS = new Map([
  ["--catalog", "catalog"],
  ["--output", "output"],
  ["--stage-root", "stageRoot"],
]);

export class WindowsPortableSetupError extends Error {}

function fail(message) {
  throw new WindowsPortableSetupError(`build-windows-portable-setup: ${message}`);
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

export function windowsSetupInstallerScript() {
  return [
    ...windowsSetupBootstrapLines(),
    ...windowsSetupPayloadLines(),
    ...windowsSetupInstallLines(),
    ...windowsSetupLaunchLines(),
    ...windowsSetupFailureLines(),
  ].join("\r\n");
}

function windowsSetupBootstrapLines() {
  return [
    "@echo off",
    "setlocal EnableExtensions DisableDelayedExpansion",
    `set "ARCHIVE=%~dp0${WINDOWS_TARGET.assetName}"`,
    'set "INSTALL_ROOT="',
    'set "ORIGINAL_CODE_PAGE="',
    String.raw`set "STAGING_ROOT=%TEMP%\Keiko-install-%RANDOM%-%RANDOM%"`,
    String.raw`set "EXTRACT_ROOT=%STAGING_ROOT%\Keiko"`,
    String.raw`set "MANAGED_ROOT_FILE=%STAGING_ROOT%\managed-root.txt"`,
    'set "KEIKO_INTERACTIVE=0"',
    'if /I "%~1"=="--interactive" set "KEIKO_INTERACTIVE=1"',
    "",
    "echo Keiko setup",
    "echo ===========",
    "echo.",
  ];
}

function windowsSetupPayloadLines() {
  return [
    "echo [1/6] Checking setup payload...",
    'if not exist "%ARCHIVE%" (',
    "  echo Keiko setup payload is missing.",
    "  goto failure",
    ")",
    "echo       Found embedded portable package.",
    'if exist "%STAGING_ROOT%" rmdir /s /q "%STAGING_ROOT%" >nul 2>nul',
    'mkdir "%STAGING_ROOT%"',
    "if errorlevel 1 goto failure",
    "echo [2/6] Extracting Keiko to a temporary staging folder...",
    `${SYSTEM_TAR} -xf "%ARCHIVE%" -C "%STAGING_ROOT%"`,
    "if errorlevel 1 goto failure",
    "echo       Extraction finished.",
    "echo [3/6] Verifying installed application files...",
    String.raw`if not exist "%EXTRACT_ROOT%\Keiko.exe" (`,
    "  echo Keiko setup payload did not contain Keiko.exe.",
    "  goto failure",
    ")",
    String.raw`if not exist "%EXTRACT_ROOT%\runtime\node\node.exe" (`,
    "  echo Keiko setup payload did not contain the bundled Node runtime.",
    "  goto failure",
    ")",
    String.raw`if not exist "%EXTRACT_ROOT%\app\dist\cli\index.js" (`,
    "  echo Keiko setup payload did not contain the Keiko CLI.",
    "  goto failure",
    ")",
    "echo       Keiko.exe found.",
    "echo       Bundled Node runtime found. No separate Node installation is required.",
    "echo       Keiko CLI found.",
    String.raw`"%EXTRACT_ROOT%\runtime\node\node.exe" "%EXTRACT_ROOT%\app\dist\cli\index.js" portable resolve-root --target windows-x64 --portable-root "%EXTRACT_ROOT%" > "%MANAGED_ROOT_FILE%"`,
    "if errorlevel 1 goto failure",
    `for /f "tokens=2 delims=:." %%C in ('chcp') do set "ORIGINAL_CODE_PAGE=%%C"`,
    'set "ORIGINAL_CODE_PAGE=%ORIGINAL_CODE_PAGE: =%"',
    "if not defined ORIGINAL_CODE_PAGE goto failure",
    "chcp 65001 >nul",
    "if errorlevel 1 goto failure",
    `set /p "INSTALL_ROOT="<"%MANAGED_ROOT_FILE%"`,
    "chcp %ORIGINAL_CODE_PAGE% >nul",
    "if errorlevel 1 goto failure",
    "if not defined INSTALL_ROOT (",
    "  echo Keiko setup could not resolve the managed install root.",
    "  goto failure",
    ")",
  ];
}

function windowsSetupInstallLines() {
  return [
    "echo [4/6] Checking the managed install through Keiko portable authority...",
    'if exist "%INSTALL_ROOT%" goto validate_existing',
    "echo [5/6] Installing Keiko through the governed portable lifecycle...",
    String.raw`"%EXTRACT_ROOT%\runtime\node\node.exe" "%EXTRACT_ROOT%\app\dist\cli\index.js" portable setup --target windows-x64 --portable-root "%EXTRACT_ROOT%" --managed-root "%INSTALL_ROOT%"`,
    "if errorlevel 1 goto failure",
    "echo       Portable lifecycle accepted the installation.",
    "goto launch_managed",
    ":validate_existing",
    "echo [5/6] Validating or recovering the existing managed installation...",
    String.raw`"%EXTRACT_ROOT%\runtime\node\node.exe" "%EXTRACT_ROOT%\app\dist\cli\index.js" portable setup --target windows-x64 --portable-root "%EXTRACT_ROOT%" --managed-root "%INSTALL_ROOT%"`,
    "if errorlevel 1 goto failure",
    "echo       Existing managed installation was validated or recovered.",
    ":launch_managed",
    String.raw`"%INSTALL_ROOT%\runtime\node\node.exe" "%INSTALL_ROOT%\app\dist\cli\index.js" portable launch --target windows-x64 --portable-root "%INSTALL_ROOT%" --managed-root "%INSTALL_ROOT%"`,
    "if errorlevel 1 goto failure",
    "echo       Managed portable lifecycle reported the application healthy.",
    ":lifecycle_ready",
    "",
  ];
}

function windowsSetupLaunchLines() {
  return [
    // No separate liveness poll: `portable launch` above exits 0 only after the lifecycle CLI's
    // waitForHealth saw /api/health answer with the exact installed version while the spawned
    // process stayed alive. That exit code IS the "Keiko is running" proof; a marker file or a
    // process poll here would re-attest weaker evidence the CLI already established.
    "echo [6/6] Keiko reported healthy; removing temporary application files...",
    "for /l %%A in (1,1,10) do (",
    '  if exist "%STAGING_ROOT%" rmdir /s /q "%STAGING_ROOT%" >nul 2>nul',
    '  if not exist "%STAGING_ROOT%" goto cleanup_ok',
    "  timeout /t 1 /nobreak >nul",
    ")",
    ":cleanup_ok",
    'if exist "%STAGING_ROOT%" (',
    "  echo Keiko setup could not remove its temporary application files.",
    "  goto failure",
    ")",
    "echo       Keiko is running.",
    "echo.",
    "echo Keiko setup finished successfully.",
    "timeout /t 2 /nobreak >nul",
    "exit /b 0",
    "",
  ];
}

function windowsSetupFailureLines() {
  return [
    ":failure",
    'set "EXIT_CODE=%ERRORLEVEL%"',
    'if "%EXIT_CODE%"=="0" set EXIT_CODE=1',
    'if exist "%STAGING_ROOT%" rmdir /s /q "%STAGING_ROOT%" >nul 2>nul',
    "echo.",
    "echo Keiko setup failed. See the message above for the failing step.",
    String.raw`echo If Keiko wrote startup logs, they are under "%USERPROFILE%\.keiko".`,
    'if "%KEIKO_INTERACTIVE%"=="1" pause',
    "exit /b %EXIT_CODE%",
    "",
  ];
}

function sedEscape(value) {
  const text = String(value);
  if (/["%\r\n]/u.test(text)) fail("IExpress path contains an unsafe character");
  return text;
}

function trimTrailingSeparators(value) {
  let end = value.length;
  while (end > 0 && (value[end - 1] === "\\" || value[end - 1] === "/")) end -= 1;
  return value.slice(0, end);
}

/**
 * The absolute command processor that IExpress hands the embedded installer script to.
 *
 * Two constraints meet here. A `.cmd` payload is not an executable image, so WExtract needs an
 * explicit command processor to run it — naming the script alone leaves the launch to the legacy
 * interpreter lookup and never reaches `install-keiko.cmd`. And naming `cmd.exe` without a path
 * would let the extraction directory or `PATH` decide which interpreter runs *before* the script
 * validates the embedded payload, which is the trust boundary the setup exists to hold.
 *
 * The path is therefore resolved on the Windows build host and embedded literally: inside a SED,
 * `%name%` is an IExpress `[Strings]` reference rather than an environment variable, so no `%VAR%`
 * token may survive into the launch fields — `sedEscape` rejects `%` in a path for the same reason.
 */
export function systemCommandProcessorPath() {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? String.raw`C:\Windows`;
  // Built by hand rather than with `join`: the generator also runs on POSIX hosts, where `join`
  // would emit a `/` separator into a path that only Windows ever resolves.
  const path = `${trimTrailingSeparators(systemRoot)}\\${COMMAND_PROCESSOR_SUFFIX}`;
  // Linear scans rather than one nested-quantifier pattern, whose backtracking would be
  // super-linear on a hostile system root.
  const shaped =
    /^[A-Za-z]:\\/u.test(path) &&
    path.endsWith(`\\${COMMAND_PROCESSOR_SUFFIX}`) &&
    !path.includes("/") &&
    !path.includes(":", 2) &&
    !/["%*?<>|\r\n]/u.test(path);
  if (!shaped) fail("system command processor must resolve to an absolute System32 cmd.exe path");
  return path;
}

function installScriptCommand(interactive) {
  // `/d` skips the AutoRun registry commands, so no per-user `Command Processor\AutoRun` value runs
  // ahead of the installer; `/s` keeps the remainder of the line literal. The script name carries
  // no space, so it needs no quoting — the ambiguity of nested SED quoting is avoided entirely.
  const command = `${systemCommandProcessorPath()} /d /s /c ${INSTALL_SCRIPT_NAME}`;
  return interactive ? `${command} --interactive` : command;
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

export function windowsSetupSed({ inputRoot, outputPath }) {
  return [
    "[Version]",
    "Class=IEXPRESS",
    "SEDVersion=3",
    "[Options]",
    "PackagePurpose=InstallApp",
    "ShowInstallProgramWindow=1",
    "HideExtractAnimation=1",
    "UseLongFileName=1",
    "InsideCompressed=0",
    "CAB_FixedSize=0",
    "CAB_ResvCodeSigning=0",
    "RebootMode=N",
    "InstallPrompt=",
    "DisplayLicense=",
    "FinishMessage=",
    `TargetName=${sedEscape(outputPath)}`,
    "FriendlyName=Keiko Windows setup",
    `AppLaunched=${installScriptCommand(true)}`,
    "PostInstallCmd=<None>",
    `AdminQuietInstCmd=${installScriptCommand(false)}`,
    `UserQuietInstCmd=${installScriptCommand(false)}`,
    "SourceFiles=SourceFiles",
    "[Strings]",
    `FILE0="${INSTALL_SCRIPT_NAME}"`,
    `FILE1="${WINDOWS_TARGET.assetName}"`,
    "[SourceFiles]",
    `SourceFiles0=${sedEscape(inputRoot)}`,
    "[SourceFiles0]",
    "%FILE0%=",
    "%FILE1%=",
    "",
  ].join("\r\n");
}

function requireWindowsHost() {
  if (process.platform !== "win32") fail("IExpress setup generation requires a Windows host");
}

export function iexpressPath() {
  const windir = process.env.WINDIR ?? String.raw`C:\Windows`;
  const systemCandidate = join(windir, "System32", "iexpress.exe");
  if (existsSync(systemCandidate)) return systemCandidate;
  if (process.platform === "win32") fail("system IExpress executable is unavailable");
  return "iexpress.exe";
}

/* v8 ignore next -- Windows/IExpress subprocess boundary is exercised by the Windows smoke job. */
function run(command, args, label) {
  // Packaging and extraction can process the full 2 GiB accepted input; the owning workflow job
  // provides the bounded timeout without imposing a size-inconsistent subprocess cap here.
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: RUN_OUTPUT_BYTES,
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

/* v8 ignore next -- extraction executes the generated Windows setup executable. */
export async function verifyWindowsPortableSetup(setupPath, archivePath) {
  assertRegularFile(setupPath, "windows setup companion");
  if (basename(setupPath) !== WINDOWS_PORTABLE_SETUP_ASSET_NAME) {
    fail(`windows setup companion must be named ${WINDOWS_PORTABLE_SETUP_ASSET_NAME}`);
  }
  if (!isPortableExecutableFile(setupPath)) fail("windows setup companion is not a PE file");
  requireWindowsHost();
  const extractRoot = mkdtempSync(join(tmpdir(), "keiko-setup-extract-"));
  try {
    run(setupPath, ["/Q", "/C", `/T:${extractRoot}`], "setup extraction verification");
    const extractedScript = join(extractRoot, INSTALL_SCRIPT_NAME);
    const extractedArchive = join(extractRoot, WINDOWS_TARGET.assetName);
    assertRegularFile(extractedScript, "extracted setup script", 1024 * 1024);
    assertRegularFile(extractedArchive, "extracted portable archive");
    await verifyExtractedWindowsSetupPayload(extractedScript, extractedArchive, archivePath);
  } finally {
    rmSync(extractRoot, { force: true, recursive: true });
  }
}

export async function verifyExtractedWindowsSetupPayload(
  extractedScript,
  extractedArchive,
  archivePath,
) {
  const expectedScript = Buffer.from(windowsSetupInstallerScript(), "utf8");
  const extractedBytes = readFileSync(extractedScript);
  if (!extractedBytes.equals(expectedScript)) {
    fail("extracted setup script bytes do not match the generated installer script");
  }
  const expectedScriptDigest = createHash("sha256").update(expectedScript).digest("hex");
  if ((await sha256File(extractedScript)) !== expectedScriptDigest) {
    fail("extracted setup script digest does not match the generated installer script");
  }
  if ((await sha256File(extractedArchive)) !== (await sha256File(archivePath))) {
    fail("extracted setup archive digest does not match the staged archive");
  }
}

/* v8 ignore next -- IExpress build/signing orchestration runs only on protected Windows jobs. */
export async function buildWindowsPortableSetup(argv, deps = {}) {
  const options = parseArgs(argv);
  const validateStageFn = deps.validateStageFn ?? validateWindowsSetupStage;
  const { archivePath, stageRoot } = await validateStageFn(options.stageRoot);
  validateWindowsSetupOutputPath(options.output, stageRoot);
  if (options.verifyOnly) {
    await verifyWindowsPortableSetup(options.output, archivePath);
    return options.output;
  }
  requireWindowsHost();
  // The launch fields embed this path literally, so a build host that cannot produce it would ship
  // a setup whose installer never starts. Prove it here rather than at a user's first run.
  if (!existsSync(systemCommandProcessorPath())) fail("system command processor is unavailable");
  mkdirSync(dirname(options.output), { recursive: true });
  const workRoot = mkdtempSync(join(tmpdir(), "keiko-setup-build-"));
  try {
    const inputRoot = join(workRoot, "input");
    mkdirSync(inputRoot, { recursive: true });
    copyFileSync(archivePath, join(inputRoot, WINDOWS_TARGET.assetName));
    writeFileSync(join(inputRoot, INSTALL_SCRIPT_NAME), windowsSetupInstallerScript(), "utf8");
    const sedPath = join(workRoot, "keiko-setup.sed");
    writeFileSync(sedPath, windowsSetupSed({ inputRoot, outputPath: options.output }), "utf8");
    rmSync(options.output, { force: true });
    run(iexpressPath(), ["/N", "/Q", sedPath], "IExpress setup build");
    await verifyWindowsPortableSetup(options.output, archivePath);
    if (options.catalog !== undefined) {
      mkdirSync(dirname(options.catalog), { recursive: true });
      assertCatalogOutputAbsent(options.catalog);
      const catalogEntry = relative(dirname(options.catalog), options.output);
      writeCatalogExclusive(options.catalog, `${catalogEntry}\n`);
    }
    return options.output;
  } finally {
    rmSync(workRoot, { force: true, recursive: true });
  }
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
