import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

// Run the actual fixture against an in-memory NetSecurity provider. No firewall cmdlet is called.
const provider = `
function New-NetFirewallRule {
  param($Name,$DisplayName,$PolicyStore,$Package,$Program,$Owner,$Direction,$Action,$Enabled,
        $Profile,$Protocol,$LocalPort,$LocalAddress,$RemoteAddress,$EdgeTraversalPolicy,
        $Authentication,$OverrideBlockRules)
  $script:application = [pscustomobject]@{Package=$Package; Program=$Program}
  $script:transport = [pscustomobject]@{Protocol=$Protocol; LocalPort=$LocalPort}
  $script:addresses = [pscustomobject]@{
    LocalAddress=$env:KEIKO_FIXTURE_ADDRESS; RemoteAddress=$env:KEIKO_FIXTURE_ADDRESS
  }
  $script:security = [pscustomobject]@{Authentication=$Authentication; OverrideBlockRules=$OverrideBlockRules}
  [pscustomobject]@{Direction=$Direction; Action=$Action; Enabled=$Enabled; Owner=$Owner;
    EdgeTraversalPolicy=$EdgeTraversalPolicy}
}
function Get-NetFirewallApplicationFilter { $script:application }
function Get-NetFirewallPortFilter { $script:transport }
function Get-NetFirewallAddressFilter { $script:addresses }
function Get-NetFirewallSecurityFilter { $script:security }
& ./scripts/testing/windows-gateway-firewall.ps1 \
  -RuleName Keiko.Gateway.Inbound.Fixture.00000000-0000-0000-0000-000000000001 \
  -PackageSid S-1-15-2-1-2-3-4-5-6-7 -Program $env:KEIKO_FIXTURE_PROGRAM \
  -Port 45678 -Family $env:KEIKO_FIXTURE_FAMILY
exit $LASTEXITCODE
`;

describe.skipIf(process.platform !== "win32")("gateway firewall address readback", () => {
  it.each([
    [2, "127.0.0.1", 0],
    [2, "127.0.0.1/32", 0],
    [23, "::1", 0],
    [23, "::1/128", 0],
    [23, "0:0:0:0:0:0:0:1", 0],
    [23, "::1/127", 13],
    [23, "::/0", 13],
    [23, "::2", 13],
    [23, "::ffff:127.0.0.1", 13],
    [23, "127.0.0.1", 13],
    [2, "::1", 13],
    [2, "127.0.0.1/8", 13],
    [2, "Any", 13],
    [23, "localhost", 13],
  ])("family %i readback %s exits %i", (family, address, expected) => {
    const result = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", provider],
      {
        encoding: "utf8",
        timeout: 15000,
        env: {
          ...process.env,
          GITHUB_ACTIONS: "true",
          RUNNER_OS: "Windows",
          RUNNER_ENVIRONMENT: "github-hosted",
          KEIKO_FIXTURE_PROGRAM: process.execPath,
          KEIKO_FIXTURE_FAMILY: String(family),
          KEIKO_FIXTURE_ADDRESS: address,
        },
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(expected);
  });
});
