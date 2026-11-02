# Qualify a temporary SCM installation on a disposable Windows runner.
[CmdletBinding()]
param([switch]$VerifyTransport)
$ErrorActionPreference = "Stop"
$serviceName = "KeikoRuntimeGateway"
$install = Join-Path $env:ProgramFiles ("Keiko-Gateway-Proof-" + [guid]::NewGuid().ToString("N"))
if (Get-Service -Name $serviceName -ErrorAction SilentlyContinue) { throw "Service name already in use" }
$helper = Join-Path $install "keiko-runtime-supervisor.exe"
$created = $false
$digest = $null
$installed = Join-Path $env:ProgramFiles "KeikoRuntimeGateway\keiko-runtime-supervisor.exe"
function Assert-GatewayCommand([string[]]$Arguments, [int]$Expected, [string]$Name) {
  & $helper @Arguments
  if ($LASTEXITCODE -ne $Expected) { throw "$Name returned $LASTEXITCODE, expected $Expected" }
}
try {
  New-Item -ItemType Directory -Path $install -ErrorAction Stop | Out-Null
  node scripts/build-runtime-supervisor.mjs windows-x64 $helper
  if ($LASTEXITCODE) { throw "Supervisor build failed" }
  node native/runtime-supervisor/test-protocol.mjs --helper $helper
  if ($LASTEXITCODE) { throw "Supervisor lifecycle proof failed" }
  node scripts/testing/test-windows-gateway-service.mjs build $helper
  if ($LASTEXITCODE) { throw "Observer build failed" }
  $os = Get-CimInstance Win32_OperatingSystem
  $volume = Get-Volume -DriveLetter $install[0]
  [ordered]@{
    windows = $os.Caption
    version = $os.Version
    arch = $os.OSArchitecture
    filesystem = $volume.FileSystem
    node = (node --version)
    supervisorSha256 = (Get-FileHash -LiteralPath $helper).Hash
    observerSha256 = (Get-FileHash -LiteralPath (Join-Path $install "gateway-service-probe.exe")).Hash
  } | ConvertTo-Json -Compress
  node scripts/testing/test-windows-gateway-service.mjs unavailable $helper
  if ($LASTEXITCODE) { throw "Absent-service proof failed" }
  $digest = (Get-FileHash -LiteralPath $helper).Hash.ToLowerInvariant()
  $wrong = "0" * 64
  Assert-GatewayCommand @("--gateway-service-status", $digest) 10 "Status before install"
  Assert-GatewayCommand @("--gateway-service-install", $wrong) 21 "Install with a foreign pin"
  if (Get-Service -Name $serviceName -ErrorAction SilentlyContinue) { throw "A foreign pin created the service" }
  $created = $true
  Assert-GatewayCommand @("--gateway-service-install", $digest) 0 "Install"
  Assert-GatewayCommand @("--gateway-service-install", $digest) 0 "Repeated install"
  Assert-GatewayCommand @("--gateway-service-status", $digest) 0 "Status after install"
  Assert-GatewayCommand @("--gateway-service-status", $wrong) 12 "Status against another version"
  $service = Get-CimInstance Win32_Service -Filter "Name='$serviceName'"
  if ($service.StartMode -ne "Auto" -or -not $service.DelayedAutoStart -or $service.StartName -ne "LocalSystem") { throw "Unexpected service configuration" }
  if ((Get-Service -Name $serviceName).ServicesDependedOn.Name -notcontains "BFE") { throw "Missing BFE dependency" }
  if ((Get-FileHash -LiteralPath $installed).Hash.ToLowerInvariant() -ne $digest) { throw "Installed image digest differs" }
  $acl = Get-Acl -LiteralPath (Split-Path $installed)
  if (-not $acl.AreAccessRulesProtected) { throw "Installation directory inherits its access rules" }
  $writeRights = [Security.AccessControl.FileSystemRights]::Write
  foreach ($rule in $acl.Access) {
    if ($rule.IdentityReference.Value -match "Authenticated Users|\\Users$|Everyone" -and ($rule.FileSystemRights -band $writeRights)) { throw "Installation directory grants write access" }
  }
  Stop-Service -Name $serviceName
  Assert-GatewayCommand @("--gateway-service-status", $digest) 11 "Status while stopped"
  Assert-GatewayCommand @("--gateway-service-install", $digest) 0 "Repair of a stopped service"
  node scripts/testing/test-windows-gateway-service.mjs installed $installed $install
  if ($LASTEXITCODE) { throw "Installed-service proof failed" }
  $transportArgs = @()
  if ($VerifyTransport) { $transportArgs += "--verify-transport" }
  node scripts/testing/test-windows-workbench-adapter.mjs $installed $install @transportArgs
  if ($LASTEXITCODE) { throw "Workbench native adapter proof failed" }
} finally {
  if ($created) {
    Assert-GatewayCommand @("--gateway-service-uninstall") 10 "Uninstall"
    Assert-GatewayCommand @("--gateway-service-uninstall") 10 "Repeated uninstall"
    if (Get-Service -Name $serviceName -ErrorAction SilentlyContinue) { throw "Uninstall left the service" }
    if (Test-Path -LiteralPath (Split-Path $installed)) { throw "Uninstall left the installation directory" }
    Assert-GatewayCommand @("--gateway-service-status", $digest) 10 "Status after uninstall"
  }
  $target = [IO.Path]::GetFullPath($install)
  if ([IO.Path]::GetDirectoryName($target) -ne [IO.Path]::GetFullPath($env:ProgramFiles) -or
      [IO.Path]::GetFileName($target) -notmatch '^Keiko-Gateway-Proof-[a-f0-9]{32}$') { throw "Unexpected proof directory" }
  if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
}
