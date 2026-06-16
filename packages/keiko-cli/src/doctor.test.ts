import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectDoctorReport, emitDoctorWarning, runDoctorCli } from "./doctor.js";
import type { CliIo } from "./runner.js";

interface Captured {
  readonly io: CliIo;
  readonly out: () => string;
  readonly err: () => string;
}

function makeIo(): Captured {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  return {
    io: {
      out: (text: string): void => {
        outChunks.push(text);
      },
      err: (text: string): void => {
        errChunks.push(text);
      },
    },
    out: (): string => outChunks.join(""),
    err: (): string => errChunks.join(""),
  };
}

const tempRoots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "keiko-doctor-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("doctor", () => {
  it("detects when a stale global binary is running instead of the local package install", () => {
    const root = makeRoot();
    const packageRoot = join(root, "node_modules", "@oscharko-dev", "keiko");
    mkdirSync(join(packageRoot, "dist", "cli"), { recursive: true });
    writeFileSync(join(packageRoot, "package.json"), '{"version":"0.2.0-beta.5"}\n', "utf8");
    writeFileSync(join(packageRoot, "dist", "cli", "index.js"), "#!/usr/bin/env node\n", "utf8");
    const report = collectDoctorReport({
      cwd: root,
      argv: [process.execPath, "C:\\Users\\dev\\AppData\\Roaming\\npm\\keiko.cmd"],
    });
    expect(report.warning).toContain("different Keiko binary");
  });

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
    const c = makeIo();
    emitDoctorWarning(c.io, {
      cwd: root,
      argv: [process.execPath, "/opt/homebrew/bin/keiko"],
    });
    expect(c.err()).toContain("stale launch path detected");
    expect(c.err()).toContain("local build");
  });

  it("prints remediation guidance", () => {
    const root = makeRoot();
    const c = makeIo();
    const code = runDoctorCli([], c.io, {}, { cwd: root, argv: [process.execPath] });
    expect(code).toBe(0);
    expect(c.out()).toContain("Keiko doctor");
    expect(c.out()).toContain("Diagnosis:");
  });

  it("emits an actionable start-time warning when a stale global wins over the local package", () => {
    const root = makeRoot();
    const packageRoot = join(root, "node_modules", "@oscharko-dev", "keiko");
    mkdirSync(join(packageRoot, "dist", "cli"), { recursive: true });
    writeFileSync(join(packageRoot, "package.json"), '{"version":"0.2.0-beta.5"}\n', "utf8");
    writeFileSync(join(packageRoot, "dist", "cli", "index.js"), "#!/usr/bin/env node\n", "utf8");
    const c = makeIo();

    emitDoctorWarning(c.io, {
      cwd: root,
      argv: [process.execPath, "/usr/local/bin/keiko"],
    });

    expect(c.err()).toContain("stale launch path detected");
    expect(c.err()).toContain(join(packageRoot, "dist", "cli", "index.js"));
    expect(c.err()).toContain("/usr/local/bin/keiko");
    expect(c.err().toLowerCase()).toContain("keiko:start");
  });

  it("stays silent when the running entry already is the local package install", () => {
    const root = makeRoot();
    const packageRoot = join(root, "node_modules", "@oscharko-dev", "keiko");
    const cliEntry = join(packageRoot, "dist", "cli", "index.js");
    mkdirSync(join(packageRoot, "dist", "cli"), { recursive: true });
    writeFileSync(join(packageRoot, "package.json"), '{"version":"0.2.0-beta.5"}\n', "utf8");
    writeFileSync(cliEntry, "#!/usr/bin/env node\n", "utf8");
    const c = makeIo();

    emitDoctorWarning(c.io, { cwd: root, argv: [process.execPath, cliEntry] });

    expect(c.err()).toBe("");
  });
});
