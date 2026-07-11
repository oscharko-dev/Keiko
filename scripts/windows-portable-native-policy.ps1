Set-StrictMode -Version Latest

function Invoke-WindowsPortableNativePolicy {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][object[]]$Entries,
    [Parameter(Mandatory = $true)][string]$ExpectedIdentityEku,
    [Parameter(Mandatory = $true)][scriptblock]$VerifySigntool,
    [Parameter(Mandatory = $true)][scriptblock]$ReadSignature,
    [Parameter(Mandatory = $true)][scriptblock]$VerifyChain,
    [Parameter(Mandatory = $true)][scriptblock]$VerifyEku,
    [Parameter(Mandatory = $true)][scriptblock]$VerifyTimestamp
  )

  if ($Entries.Count -eq 0) {
    return [pscustomobject]@{
      PublisherChainVerified = $false
      TimestampVerified = $false
      ResultCount = 0
      Results = @()
    }
  }

  $publisherVerified = $true
  $timestampVerified = $true
  $results = @()
  foreach ($entry in $Entries) {
    $publisherValid = $false
    $timestampValid = $false
    try {
      $signtoolValid = [bool](& $VerifySigntool $entry.Path)
      $signature = & $ReadSignature $entry.Path
      $signer = $signature.SignerCertificate
      $publisherValid =
        $signtoolValid -and
        $signature.Status.ToString() -eq "Valid" -and
        $null -ne $signer -and
        [bool](& $VerifyChain $signer) -and
        [bool](& $VerifyEku $signer "1.3.6.1.5.5.7.3.3") -and
        [bool](& $VerifyEku $signer $ExpectedIdentityEku)
      $timestampValid = [bool](& $VerifyTimestamp $entry.Path)
    }
    catch {
      $publisherValid = $false
      $timestampValid = $false
    }
    $publisherVerified = $publisherVerified -and $publisherValid
    $timestampVerified = $timestampVerified -and $timestampValid
    $results += [pscustomobject]@{
      PublisherVerified = $publisherValid
      TimestampVerified = $timestampValid
    }
  }

  return [pscustomobject]@{
    PublisherChainVerified = $publisherVerified -and $results.Count -eq $Entries.Count
    TimestampVerified = $timestampVerified -and $results.Count -eq $Entries.Count
    ResultCount = $results.Count
    Results = $results
  }
}
