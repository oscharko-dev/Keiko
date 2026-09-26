import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  normalizePortableSetupCompanion,
  portableSetupCompanionRecord,
  portableSetupCompanionUpload,
} from "../lib/portable-setup-companion.mjs";
import { WINDOWS_PORTABLE_SETUP_ASSET_NAME } from "../portable-runtime.mjs";

const roots = [];

function root() {
  const path = mkdtempSync(join(tmpdir(), "keiko-setup-companion-"));
  roots.push(path);
  return path;
}

function portableExecutable() {
  const bytes = Buffer.alloc(128);
  bytes[0] = 0x4d;
  bytes[1] = 0x5a;
  bytes.writeUInt32LE(64, 0x3c);
  bytes.set([0x50, 0x45, 0x00, 0x00], 64);
  return bytes;
}

function setupEntry(setupPath, overrides = {}) {
  const upload = portableSetupCompanionUpload(setupPath);
  return {
    setupPath,
    setupSha256: upload.expectedSha256,
    setupSizeBytes: upload.expectedSize,
    ...overrides,
  };
}

function expectSetupFailure({ message, setupPath, stageRoot }) {
  expect(
    normalizePortableSetupCompanion({
      baseDir: stageRoot,
      entry: { setupPath },
      platformTarget: "windows-x64",
      stageRoot,
    }),
  ).toEqual({ failures: [`windows-x64.setupPath ${message}`], setupPath: undefined });
}

afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { force: true, recursive: true });
});

