import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
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
  appendSetupOverlay,
  assertBakedPayloadIdentity,
  buildWindowsPortableSetup,
  setupCatalogContent,
  validateWindowsSetupOutputPath,
  validateWindowsSetupStage,
  verifyWindowsPortableSetup,
  WindowsPortableSetupError,
} from "../build-windows-portable-setup.mjs";
import { isPortableExecutableFile } from "../lib/portable-executable.mjs";
import { buildSetupOverlayHeader } from "../lib/portable-setup-overlay.mjs";
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

describe("assertBakedPayloadIdentity", () => {
  const validHex = "a".repeat(64);

  it("accepts a 64-char lowercase hex digest with a positive safe-integer size", () => {
    expect(() => assertBakedPayloadIdentity(validHex, 130_000_000)).not.toThrow();
  });

  it("rejects a digest that is not 64 lowercase hex characters", () => {
    for (const bad of ["a".repeat(63), "a".repeat(65), "A".repeat(64), "g".repeat(64), "", 123]) {
      expect(() => assertBakedPayloadIdentity(bad, 1)).toThrow(WindowsPortableSetupError);
    }
  });

  it("rejects a size that is not a positive safe integer", () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, "1"]) {
      expect(() => assertBakedPayloadIdentity(validHex, bad)).toThrow(WindowsPortableSetupError);
    }
  });
});

describe("setupCatalogContent", () => {
  it("names the setup companion by basename relative to the sibling catalog", () => {
    // The catalog and the companion are always siblings, so the entry is the basename plus a
    // newline — the same on POSIX and Windows, which is why this is testable off a Windows host.
    const dir = join(tmpdir(), "keiko-catalog");
    expect(
      setupCatalogContent(
        join(dir, "windows-setup-signing-file.txt"),
        join(dir, WINDOWS_PORTABLE_SETUP_ASSET_NAME),
      ),
    ).toBe(`${WINDOWS_PORTABLE_SETUP_ASSET_NAME}\n`);
  });
});

