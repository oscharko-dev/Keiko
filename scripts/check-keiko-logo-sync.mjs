// KEIKO-1018 sync gate: packages/keiko-ui/public/keiko-logo.svg (ADR-0024 D5's documented
// source of truth for PWA icon generation, and README.md's raw-GitHub-URL logo badge) and
// packages/keiko-ui/public/assets/keiko-logo.svg (a separate copy referenced at runtime by
// Header.tsx, ModeSwitch.tsx, AppShell.tsx, ChatWindow.tsx, VoiceDialogMode.tsx,
// PermControl.tsx, and KeikoTwinPanel.tsx) are two independently committed copies of the same
// mark. Both are genuinely used for different purposes today, so neither can simply be
// deleted -- but until this gate, nothing caught the two files drifting apart. This is a plain
// byte-for-byte comparison: exit non-zero with both paths (and their byte lengths, never their
// content) on divergence.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const ROOT_LOGO_PATH = resolve(repoRoot, "packages", "keiko-ui", "public", "keiko-logo.svg");
const ASSETS_LOGO_PATH = resolve(
  repoRoot,
  "packages",
  "keiko-ui",
  "public",
  "assets",
  "keiko-logo.svg",
);

/**
 * Returns `null` when the two keiko-logo.svg copies are byte-identical, or a diagnostic string
 * (paths and byte lengths only -- never file content) when they diverge. Exported for the
 * co-located regression pin so the check can run without spawning this script as a subprocess.
 */
export function checkKeikoLogoSync({
  rootPath = ROOT_LOGO_PATH,
  assetsPath = ASSETS_LOGO_PATH,
} = {}) {
  const root = readFileSync(rootPath);
  const assets = readFileSync(assetsPath);
  if (root.equals(assets)) return null;
  return (
    `${rootPath} (${String(root.length)} bytes) and ${assetsPath} (${String(assets.length)} ` +
    `bytes) have diverged. Both copies of the Keiko logo must stay byte-identical -- see KEIKO-1018.`
  );
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const divergence = checkKeikoLogoSync();
  if (divergence === null) {
    console.log("keiko-logo.svg (root) ↔ assets/keiko-logo.svg: byte-identical.");
    process.exit(0);
  }
  console.error(`FAIL: ${divergence}`);
  process.exit(1);
}
