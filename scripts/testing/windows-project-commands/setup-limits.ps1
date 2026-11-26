# #4493: prepares the limit cases `limits.json` names, for the account that runs it, after
# setup-workspace.ps1: a file below a path longer than MAX_PATH; a junction inside the workspace to
# a folder inside it, and one to a folder outside it (never a real profile folder); a copy of the
# workspace on a second volume (when -Volume names one); and a copy in a folder an administrator
# shared as \\localhost\k4493.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File setup-limits.ps1 [-Volume D:]
param([string]$Volume = "")
$ErrorActionPreference = "Stop"
$ws = Join-Path $env:USERPROFILE "keiko-4493\ws"
$deep = "\\?\" + (Join-Path $ws ("deep\" + (("segment-of-forty-characters-for-length" + "\") * 8)))
New-Item -ItemType Directory -Force -Path $deep | Out-Null
Set-Content -LiteralPath ($deep + "file.txt") -Value "deep" -Encoding ascii
New-Item -ItemType Directory -Force -Path (Join-Path $ws "inside") | Out-Null
Set-Content -Path (Join-Path $ws "inside\file.txt") -Value "inside" -Encoding ascii
& cmd.exe /d /c mklink /J (Join-Path $ws "link-inside") (Join-Path $ws "inside") | Out-Null
$outside = Join-Path $env:USERPROFILE "keiko-4493\outside-target"
New-Item -ItemType Directory -Force -Path $outside | Out-Null
Set-Content -Path (Join-Path $outside "file.txt") -Value "outside" -Encoding ascii
& cmd.exe /d /c mklink /J (Join-Path $ws "link-outside") $outside | Out-Null
if ($Volume -ne "") {
  $other = Join-Path $Volume "keiko-4493-ws"
  if (Test-Path $other) { Remove-Item -Recurse -Force $other }
  Copy-Item -Recurse (Join-Path $ws "*") -Destination (New-Item -ItemType Directory -Path $other) -Exclude deep, link-inside, link-outside
}
$share = Join-Path $env:USERPROFILE "keiko-4493-share"
if (Test-Path $share) { Copy-Item -Force (Join-Path $ws "package.json") $share }
"limits ready"
