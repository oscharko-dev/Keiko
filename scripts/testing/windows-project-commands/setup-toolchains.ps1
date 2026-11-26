# #4493: installs the per-user toolchains `toolchains-per-user-extra.json` names, for the account that
# runs it (a standard user), after setup-workspace.ps1. From -Downloads, each archive checked against
# the SHA-256 its publisher states: a Temurin JDK 21, PowerShell 7 and Apache Maven (the x64 builds,
# emulated on an ARM64 machine), unpacked under %LOCALAPPDATA%\Programs, and Yarn 1 from its npm
# tarball without its install script. It creates a Maven project at %USERPROFILE%\keiko-4493\mvn-ws
# and fills a repository by building it once outside the tree, which needs the network. -Scoop
# installs Scoop and its nodejs-lts for this account through Scoop's own installer, which carries no
# published checksum: lab machines only.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File setup-toolchains.ps1 -Downloads <dir> [-Scoop]
param([Parameter(Mandatory)][string]$Downloads, [switch]$Scoop)
$ErrorActionPreference = "Stop"
$programs = Join-Path $env:LOCALAPPDATA "Programs"
$expected = @{
  "OpenJDK21U-jdk_x64_windows_hotspot_21.0.13.1_2.zip" = "BBEBEA1469996B276683C9299C227B294F85C847039C82633218186A4AD4FBF2"
  "PowerShell-7.7.0-win-x64.zip"                       = "7C74E03B20A75B59715847439D046A6214B1863EE79B187872980F139BB4A05F"
  "apache-maven-3.9.16-bin.zip"                        = "5AF3B743DD8B876B5C45DA33B676251E5F1687712644ABB4EE519CA56E1D89CE"
  "yarn-1.22.22.tgz"                                   = "C17D3797FB9A9115BF375E31BFD30058CAC6BC9C3B8807A3D8CB2094794B51CA"
}
foreach ($name in $expected.Keys) {
  $actual = (Get-FileHash -Algorithm SHA256 (Join-Path $Downloads $name)).Hash
  if ($actual -ne $expected[$name]) { throw "$name has SHA-256 $actual, expected $($expected[$name])" }
}
function Unpack([string]$Archive, [string]$Target) {
  $final = Join-Path $programs $Target
  if (Test-Path $final) { return $final }
  $staging = Join-Path $programs ("unpack-" + $Target)
  if (Test-Path $staging) { Remove-Item -Recurse -Force $staging }
  New-Item -ItemType Directory -Force -Path $staging | Out-Null
  & tar.exe -xf (Join-Path $Downloads $Archive) -C $staging
  if ($LASTEXITCODE -ne 0) { throw "tar could not unpack $Archive ($LASTEXITCODE)" }
  $entries = @(Get-ChildItem $staging)
  if ($entries.Count -eq 1 -and $entries[0].PSIsContainer) {
    Move-Item $entries[0].FullName $final
    Remove-Item $staging
  } else {
    Move-Item $staging $final
  }
  $final
}
$jdk = Unpack "OpenJDK21U-jdk_x64_windows_hotspot_21.0.13.1_2.zip" "jdk-21"
Unpack "PowerShell-7.7.0-win-x64.zip" "pwsh-7" | Out-Null
$maven = Unpack "apache-maven-3.9.16-bin.zip" "maven"
$yarn = Join-Path $programs "yarn"
if (-not (Test-Path (Join-Path $yarn "yarn.cmd"))) {
  & (Join-Path $programs "nodejs\npm.cmd") install --global --offline --ignore-scripts --prefix $yarn (Join-Path $Downloads "yarn-1.22.22.tgz")
  if ($LASTEXITCODE -ne 0) { throw "npm could not install Yarn ($LASTEXITCODE)" }
}
$project = Join-Path $env:USERPROFILE "keiko-4493\mvn-ws"
New-Item -ItemType Directory -Force -Path (Join-Path $project "src\main\java\probe"), (Join-Path $project "src\test\java\probe") | Out-Null
Set-Content -Path (Join-Path $project "pom.xml") -Encoding ascii -Value @'
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>probe</groupId>
  <artifactId>probe-4493</artifactId>
  <version>1.0.0</version>
  <properties>
    <maven.compiler.release>21</maven.compiler.release>
    <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
  </properties>
  <dependencies>
    <dependency>
      <groupId>org.junit.jupiter</groupId>
      <artifactId>junit-jupiter</artifactId>
      <version>5.11.4</version>
      <scope>test</scope>
    </dependency>
  </dependencies>
  <build>
    <plugins>
      <plugin>
        <groupId>org.apache.maven.plugins</groupId>
        <artifactId>maven-surefire-plugin</artifactId>
        <version>3.5.2</version>
      </plugin>
    </plugins>
  </build>
</project>
'@
Set-Content -Path (Join-Path $project "src\main\java\probe\Sum.java") -Encoding ascii -Value 'package probe; public final class Sum { private Sum() {} public static int of(int a, int b) { return a + b; } }'
Set-Content -Path (Join-Path $project "src\test\java\probe\SumTest.java") -Encoding ascii -Value 'package probe; import static org.junit.jupiter.api.Assertions.assertEquals; import org.junit.jupiter.api.Test; class SumTest { @Test void adds() { assertEquals(5, Sum.of(2, 3)); } }'
$repository = Join-Path $env:USERPROFILE "keiko-4493-m2"
$env:JAVA_HOME = $jdk
& (Join-Path $maven "bin\mvn.cmd") -B -q -f (Join-Path $project "pom.xml") "-Dmaven.repo.local=$repository" verify
if ($LASTEXITCODE -ne 0) { throw "the outside build that fills the repository failed ($LASTEXITCODE)" }
& cmd.exe /d /c rmdir /s /q (Join-Path $project "target")
$scoopCommand = Join-Path $env:USERPROFILE "scoop\shims\scoop.cmd"
if ($Scoop -and -not (Test-Path $scoopCommand)) {
  $installer = Join-Path $env:TEMP "scoop-install.ps1"
  Invoke-RestMethod -Uri "https://get.scoop.sh" -OutFile $installer
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer
  if (-not (Test-Path $scoopCommand)) { throw "the Scoop installer did not install Scoop" }
}
if ($Scoop -and -not (Test-Path (Join-Path $env:USERPROFILE "scoop\apps\nodejs-lts\current\node.exe"))) {
  & $scoopCommand install nodejs-lts 7zip
  if ($LASTEXITCODE -ne 0) { throw "Scoop could not install nodejs-lts and 7zip ($LASTEXITCODE)" }
}
"toolchains ready: $programs"
