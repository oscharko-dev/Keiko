# Qualify a temporary SCM installation on a disposable Windows runner.
[CmdletBinding()]
param()
$ErrorActionPreference = "Stop"
$serviceName = "KeikoRuntimeGateway"
$install = Join-Path $env:ProgramFiles ("Keiko-Gateway-Proof-" + [guid]::NewGuid().ToString("N"))
if (Get-Service -Name $serviceName -ErrorAction SilentlyContinue) { throw "Service name already in use" }
$helper = Join-Path $install "keiko-runtime-supervisor.exe"
$created = $false
try {
  New-Item -ItemType Directory -Path $install -ErrorAction Stop | Out-Null
  node scripts/build-runtime-supervisor.mjs windows-x64 $helper
  if ($LASTEXITCODE) { throw "Supervisor build failed" }
  node scripts/testing/test-windows-gateway-service.mjs build $helper
  if ($LASTEXITCODE) { throw "Observer build failed" }
  node scripts/testing/test-windows-gateway-service.mjs unavailable $helper
  if ($LASTEXITCODE) { throw "Absent-service proof failed" }
  New-Service -Name $serviceName -BinaryPathName ('"' + $helper + '" --gateway-service') -StartupType Manual -DependsOn BFE | Out-Null
  $created = $true
  Start-Service -Name $serviceName
  node scripts/testing/test-windows-gateway-service.mjs installed $helper
  if ($LASTEXITCODE) { throw "Installed-service proof failed" }
} finally {
  if ($created) {
    Stop-Service -Name $serviceName -ErrorAction Stop
    & "$env:SystemRoot\System32\sc.exe" delete $serviceName
    if ($LASTEXITCODE) { throw "Service cleanup failed" }
  }
  $target = [IO.Path]::GetFullPath($install)
  if ([IO.Path]::GetDirectoryName($target) -ne [IO.Path]::GetFullPath($env:ProgramFiles) -or
      [IO.Path]::GetFileName($target) -notmatch '^Keiko-Gateway-Proof-[a-f0-9]{32}$') { throw "Unexpected proof directory" }
  if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
}
