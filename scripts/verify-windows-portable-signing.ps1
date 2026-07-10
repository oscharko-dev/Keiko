[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$StageRoot,
  [Parameter(Mandatory = $true)][string]$InventoryPath,
  [Parameter(Mandatory = $true)][string]$VerificationInput,
  [Parameter(Mandatory = $true)][string]$ExpectedIdentityEku
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Fail-Bounded([string]$Reason) {
  throw "windows-portable-signing: $Reason"
}

function Test-Eku([System.Security.Cryptography.X509Certificates.X509Certificate2]$Certificate, [string]$Oid) {
  foreach ($extension in $Certificate.Extensions) {
    if ($extension.Oid.Value -ne "2.5.29.37") { continue }
    $eku = [System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new(
      $extension,
      $extension.Critical
    )
    if ($null -ne ($eku.EnhancedKeyUsages | Where-Object { $_.Value -eq $Oid })) { return $true }
  }
  return $false
}

function Test-CertificateChain([System.Security.Cryptography.X509Certificates.X509Certificate2]$Certificate) {
  $chain = [System.Security.Cryptography.X509Certificates.X509Chain]::new()
  try {
    $chain.ChainPolicy.RevocationMode = [System.Security.Cryptography.X509Certificates.X509RevocationMode]::Online
    $chain.ChainPolicy.RevocationFlag = [System.Security.Cryptography.X509Certificates.X509RevocationFlag]::EntireChain
    return $chain.Build($Certificate)
  }
  finally {
    $chain.Dispose()
  }
}

function Test-Rfc3161Timestamp([string]$Path) {
  $result = [WindowsPortableRfc3161]::VerifyFile($Path)
  return $result.Valid -and $result.Certificates.Count -gt 0
}

try {
  $references = [string][AppContext]::GetData("TRUSTED_PLATFORM_ASSEMBLIES") -split [IO.Path]::PathSeparator
  Add-Type -Path (Join-Path $PSScriptRoot "windows-portable-rfc3161.cs") -ReferencedAssemblies $references
}
catch {
  Fail-Bounded "verification-tool-unavailable"
}

if ($ExpectedIdentityEku -notmatch '^1\.3\.6\.1\.4\.1\.311\.97\.[0-9]+(?:\.[0-9]+)*$') {
  Fail-Bounded "configured subscriber identity EKU is invalid"
}
if (-not (Test-Path -LiteralPath $InventoryPath -PathType Leaf)) {
  Fail-Bounded "PE inventory is unavailable"
}
if ($null -eq (Get-Command signtool.exe -ErrorAction SilentlyContinue)) {
  Fail-Bounded "verification-tool-unavailable"
}

$stage = [System.IO.Path]::GetFullPath($StageRoot)
$payload = [System.IO.Path]::GetFullPath((Join-Path $stage "payload\Keiko"))
$inventory = Get-Content -LiteralPath $InventoryPath -Raw | ConvertFrom-Json
if ($inventory.schemaVersion -ne 1 -or $inventory.target -ne "windows-x64" -or $inventory.files.Count -lt 1) {
  Fail-Bounded "PE inventory is invalid"
}

$publisherVerified = $true
$timestampVerified = $true
$verifiedCount = 0
$inventoryPaths = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
foreach ($entry in $inventory.files) {
  if ($entry.relativePath -notmatch '^[^\\/:*?"<>|]+(?:/[^\\/:*?"<>|]+)*$') {
    Fail-Bounded "PE inventory contains an unsafe path"
  }
  $candidate = [System.IO.Path]::GetFullPath((Join-Path $payload ($entry.relativePath -replace '/', '\')))
  $prefix = $payload.TrimEnd('\') + '\'
  if (-not $candidate.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    Fail-Bounded "PE inventory escapes the payload root"
  }
  if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
    Fail-Bounded "an inventoried PE file is missing"
  }

  try {
    & signtool.exe verify /pa /all /tw /v $candidate *> $null
    $signtoolValid = $LASTEXITCODE -eq 0
    $signature = Get-AuthenticodeSignature -LiteralPath $candidate
    $signer = $signature.SignerCertificate
    $publisherValid =
      $signtoolValid -and
      $signature.Status -eq [System.Management.Automation.SignatureStatus]::Valid -and
      $null -ne $signer -and
      (Test-CertificateChain $signer) -and
      (Test-Eku $signer "1.3.6.1.5.5.7.3.3") -and
      (Test-Eku $signer $ExpectedIdentityEku)
    $timestampValid = Test-Rfc3161Timestamp $candidate
  }
  catch {
    $publisherValid = $false
    $timestampValid = $false
  }
  $publisherVerified = $publisherVerified -and $publisherValid
  $timestampVerified = $timestampVerified -and $timestampValid
  if (-not $inventoryPaths.Add($entry.relativePath)) { Fail-Bounded "PE inventory contains duplicates" }
  $verifiedCount += 1
}

if ($verifiedCount -ne $inventory.files.Count) {
  Fail-Bounded "PE verification coverage is incomplete"
}

$manifest = Get-Content -LiteralPath (Join-Path $stage "manifest\portable-manifest.json") -Raw | ConvertFrom-Json
$sidecars = @()
foreach ($sidecar in @($manifest.sidecarRuntimes)) {
  if (-not $inventoryPaths.Contains($sidecar.executablePath)) {
    Fail-Bounded "sidecar PE verification coverage is incomplete"
  }
  $sidecars += [ordered]@{
    name = $sidecar.name
    reasonCodes = @()
    verificationChecks = [ordered]@{
      publisherChainVerified = $publisherVerified
      timestampVerified = $timestampVerified
    }
  }
}
$reasonCodes = @()
if (-not $publisherVerified) { $reasonCodes += "windows-publisher-chain-unverified" }
if (-not $timestampVerified) { $reasonCodes += "windows-timestamp-unverified" }
$result = [ordered]@{
  reasonCodes = $reasonCodes
  verificationChecks = [ordered]@{
    publisherChainVerified = $publisherVerified
    timestampVerified = $timestampVerified
  }
  sidecarRuntimes = $sidecars
}
$result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $VerificationInput -Encoding utf8NoBOM

if (-not $publisherVerified) { Fail-Bounded "windows-publisher-chain-unverified" }
if (-not $timestampVerified) { Fail-Bounded "windows-timestamp-unverified" }
Write-Host "windows-portable-signing: native verification passed for $verifiedCount PE files"