function sha256Hex(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function portableExecutable(marker = 0) {
  const bytes = Buffer.alloc(128, marker);
  bytes[0] = 0x4d;
  bytes[1] = 0x5a;
  bytes.writeUInt32LE(64, 0x3c);
  bytes.set([0x50, 0x45, 0x00, 0x00], 64);
  return bytes;
}

// Minimal-but-real synthetic PE32+ image: DOS header, PE signature, COFF header, a PE32+ optional
// header with NO certificate table directory, and one section whose raw data ends exactly at the
// buffer's own length (i.e. `portableExecutableOverlayBounds` sees no existing overlay). A fixed,
// unparametrized duplicate of the fixture builder in portable-setup-overlay.test.mjs — this file
// only needs the ONE happy-path shape to exercise `appendSetupOverlay`/`verifyWindowsPortableSetup`
// as integration points; the overlay codec's own bounds math is exhaustively covered there.
function buildValidStub() {
  const eLfanew = 64;
  const coffOffset = eLfanew + 4;
  const optionalHeaderOffset = coffOffset + 20;
  const sizeOfOptionalHeader = 240;
  const sectionTableOffset = optionalHeaderOffset + sizeOfOptionalHeader;
  const buffer = Buffer.alloc(1024);
  buffer[0] = 0x4d; // 'M'
  buffer[1] = 0x5a; // 'Z'
  buffer.writeUInt32LE(eLfanew, 0x3c);
  buffer.write("PE\0\0", eLfanew, "latin1");
  buffer.writeUInt16LE(1, coffOffset + 2); // NumberOfSections
  buffer.writeUInt16LE(sizeOfOptionalHeader, coffOffset + 16);
  buffer.writeUInt16LE(0x20b, optionalHeaderOffset); // PE32+
  buffer.writeUInt32LE(512, optionalHeaderOffset + 60); // SizeOfHeaders
  // Security directory (DataDirectory[4]) left zeroed: no certificate table.
  buffer.writeUInt32LE(512, sectionTableOffset + 16); // SizeOfRawData
  buffer.writeUInt32LE(512, sectionTableOffset + 20); // PointerToRawData
  return buffer;
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

  it("bounds setup verification before parsing the overlay", async () => {
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

    // A structurally valid PE32+ image with no overlay data appended at all: the overlay header
    // cannot even be read, so this is refused by the overlay parser, not by any executed extractor.
    writeFileSync(setupPath, buildValidStub());
    await expectSetupError(
      () => verifyWindowsPortableSetup(setupPath, archivePath),
      "setup overlay header is truncated",
    );
  });

  describe("appendSetupOverlay + verifyWindowsPortableSetup", () => {
    it("round-trips a compiled stub and a staged archive into a verifiable setup companion", async () => {
      const dir = root();
      const stubPath = join(dir, "stub.exe");
      const archivePath = join(dir, "keiko-windows-x64.zip");
      const outputPath = join(dir, WINDOWS_PORTABLE_SETUP_ASSET_NAME);
      writeFileSync(stubPath, buildValidStub());
      writeFileSync(archivePath, "keiko portable archive fixture bytes");

      const result = await appendSetupOverlay(stubPath, archivePath, outputPath);

      expect(result).toBe(outputPath);
      expect(isPortableExecutableFile(outputPath)).toBe(true);
      await expect(verifyWindowsPortableSetup(outputPath, archivePath)).resolves.toBeUndefined();
    });

    it("rejects a stub that already carries trailing data before the overlay is appended", async () => {
      const dir = root();
      const stubPath = join(dir, "stub.exe");
      const archivePath = join(dir, "keiko-windows-x64.zip");
      writeFileSync(stubPath, Buffer.concat([buildValidStub(), Buffer.from("unexpected tail")]));
      writeFileSync(archivePath, "archive bytes");

      await expectSetupError(
        () =>
          appendSetupOverlay(stubPath, archivePath, join(dir, WINDOWS_PORTABLE_SETUP_ASSET_NAME)),
        "unexpectedly carries trailing data",
      );
    });

    it("rejects a header digest that does not match the staged archive", async () => {
      const dir = root();
      const archiveBytes = Buffer.from("keiko portable archive fixture");
      const archivePath = join(dir, "keiko-windows-x64.zip");
      writeFileSync(archivePath, archiveBytes);
      const header = buildSetupOverlayHeader({
        payloadSha256Hex: sha256Hex(Buffer.from("not the staged archive")),
        payloadSizeBytes: archiveBytes.byteLength,
      });
      const setupPath = join(dir, WINDOWS_PORTABLE_SETUP_ASSET_NAME);
      writeFileSync(setupPath, Buffer.concat([buildValidStub(), header, archiveBytes]));

      await expectSetupError(
        () => verifyWindowsPortableSetup(setupPath, archivePath),
        "payload digest does not match the staged archive",
      );
    });

    it("rejects a magic mismatch in the embedded overlay header", async () => {
      const dir = root();
      const archiveBytes = Buffer.from("keiko portable archive fixture");
      const archivePath = join(dir, "keiko-windows-x64.zip");
      writeFileSync(archivePath, archiveBytes);
      const stub = buildValidStub();
      const header = buildSetupOverlayHeader({
        payloadSha256Hex: sha256Hex(archiveBytes),
        payloadSizeBytes: archiveBytes.byteLength,
      });
      const file = Buffer.concat([stub, header, archiveBytes]);
      file[stub.byteLength] = 0x00;
      const setupPath = join(dir, WINDOWS_PORTABLE_SETUP_ASSET_NAME);
      writeFileSync(setupPath, file);

      await expectSetupError(
        () => verifyWindowsPortableSetup(setupPath, archivePath),
        "magic does not match KSETUP01",
      );
    });

    it("rejects trailing padding beyond the 7-byte alignment allowance", async () => {
      const dir = root();
      const archiveBytes = Buffer.from("keiko portable archive fixture");
      const archivePath = join(dir, "keiko-windows-x64.zip");
      writeFileSync(archivePath, archiveBytes);
      const header = buildSetupOverlayHeader({
        payloadSha256Hex: sha256Hex(archiveBytes),
        payloadSizeBytes: archiveBytes.byteLength,
      });
      const file = Buffer.concat([buildValidStub(), header, archiveBytes, Buffer.alloc(8)]);
      const setupPath = join(dir, WINDOWS_PORTABLE_SETUP_ASSET_NAME);
      writeFileSync(setupPath, file);

      await expectSetupError(
        () => verifyWindowsPortableSetup(setupPath, archivePath),
        "padding exceeds 7 bytes",
      );
    });

    it("rejects a payload size that does not match the staged archive", async () => {
      const dir = root();
      const archiveBytes = Buffer.from("keiko portable archive fixture, longer than the payload");
      const archivePath = join(dir, "keiko-windows-x64.zip");
      writeFileSync(archivePath, archiveBytes);
      const embeddedPayload = Buffer.from("short payload");
      const header = buildSetupOverlayHeader({
        payloadSha256Hex: sha256Hex(embeddedPayload),
        payloadSizeBytes: embeddedPayload.byteLength,
      });
      const setupPath = join(dir, WINDOWS_PORTABLE_SETUP_ASSET_NAME);
      writeFileSync(setupPath, Buffer.concat([buildValidStub(), header, embeddedPayload]));

      await expectSetupError(
        () => verifyWindowsPortableSetup(setupPath, archivePath),
        "payload size does not match the staged archive",
      );
    });
  });
});
