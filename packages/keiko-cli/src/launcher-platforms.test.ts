import { describe, expect, it } from "vitest";
import {
  launcherFor,
  linuxLauncher,
  macosLauncher,
  windowsLauncher,
  validateExecPath,
  validatePort,
  LauncherError,
  MIN_PORT,
  MAX_PORT,
} from "./launcher-platforms.js";

// Adversarial executable paths that MUST be refused. Each one targets a distinct
// shell-injection class. The test below iterates them individually so a regression on
// one character class fails its own sub-assertion (mutation-robust).
const ADVERSARIAL_EXEC_PATHS: readonly (readonly [string, string])[] = [
  ["/usr/local/bin/keiko;rm -rf /", "semicolon command separator"],
  ["/usr/local/bin/keiko && evil", "&& chained command"],
  ["/Users/me/My Keiko/bin/keiko", "ASCII space"],
  ["/usr/local/bin/keiko|nc evil 80", "pipe to network sink"],
  ["/usr/local/bin/keiko`whoami`", "command substitution backticks"],
  ["/usr/local/bin/keiko$(whoami)", "command substitution $()"],
  ["/usr/local/bin/keiko\nrm -rf /", "newline injection"],
  ["/usr/local/bin/keiko\rrm -rf /", "carriage return injection"],
  ["/usr/local/bin/'keiko'", "single quote"],
  ['/usr/local/bin/"keiko"', "double quote"],
  ["/usr/local/bin/keiko*", "glob asterisk"],
  ["/usr/local/bin/keiko?", "glob question mark"],
  ["/usr/local/bin/keiko>out", "stdout redirect"],
  ["/usr/local/bin/keiko<in", "stdin redirect"],
  ["/usr/local/bin/keiko#x", "hash"],
  ["/usr/local/bin/keiko!x", "history expansion bang"],
  ["/usr/local/bin/keiko&", "background ampersand"],
  ["~/bin/keiko", "tilde home expansion"],
  ["/usr/local/bin/keiko\t-x", "tab"],
  ["/usr/local/bin/keiko\x00x", "NUL byte"],
];

describe("validateExecPath", () => {
  it("accepts plain POSIX paths", () => {
    expect(validateExecPath("/usr/local/bin/keiko")).toBe("/usr/local/bin/keiko");
  });

  it("accepts a Windows-style backslash drive path", () => {
    expect(validateExecPath("C:\\Program\\keiko.exe")).toBe("C:\\Program\\keiko.exe");
  });

  it("accepts a scoped npm install path containing @", () => {
    const scopedPath = "/workspace/node_modules/@oscharko-dev/keiko/bin/keiko";
    expect(validateExecPath(scopedPath)).toBe(scopedPath);
  });

  it("rejects an empty path", () => {
    expect(() => validateExecPath("")).toThrow(LauncherError);
  });

  it("rejects an excessively long path", () => {
    const long = "/" + "a".repeat(4096);
    expect(() => validateExecPath(long)).toThrow(/exceeds 4096/);
  });

  for (const [bad, label] of ADVERSARIAL_EXEC_PATHS) {
    it(`refuses adversarial exec path (${label}): ${JSON.stringify(bad)}`, () => {
      // Adversarial inputs MUST be refused. If the allow-list regex is mutated to be
      // looser (e.g. accidentally adding ` ` or `;`), at least one of these sub-tests
      // will fail by class, surfacing the regression.
      let threw = false;
      try {
        validateExecPath(bad);
      } catch (e) {
        threw = true;
        expect(e).toBeInstanceOf(LauncherError);
        expect((e as LauncherError).code).toBe("EXEC_PATH_UNSAFE");
      }
      expect(threw).toBe(true);
    });
  }
});

describe("validatePort", () => {
  it("accepts the inclusive lower bound", () => {
    expect(validatePort(MIN_PORT)).toBe(MIN_PORT);
  });
  it("accepts the inclusive upper bound", () => {
    expect(validatePort(MAX_PORT)).toBe(MAX_PORT);
  });
  it("rejects below 1024", () => {
    expect(() => validatePort(80)).toThrow(LauncherError);
    expect(() => validatePort(1023)).toThrow(LauncherError);
  });
  it("rejects above 65535", () => {
    expect(() => validatePort(65536)).toThrow(LauncherError);
    expect(() => validatePort(70000)).toThrow(LauncherError);
  });
  it("rejects non-integers", () => {
    expect(() => validatePort(3000.5)).toThrow(LauncherError);
    expect(() => validatePort(Number.NaN)).toThrow(LauncherError);
  });
});

