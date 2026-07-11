[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$ArtifactRoot,
  [Parameter(Mandatory = $true)][string]$ExpectedIdentityEku,
  [Parameter(Mandatory = $true)][string]$ScratchRoot
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
$artifact = [System.IO.Path]::GetFullPath($ArtifactRoot)
$scratch = [System.IO.Path]::GetFullPath($ScratchRoot)
try {
  if (Test-Path -LiteralPath $scratch) { Remove-Item -LiteralPath $scratch -Recurse -Force }
  New-Item -ItemType Directory -Path $scratch | Out-Null
  $manifest = Get-Content -LiteralPath (Join-Path $artifact "manifest\portable-manifest.json") -Raw | ConvertFrom-Json
  if ($manifest.artifact.platformTarget -ne "windows-x64" -or $manifest.release.releaseId -ne 0 -or $manifest.artifact.assetId -ne 0) {
    throw "fresh-windows-qualification: candidate manifest identity is invalid"
  }
  $archive = Join-Path $artifact $manifest.artifact.assetName
  if ((Get-Item -LiteralPath $archive).Length -ne $manifest.artifact.sizeBytes) { throw "fresh-windows-qualification: archive size mismatch" }
  if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $manifest.artifact.sha256) { throw "fresh-windows-qualification: archive digest mismatch" }
  Expand-Archive -LiteralPath $archive -DestinationPath (Join-Path $scratch "extracted")
  $stage = Join-Path $scratch "stage"
  New-Item -ItemType Directory -Path (Join-Path $stage "payload") | Out-Null
  Copy-Item -LiteralPath (Join-Path $scratch "extracted\Keiko") -Destination (Join-Path $stage "payload\Keiko") -Recurse
  Copy-Item -LiteralPath (Join-Path $artifact "manifest") -Destination (Join-Path $stage "manifest") -Recurse
  $inventory = Join-Path $scratch "inventory.json"
  $catalog = Join-Path $scratch "catalog.txt"
  node scripts/windows-portable-signing.mjs inventory --stage-root $stage --inventory $inventory --catalog $catalog
  ./scripts/verify-windows-portable-signing.ps1 -StageRoot $stage -InventoryPath $inventory -VerificationInput (Join-Path $scratch "verification.json") -ExpectedIdentityEku $ExpectedIdentityEku
  Write-Host "fresh Windows qualification passed for windows-x64"
}
finally {
  if (Test-Path -LiteralPath $scratch) { Remove-Item -LiteralPath $scratch -Recurse -Force }
}
