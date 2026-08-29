$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$root = Split-Path -Parent $PSScriptRoot
$scratch = Join-Path $env:RUNNER_TEMP ("keiko-native-quality-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $scratch | Out-Null

try {
  if ([string]::IsNullOrWhiteSpace($env:INCLUDE)) {
    throw "MSVC INCLUDE environment is required"
  }
  $env:CAExcludePath = $env:INCLUDE
  $nativeFlags = @(
    "/nologo", "/std:c17", "/W4", "/WX", "/analyze", "/external:env:INCLUDE", "/external:W0"
  )

  # Review 3887051410 (and its follow-up, PR #3354 review): the shipped launcher's PRODUCTION link
  # line (/MT static CRT + /DEPENDENTLOADFLAG:0x800 for statically-linked imports,
  # stage-portable-runtime.mjs) was compiled by no PR-time gate -- portable-assets.yml is
  # tag/dispatch-only, so a broken link flag surfaced for the first time during a release build.
  # Compiling with the same flags here proves the toolchain accepts the exact production line on
  # every pull request.
  #
  # A SECOND, independently hand-typed copy of those flags would defeat the point: if
  # compileWindowsLauncher() in the producer ever dropped /MT or /DEPENDENTLOADFLAG:0x800, a
  # retyped copy here would keep compiling the OLD hardened command and keep reporting PASS --
  # proving a configuration the product no longer ships. So this gate does not retype them: it
  # reads compileWindowsLauncher() out of the producer itself (AGENTS.md §7 -- a fixture must
  # never restate a formula the code under test owns, derive it from the production entry point)
  # and fails closed, before compiling anything, the moment either literal is no longer there.
  $productionScriptPath = Join-Path $PSScriptRoot "stage-portable-runtime.mjs"
  $productionScriptSource = Get-Content -LiteralPath $productionScriptPath -Raw
  $launcherFunctionStart = $productionScriptSource.IndexOf("function compileWindowsLauncher(")
  $launcherFunctionEnd = $productionScriptSource.IndexOf("function requireWindowsLauncherIconSource(")
  if ($launcherFunctionStart -lt 0 -or $launcherFunctionEnd -lt 0 -or
      $launcherFunctionEnd -le $launcherFunctionStart) {
    throw "could not locate compileWindowsLauncher() in stage-portable-runtime.mjs to derive the production link flags"
  }
  $launcherFunctionSource = $productionScriptSource.Substring(
    $launcherFunctionStart, $launcherFunctionEnd - $launcherFunctionStart
  )
  foreach ($requiredFlagLiteral in @('"/MT"', '"/DEPENDENTLOADFLAG:0x800"')) {
    if (-not $launcherFunctionSource.Contains($requiredFlagLiteral)) {
      throw ("scripts/stage-portable-runtime.mjs compileWindowsLauncher() no longer contains " +
        "the hardened flag $requiredFlagLiteral -- update this gate deliberately if the " +
        "hardening posture changed, do not let it silently keep proving a configuration the " +
        "product no longer ships")
    }
  }
  # Proven present above, byte-for-byte, in the production entry point -- not an independent guess.
  $productionMTFlag = "/MT"
  $productionLinkFlags = @("/DEPENDENTLOADFLAG:0x800")

  $launcher = Join-Path $root "native/portable-launcher/keiko-portable-launcher.c"
  $launcherOut = Join-Path $scratch "keiko-launcher.exe"
  $launcherObject = Join-Path $scratch "keiko-launcher.obj"
  & cl.exe @nativeFlags $productionMTFlag '/DKEIKO_PORTABLE_TARGET="windows-x64"' `
    "/Fo:$launcherObject" "/Fe:$launcherOut" $launcher /link @productionLinkFlags
  if ($LASTEXITCODE -ne 0) { throw "MSVC native quality analysis failed" }

  $launcherTest = Join-Path $root "native/portable-launcher/keiko-portable-launcher.windows.test.c"
  $launcherTestOut = Join-Path $scratch "keiko-launcher-test.exe"
  $launcherTestObject = Join-Path $scratch "keiko-launcher-test.obj"
  & cl.exe @nativeFlags '/DKEIKO_PORTABLE_TARGET="windows-x64"' `
    "/Fo:$launcherTestObject" "/Fe:$launcherTestOut" $launcherTest
  if ($LASTEXITCODE -ne 0) { throw "MSVC launcher behavior build failed" }
  & $launcherTestOut
  if ($LASTEXITCODE -ne 0) { throw "Windows launcher behavior verification failed" }

  # #2992: the Keiko-owned native setup bootstrap replaces the IExpress self-extractor. It is held
  # to the same /W4 /WX /analyze bar as the launcher. The baked-payload defines here are QUALITY
  # dummies (a valid 64-hex digest and a nonzero size) -- the real values are baked per release by
  # build-windows-portable-setup.mjs; this build only proves the source compiles and analyzes clean.
  $setupDefines = @(
    '/DKEIKO_SETUP_TARGET="windows-x64"',
    '/DKEIKO_SETUP_PAYLOAD_SHA256_HEX="0000000000000000000000000000000000000000000000000000000000000000"',
    "/DKEIKO_SETUP_PAYLOAD_SIZE_BYTES=1ULL"
  )
  $setupBootstrap = Join-Path $root "native/setup-bootstrap/keiko-setup-bootstrap.c"
  $setupBootstrapOut = Join-Path $scratch "keiko-setup-bootstrap.exe"
  $setupBootstrapObject = Join-Path $scratch "keiko-setup-bootstrap.obj"
  & cl.exe @nativeFlags $productionMTFlag @setupDefines "/Fo:$setupBootstrapObject" `
    "/Fe:$setupBootstrapOut" $setupBootstrap /link @productionLinkFlags
  if ($LASTEXITCODE -ne 0) { throw "MSVC setup-bootstrap quality analysis failed" }

  $setupBootstrapTest = Join-Path $root "native/setup-bootstrap/keiko-setup-bootstrap.windows.test.c"
  $setupBootstrapTestOut = Join-Path $scratch "keiko-setup-bootstrap-test.exe"
  $setupBootstrapTestObject = Join-Path $scratch "keiko-setup-bootstrap-test.obj"
  & cl.exe @nativeFlags @setupDefines "/Fo:$setupBootstrapTestObject" "/Fe:$setupBootstrapTestOut" $setupBootstrapTest
  if ($LASTEXITCODE -ne 0) { throw "MSVC setup-bootstrap behavior build failed" }
  & $setupBootstrapTestOut
  if ($LASTEXITCODE -ne 0) { throw "Windows setup-bootstrap behavior verification failed" }

  $c11Flags = @(
    "/nologo", "/std:c11", "/W4", "/WX", "/analyze", "/external:env:INCLUDE", "/external:W0",
    "/DUNICODE", "/D_UNICODE", "/D_CRT_SECURE_NO_WARNINGS"
  )

  $secureRead = Join-Path $root "native/secure-workspace-read/secure_workspace_read.c"
  $secureReadOut = Join-Path $scratch "secure-workspace-read.exe"
  $secureReadObject = Join-Path $scratch "secure-workspace-read.obj"
  & cl.exe @c11Flags "/Fo:$secureReadObject" "/Fe:$secureReadOut" $secureRead /link ntdll.lib
  if ($LASTEXITCODE -ne 0) { throw "MSVC secure-workspace-read quality analysis failed" }

  $supervisor = Join-Path $root "native/runtime-supervisor/windows/keiko_runtime_supervisor.c"
  $supervisorOut = Join-Path $scratch "keiko-runtime-supervisor.exe"
  $supervisorObject = Join-Path $scratch "keiko-runtime-supervisor.obj"
  & cl.exe @c11Flags "/Fo:$supervisorObject" "/Fe:$supervisorOut" $supervisor
  if ($LASTEXITCODE -ne 0) { throw "MSVC runtime-supervisor quality analysis failed" }

  $fixture = Join-Path $root "native/runtime-supervisor/windows/qualification_fixture.c"
  $fixtureOut = Join-Path $scratch "qualification-fixture.exe"
  $fixtureObject = Join-Path $scratch "qualification-fixture.obj"
  & cl.exe @c11Flags "/Fo:$fixtureObject" "/Fe:$fixtureOut" $fixture
  if ($LASTEXITCODE -ne 0) { throw "MSVC qualification-fixture quality analysis failed" }

  $attestation = Join-Path $root "native/runtime-attestation/windows/keiko_runtime_attestation.c"
  $attestationHeader = Join-Path $scratch "runtime_attestation_payload.h"
  $attestationOut = Join-Path $scratch "keiko-runtime-attestation.exe"
  $attestationObject = Join-Path $scratch "keiko-runtime-attestation.obj"
  $attestationPayload = '{"schemaVersion":1}' + [Environment]::NewLine
  @"
#ifndef KEIKO_RUNTIME_ATTESTATION_PAYLOAD_H
#define KEIKO_RUNTIME_ATTESTATION_PAYLOAD_H
static const unsigned char KEIKO_RUNTIME_ATTESTATION[] = {0x7b,0x22,0x73,0x63,0x68,0x65,0x6d,0x61,0x56,0x65,0x72,0x73,0x69,0x6f,0x6e,0x22,0x3a,0x31,0x7d,0x0a};
static const size_t KEIKO_RUNTIME_ATTESTATION_LENGTH = 20u;
#endif
"@ | Set-Content -LiteralPath $attestationHeader -Encoding utf8NoBOM
  & cl.exe @c11Flags "/I$scratch" "/Fo:$attestationObject" "/Fe:$attestationOut" $attestation
  if ($LASTEXITCODE -ne 0) { throw "MSVC runtime-attestation quality analysis failed" }
  $actualAttestationPayload = & $attestationOut --emit
  if ($LASTEXITCODE -ne 0 -or ($actualAttestationPayload + [Environment]::NewLine) -ne $attestationPayload) {
    throw "Runtime-attestation carrier boundary verification failed"
  }

  node (Join-Path $root "native/secure-workspace-read/test-protocol.mjs")
  if ($LASTEXITCODE -ne 0) { throw "secure-workspace-read boundary qualification failed" }

  node (Join-Path $root "native/runtime-supervisor/test-protocol.mjs")
  if ($LASTEXITCODE -ne 0) { throw "runtime-supervisor Job Object qualification failed" }

  $project = Join-Path $PSScriptRoot "native-quality/windows-rfc3161-quality.csproj"
  $intermediate = Join-Path $scratch "obj/"
  $output = Join-Path $scratch "bin/"
  dotnet build $project --configuration Release --nologo `
    "-p:BaseIntermediateOutputPath=$intermediate" "-p:OutputPath=$output"
  if ($LASTEXITCODE -ne 0) { throw ".NET analyzer quality build failed" }

  & pwsh -NoProfile -NonInteractive -File (Join-Path $PSScriptRoot "__tests__/windows-rfc3161-fixtures.ps1")
  if ($LASTEXITCODE -ne 0) { throw "RFC3161 fixture verification failed" }
} finally {
  Remove-Item -LiteralPath $scratch -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Output "windows-native-quality: PASS - compiler, analyzer, and fixture checks completed."
