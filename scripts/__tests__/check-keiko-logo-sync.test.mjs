// KEIKO-1018 regression pin: packages/keiko-ui/public/keiko-logo.svg and
// packages/keiko-ui/public/assets/keiko-logo.svg must stay byte-identical. Before this gate,
// either copy could be hand-edited without the other one updating, silently shipping a stale
// PWA-icon source (ADR-0024 D5) out of sync with the runtime-rendered logo (or vice versa).
//
// The gate is scripts/check-keiko-logo-sync.mjs. This pin covers the two invariants that make
// the gate worth having:
//   1. The gate PASSES against the current on-disk sources (there is no divergence today).
//   2. The gate BITES: a mutated fixture where one copy diverges by even a single byte must be
//      reported. Without this, the gate could silently degrade into a no-op that always passes.

import { Buffer } from "node:buffer";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { checkKeikoLogoSync } from "../check-keiko-logo-sync.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const originalRootPath = resolve(repoRoot, "packages", "keiko-ui", "public", "keiko-logo.svg");
const originalAssetsPath = resolve(
  repoRoot,
  "packages",
  "keiko-ui",
  "public",
  "assets",
  "keiko-logo.svg",
);

let scratchDir;

beforeEach(() => {
  scratchDir = mkdtempSync(join(tmpdir(), "keiko-1018-logo-sync-"));
});
afterEach(() => {
  rmSync(scratchDir, { recursive: true, force: true });
});

function fixtureCopy() {
  const rootCopy = join(scratchDir, "keiko-logo.svg");
  const assetsCopy = join(scratchDir, "assets-keiko-logo.svg");
  writeFileSync(rootCopy, readFileSync(originalRootPath));
  writeFileSync(assetsCopy, readFileSync(originalAssetsPath));
  return { rootCopy, assetsCopy };
}

describe("scripts/check-keiko-logo-sync.mjs — keiko-logo.svg (root) <-> assets/keiko-logo.svg", () => {
  it("passes against the current on-disk sources", () => {
    // Uses the default paths — the real production files must be byte-identical right now.
    expect(checkKeikoLogoSync()).toBeNull();
  });

  it("bites when the assets copy diverges by a single trailing byte", () => {
    const { rootCopy, assetsCopy } = fixtureCopy();
    const original = readFileSync(assetsCopy);
    writeFileSync(assetsCopy, Buffer.concat([original, Buffer.from("\n")]));

    const divergence = checkKeikoLogoSync({ rootPath: rootCopy, assetsPath: assetsCopy });
    expect(divergence).not.toBeNull();
    expect(divergence).toContain(rootCopy);
    expect(divergence).toContain(assetsCopy);
  });

  it("bites when the root copy diverges from the assets copy", () => {
    const { rootCopy, assetsCopy } = fixtureCopy();
    writeFileSync(rootCopy, Buffer.from("<svg></svg>"));

    const divergence = checkKeikoLogoSync({ rootPath: rootCopy, assetsPath: assetsCopy });
    expect(divergence).not.toBeNull();
  });
});
