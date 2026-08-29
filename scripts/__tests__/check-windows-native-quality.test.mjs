// The Windows native-quality gate compiles the launcher with the PRODUCTION hardening flags, and it
// derives those flags from `scripts/stage-portable-runtime.mjs` rather than restating them — so a
// change that drops `/MT` or `/DEPENDENTLOADFLAG:0x800` from the shipped command cannot leave the
// gate happily proving a configuration the product no longer ships (PR #3355 review).
//
// That derivation is itself untested logic living in PowerShell, which is exactly the shape that
// rots unnoticed. These tests run the real derivation block against the real production file and
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
const PRODUCTION = "scripts/stage-portable-runtime.mjs";

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

// Runs ONLY the gate's flag-derivation block, against `sourcePath`, and reports whether it accepted.
// The block is lifted from the gate itself at test time, so this cannot drift from what ships: if
// someone rewrites the derivation, this harness runs the rewritten version.
function derivationAccepts(sourcePath) {
  const gate = readFileSync(GATE, "utf8");
  const start = gate.indexOf("$launcherFunctionStart");
  const end = gate.indexOf("$productionMTFlag");
  expect(start, "derivation block start marker missing from the gate").toBeGreaterThan(-1);
  expect(end, "derivation block end marker missing from the gate").toBeGreaterThan(start);
  const block = gate.slice(start, end);

  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$productionScriptSource = Get-Content -Raw ${JSON.stringify(sourcePath)}`,
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

  function copyWith(transform) {
    const dir = mkdtempSync(join(tmpdir(), "keiko-native-gate-"));
    scratch.push(dir);
    const path = join(dir, "stage-portable-runtime.mjs");
    writeFileSync(path, transform(readFileSync(PRODUCTION, "utf8")), "utf8");
    return path;
  }

  it("accepts the real production file unchanged", () => {
    expect(derivationAccepts(PRODUCTION)).toContain("ACCEPTED");
  });

  // One case per required flag: dropping either from the shipped command must fail the gate, because
  // continuing would compile with hardening the product no longer applies.
  it.each(['"/MT"', '"/DEPENDENTLOADFLAG:0x800"'])("rejects a build that drops %s", (flag) => {
    const path = copyWith((source) => source.replace(flag, '"/REMOVED"'));
    expect(derivationAccepts(path)).toContain("REJECTED");
  });

  // The stale-evidence case the review named: the literal still EXISTS in the function, but only in
  // a comment — the active compiler argument list no longer carries it. A plain substring search is
  // satisfied here and would keep certifying a posture the product dropped.
  it("rejects a flag that survives only in a comment, not in the argument list", () => {
    const path = copyWith((source) => source.replace('        "/MT",\n', '        // "/MT",\n'));
    expect(derivationAccepts(path)).toContain("REJECTED");
  });

  it("rejects a file whose compileWindowsLauncher() cannot be located at all", () => {
    // replaceAll, not replace: the name appears several times (declaration plus call sites), and
    // renaming only the first still leaves the gate an anchor to find — which is how this test first
    // passed vacuously.
    const path = copyWith((source) => source.replaceAll("compileWindowsLauncher", "renamedAway"));
    expect(derivationAccepts(path)).toContain("REJECTED");
  });
});
