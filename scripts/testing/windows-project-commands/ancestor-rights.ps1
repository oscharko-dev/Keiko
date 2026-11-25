# #4493: the ancestor-rights experiment of the qualification document. Lab tooling, never product
# behaviour: it weakens the machine for every AppContainer on it until it is restored, so it runs only
# on a disposable lab machine, by an administrator, and refuses without -DisposableLabVm.
# `v1` gives ALL APPLICATION PACKAGES (S-1-15-2-1), without inheritance, the rights the Windows
# capabilities isolatedWin32-volumeRootMinimal, -profilesRootMinimal and -userProfileMinimal hold on
# C:\, C:\Users and the profile; `v2` adds list rights on the profile folders above the workspace and
# the toolchains. It refuses to start when any of these folders already carries an explicit entry for
# that SID, rolls back when a step fails, and `restore` fails unless every entry is gone.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File ancestor-rights.ps1 -Mode v1|v2|restore -UserProfile C:\Users\<name> -DisposableLabVm
param(
  [Parameter(Mandatory)][ValidateSet("v1", "v2", "restore")][string]$Mode,
  [Parameter(Mandatory)][string]$UserProfile,
  [switch]$DisposableLabVm
)
$ErrorActionPreference = "Stop"
if (-not $DisposableLabVm) { throw "ancestor-rights.ps1 runs only on a disposable lab machine (-DisposableLabVm)" }
if (-not (Test-Path -LiteralPath $UserProfile -PathType Container)) { throw "no profile folder: $UserProfile" }
$sid = "S-1-15-2-1"
$profileChain = @($UserProfile, "$UserProfile\AppData", "$UserProfile\AppData\Local", "$UserProfile\keiko-4493")
$all = @("C:\", "C:\Users") + $profileChain
function Entries([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return 0 }
  $rules = (Get-Acl -LiteralPath $Path).GetAccessRules($true, $false, [System.Security.Principal.SecurityIdentifier])
  @($rules | Where-Object { $_.IdentityReference.Value -eq $sid }).Count
}
function Icacls([string[]]$Arguments) {
  $output = & icacls.exe @Arguments 2>&1
  if ($LASTEXITCODE -ne 0) { throw "icacls $($Arguments -join ' ') failed ($LASTEXITCODE): $output" }
}
function Restore {
  foreach ($path in $all) { if (Test-Path -LiteralPath $path) { Icacls @($path, "/remove:g", "*$sid") } }
  $left = @($all | Where-Object { (Entries $_) -ne 0 })
  if ($left.Count -ne 0) { throw "entries for $sid remain on: $($left -join ', ')" }
}
if ($Mode -eq "restore") {
  Restore
} else {
  $present = @($all | Where-Object { (Entries $_) -ne 0 })
  if ($present.Count -ne 0) { throw "explicit entries for $sid already exist on: $($present -join ', '); restore first" }
  try {
    Icacls @("C:\", "/grant", "*${sid}:(S,RD,X,RA)")
    Icacls @("C:\Users", "/grant", "*${sid}:(S,RD,X)")
    if ($Mode -eq "v1") { Icacls @($UserProfile, "/grant", "*${sid}:(S,X)") }
    else { foreach ($path in $profileChain) { Icacls @($path, "/grant", "*${sid}:(S,RD,X,RA)") } }
  } catch {
    Restore
    throw
  }
}
foreach ($path in $all) { "$path entries=$(Entries $path)" }
