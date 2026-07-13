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

  $launcher = Join-Path $root "native/portable-launcher/keiko-portable-launcher.c"
  $launcherOut = Join-Path $scratch "keiko-launcher.exe"
  $launcherObject = Join-Path $scratch "keiko-launcher.obj"
  & cl.exe @nativeFlags '/DKEIKO_PORTABLE_TARGET="windows-x64"' `
    "/Fo:$launcherObject" "/Fe:$launcherOut" $launcher
  if ($LASTEXITCODE -ne 0) { throw "MSVC native quality analysis failed" }

  $launcherTest = Join-Path $root "native/portable-launcher/keiko-portable-launcher.windows.test.c"
  $launcherTestOut = Join-Path $scratch "keiko-launcher-test.exe"
  $launcherTestObject = Join-Path $scratch "keiko-launcher-test.obj"
  & cl.exe @nativeFlags '/DKEIKO_PORTABLE_TARGET="windows-x64"' `
    "/Fo:$launcherTestObject" "/Fe:$launcherTestOut" $launcherTest
  if ($LASTEXITCODE -ne 0) { throw "MSVC launcher behavior build failed" }
  & $launcherTestOut
  if ($LASTEXITCODE -ne 0) { throw "Windows launcher behavior verification failed" }

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
