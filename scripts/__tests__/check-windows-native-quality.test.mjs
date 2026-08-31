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
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const GATE = "scripts/check-windows-native-quality.ps1";
const RFC3161_PROJECT = "scripts/native-quality/windows-rfc3161-quality.csproj";
const RFC3161_LOCK = "scripts/native-quality/packages.lock.json";
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

// Runs ONLY the gate's shared flag-derivation helper against both producers. The helper is lifted
// from the gate at test time, so this cannot drift from what ships: if someone rewrites the
// derivation, this harness runs the rewritten version. Each source defaults to the real production
// file, so a test can sabotage one producer while the other stays genuine.
function derivationAccepts({
  launcherSourcePath = PRODUCTION_LAUNCHER,
  setupBootstrapSourcePath = PRODUCTION_SETUP_BOOTSTRAP,
} = {}) {
  const gate = readFileSync(GATE, "utf8");
  const start = gate.indexOf("function Get-ActiveNativeProducerSource");
  const end = gate.indexOf("$root = Split-Path");
  expect(start, "derivation helper start marker missing from the gate").toBeGreaterThan(-1);
  expect(end, "derivation block end marker missing from the gate").toBeGreaterThan(start);
  const helpers = gate.slice(start, end);

  const script = [
    "$ErrorActionPreference = 'Stop'",
    helpers,
    `$launcherSource = Get-Content -Raw ${JSON.stringify(launcherSourcePath)}`,
    `$setupSource = Get-Content -Raw ${JSON.stringify(setupBootstrapSourcePath)}`,
    `$required = @('"/MT"', '"/DEPENDENTLOADFLAG:0x800"')`,
    "try {",
    "  Assert-NativeProducerLinkFlags -Source $launcherSource -FunctionName 'compileWindowsLauncher' -EndMarker 'function requireWindowsLauncherIconSource(' -ProducerPath 'scripts/stage-portable-runtime.mjs' -RequiredFlagLiterals $required",
    "  Assert-NativeProducerLinkFlags -Source $setupSource -FunctionName 'compileSetupBootstrap' -EndMarker 'function fsyncFile(' -ProducerPath 'scripts/build-windows-portable-setup.mjs' -RequiredFlagLiterals $required",
    "  'ACCEPTED'",
    "} catch { 'REJECTED: ' + $_.Exception.Message }",
  ].join("\n");

  return execFileSync("pwsh", ["-NoProfile", "-Command", script], { encoding: "utf8" });
}

function packageReferences(csproj) {
  const references = [
    ...csproj.matchAll(/<PackageReference Include="([^"]+)" Version="([^"]+)" \/>/gu),
  ].map((match) => ({ id: match[1], version: match[2] }));
  expect(references.length, `${RFC3161_PROJECT} has no PackageReference`).toBeGreaterThan(0);
  return references;
}

function productionDotnetBuildInvocation(gateSource) {
  const start = gateSource.indexOf("dotnet build $project");
  expect(start, "RFC3161 `dotnet build` invocation missing from the gate").toBeGreaterThan(-1);
  const failure = gateSource.indexOf('throw ".NET analyzer quality build failed"', start);
  expect(failure, "RFC3161 build failure throw missing from the gate").toBeGreaterThan(start);
  return gateSource.slice(start, failure);
}

function lockResolvedVersion(lock, packageId) {
  expect(lock).toEqual(expect.objectContaining({ dependencies: expect.any(Object) }));
  const graphs = Object.values(lock.dependencies);
  expect(graphs.length, "NuGet lock has no target-framework graphs").toBeGreaterThan(0);
  const versions = graphs.map((graph) => {
    expect(graph).toEqual(
      expect.objectContaining({
        [packageId]: expect.objectContaining({
          type: "Direct",
          resolved: expect.any(String),
        }),
      }),
    );
    return graph[packageId].resolved;
  });
  expect(new Set(versions).size, `${packageId} resolved versions disagree across TFMs`).toBe(1);
  const [resolved] = versions;
  expect(typeof resolved).toBe("string");
  return resolved;
}

// Always-on: these pins must not hide behind `pwsh`. The Windows compile half of the gate stays
// CI-only; the lock contract is a committed artifact and can be checked on every host.
describe("RFC3161 NuGet lock contract (KEIKO-0899)", () => {
  it("commits packages.lock.json beside the analyzer csproj", () => {
    expect(existsSync(RFC3161_LOCK), `${RFC3161_LOCK} must be committed`).toBe(true);
  });

  it("keeps RestorePackagesWithLockFile on the csproj and locked mode on the gate build", () => {
    const csproj = readFileSync(RFC3161_PROJECT, "utf8");
    expect(csproj).toMatch(/<RestorePackagesWithLockFile>true<\/RestorePackagesWithLockFile>/u);
    expect(csproj).not.toMatch(/<RestoreLockedMode>\s*true\s*<\/RestoreLockedMode>/u);
    const invocation = productionDotnetBuildInvocation(readFileSync(GATE, "utf8"));
    expect(invocation).toContain('"-p:RestoreLockedMode=true"');
  });

  it("pins every csproj PackageReference to the same resolved version in the lock", () => {
    const csproj = readFileSync(RFC3161_PROJECT, "utf8");
    const lock = JSON.parse(readFileSync(RFC3161_LOCK, "utf8"));
    for (const reference of packageReferences(csproj)) {
      expect(lockResolvedVersion(lock, reference.id)).toBe(reference.version);
    }
  });
});

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

  it("rejects a launcher flag hidden inside an interior block-comment line", () => {
    const launcherSourcePath = copyLauncherWith((source) =>
      source.replace('        "/MT",\n', '        /*\n        "/MT",\n        */\n'),
    );
    expect(derivationAccepts({ launcherSourcePath })).toContain("REJECTED");
  });

  it("rejects a setup-bootstrap flag hidden inside an interior block-comment line", () => {
    const setupBootstrapSourcePath = copySetupBootstrapWith((source) =>
      source.replace('        "/MT",\n', '        /*\n        "/MT",\n        */\n'),
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
