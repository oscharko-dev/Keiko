// #2906 round 3 (comment 3865329060): the KEIKO-1018 sync gate compared TWO independently
// committed copies of the Keiko logo (packages/keiko-ui/public/keiko-logo.svg and
// packages/keiko-ui/public/assets/keiko-logo.svg) for byte-identity, permanently maintaining
// code and CI surface around a drift class that only existed because two files served the same
// mark. Every runtime reference the second copy served (Header.tsx, AppShell.tsx,
// ChatWindow.tsx, VoiceDialogMode.tsx, PermControl.tsx) was internal — none is a documented
// external compatibility contract — so all of them now point at the one committed file instead.
// This pin replaces the sync gate: it protects the SAME invariant (one logo, one place) by
// refusing to let the duplicate file or a stray reference to its old path come back, rather than
// reconciling two copies that should never have existed independently.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const uiPublicDir = resolve(repoRoot, "packages", "keiko-ui", "public");
const uiSrcDir = resolve(repoRoot, "packages", "keiko-ui", "src");

const TEXT_FILE_EXTENSIONS = new Set([".ts", ".tsx", ".mjs", ".js"]);

function collectFiles(dir) {
  const files = [];
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    if (name.name === "node_modules") continue;
    const full = join(dir, name.name);
    if (name.isDirectory()) {
      files.push(...collectFiles(full));
      continue;
    }
    files.push(full);
  }
  return files;
}

describe("keiko logo — single committed source (comment 3865329060)", () => {
  it("keeps exactly one committed keiko-logo.svg under packages/keiko-ui/public", () => {
    expect(existsSync(join(uiPublicDir, "keiko-logo.svg"))).toBe(true);
    expect(existsSync(join(uiPublicDir, "assets", "keiko-logo.svg"))).toBe(false);
  });

  it("has no lingering source reference to the removed /assets/keiko-logo.svg path", () => {
    const offenders = [];
    for (const file of collectFiles(uiSrcDir)) {
      const ext = file.slice(file.lastIndexOf("."));
      if (!TEXT_FILE_EXTENSIONS.has(ext)) continue;
      const content = readFileSync(file, "utf8");
      if (content.includes("/assets/keiko-logo.svg")) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
