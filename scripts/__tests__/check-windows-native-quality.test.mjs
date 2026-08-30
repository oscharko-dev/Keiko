// The Windows native-quality gate compiles TWO independently hardened native producers with the
// PRODUCTION hardening flags — compileWindowsLauncher() in stage-portable-runtime.mjs and
// compileSetupBootstrap() in build-windows-portable-setup.mjs — and it derives those flags from
// each producer rather than restating them, so a change that drops `/MT` or
// `/DEPENDENTLOADFLAG:0x800` from either shipped command cannot leave the gate happily proving a
// configuration the product no longer ships (PR #3355 review, and its follow-up: the gate
// originally derived only the launcher's flags and never inspected compileSetupBootstrap() at all,
// so THAT binary's hardening could silently drop with the gate still green).
//
// That derivation is itself untested logic living in PowerShell, which is exactly the shape that
// rots unnoticed. These tests run the real derivation block against the real production files and
// against deliberately broken copies, using `pwsh` (present on this host and on the Windows runner).
// They are SKIPPED where pwsh is absent rather than silently passing — a skip is visible, a vacuous
// pass is not.
//
// What they cannot do: run `cl.exe`. The compile-and-analyze half of that gate is genuinely
// Windows-only and stays CI's job; these tests cover the flag-derivation half, which is where the
// drift risk lives.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const GATE = "scripts/check-windows-native-quality.ps1";
const PRODUCTION_LAUNCHER = "scripts/stage-portable-runtime.mjs";
const PRODUCTION_SETUP_BOOTSTRAP = "scripts/build-windows-portable-setup.mjs";

function hasPwsh() {
  try {
    execFileSync("pwsh", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

// Runs ONLY the gate's flag-derivation block — BOTH producers' — against the given launcher /
// setup-bootstrap sources, and reports whether it accepted. The block is lifted from the gate
// itself at test time, so this cannot drift from what ships: if someone rewrites the derivation,
// this harness runs the rewritten version. Each source defaults to the real production file, so a
// test can sabotage one producer while the other stays genuine — proving the two derivations are
// independent, not that either one alone works.
function derivationAccepts({
  launcherSourcePath = PRODUCTION_LAUNCHER,
  setupBootstrapSourcePath = PRODUCTION_SETUP_BOOTSTRAP,
} = {}) {
  const gate = readFileSync(GATE, "utf8");
  const start = gate.indexOf("$launcherFunctionStart");
  const end = gate.indexOf("$setupBootstrapMTFlag");
  expect(start, "derivation block start marker missing from the gate").toBeGreaterThan(-1);
  expect(end, "derivation block end marker missing from the gate").toBeGreaterThan(start);
  const block = gate.slice(start, end);

  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$productionScriptSource = Get-Content -Raw ${JSON.stringify(launcherSourcePath)}`,
    `$setupBuildScriptSource = Get-Content -Raw ${JSON.stringify(setupBootstrapSourcePath)}`,
    "try {",
    block,
    "  'ACCEPTED'",
    "} catch { 'REJECTED: ' + $_.Exception.Message }",
  ].join("\n");

  return execFileSync("pwsh", ["-NoProfile", "-Command", script], { encoding: "utf8" });
}

describe.skipIf(!hasPwsh())("check-windows-native-quality flag derivation", () => {
  const scratch = [];

  afterEach(() => {
    for (const dir of scratch.splice(0)) rmSync(dir, { force: true, recursive: true });
  });

  function copyWith(productionPath, fileName, transform) {
    const dir = mkdtempSync(join(tmpdir(), "keiko-native-gate-"));
    scratch.push(dir);
    const path = join(dir, fileName);
    writeFileSync(path, transform(readFileSync(productionPath, "utf8")), "utf8");
    return path;
  }

  function copyLauncherWith(transform) {
    return copyWith(PRODUCTION_LAUNCHER, "stage-portable-runtime.mjs", transform);
  }

  function copySetupBootstrapWith(transform) {
    return copyWith(PRODUCTION_SETUP_BOOTSTRAP, "build-windows-portable-setup.mjs", transform);
  }

  it("accepts the real production files unchanged", () => {
    expect(derivationAccepts()).toContain("ACCEPTED");
  });

  // One case per required flag: dropping either from the shipped launcher command must fail the
  // gate, because continuing would compile with hardening the product no longer applies.
  it.each(['"/MT"', '"/DEPENDENTLOADFLAG:0x800"'])(
    "rejects a launcher build that drops %s",
    (flag) => {
      const launcherSourcePath = copyLauncherWith((source) => source.replace(flag, '"/REMOVED"'));
      expect(derivationAccepts({ launcherSourcePath })).toContain("REJECTED");
    },
  );

  // The gap this extension closes: dropping either flag from compileSetupBootstrap() must
  // INDEPENDENTLY fail the gate, even though compileWindowsLauncher() — a different function in a
  // different file — still carries both. Before this extension the gate never read this file at
  // all, so this sabotage would have compiled clean using the launcher's borrowed flags.
  it.each(['"/MT"', '"/DEPENDENTLOADFLAG:0x800"'])(
    "rejects a setup-bootstrap build that drops %s",
    (flag) => {
      const setupBootstrapSourcePath = copySetupBootstrapWith((source) =>
        source.replace(flag, '"/REMOVED"'),
      );
      expect(derivationAccepts({ setupBootstrapSourcePath })).toContain("REJECTED");
    },
  );

  // The stale-evidence case the review named: the literal still EXISTS in the function, but only in
  // a comment — the active compiler argument list no longer carries it. A plain substring search is
  // satisfied here and would keep certifying a posture the product dropped. Covered for both
  // producers: the comment-stripping logic is duplicated per derivation block, not shared, so each
  // copy needs its own proof that it actually strips rather than merely existing.
  it("rejects a launcher flag that survives only in a comment, not in the argument list", () => {
    const launcherSourcePath = copyLauncherWith((source) =>
      source.replace('        "/MT",\n', '        // "/MT",\n'),
    );
    expect(derivationAccepts({ launcherSourcePath })).toContain("REJECTED");
  });

  it("rejects a setup-bootstrap flag that survives only in a comment, not in the argument list", () => {
    const setupBootstrapSourcePath = copySetupBootstrapWith((source) =>
      source.replace('        "/MT",\n', '        // "/MT",\n'),
    );
    expect(derivationAccepts({ setupBootstrapSourcePath })).toContain("REJECTED");
  });

  it("rejects a file whose compileWindowsLauncher() cannot be located at all", () => {
    // replaceAll, not replace: the name appears several times (declaration plus call sites), and
    // renaming only the first still leaves the gate an anchor to find — which is how this test first
    // passed vacuously.
    const launcherSourcePath = copyLauncherWith((source) =>
      source.replaceAll("compileWindowsLauncher", "renamedAway"),
    );
    expect(derivationAccepts({ launcherSourcePath })).toContain("REJECTED");
  });

  it("rejects a file whose compileSetupBootstrap() cannot be located at all", () => {
    const setupBootstrapSourcePath = copySetupBootstrapWith((source) =>
      source.replaceAll("compileSetupBootstrap", "renamedAway"),
    );
    expect(derivationAccepts({ setupBootstrapSourcePath })).toContain("REJECTED");
  });
});