describe("linuxLauncher", () => {
  it("installs under ~/.local/share/applications", () => {
    expect(linuxLauncher.installDirFor("/home/u")).toBe("/home/u/.local/share/applications");
  });
  it("uses 0o644 file mode", () => {
    expect(linuxLauncher.fileMode).toBe(0o644);
  });
  it("uses keiko.desktop filename", () => {
    expect(linuxLauncher.safeFileName()).toBe("keiko.desktop");
  });
  it("matches the golden .desktop content with no port", () => {
    expect(linuxLauncher.generateContent({ exe: "/usr/local/bin/keiko", port: undefined })).toBe(
      [
        "[Desktop Entry]",
        "Type=Application",
        "Name=Keiko",
        "Comment=Keiko local developer-assist workspace",
        "Exec=/usr/local/bin/keiko start --open",
        "Terminal=false",
        "Categories=Development;",
        "StartupNotify=true",
        "",
      ].join("\n"),
    );
  });
  it("bakes a validated port into the Exec line", () => {
    const content = linuxLauncher.generateContent({
      exe: "/usr/local/bin/keiko",
      port: 3000,
    });
    expect(content).toContain("Exec=/usr/local/bin/keiko start --open --port 3000");
  });
  it("refuses an unsafe exec path", () => {
    expect(() => linuxLauncher.generateContent({ exe: "/bin/keiko;rm", port: undefined })).toThrow(
      LauncherError,
    );
  });
  it("refuses an out-of-range port", () => {
    expect(() => linuxLauncher.generateContent({ exe: "/usr/local/bin/keiko", port: 22 })).toThrow(
      LauncherError,
    );
  });
});

describe("macosLauncher", () => {
  it("installs under ~/Applications", () => {
    expect(macosLauncher.installDirFor("/Users/u")).toBe("/Users/u/Applications");
  });
  it("uses 0o755 file mode", () => {
    expect(macosLauncher.fileMode).toBe(0o755);
  });
  it("uses 'Keiko Launcher.command' filename", () => {
    expect(macosLauncher.safeFileName()).toBe("Keiko Launcher.command");
  });
  it("generates a bash script with bang line, set -euo pipefail, and exec", () => {
    const content = macosLauncher.generateContent({
      exe: "/usr/local/bin/keiko",
      port: undefined,
    });
    expect(content.startsWith("#!/usr/bin/env bash\n")).toBe(true);
    expect(content).toContain("set -euo pipefail");
    expect(content).toContain("exec /usr/local/bin/keiko start --open");
    expect(content.endsWith("\n")).toBe(true);
  });
  it("includes the port flag when given", () => {
    expect(macosLauncher.generateContent({ exe: "/usr/local/bin/keiko", port: 4000 })).toContain(
      "exec /usr/local/bin/keiko start --open --port 4000",
    );
  });
  it("refuses an unsafe exec path", () => {
    expect(() =>
      macosLauncher.generateContent({ exe: "/Users/me/My Keiko/bin/keiko", port: undefined }),
    ).toThrow(LauncherError);
  });
});

describe("windowsLauncher", () => {
  it("installs under %APPDATA%\\Microsoft\\Windows\\Start Menu\\Programs", () => {
    expect(windowsLauncher.installDirFor("C:\\Users\\me")).toBe(
      "C:\\Users\\me\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs",
    );
  });
  it("uses Keiko.bat filename", () => {
    expect(windowsLauncher.safeFileName()).toBe("Keiko.bat");
  });
  it("generates the `.bat` fallback content with CRLF", () => {
    expect(windowsLauncher.generateContent({ exe: "C:\\Tools\\keiko.exe", port: undefined })).toBe(
      '@start "" C:\\Tools\\keiko.exe start --open\r\n',
    );
  });
  it("includes the port flag when given", () => {
    expect(windowsLauncher.generateContent({ exe: "C:\\Tools\\keiko.exe", port: 5000 })).toBe(
      '@start "" C:\\Tools\\keiko.exe start --open --port 5000\r\n',
    );
  });
  it("refuses an unsafe exec path", () => {
    expect(() =>
      windowsLauncher.generateContent({
        exe: "C:\\Program Files\\Keiko\\keiko.exe",
        port: undefined,
      }),
    ).toThrow(LauncherError);
  });
});

describe("launcherFor", () => {
  it("returns the linux launcher", () => {
    expect(launcherFor("linux")).toBe(linuxLauncher);
  });
  it("returns the macos launcher", () => {
    expect(launcherFor("darwin")).toBe(macosLauncher);
  });
  it("returns the windows launcher", () => {
    expect(launcherFor("win32")).toBe(windowsLauncher);
  });
  it("rejects an unknown platform", () => {
    // `freebsd` is a valid `NodeJS.Platform` token but deliberately absent from the
    // launcher REGISTRY (we ship linux/darwin/win32 only). No cast is needed — the
    // value is type-correct; the refusal is a runtime check.
    expect(() => launcherFor("freebsd")).toThrow(LauncherError);
  });
});