describe("portable setup companion", () => {
  it("normalises, records, and prepares a valid Windows setup companion upload", () => {
    const stageRoot = root();
    const setupPath = join(stageRoot, WINDOWS_PORTABLE_SETUP_ASSET_NAME);
    writeFileSync(setupPath, portableExecutable());
    const result = normalizePortableSetupCompanion({
      baseDir: stageRoot,
      entry: setupEntry(setupPath),
      platformTarget: "windows-x64",
      stageRoot,
    });

    expect(result).toEqual({ failures: [], setupPath });
    const original = { platformTarget: "windows-x64" };
    expect(portableSetupCompanionRecord(original, setupPath)).toEqual({
      platformTarget: "windows-x64",
      setupAssetName: WINDOWS_PORTABLE_SETUP_ASSET_NAME,
      setupPath,
    });
    expect(original).toEqual({ platformTarget: "windows-x64" });
    expect(portableSetupCompanionRecord({ platformTarget: "macos-x64" })).toEqual({
      platformTarget: "macos-x64",
    });
    expect(portableSetupCompanionUpload(setupPath)).toMatchObject({
      assetName: WINDOWS_PORTABLE_SETUP_ASSET_NAME,
      expectedSha256: createHash("sha256").update(portableExecutable()).digest("hex"),
      expectedSize: 128,
    });
  });

  it.each([
    [
      "digest",
      { setupSha256: "0".repeat(64) },
      "windows-x64.setupSha256 must match the setup companion bytes.",
    ],
    [
      "size",
      { setupSizeBytes: 129 },
      "windows-x64.setupSizeBytes must match the setup companion size.",
    ],
  ])("rejects a setup companion whose declared %s binding is stale", (_case, override, message) => {
    const stageRoot = root();
    const setupPath = join(stageRoot, WINDOWS_PORTABLE_SETUP_ASSET_NAME);
    writeFileSync(setupPath, portableExecutable());

    const result = normalizePortableSetupCompanion({
      baseDir: stageRoot,
      entry: setupEntry(setupPath, override),
      platformTarget: "windows-x64",
      stageRoot,
    });

    expect(result.setupPath).toBeUndefined();
    expect(result.failures).toEqual([message]);
  });

  it.each([
    ["requires a setup path for Windows", "windows-x64", {}, "must be a non-empty string"],
    ["accepts no setup path on macOS", "macos-x64", {}, ""],
    ["rejects setup paths on macOS", "macos-x64", { setupPath: "setup.exe" }, "only supported"],
    [
      "rejects a misnamed setup",
      "windows-x64",
      { setupPath: "bad.exe" },
      `must be named ${WINDOWS_PORTABLE_SETUP_ASSET_NAME}`,
    ],
  ])(
    "normalises target-specific setup paths when it %s",
    (_case, platformTarget, entry, message) => {
      const stageRoot = root();
      if (entry.setupPath === "bad.exe") writeFileSync(join(stageRoot, "bad.exe"), "not PE");
      const result = normalizePortableSetupCompanion({
        baseDir: stageRoot,
        entry,
        platformTarget,
        stageRoot,
      });
      expect(result.setupPath).toBeUndefined();
      if (message.length === 0) expect(result.failures).toEqual([]);
      else expect(result.failures.join("\n")).toContain(message);
    },
  );

  it("rejects a canonical setup path whose bytes are not a PE file", () => {
    const stageRoot = root();
    const setupPath = join(stageRoot, WINDOWS_PORTABLE_SETUP_ASSET_NAME);
    writeFileSync(setupPath, "not PE");

    const result = normalizePortableSetupCompanion({
      baseDir: stageRoot,
      entry: { setupPath },
      platformTarget: "windows-x64",
      stageRoot,
    });

    expect(result).toEqual({
      failures: ["windows-x64.setupPath must point to a PE file."],
      setupPath: undefined,
    });
  });

  it("rejects a logical setup size beyond the bound without writing a 2 GiB payload", () => {
    const stageRoot = root();
    const setupPath = join(stageRoot, WINDOWS_PORTABLE_SETUP_ASSET_NAME);
    writeFileSync(setupPath, portableExecutable());
    // truncate changes only the file's logical length; no multi-gigabyte payload is written.
    truncateSync(setupPath, 2 * 1024 * 1024 * 1024 + 1);

    expectSetupFailure({
      message: "exceeds its bounded size.",
      setupPath,
      stageRoot,
    });
  });

  it("rejects missing, non-file, empty, linked, and escaped setup paths", () => {
    const cases = [
      {
        arrange(stageRoot) {
          return join(stageRoot, WINDOWS_PORTABLE_SETUP_ASSET_NAME);
        },
        message: "does not exist.",
      },
      {
        arrange(stageRoot) {
          const setupPath = join(stageRoot, WINDOWS_PORTABLE_SETUP_ASSET_NAME);
          mkdirSync(setupPath);
          return setupPath;
        },
        message: "must point to a regular file.",
      },
      {
        arrange(stageRoot) {
          const setupPath = join(stageRoot, WINDOWS_PORTABLE_SETUP_ASSET_NAME);
          writeFileSync(setupPath, "");
          return setupPath;
        },
        message: "must not be empty.",
      },
      {
        arrange(stageRoot) {
          const sourcePath = join(stageRoot, "source.exe");
          const setupPath = join(stageRoot, WINDOWS_PORTABLE_SETUP_ASSET_NAME);
          writeFileSync(sourcePath, portableExecutable());
          linkSync(sourcePath, setupPath);
          return setupPath;
        },
        message: "must not be hard linked.",
      },
      {
        arrange(stageRoot) {
          const sourcePath = join(stageRoot, "source.exe");
          const setupPath = join(stageRoot, WINDOWS_PORTABLE_SETUP_ASSET_NAME);
          writeFileSync(sourcePath, portableExecutable());
          symlinkSync(sourcePath, setupPath);
          return setupPath;
        },
        message: "must not be a symbolic link.",
      },
      {
        arrange() {
          const setupPath = join(root(), WINDOWS_PORTABLE_SETUP_ASSET_NAME);
          writeFileSync(setupPath, portableExecutable());
          return setupPath;
        },
        message: "must stay within the portable stage root.",
      },
    ];

    for (const testCase of cases) {
      const stageRoot = root();
      expectSetupFailure({
        message: testCase.message,
        setupPath: testCase.arrange(stageRoot),
        stageRoot,
      });
    }
  });
});
