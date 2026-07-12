$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "..\windows-portable-native-policy.ps1")

$expectedEku = "1.3.6.1.4.1.311.97.12345"

function Invoke-Fixture([hashtable]$Observations) {
  $entries = @($Observations.Keys | Sort-Object | ForEach-Object { [pscustomobject]@{ Path = $_ } })
  return Invoke-WindowsPortableNativePolicy `
    -Entries $entries `
    -ExpectedIdentityEku $expectedEku `
    -VerifySigntool { param($Path) $Observations[$Path].Signtool } `
    -ReadSignature {
      param($Path)
      $observation = $Observations[$Path]
      if ($observation.Throws) { throw "unbounded provider detail" }
      return [pscustomobject]@{
        Status = $observation.Status
        SignerCertificate = if ($observation.Signer) { $observation } else { $null }
      }
    } `
    -VerifyChain { param($Certificate) $Certificate.Chain } `
    -VerifyEku {
      param($Certificate, $Oid)
      if ($Oid -eq "1.3.6.1.5.5.7.3.3") { return $Certificate.CodeEku }
      return $Certificate.IdentityEku
    } `
    -VerifyTimestamp { param($Path) $Observations[$Path].Timestamp }
}

function Observation([hashtable]$Overrides = @{}) {
  $value = @{
    Signtool = $true
    Status = "Valid"
    Signer = $true
    Chain = $true
    CodeEku = $true
    IdentityEku = $true
    Timestamp = $true
    Throws = $false
  }
  foreach ($key in $Overrides.Keys) { $value[$key] = $Overrides[$key] }
  return [pscustomobject]$value
}

function Assert-Policy([string]$Name, [hashtable]$Observations, [bool]$Publisher, [bool]$Timestamp) {
  $result = Invoke-Fixture $Observations
  if ($result.PublisherChainVerified -ne $Publisher -or $result.TimestampVerified -ne $Timestamp) {
    throw "native policy fixture failed: $Name"
  }
}

Assert-Policy "success" @{ a = Observation } $true $true
Assert-Policy "valid-but-unsigned" @{
  a = Observation @{ Signtool = $false; Status = "NotSigned"; Signer = $false; Timestamp = $false }
} $false $false
Assert-Policy "partial-signing" @{
  a = Observation
  b = Observation @{ Signtool = $false; Status = "NotSigned"; Signer = $false; Timestamp = $false }
} $false $false
Assert-Policy "invalid-chain" @{ a = Observation @{ Chain = $false } } $false $true
Assert-Policy "subscriber-eku-mismatch" @{ a = Observation @{ IdentityEku = $false } } $false $true
Assert-Policy "missing-rfc3161" @{ a = Observation @{ Timestamp = $false } } $true $false
Assert-Policy "legacy-rfc3161" @{ a = Observation @{ Timestamp = $false } } $true $false
Assert-Policy "invalid-rfc3161" @{ a = Observation @{ Timestamp = $false } } $true $false
Assert-Policy "bounded-native-exception" @{ a = Observation @{ Throws = $true } } $false $false
Assert-Policy "empty-entries" @{} $false $false
