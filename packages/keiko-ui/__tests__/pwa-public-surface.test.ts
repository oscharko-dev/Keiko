import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(here, "..");

const REQUIRED_PUBLIC_FILES: readonly string[] = [
  "public/manifest.webmanifest",
  "public/icon-192.png",
  "public/icon-512.png",
  "public/icon-192-maskable.png",
  "public/icon-512-maskable.png",
  "public/apple-touch-icon.png",
  "public/favicon.svg",
  "public/favicon.ico",
  // Self-hosted JetBrains Mono (foundations.html §02) + its SIL OFL 1.1 license must ship
  // so the brand mono renders offline, same-origin (CSP font-src 'self').
  "public/fonts/jetbrains-mono-latin-wght-normal.woff2",
  "public/fonts/OFL.txt",
];

interface PackEntry {
  readonly path: string;
}

interface PackResult {
  readonly files: readonly PackEntry[];
}

function npmCommand(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function needsShell(command: string): boolean {
  return process.platform === "win32" && command.endsWith(".cmd");
}

function packDryRun(): readonly string[] {
  const npm = npmCommand();
  const result = spawnSync(npm, ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: PKG_ROOT,
    encoding: "utf8",
    shell: needsShell(npm),
  });
  if (result.status !== 0) {
    throw new Error(`npm pack --dry-run failed: ${result.stderr}`);
  }
  const parsed = JSON.parse(result.stdout) as PackResult | readonly PackResult[];
  const entry = Array.isArray(parsed) ? parsed[0] : parsed;
  return entry === undefined ? [] : entry.files.map((f: PackEntry) => f.path);
}

describe("keiko-ui PWA public surface (ADR-0024, issue #123)", () => {
  it("ships every required PWA public asset in `npm pack --dry-run`", () => {
    const paths = packDryRun();
    for (const required of REQUIRED_PUBLIC_FILES) {
      expect(paths, `expected ${required} in pack output`).toContain(required);
    }
  }, 120_000);
});
