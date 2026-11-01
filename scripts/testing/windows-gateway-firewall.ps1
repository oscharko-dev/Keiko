# Disposable GitHub runner fixture. Never invoked by the default native test or shipping code.
param(
    [Parameter(Mandatory)][ValidatePattern('^Keiko\.Gateway\.Inbound\.Fixture\.[0-9a-f-]{36}$')][string]$RuleName,
    [Parameter(Mandatory)][ValidatePattern('^S-1-15-2(-[0-9]+){7}$')][string]$PackageSid,
    [Parameter(Mandatory)][string]$Program,
    [Parameter(Mandatory)][ValidateRange(1, 65535)][int]$Port,
    [Parameter(Mandatory)][ValidateSet(2, 23)][int]$Family
)

# Accept only one exact host, including the provider's canonical IPv6 spelling.
# A subnet, range, mapped IPv4 address, or address from the other family is not equivalent.
function Test-ExactLoopbackAddress($Values, [int]$AddressFamily) {
    if (@($Values).Count -ne 1) { return $false }
    $parts = ([string]@($Values)[0]).Split('/')
    $width = if ($AddressFamily -eq 2) { '32' } else { '128' }
    if ($parts.Count -gt 2 -or ($parts.Count -eq 2 -and $parts[1] -cne $width)) { return $false }
    $parsed = $null
    if (-not [Net.IPAddress]::TryParse($parts[0], [ref]$parsed)) { return $false }
    $expected = if ($AddressFamily -eq 2) { [Net.IPAddress]::Loopback } else { [Net.IPAddress]::IPv6Loopback }
    return $parsed.Equals($expected)
}

$ErrorActionPreference = 'Stop'
$stage = 100
try {
    if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows' -or
        $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or
        -not [IO.Path]::IsPathRooted($Program) -or -not (Test-Path -LiteralPath $Program -PathType Leaf)) {
        exit 87
    }
    $address = if ($Family -eq 2) { '127.0.0.1' } else { '::1/128' }
    $owner = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    # All restrictions are applied atomically; never create a broad intermediate allow rule.
    $parameters = @{
        Name = $RuleName; DisplayName = $RuleName; PolicyStore = 'PersistentStore'
        Package = $PackageSid; Program = $Program; Owner = $owner
        Direction = 'Inbound'; Action = 'Allow'; Enabled = 'True'; Profile = 'Any'
        Protocol = 'TCP'; LocalPort = "$Port"; LocalAddress = $address; RemoteAddress = $address
        EdgeTraversalPolicy = 'Block'; Authentication = 'NotRequired'; OverrideBlockRules = $false
    }
    $stage = 101
    $rule = New-NetFirewallRule @parameters
    $stage = 102
    $application = $rule | Get-NetFirewallApplicationFilter
    $stage = 103
    $transport = $rule | Get-NetFirewallPortFilter
    $stage = 104
    $addresses = $rule | Get-NetFirewallAddressFilter
    $stage = 105
    $security = $rule | Get-NetFirewallSecurityFilter
    if ($application.Package -ne $PackageSid -or $application.Program -ne $Program -or
        "$($transport.Protocol)" -notin @('TCP', '6') -or
        @($transport.LocalPort).Count -ne 1 -or @($transport.LocalPort)[0] -ne "$Port" -or
        -not (Test-ExactLoopbackAddress $addresses.LocalAddress $Family) -or
        -not (Test-ExactLoopbackAddress $addresses.RemoteAddress $Family) -or
        "$($rule.Direction)" -ne 'Inbound' -or "$($rule.Action)" -ne 'Allow' -or
        "$($rule.Enabled)" -ne 'True' -or $rule.Owner -ne $owner -or
        "$($rule.EdgeTraversalPolicy)" -ne 'Block' -or
        "$($security.Authentication)" -ne 'NotRequired' -or
        "$($security.OverrideBlockRules)" -ne 'False') {
        exit 13
    }
    exit 0
} catch {
    # The native owner always removes and reads back the unique rule name, including failures.
    # Do not emit PowerShell exceptions, which can contain paths and private package identities.
    if ($stage -eq 101 -and $_.Exception.HResult -lt 0) { exit $_.Exception.HResult }
    exit $stage
}
