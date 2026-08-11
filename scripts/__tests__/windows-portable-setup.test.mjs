import { Buffer } from "node:buffer";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildWindowsPortableSetup,
  iexpressPath,
  systemCommandProcessorPath,
  validateWindowsSetupOutputPath,
  validateWindowsSetupStage,
  verifyWindowsPortableSetup,
  verifyExtractedWindowsSetupPayload,
  WindowsPortableSetupError,
  windowsSetupInstallerScript,
  windowsSetupSed,
} from "../build-windows-portable-setup.mjs";
import { isPortableExecutableFile } from "../lib/portable-executable.mjs";
import { WINDOWS_PORTABLE_SETUP_ASSET_NAME } from "../portable-runtime.mjs";

const roots = [];

function root() {
  const path = mkdtempSync(join(tmpdir(), "keiko-windows-setup-"));
  roots.push(path);
  return path;
}

afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { force: true, recursive: true });
});

function restoreEnvValue(key, previous) {
  // `Reflect.deleteProperty` rather than `delete`: the key is a parameter, and a dynamically
  // computed `delete` is rejected by lint.
  if (previous === undefined) Reflect.deleteProperty(process.env, key);
  else process.env[key] = previous;
}

function portableExecutable(marker = 0) {
  const bytes = Buffer.alloc(128, marker);
  bytes[0] = 0x4d;
  bytes[1] = 0x5a;
  bytes.writeUInt32LE(64, 0x3c);
  bytes.set([0x50, 0x45, 0x00, 0x00], 64);
  return bytes;
}

