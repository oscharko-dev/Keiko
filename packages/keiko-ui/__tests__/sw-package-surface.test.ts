import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(here, "..");

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

describe("keiko-ui PWA service-worker surface (ADR-0024 D6, issue #126)", () => {
  it("ships public/sw.js in `npm pack --dry-run`", () => {
    const paths = packDryRun();
    expect(paths, "expected public/sw.js in pack output").toContain("public/sw.js");
  }, 120_000);
});
