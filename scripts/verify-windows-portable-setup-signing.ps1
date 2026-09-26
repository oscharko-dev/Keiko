[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$SetupPath,
  [Parameter(Mandatory = $true)][string]$ExpectedIdentityEku
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot "windows-portable-native-policy.ps1")

function Fail-Bounded([string]$Reason) {
  throw "windows-portable-setup-signing: $Reason"
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
  $result = [Keiko.Portable.WindowsPortableRfc3161]::VerifyFile($Path)
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
if ($null -eq (Get-Command signtool.exe -ErrorAction SilentlyContinue)) {
  Fail-Bounded "verification-tool-unavailable"
}

$setup = [System.IO.Path]::GetFullPath($SetupPath)
if ([System.IO.Path]::GetFileName($setup) -ine "keiko-windows-x64-setup.exe") {
  Fail-Bounded "setup companion name is invalid"
}
if (-not (Test-Path -LiteralPath $setup -PathType Leaf)) {
  Fail-Bounded "setup companion is unavailable"
}

$policy = Invoke-WindowsPortableNativePolicy `
  -Entries @([pscustomobject]@{ Path = $setup }) `
  -ExpectedIdentityEku $ExpectedIdentityEku `
  -VerifySigntool {
    param($Path)
    & signtool.exe verify /pa /all /tw /v $Path *> $null
    return $LASTEXITCODE -eq 0
  } `
  -ReadSignature { param($Path) Get-AuthenticodeSignature -LiteralPath $Path } `
  -VerifyChain { param($Certificate) Test-CertificateChain $Certificate } `
  -VerifyEku { param($Certificate, $Oid) Test-Eku $Certificate $Oid } `
  -VerifyTimestamp { param($Path) Test-Rfc3161Timestamp $Path }

if ($policy.ResultCount -ne 1) { Fail-Bounded "setup verification coverage is incomplete" }
if (-not $policy.PublisherChainVerified) { Fail-Bounded "windows-publisher-chain-unverified" }
if (-not $policy.TimestampVerified) { Fail-Bounded "windows-timestamp-unverified" }
Write-Host "windows-portable-setup-signing: setup companion verification passed"