async function expectSetupError(action, message) {
  let error;
  try {
    await action();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(WindowsPortableSetupError);
  expect(error.message).toContain(message);
}

describe("windows portable setup companion", () => {
  it("keeps the setup output directly inside the canonical stage root", () => {
    const stageRoot = root();
    expect(() =>
      validateWindowsSetupOutputPath(join(stageRoot, WINDOWS_PORTABLE_SETUP_ASSET_NAME), stageRoot),
    ).not.toThrow();
    expect(() =>
      validateWindowsSetupOutputPath(join(root(), WINDOWS_PORTABLE_SETUP_ASSET_NAME), stageRoot),
    ).toThrow(/must stay directly within the stage root/u);
    expect(() => validateWindowsSetupOutputPath(join(stageRoot, "wrong.exe"), stageRoot)).toThrow(
      /must be named/u,
    );
  });

  it("resolves the Windows IExpress executable from WINDIR with a PATH fallback", () => {
    const previous = process.env.WINDIR;
    const windir = root();
    try {
      process.env.WINDIR = windir;
      if (process.platform === "win32") {
        expect(() => iexpressPath()).toThrow(/system IExpress executable is unavailable/u);
      } else {
        expect(iexpressPath()).toBe("iexpress.exe");
      }
      mkdirSync(join(windir, "System32"), { recursive: true });
      writeFileSync(join(windir, "System32", "iexpress.exe"), "fixture");
      expect(iexpressPath()).toBe(join(windir, "System32", "iexpress.exe"));
    } finally {
      restoreEnvValue("WINDIR", previous);
    }
  });

  it("recognizes bounded PE setup companions", () => {
    const dir = root();
    const setupPath = join(dir, WINDOWS_PORTABLE_SETUP_ASSET_NAME);
    writeFileSync(setupPath, portableExecutable(7));
    expect(isPortableExecutableFile(setupPath)).toBe(true);
    writeFileSync(setupPath, "not an executable");
    expect(isPortableExecutableFile(setupPath)).toBe(false);
    expect(isPortableExecutableFile(join(dir, "missing.exe"))).toBe(false);

    const badMagic = Buffer.alloc(128, 1);
    writeFileSync(setupPath, badMagic);
    expect(isPortableExecutableFile(setupPath)).toBe(false);

    const badOffset = portableExecutable(2);
    badOffset.writeUInt32LE(4, 0x3c);
    writeFileSync(setupPath, badOffset);
    expect(isPortableExecutableFile(setupPath)).toBe(false);

    const badSignature = portableExecutable(3);
    badSignature.set([0, 0, 0, 0], 64);
    writeFileSync(setupPath, badSignature);
    expect(isPortableExecutableFile(setupPath)).toBe(false);
  });

  it("bounds CLI arguments before touching Windows host tools", async () => {
    await expectSetupError(() => buildWindowsPortableSetup([]), "--stage-root is required");
    await expectSetupError(() => buildWindowsPortableSetup(["--unknown"]), "invalid arguments");
    await expectSetupError(
      () => buildWindowsPortableSetup(["--stage-root", "--verify-only"]),
      "--stage-root requires a value",
    );
    await expectSetupError(
      () =>
        buildWindowsPortableSetup([
          "--stage-root",
          root(),
          "--catalog",
          join(root(), WINDOWS_PORTABLE_SETUP_ASSET_NAME),
        ]),
      "--catalog must be named windows-setup-signing-file.txt",
    );
    await expectSetupError(
      () =>
        buildWindowsPortableSetup([
          "--stage-root",
          root(),
          "--output",
          join(root(), WINDOWS_PORTABLE_SETUP_ASSET_NAME),
          "--catalog",
          join(root(), "catalogs", "windows-setup-signing-file.txt"),
        ]),
      "--catalog must be beside the staged setup companion",
    );
    await expectSetupError(() => {
      const missingStage = join(root(), "missing-stage");
      return buildWindowsPortableSetup([
        "--verify-only",
        "--stage-root",
        missingStage,
        "--catalog",
        join(missingStage, "windows-setup-signing-file.txt"),
      ]);
    }, "missing stage root");

    for (const link of [symlinkSync, linkSync]) {
      const dir = root();
      const target = join(dir, "linked-target.txt");
      const catalog = join(dir, "windows-setup-signing-file.txt");
      writeFileSync(target, "must not be truncated\n");
      try {
        link(target, catalog);
      } catch (error) {
        if (link === symlinkSync && error?.code === "EPERM") continue;
        throw error;
      }
      await expectSetupError(
        () =>
          buildWindowsPortableSetup([
            "--stage-root",
            dir,
            "--output",
            join(dir, WINDOWS_PORTABLE_SETUP_ASSET_NAME),
            "--catalog",
            catalog,
          ]),
        "setup signing catalog must not already exist",
      );
      expect(readFileSync(target, "utf8")).toBe("must not be truncated\n");
    }
  });

  it("rejects an orchestration output outside the validated stage before host execution", async () => {
    const stageRoot = root();
    const archivePath = join(stageRoot, "keiko-windows-x64.zip");
    const outside = root();
    writeFileSync(archivePath, "validated archive fixture");

    await expectSetupError(
      () =>
        buildWindowsPortableSetup(
          ["--stage-root", stageRoot, "--output", join(outside, WINDOWS_PORTABLE_SETUP_ASSET_NAME)],
          {
            validateStageFn: () => Promise.resolve({ archivePath, stageRoot }),
          },
        ),
      "--output must stay directly within the stage root",
    );
  });

  // RELOCATED, NOT RELAXED (ADR-0163 D9). The invariant this pin protects is "an invalid stage
  // manifest is refused with named failures". It used to be expressed through the "pass if EITHER
  // the candidate or the staging validator accepts" shape, which is strictly weaker than asking
  // the manifest which lifecycle lane it declares and holding it to exactly that lane's rules. A
  // manifest that declares no stageable lane — including an empty one — is now refused outright.
  it("refuses a stage manifest that declares no stageable lifecycle lane", async () => {
    const dir = root();
    mkdirSync(join(dir, "manifest"), { recursive: true });
    writeFileSync(join(dir, "keiko-windows-x64.zip"), "zip fixture");
    writeFileSync(join(dir, "manifest", "portable-manifest.json"), "{}\n");

    let error;
    try {
      await validateWindowsSetupStage(dir);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(WindowsPortableSetupError);
    expect(error.message).toContain("security.verificationPolicy");
    expect(error.message).toContain("declares no stageable lifecycle lane");
  });

  it("holds a lane-declaring stage manifest to exactly that lane's rules", async () => {
    const dir = root();
    mkdirSync(join(dir, "manifest"), { recursive: true });
    writeFileSync(join(dir, "keiko-windows-x64.zip"), "zip fixture");
    // Declares the production lane but carries nothing else: the previous "either validator wins"
    // shape let a manifest slip through on the staging validator's verdict.
    writeFileSync(
      join(dir, "manifest", "portable-manifest.json"),
      `${JSON.stringify({ security: { verificationPolicy: "production" } })}\n`,
    );

    let error;
    try {
      await validateWindowsSetupStage(dir);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(WindowsPortableSetupError);
    expect(error.message).not.toContain("declares no stageable lifecycle lane");
  });

  it("bounds malformed stage roots and payload files", async () => {
    const stageFile = join(root(), "stage-file");
    writeFileSync(stageFile, "not a directory");
    await expectSetupError(
      () => validateWindowsSetupStage(stageFile),
      "stage root must be a regular directory",
    );

    const missingArchiveStage = root();
    await expectSetupError(
      () => validateWindowsSetupStage(missingArchiveStage),
      "missing windows portable archive",
    );

    const archiveDirectoryStage = root();
    mkdirSync(join(archiveDirectoryStage, "keiko-windows-x64.zip"));
    await expectSetupError(
      () => validateWindowsSetupStage(archiveDirectoryStage),
      "windows portable archive must be a regular unlinked file",
    );

    const emptyArchiveStage = root();
    writeFileSync(join(emptyArchiveStage, "keiko-windows-x64.zip"), "");
    await expectSetupError(
      () => validateWindowsSetupStage(emptyArchiveStage),
      "windows portable archive has an invalid bounded size",
    );

    const missingManifestStage = root();
    writeFileSync(join(missingManifestStage, "keiko-windows-x64.zip"), "zip fixture");
    await expectSetupError(
      () => validateWindowsSetupStage(missingManifestStage),
      "missing windows portable manifest",
    );

    const emptyManifestStage = root();
    writeFileSync(join(emptyManifestStage, "keiko-windows-x64.zip"), "zip fixture");
    mkdirSync(join(emptyManifestStage, "manifest"), { recursive: true });
    writeFileSync(join(emptyManifestStage, "manifest", "portable-manifest.json"), "");
    await expectSetupError(
      () => validateWindowsSetupStage(emptyManifestStage),
      "windows portable manifest has an invalid bounded size",
    );
  });

  it("generates an installer script that installs the whole portable tree before launch", () => {
    const script = windowsSetupInstallerScript();
    const resolveRootCommand =
      'portable resolve-root --target windows-x64 --portable-root "%EXTRACT_ROOT%"';
    const freshSetupCommand =
      '"%EXTRACT_ROOT%\\runtime\\node\\node.exe" "%EXTRACT_ROOT%\\app\\dist\\cli\\index.js" portable setup --target windows-x64 --portable-root "%EXTRACT_ROOT%" --managed-root "%INSTALL_ROOT%"';
    const existingSetupCommand =
      '"%EXTRACT_ROOT%\\runtime\\node\\node.exe" "%EXTRACT_ROOT%\\app\\dist\\cli\\index.js" portable setup --target windows-x64 --portable-root "%EXTRACT_ROOT%" --managed-root "%INSTALL_ROOT%"';
    const managedLaunchCommand =
      '"%INSTALL_ROOT%\\runtime\\node\\node.exe" "%INSTALL_ROOT%\\app\\dist\\cli\\index.js" portable launch --target windows-x64 --portable-root "%INSTALL_ROOT%" --managed-root "%INSTALL_ROOT%"';
    expect(script).toContain("setlocal EnableExtensions DisableDelayedExpansion");
    expect(script).not.toContain("setlocal EnableExtensions\r\n");
    expect(script).toContain("[1/6] Checking setup payload...");
    expect(script).toContain('"%SystemRoot%\\System32\\tar.exe" -xf "%ARCHIVE%"');
    expect(script).not.toContain("Expand-Archive");
    expect(script).not.toMatch(/WindowsPowerShell\\v1\.0\\powershell\.exe/iu);
    expect(script).not.toMatch(/(?:^|\r\n)powershell\.exe /u);
    expect(script).toContain("%EXTRACT_ROOT%\\runtime\\node\\node.exe");
    expect(script).toContain("%EXTRACT_ROOT%\\app\\dist\\cli\\index.js");
    expect(script).toContain(
      "Bundled Node runtime found. No separate Node installation is required.",
    );
    expect(script).toContain(freshSetupCommand);
    expect(script).toContain(resolveRootCommand);
    expect(script.indexOf(resolveRootCommand)).toBeLessThan(
      script.indexOf('if exist "%INSTALL_ROOT%" goto validate_existing'),
    );
    expect(script).toContain("Keiko setup could not resolve the managed install root.");
    expect(script).toContain('> "%MANAGED_ROOT_FILE%"');
    expect(script).toContain("chcp 65001 >nul");
    expect(script).toContain("tokens=2 delims=:.");
    expect(script).toContain("chcp %ORIGINAL_CODE_PAGE% >nul");
    expect(script).toContain('set /p "INSTALL_ROOT="<"%MANAGED_ROOT_FILE%"');
    expect(script).not.toContain('set "INSTALL_ROOT=%LOCALAPPDATA%\\Programs\\Keiko"');
    expect(script).toContain("--target windows-x64 --portable-root");
    expect(script).toContain('if exist "%INSTALL_ROOT%" goto validate_existing');
    expect(script).toContain(existingSetupCommand);
    expect(script).toContain(managedLaunchCommand);
    expect(script.indexOf(freshSetupCommand)).toBeLessThan(script.indexOf(managedLaunchCommand));
    expect(script.indexOf(existingSetupCommand)).toBeLessThan(script.indexOf(managedLaunchCommand));
    expect(script.split(managedLaunchCommand)).toHaveLength(2);
    expect(script).toContain("Existing managed installation was validated or recovered.");
    expect(script).not.toContain(
      'portable setup --target windows-x64 --portable-root "%INSTALL_ROOT%"',
    );
    expect(script).not.toContain('move "%INSTALL_ROOT%"');
    expect(script).not.toContain('rmdir /s /q "%INSTALL_ROOT%"');
    expect(script).not.toContain("Start-Process");
    // The managed `portable launch` exit code IS the health proof (the lifecycle CLI's
    // waitForHealth gates it on /api/health answering with the installed version), so the
    // payload carries NO secondary liveness poll: no marker file, no process query, no sleep.
    expect(script).toContain("Keiko reported healthy; removing temporary application files");
    expect(script).not.toContain("KEIKO_IEXPRESS_HEALTHY");
    expect(script).not.toContain("timeout /t 5 /nobreak");
    // timeout.exe demands console stdin and exits instantly under a redirected-stdin host
    // (quiet IExpress) — the payload must pace retries with ping instead.
    expect(script).not.toMatch(/\btimeout \/t\b/u);
    expect(script).toContain("ping -n 2 127.0.0.1 >nul");
    expect(script).not.toContain("AddSeconds(30)");
    expect(script).not.toContain("Get-Process -Name Keiko,node");
    expect(script).not.toContain("Start-Sleep -Milliseconds 500");
    expect(script).not.toContain("Get-CimInstance Win32_Process");
    expect(script).toContain("for /l %%A in (1,1,10) do (");
    expect(script).toContain('rmdir /s /q "%STAGING_ROOT%"');
    expect(script).toContain('if exist "%STAGING_ROOT%" (');
    expect(script).toContain("Keiko setup could not remove its temporary application files.");
    expect(script.indexOf(managedLaunchCommand)).toBeLessThan(script.indexOf(":cleanup_ok"));
    expect(script).toContain('if "%KEIKO_INTERACTIVE%"=="1" pause');
    expect(script).not.toContain("\r\npause\r\n");
    expect(script).toContain("Keiko setup finished successfully.");
    expect(script).not.toContain("Keiko wird installiert");
    expect(script).not.toContain("Starte Keiko");
  });

  it("generates an IExpress package definition for the archive and installer script", () => {
    const sed = windowsSetupSed({
      inputRoot: String.raw`C:\keiko setup\input`,
      outputPath: String.raw`C:\keiko setup\keiko-windows-x64-setup.exe`,
    });
    expect(sed).toContain("Class=IEXPRESS");
    expect(sed).toContain(`TargetName=C:\\keiko setup\\${WINDOWS_PORTABLE_SETUP_ASSET_NAME}`);
    const interpreter = systemCommandProcessorPath();
    expect(sed).toContain(`AppLaunched=${interpreter} /d /s /c install-keiko.cmd --interactive`);
    expect(sed).toContain(`AdminQuietInstCmd=${interpreter} /d /s /c install-keiko.cmd`);
    expect(sed).toContain(`UserQuietInstCmd=${interpreter} /d /s /c install-keiko.cmd`);
    expect(sed).toContain('FILE1="keiko-windows-x64.zip"');
  });

  // A `.cmd` payload is not an executable image: every launch field must hand it to a command
  // processor, and that processor must be named by absolute path so neither the extraction
  // directory nor `PATH` can supply the interpreter that runs before the payload is validated.
  // Dropping the interpreter shipped a setup whose installer never ran (#2966).
  it("launches every IExpress mode through an absolute System32 command processor", () => {
    const sed = windowsSetupSed({
      inputRoot: String.raw`C:\keiko setup\input`,
      outputPath: String.raw`C:\keiko setup\keiko-windows-x64-setup.exe`,
    });
    const launchFields = sed
      .split("\r\n")
      .filter((line) => /^(?:AppLaunched|AdminQuietInstCmd|UserQuietInstCmd)=/u.test(line));

    expect(launchFields).toHaveLength(3);
    for (const field of launchFields) {
      const command = field.slice(field.indexOf("=") + 1);
      expect(command).toMatch(/^[A-Za-z]:\\(?:[^\\]+\\)*System32\\cmd\.exe /u);
      expect(command).toContain(" /d /s /c install-keiko.cmd");
      // A `%VAR%` token would be read as an IExpress `[Strings]` reference, not an environment
      // variable, so the interpreter path has to reach the SED already resolved.
      expect(command).not.toContain("%");
    }
  });

  it("rejects a system root that is not an absolute Windows path", () => {
    const systemRoot = process.env.SystemRoot;
    const windir = process.env.WINDIR;
    try {
      process.env.SystemRoot = "/usr/bin";
      delete process.env.WINDIR;
      expect(() => systemCommandProcessorPath()).toThrow(
        /system command processor must resolve to an absolute System32 cmd\.exe path/u,
      );
      // Trailing separator: a raw template cannot carry it, because the backslash would escape the
      // closing backtick.
      process.env.SystemRoot = "D:\\Windows\\";
      expect(systemCommandProcessorPath()).toBe(String.raw`D:\Windows\System32\cmd.exe`);
    } finally {
      restoreEnvValue("SystemRoot", systemRoot);
      restoreEnvValue("WINDIR", windir);
    }
  });

  it("rejects extracted installer scripts that differ from the generated script", async () => {
    const dir = root();
    const extractedScript = join(dir, "install-keiko.cmd");
    const extractedArchive = join(dir, "keiko-windows-x64.zip");
    const archivePath = join(dir, "staged.zip");
    writeFileSync(extractedScript, windowsSetupInstallerScript(), "utf8");
    writeFileSync(extractedArchive, "portable archive", "utf8");
    writeFileSync(archivePath, "portable archive", "utf8");

    await verifyExtractedWindowsSetupPayload(extractedScript, extractedArchive, archivePath);

    writeFileSync(extractedScript, "@echo off\r\necho altered\r\n", "utf8");
    await expectSetupError(
      () => verifyExtractedWindowsSetupPayload(extractedScript, extractedArchive, archivePath),
      "extracted setup script bytes do not match the generated installer script",
    );

    writeFileSync(extractedScript, windowsSetupInstallerScript(), "utf8");
    writeFileSync(extractedArchive, "different portable archive", "utf8");
    await expectSetupError(
      () => verifyExtractedWindowsSetupPayload(extractedScript, extractedArchive, archivePath),
      "extracted setup archive digest does not match the staged archive",
    );
  });

  it("rejects IExpress paths with control characters or quotes", () => {
    expect(() =>
      windowsSetupSed({
        inputRoot: "C:\\keiko\nsetup\\input",
        outputPath: "C:\\keiko setup\\keiko-windows-x64-setup.exe",
      }),
    ).toThrow(/IExpress path contains an unsafe character/u);
    expect(() =>
      windowsSetupSed({
        inputRoot: 'C:\\keiko"setup\\input',
        outputPath: "C:\\keiko setup\\keiko-windows-x64-setup.exe",
      }),
    ).toThrow(/IExpress path contains an unsafe character/u);
    expect(() =>
      windowsSetupSed({
        inputRoot: "C:\\keiko%TEMP%\\input",
        outputPath: "C:\\keiko setup\\keiko-windows-x64-setup.exe",
      }),
    ).toThrow(/IExpress path contains an unsafe character/u);
  });

  it("bounds setup verification before extraction", async () => {
    const dir = root();
    const archivePath = join(dir, "keiko-windows-x64.zip");
    writeFileSync(archivePath, "zip fixture");

    await expectSetupError(
      () => verifyWindowsPortableSetup(join(dir, "missing.exe"), archivePath),
      "missing windows setup companion",
    );

    const wrongName = join(dir, "wrong-name.exe");
    writeFileSync(wrongName, portableExecutable(11));
    await expectSetupError(
      () => verifyWindowsPortableSetup(wrongName, archivePath),
      `windows setup companion must be named ${WINDOWS_PORTABLE_SETUP_ASSET_NAME}`,
    );

    const setupPath = join(dir, WINDOWS_PORTABLE_SETUP_ASSET_NAME);
    writeFileSync(setupPath, "not an executable");
    await expectSetupError(
      () => verifyWindowsPortableSetup(setupPath, archivePath),
      "windows setup companion is not a PE file",
    );

    if (process.platform !== "win32") {
      writeFileSync(setupPath, portableExecutable(12));
      await expectSetupError(
        () => verifyWindowsPortableSetup(setupPath, archivePath),
        "IExpress setup generation requires a Windows host",
      );
    }
  });
});
