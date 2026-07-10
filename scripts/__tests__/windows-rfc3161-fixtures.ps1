$ErrorActionPreference = "Stop"
$references = [string][AppContext]::GetData("TRUSTED_PLATFORM_ASSEMBLIES") -split [IO.Path]::PathSeparator
Add-Type -Path (Join-Path $PSScriptRoot "..\windows-portable-rfc3161.cs") -ReferencedAssemblies $references
Add-Type -Path (Join-Path $PSScriptRoot "windows-rfc3161-fixtures.cs") -ReferencedAssemblies $references

function Assert-Result([string]$Mode, [bool]$Expected) {
  $fixture = [WindowsRfc3161Fixtures]::Create($Mode)
  $roots = [System.Security.Cryptography.X509Certificates.X509Certificate2Collection]::new()
  [void]$roots.Add($fixture.TrustRoot)
  $result = [WindowsPortableRfc3161]::VerifyAuthenticodeCms($fixture.Cms, $roots)
  if ($result.Valid -ne $Expected) { throw "RFC3161 fixture failed: $Mode" }
}

Assert-Result "valid" $true
Assert-Result "missing" $false
Assert-Result "legacy" $false
Assert-Result "rfc-plus-legacy" $false
Assert-Result "wrong-digest" $false
Assert-Result "wrong-imprint" $false
Assert-Result "corrupt-token" $false
Assert-Result "wrong-eku" $false
Assert-Result "wrong-root" $false
Assert-Result "duplicate" $false

$malformed = [WindowsPortableRfc3161]::VerifyAuthenticodeCms([byte[]](1, 2, 3))
if ($malformed.Valid -or $malformed.Reason -ne "windows-timestamp-unverified") {
  throw "malformed CMS was not bounded"
}
