# #4493: prepares the workspace the plans in this folder name, for the account that runs it (a
# standard user). It creates %USERPROFILE%\keiko-4493\ws (an npm project, a Git repository with one
# commit and a linked worktree, a plain .env and a .env.denied that every AppContainer is denied by an
# explicit entry), and copies a Node.js into the per-user location the plans name when none is there.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File setup-workspace.ps1 -NodeSource <dir> -Git <git.exe>
param([Parameter(Mandatory)][string]$NodeSource, [Parameter(Mandatory)][string]$Git)
$ErrorActionPreference = "Stop"
$root = Join-Path $env:USERPROFILE "keiko-4493"
$ws = Join-Path $root "ws"
if (Test-Path $root) { Remove-Item -Recurse -Force $root }
New-Item -ItemType Directory -Path $ws | Out-Null
Set-Content -Path (Join-Path $ws "package.json") -Encoding ascii -Value '{ "name": "probe-4493", "version": "1.0.0", "private": true, "scripts": { "test": "node test.js" } }'
Set-Content -Path (Join-Path $ws "test.js") -Encoding ascii -Value 'require("node:fs").writeFileSync("out.txt", "tests passed\n"); console.log("1 test passed");'
Set-Content -Path (Join-Path $ws ".env") -Encoding ascii -Value "PROBE_VALUE=plain"
$denied = Join-Path $ws ".env.denied"
Set-Content -Path $denied -Encoding ascii -Value "PROBE_VALUE=denied"
# S-1-15-2-1 is ALL APPLICATION PACKAGES: an explicit deny for every AppContainer, read and write.
& icacls.exe $denied /deny "*S-1-15-2-1:(R,W)" | Out-Null
Push-Location $ws
& $Git init -q -b main
& $Git -c user.name=Probe -c user.email=probe@keiko.invalid -c commit.gpgsign=false add package.json test.js
& $Git -c user.name=Probe -c user.email=probe@keiko.invalid -c commit.gpgsign=false commit -q -m Baseline
& $Git worktree add -q (Join-Path $root "ws-worktree") -b probe-worktree
Pop-Location
$userNode = Join-Path $env:LOCALAPPDATA "Programs\nodejs"
if (-not (Test-Path (Join-Path $userNode "node.exe"))) {
  New-Item -ItemType Directory -Force -Path $userNode | Out-Null
  Copy-Item -Recurse -Force (Join-Path $NodeSource "*") $userNode
}
"workspace ready: $ws"
