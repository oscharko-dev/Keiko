import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectDoctorReport, emitDoctorWarning, runDoctorCli } from "./doctor.js";
import { makeCapturedIo } from "./test-support/cli-io.js";

const tempRoots: string[] = [];

// Creating a file symlink on Windows needs elevated rights or Developer Mode.
const fileSymlinksUnavailable = process.platform === "win32";

function tempDirIsCaseInsensitive(): boolean {
  const probe = mkdtempSync(join(tmpdir(), "keiko-doctor-case-"));
  try {
    writeFileSync(join(probe, "probe.js"), "", "utf8");
    return existsSync(join(probe, "PROBE.js"));
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "keiko-doctor-"));
  tempRoots.push(root);
  return root;
}

function writeInstalledPackage(root: string): string {
  const packageRoot = join(root, "node_modules", "@oscharko-dev", "keiko");
  mkdirSync(join(packageRoot, "dist", "cli"), { recursive: true });
  mkdirSync(join(packageRoot, "dist", "ui", "static"), { recursive: true });
  writeFileSync(join(packageRoot, "package.json"), '{"version":"0.2.0-beta.5"}\n', "utf8");
  writeFileSync(join(packageRoot, "dist", "cli", "index.js"), "#!/usr/bin/env node\n", "utf8");
  writeFileSync(join(packageRoot, "dist", "ui", "static", "index.html"), "<html></html>\n", "utf8");
  return packageRoot;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("doctor", () => {
  it("detects when a stale global binary is running instead of the local package install", () => {
    const root = makeRoot();
    writeInstalledPackage(root);
    const report = collectDoctorReport({
      cwd: root,
      argv: [process.execPath, "C:\\Users\\dev\\AppData\\Roaming\\npm\\keiko.cmd"],
    });
    expect(report.warning).toContain("different");
    expect(report.warning).toContain("local build");
  });

  // A project install (`npm install @oscharko-dev/keiko`) runs `node_modules/.bin/keiko`, which npm
  // links to the package's own `dist/cli/index.js`. That is the installed package, not a stale
  // binary, and 1.3.0 printed the stale-launch warning on every `keiko start` there (#3897).
  it.skipIf(fileSymlinksUnavailable)(
    "does not warn when the running entry is npm's bin link to the installed package",
    () => {
      const root = makeRoot();
      const packageRoot = writeInstalledPackage(root);
      const binDir = join(root, "node_modules", ".bin");
      mkdirSync(binDir, { recursive: true });
      symlinkSync(
        join("..", "@oscharko-dev", "keiko", "dist", "cli", "index.js"),
        join(binDir, "keiko"),
      );
      const report = collectDoctorReport({
        cwd: root,
        argv: [process.execPath, join(binDir, "keiko")],
      });
      expect(report.localPackageInstall?.cliEntry).toBe(
        join(packageRoot, "dist", "cli", "index.js"),
      );
      expect(report.warning).toBeUndefined();
    },
  );

  // realpath keeps the spelling it was given, so on a case-insensitive filesystem the same
  // installed entry spelled with other casing must still count as the installed package.
  it.skipIf(!tempDirIsCaseInsensitive())(
    "does not warn when the running entry names the installed entry with other casing",
    () => {
      const root = makeRoot();
      const packageRoot = writeInstalledPackage(root);
      const report = collectDoctorReport({
        cwd: root,
        argv: [process.execPath, join(packageRoot, "dist", "cli", "INDEX.js")],
      });
      expect(report.warning).toBeUndefined();
    },
  );

  it.skipIf(fileSymlinksUnavailable)(
    "still warns when a bin link leads to another installation",
    () => {
      const root = makeRoot();
      writeInstalledPackage(root);
      const elsewhere = join(makeRoot(), "keiko.js");
      writeFileSync(elsewhere, "#!/usr/bin/env node\n", "utf8");
      const binDir = join(root, "global-bin");
      mkdirSync(binDir, { recursive: true });
      symlinkSync(elsewhere, join(binDir, "keiko"));
      const report = collectDoctorReport({
        cwd: root,
        argv: [process.execPath, join(binDir, "keiko")],
      });
      expect(report.warning).toContain("different");
    },
  );

  it("warns when a built checkout exists but the running entry points elsewhere", () => {
    const root = makeRoot();
    mkdirSync(join(root, "dist", "cli"), { recursive: true });
    mkdirSync(join(root, "dist", "ui", "static"), { recursive: true });
    writeFileSync(
      join(root, "package.json"),
      '{"name":"@oscharko-dev/keiko","version":"0.2.0-beta.5"}\n',
    );
    writeFileSync(join(root, "dist", "cli", "index.js"), "#!/usr/bin/env node\n");
    writeFileSync(join(root, "dist", "ui", "static", "index.html"), "<html></html>\n");
    const c = makeCapturedIo();
    emitDoctorWarning(c.io, {
      cwd: root,
      argv: [process.execPath, "/opt/homebrew/bin/keiko"],
    });
    expect(c.err()).toContain("stale launch path detected");
    expect(c.err()).toContain("local build");
  });

  it("prints remediation guidance", () => {
    const root = makeRoot();
    const c = makeCapturedIo();
    const code = runDoctorCli([], c.io, {}, { cwd: root, argv: [process.execPath] });
    expect(code).toBe(0);
    expect(c.out()).toContain("Keiko doctor");
    expect(c.out()).toContain("Diagnosis:");
  });
});
