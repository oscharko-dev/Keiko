# Windows cross-test machine on the development Mac (#4374)

Keiko must run cleanly on Windows, and every qualification so far ran on macOS. This page describes
the Windows 11 virtual machine on the development MacBook that closes that gap, in enough detail to
rebuild it from nothing. It belongs to epic #4351 and is the machine the Windows checks of that epic
use.

## What this machine proves, and what it does not

The host is an Apple M4 Max. The guest is therefore **Windows 11 on ARM64**, not Windows on an Intel
or AMD chip. The machine proves the **Windows operating system**: its file system, access control,
paths, line endings, text encoding, certificate store, installation path and process model are those
of Windows. It does **not** prove Intel or AMD hardware.

Two legs stand in for the two kinds of customer computer:

| Leg                 | Node build                   | What it stands for                                                                                                                                         |
| ------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| x64 under emulation | x64 (the release's own Node) | A customer's Intel or AMD computer, as far as an operating system can stand in for it. The only leg that can carry a Knowledge Pod, and so a Jira journey. |
| native ARM64 Node   | ARM64                        | A Windows-on-ARM computer. Expected to lack the native vector runtime: the pinned USearch manifest has no `win32-arm64` target.                            |

The release artifact is x64 only (`keiko-windows-x64-setup.exe`, `keiko-windows-x64.zip`); there is
no Windows ARM64 release. The ARM64 leg therefore runs the release's `app/` tree on a separately
installed ARM64 Node.

## Machine summary

| Item                 | Value                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------- |
| Hypervisor           | UTM 5.0.8 (free build, Homebrew cask `utm`), QEMU 10 with Apple Hypervisor.framework        |
| Guest OS             | Windows 11 IoT Enterprise LTSC 2024 Evaluation, ARM64                                       |
| Build                | 24H2, build 26100.9974 (2026-11 security update KB5132061); no update left on 2026-11-13    |
| Resources            | 8 virtual cores, 16 GB memory, 128 GB disk (sparse qcow2)                                   |
| Firmware and devices | UEFI, TPM 2.0 (swtpm), NVMe system disk, virtio network, ramfb display                      |
| Node                 | v26.13.1 as x64 (`C:\tools\node-x64`) and as ARM64 (`C:\tools\node-arm64`), side by side    |
| Browser              | Microsoft Edge (Chromium) 157.0.4341.46                                                     |
| Keiko under test     | v1.4.0 from the public release, verified against the release's `windows-x64-SHA256SUMS.txt` |
| License              | Microsoft evaluation, 90 days, activated online, expires **2027-02-11**                     |
| Snapshot             | `clean-updated` (UTM snapshot of the stopped machine)                                       |

The guest never holds more than 8 cores and 16 GB. A lab run may be in progress on the same Mac, so
the machine must stay inside 90 % of the host's processor and memory.

## License and expiry — read this first

- Only Microsoft's free evaluation is used. No product key, no activation tool, no subscription, no
  payment and no account with payment data are involved, and none may be introduced. Use a local
  guest account.
- The evaluation expires on **2027-02-11**, 90 days after online activation on 2026-11-13.
  **Reminder: renew or rebuild by 2027-02-04.** After expiry Windows shows a black desktop, a "not
  genuine" notice and shuts the PC down every hour.
- Renewal inside the evaluation terms is Microsoft's built-in `slmgr /rearm`, followed by a reboot
  and a fresh `slmgr /ato`. The guest reported two remaining rearms at the first check. When rearms
  are exhausted, rebuild from this page with a current evaluation image.
- Prove the state at any time, in an elevated prompt, with
  `cscript //nologo %windir%\system32\slmgr.vbs /xpr` and `/dli`. The first prints
  "Timebased activation will expire …", the second `License Status: Licensed` and
  `TIMEBASED_EVAL channel`.
- Do not set the guest clock back, do not use a key or activation tool, and stop if any step asks
  for payment.

### Why this edition, and why it needed activation

Microsoft's evaluation page for Windows 11 Enterprise 26H2 announces "x64 ISO and Arm64 ISO", but
its download page, checked on 2026-11-13, lists only 64-bit (x64) images in all 11 languages; every
link resolves to an `…x64FRE…` ISO. The LTSC 2024 Enterprise evaluation is x64 only. The **Windows
11 IoT Enterprise LTSC 2024 Evaluation** offers an ARM64 ISO, after a registration form on
Microsoft's evaluation site. It is the same Windows 11 code base (24H2 servicing branch) with the
same file system, access control, path and certificate behavior, but it is a different edition than
Windows 11 Enterprise. Record that whenever results from this machine are quoted.

The image was built in September 2024. Installed offline, its first boot reports
`License Status: Notification` with `0xC004F009` (grace time expired), and the desktop shows
"Windows License is expired". With the network up, `slmgr /ato` activated the evaluation
(`Product activated successfully`), after which `/xpr` reports the 90-day expiry. An evaluation image
that cannot be activated this way is not usable here; stop and report it instead of looking for
another source.

### Image provenance

- Download host: `software-static.download.prss.microsoft.com` (Microsoft's own evaluation CDN),
  reached over HTTPS from the evaluation page. The file name,
  `26100.1742.240906-0331.ge_release_svc_refresh_CLIENT_IOT_LTSC_EVAL_A64FRE_en-us.iso`, matches
  Microsoft's naming for the IoT Enterprise LTSC 2024 ARM64 evaluation. It is 5,042,194,432 bytes.
- SHA-256 of the file used:
  `3dcdba9c9c0aa0430d4332b60c9afcb3cd613d648a49cbba2d4ef7b5978f32e8`.
- Microsoft's published hash list (`Windows11IOTEnterpriseLTSCHashValues.pdf`, dated May 2024)
  does **not** carry this image: it lists
  `CCEC358A760C3C581249F091ED42D04F37B2B99C347B7A58257C3CC272D7982C` for an older ARM64 build,
  which predates this September 2024 refresh. The integrity of the file therefore rests on the
  download host and on TLS, not on that list. The image's `install.wim` reports one image, `Windows
11 IoT Enterprise LTSC 2024 Evaluation`, ARM64, edition `IoTEnterpriseSEval`, build 26100.

## Host prerequisites

- An Apple silicon Mac with enough free resources for 8 virtual cores and 16 GB.
- `brew install --cask utm` (UTM 5.0.8). Use the free build from the project or Homebrew, never the
  paid Mac App Store edition.
- `brew install wimlib` (optional, to read the image index), Python 3 for the helper scripts, and
  the `ssh` client.
- The UTM guest tools ISO, version 0.1.271, from the UTM project's QEMU release `v10.0.2-utm`
  (`utm-guest-tools-0.1.271.iso`, 127,084,544 bytes, SHA-256
  `65b6a69b392ee01dd314c10f3dad9ebbf9c4160be43f5f0dd6bb715944d9095b`, matching the digest GitHub
  publishes for the asset). It carries the virtio drivers for Windows ARM64, among them the network
  driver this machine needs, and is free.
- A private working directory for everything below. Keep the guest's administrator credential and
  the SSH private key outside the repository, readable only by you; this page never records either.

## Build procedure

### 1. Create the machine

UTM's machine bundle lives in a sandbox container the shell cannot read. Create a skeleton with
UTM's AppleScript interface, export it, adjust `config.plist`, and import the result:

1. `make new virtual machine` with `backend: qemu`, `architecture: aarch64`, `memory: 16384`,
   `cpu cores: 8`, `hypervisor: true`, `uefi: true`, a removable drive whose `source` is the ISO and
   a drive of `guest size: 131072` (MiB), and one network interface.
2. `export` the machine and edit its `config.plist` as below, then `delete` the skeleton and
   `import` the edited bundle.

Settings that differ from UTM's defaults:

| `config.plist` key                | Value                                                                |
| --------------------------------- | -------------------------------------------------------------------- |
| `QEMU.TPMDevice`                  | `true`                                                               |
| `Drive` (system disk) `Interface` | `NVMe` (Windows has an inbox NVMe driver, but no virtio storage one) |
| `Drive` order                     | Windows ISO, answer-file ISO, system disk                            |
| `Display[0].Hardware`             | `virtio-ramfb`                                                       |
| `Network[0].Hardware`             | `e1000e` at first; changed to `virtio-net-pci` after the driver step |
| `Network[0].Mode`                 | `Emulated` with port forward TCP 127.0.0.1:2222 → guest 22           |
| `QEMU.AdditionalArguments`        | `-monitor tcp:127.0.0.1:55577,server,nowait` and `-vnc 127.0.0.1:77` |

Notes:

- **Network mode.** UTM's "Shared Network" (vmnet NAT) gives the guest internet access, but macOS
  denies a tool without the Local Network privacy permission any connection to the guest
  (`No route to host`). Granting that permission is a host security setting, so the machine uses
  UTM's **Emulated** mode instead: still NAT, the guest reaches the internet and the host, nothing
  is reachable from outside, and the only door is the loopback port forward 127.0.0.1:2222 → guest 22. Port forwards are only honoured in Emulated mode.
- **Monitor and VNC.** Both listen on the loopback interface only. The QEMU monitor injects the one
  keypress the Windows installer needs and the keystrokes for the few steps done at the console; the
  VNC display is used for screenshots (a tiny RFB client reading the raw framebuffer is enough). Do
  not expose either beyond 127.0.0.1.
- The machine's UTM name is `keiko-win11-arm64`. Changing the network interface, the drives or the
  port forward later works through `update configuration`, with the machine stopped.

### 2. Unattended installation

The installer reads `Autounattend.xml` from the second ISO. Build that ISO from a folder that holds
the answer file, the provisioning script and the host's SSH **public** key:

```sh
hdiutil makehybrid -iso -joliet -default-volume-name KEIKOANS -o answers.iso <answers-folder>
```

The answer file (appendix A) accepts the license terms, wipes disk 0 and lays out EFI, MSR and NTFS
partitions, installs image index 1 (the only one), sets the machine name and time zone, creates one
local administrator with a random password, signs it in automatically and runs
`keiko-firstlogon.ps1` (appendix B). It also sets `BypassSecureBootCheck` and `BypassCPUCheck` under
`HKLM\SYSTEM\Setup\LabConfig` for the installer only, as a safety net for UTM's firmware; the TPM is
real. Substitute the placeholders `@@GUEST_USER@@` and `@@GUEST_PASSWORD@@` when writing the file,
and keep the filled copy private.

Start the machine. Windows' CD boot loader waits for a key and the unattended machine has nobody to
press it, so spam a harmless key through the QEMU monitor from the moment the firmware starts, for
about 30 seconds (`sendkey spc` once every half second, after a `system_reset` if the firmware
already gave up and sits in the UEFI shell). Setup then runs by itself and reaches the desktop after
about 15 minutes.

### 3. Network driver

After setup the guest has no network: the `e1000e` adapter has no inbox driver on ARM64. This is
also why the first `slmgr` check reports an expired grace period.

1. Attach the UTM guest tools ISO as one more removable drive and change the adapter to
   `virtio-net-pci`, both through `update configuration` with the machine stopped.
2. Boot, open an elevated prompt, and install the network driver from the tools ISO:
   `pnputil /add-driver <tools-drive>:\Drivers\NetKVM\w11\ARM64\netkvm.inf /install`.
3. `ipconfig` shows an address from UTM's 10.0.2.0/24 NAT and `ping www.microsoft.com` answers.

### 4. Activation

In an elevated prompt with the network up:

```bat
cscript //nologo %windir%\system32\slmgr.vbs /ato
cscript //nologo %windir%\system32\slmgr.vbs /xpr
cscript //nologo %windir%\system32\slmgr.vbs /dli
```

Expected: `Product activated successfully`, then `Timebased activation will expire <date>` and
`License Status: Licensed` in the `TIMEBASED_EVAL` channel with 90 days. If `/ato` does not take,
use `slmgr /rearm`, reboot and repeat. If that fails too, stop and report; do not switch image or
source on your own.

### 5. OpenSSH, key-only, guest side only

`keiko-firstlogon.ps1` installs the OpenSSH server capability from Windows Update (it needs the
network, so rerun it from the answer-file drive after step 4), starts `sshd`, makes PowerShell the
default shell, writes the host's public key to `administrators_authorized_keys` with the required
ACL and turns off password authentication. Make sure the `OpenSSH SSH Server (sshd)` firewall rule
covers all profiles (`netsh advfirewall firewall set rule name="OpenSSH SSH Server (sshd)" new
profile=any`): the NAT network is classified as public and the rule otherwise drops the forwarded
connection (the symptom is `Connection timed out during banner exchange`).

From the host:

```sh
ssh -i <private-key> -p 2222 <guest-admin>@127.0.0.1
```

Nothing else in the guest listens beyond the host loopback. Set `RealTimeIsUniversal` to 1 under
`HKLM\SYSTEM\CurrentControlSet\Control\TimeZoneInformation` so Windows reads UTM's UTC hardware
clock correctly, and reboot once.

### 6. Updates

Run the Windows Update agent through a scheduled task as SYSTEM (the API refuses a network-logon
token, so it cannot run directly over SSH): appendix C runs one pass; repeat it with a reboot
whenever it reports `reboot=True` until it reports `none`. Then take the snapshot.

### 7. Toolchain

`keiko-guest-toolchain.ps1` (appendix D) downloads the Node v26.13.1 x64 and ARM64 zips from
`nodejs.org`, verifies each against the published `SHASUMS256.txt` and extracts them to
`C:\tools\node-x64` and `C:\tools\node-arm64`. Both run: the x64 build reports `x64` under
Windows' emulation, the ARM64 build `arm64`. The browser is the Microsoft Edge that ships with the
image.

### 8. Snapshot

With the machine stopped, `create snapshot` named `clean-updated`, only after the license state shows
a valid evaluation with an expiry date. Restore with `restore` and the same name. The snapshot holds
the fully updated system with OpenSSH, the two Node builds and the license state above; it holds no
Keiko installation and no browser policy. After a restore, set the two Edge policy values from the
start proofs again and fetch the release (appendix E).

## Installing Keiko from the real release

`keiko-fetch-release.ps1` (appendix E) downloads `keiko-windows-x64.zip` and
`windows-x64-SHA256SUMS.txt` from the public GitHub release of the given tag, compares the digest
and extracts to `C:\keiko\<tag>\extracted\Keiko`. For v1.4.0 the verified digest is
`ba6ae83c7655b69e1266beaeb9ce2eef6babffda1b4820a25a463ae5e5f22b76`. Never install from a shared
folder of a working tree; the machine tests what a customer downloads.

The archive carries its own pinned x64 Node under `runtime\node`, the `app\` tree and the
`Keiko.exe` launcher; see the
[portable launch and setup guide](../release/portable-launch-setup-guide.md) and the
[portable runtime artifact contract](../release/portable-runtime-artifact-contract.md).

### Start proofs (v1.4.0)

Both proofs ran on 2026-11-13 against the extracted v1.4.0 archive, in the interactive desktop session
of the guest (not over SSH, whose session cannot open a browser). The UI answered
`GET http://127.0.0.1:1983/api/health` with `{"status":"ok","version":"1.4.0", … "readiness":"ready"}`
and Microsoft Edge showed Keiko's first-run "Connect Keiko to your internal LLMs" page.

| Leg                 | Node                                                                | Command                                                           | Result                                                         |
| ------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------- |
| x64 under emulation | the release's own `runtime\node\node.exe` (`process.arch` is `x64`) | `node.exe app\dist\cli\index.js start --open --start-timeout 240` | Healthy, UI open in Edge. Started in under four minutes.       |
| native ARM64        | `C:\tools\node-arm64\node.exe` (`process.arch` is `arm64`)          | the same command with the ARM64 Node                              | Healthy, UI open in Edge. Started well inside the same window. |

What differs from a customer's machine, and what does not work as shipped:

- **`Keiko.exe` refuses to start in the x64 leg.** The portable launcher checks that the managed
  root is on a local volume with a PowerShell program that has a fixed 10-second limit
  (`WINDOWS_LOCAL_VOLUME_TIMEOUT_MS`). Under this machine's x64 emulation PowerShell takes 13 to 20
  seconds even for `exit 0`, so the check times out and Keiko fails closed with
  `keiko portable setup: Windows managed root must be on a local volume`; the Activity Log records
  `security.windows-local-volume.refused` (`unsafe-target`). The same check passes in about 4
  seconds under the ARM64 Node. The refusal is correct for the time it was given; the slow
  PowerShell is a property of x64 emulation in this virtual machine (Defender real-time protection
  was not the cause: excluding the processes or pausing it changed nothing, and tamper protection
  keeps real-time protection on). An Intel or AMD computer does not have this latency. The product
  decision whether a slow-but-correct check should be allowed more time belongs to the epic, not to
  this page.
- **`keiko start` needs more than its default start window.** The default `--start-timeout` of 20
  seconds ends in `health-timeout` here, because the UI process runs several PowerShell identity
  checks at startup. `--start-timeout 240` (or `KEIKO_START_TIMEOUT_SECS=240`) is the documented
  setting and is enough. Without it the CLI also leaves the UI process running; stop it with
  `keiko stop`.
- Start from a normal working directory (the user profile). A scheduled task starts in
  `C:\Windows\System32`, where `keiko start` fails with "failed to spawn the UI process".
- The release archive's own `--open` hand-off was requested (`cli.lifecycle.browser-handoff`) but
  opened no window from a bare extracted archive; the page was opened with Edge directly on the
  same loopback URL. Edge's first-run overlay is suppressed with the policy values
  `HideFirstRunExperience=1` and `BrowserSignin=0` under `HKLM\SOFTWARE\Policies\Microsoft\Edge`.
- A launch from a scheduled task or the Run dialog needs an interactive session: the machine
  auto-signs in the local administrator, so one exists after every boot.

## Reaching the lab Jira without any repository change

The lab's HTTPS front end issues a certificate for `localhost` and `127.0.0.1` only and refuses any
other `Host` header, so the guest cannot use the host's network address. Keep the exact loopback
origin through a reverse tunnel instead. It needs no change to the lab or to Keiko and opens
nothing on the host:

```sh
ssh -i <private-key> -p 2222 -N -R <lab-tls-port>:127.0.0.1:<lab-tls-port> <guest-admin>@127.0.0.1
```

The tunnel listens on the guest's loopback interface only, so inside the guest the lab is
`https://127.0.0.1:<lab-tls-port>`. The lab's port and state directory change between lab runs; read
the port from the running lab container and the CA certificate from that lab's TLS directory
(`secrets/tls/ca.pem`). Copy only the public CA certificate, never a key.

Trust the lab's private certificate authority in the guest the documented way, for a process or a
shell: `KEIKO_CA_BUNDLE_PATH=<ca.pem>` for Keiko, or `NODE_EXTRA_CA_CERTS=<ca.pem>` for Node.
Certificate verification stays on.

Proof of the path (a probe that does a verified `GET /status`, appendix F), run on 2026-11-13:

| Step                                              | Result                                                        |
| ------------------------------------------------- | ------------------------------------------------------------- |
| Tunnel listener inside the guest                  | `127.0.0.1:<port>` and `[::1]:<port>` listening, nothing else |
| `GET /status` with the lab CA trusted, x64 Node   | HTTP 200, `tlsAuthorized true`, Jira state `RUNNING`          |
| The same with the ARM64 Node                      | HTTP 200, `tlsAuthorized true`, Jira state `RUNNING`          |
| Negative control, CA not trusted, verification on | `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, no connection is accepted  |

Certificate verification was never disabled. The lab was only read once per probe; nothing on the
host was opened or restarted.

This proof ends at "the guest reaches the lab Jira over HTTPS with verification enabled". Connecting
a Jira Pod and running Jira journeys is #4358; the lab scripts are not run in the guest.

## Bringing a build of the current `dev` into the guest

No release exists for a change under test, so build the same artifact the release workflow stages.
This path is documented but was not exercised while setting up the machine.

1. Dispatch the unsigned evaluation staging build from the branch under test:
   `gh workflow run portable-assets.yml --ref <branch> -f evaluation_build=true`. It stages the
   `windows-x64` target in the artifact `portable-stage-windows-x64-evaluation-unsigned` and is never
   assembled into a release. The workflow's own smoke runs on the staged tree.
2. Download it on the host: `gh run download <run-id> -n portable-stage-windows-x64-evaluation-unsigned`.
3. Copy the staged tree into the guest over the loopback SSH port (`scp -r -P 2222`), into a new
   directory under `C:\keiko\dev-<short-sha>`. Record the commit, the run id and the digest of every
   top-level file; the evaluation artifact has no release signature, so the digest list is the only
   identity.
4. Start it exactly like the release: `Keiko.exe` for the x64 leg, `C:\tools\node-arm64\node.exe
app\dist\cli\index.js start` for the ARM64 leg.

A change that only needs the server, not the packaged launcher, can also run from a working tree
built on the host and packed with `npm pack`, installed in the guest with the x64 Node's npm. This
is the developer path; the evaluation staging build above is the one that matches what a customer
runs.

## Operating limits and findings

- **Hardware.** This machine proves the Windows operating system, not Intel or AMD hardware. The x64
  leg runs under Windows' ARM64-to-x64 emulation.
- **Knowledge Pod on ARM64.** The pinned USearch native vector runtime has no `win32-arm64` target
  (`usearch-runtime-manifest.ts`), so a Knowledge Pod is expected to be unavailable under an ARM64
  Node. The x64 leg is therefore the only one that can carry the Jira journeys of #4358.
- **Recorded finding.** `usearchRuntimeTargetKey("win32", "arm64")` returns no target in the
  released v1.4.0 build, while `("win32", "x64")` resolves `win32-x64`; the ANN search reports
  `runtime-unavailable` for an unknown target. The ARM64-Node leg therefore cannot carry a Knowledge
  Pod; this was verified against the shipped manifest, not by creating a Pod in the UI.
- **Edition.** The guest is Windows 11 IoT Enterprise LTSC 2024 (24H2 servicing), not Windows 11
  Enterprise 26H2. Quote that edition in every result.
- **Host load.** Shut the guest down (`utmctl stop <machine> --request`) when it is not in use.
  Never give it more than 8 cores and 16 GB.
- **Clock.** Without `RealTimeIsUniversal` the guest runs an hour behind. Never move the clock back
  to extend the evaluation.

## Rebuild checklist

1. Install UTM 5.0.8 (free build). Download the guest tools ISO and check its digest.
2. Register on Microsoft's evaluation site and download the IoT Enterprise LTSC 2024 evaluation ARM64
   ISO (or a current ARM64 evaluation, if Microsoft lists one). Record its SHA-256.
3. Create the machine and settings above, build the answer-file ISO, boot, send the key.
4. Install the NetKVM driver, move to `virtio-net-pci`, run `slmgr /ato`, record the expiry.
5. Rerun the provisioning script for OpenSSH, open the firewall rule to all profiles, set
   `RealTimeIsUniversal`, run updates until none remain.
6. Install the two Node builds, fetch and verify the Keiko release, run the start proofs.
7. Take the `clean-updated` snapshot and write the expiry date and reminder date into the issue.

## Appendix: scripts

The helper files are small enough to keep here. Placeholders in angle brackets or `@@…@@` are filled
in on the host and are never committed.

### A. `Autounattend.xml`

```xml
<?xml version="1.0" encoding="utf-8"?>
<unattend xmlns="urn:schemas-microsoft-com:unattend">
  <settings pass="windowsPE">
    <component name="Microsoft-Windows-International-Core-WinPE" processorArchitecture="arm64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">
      <SetupUILanguage><UILanguage>en-US</UILanguage></SetupUILanguage>
      <InputLocale>en-US</InputLocale>
      <SystemLocale>en-US</SystemLocale>
      <UILanguage>en-US</UILanguage>
      <UserLocale>en-US</UserLocale>
    </component>
    <component name="Microsoft-Windows-Setup" processorArchitecture="arm64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">
      <RunSynchronous>
        <RunSynchronousCommand wcm:action="add" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State"><Order>1</Order><Path>reg add HKLM\SYSTEM\Setup\LabConfig /v BypassSecureBootCheck /t REG_DWORD /d 1 /f</Path></RunSynchronousCommand>
        <RunSynchronousCommand wcm:action="add" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State"><Order>2</Order><Path>reg add HKLM\SYSTEM\Setup\LabConfig /v BypassCPUCheck /t REG_DWORD /d 1 /f</Path></RunSynchronousCommand>
      </RunSynchronous>
      <DiskConfiguration>
        <WillShowUI>OnError</WillShowUI>
        <Disk wcm:action="add" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State">
          <DiskID>0</DiskID>
          <WillWipeDisk>true</WillWipeDisk>
          <CreatePartitions>
            <CreatePartition wcm:action="add"><Order>1</Order><Type>EFI</Type><Size>260</Size></CreatePartition>
            <CreatePartition wcm:action="add"><Order>2</Order><Type>MSR</Type><Size>16</Size></CreatePartition>
            <CreatePartition wcm:action="add"><Order>3</Order><Type>Primary</Type><Extend>true</Extend></CreatePartition>
          </CreatePartitions>
          <ModifyPartitions>
            <ModifyPartition wcm:action="add"><Order>1</Order><PartitionID>1</PartitionID><Format>FAT32</Format><Label>System</Label></ModifyPartition>
            <ModifyPartition wcm:action="add"><Order>2</Order><PartitionID>2</PartitionID></ModifyPartition>
            <ModifyPartition wcm:action="add"><Order>3</Order><PartitionID>3</PartitionID><Format>NTFS</Format><Label>Windows</Label><Letter>C</Letter></ModifyPartition>
          </ModifyPartitions>
        </Disk>
      </DiskConfiguration>
      <ImageInstall>
        <OSImage>
          <InstallTo><DiskID>0</DiskID><PartitionID>3</PartitionID></InstallTo>
          <InstallFrom><MetaData wcm:action="add" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State"><Key>/IMAGE/INDEX</Key><Value>1</Value></MetaData></InstallFrom>
        </OSImage>
      </ImageInstall>
      <UserData><AcceptEula>true</AcceptEula></UserData>
    </component>
  </settings>
  <settings pass="specialize">
    <component name="Microsoft-Windows-Shell-Setup" processorArchitecture="arm64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">
      <ComputerName>KEIKO-WIN11</ComputerName>
      <TimeZone>W. Europe Standard Time</TimeZone>
    </component>
  </settings>
  <settings pass="oobeSystem">
    <component name="Microsoft-Windows-International-Core" processorArchitecture="arm64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">
      <InputLocale>en-US</InputLocale>
      <SystemLocale>en-US</SystemLocale>
      <UILanguage>en-US</UILanguage>
      <UserLocale>en-US</UserLocale>
    </component>
    <component name="Microsoft-Windows-Shell-Setup" processorArchitecture="arm64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">
      <OOBE>
        <HideEULAPage>true</HideEULAPage>
        <HideOEMRegistrationScreen>true</HideOEMRegistrationScreen>
        <HideOnlineAccountScreens>true</HideOnlineAccountScreens>
        <HideWirelessSetupInOOBE>true</HideWirelessSetupInOOBE>
        <ProtectYourPC>3</ProtectYourPC>
        <NetworkLocation>Work</NetworkLocation>
      </OOBE>
      <UserAccounts>
        <LocalAccounts>
          <LocalAccount wcm:action="add" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State">
            <Name>@@GUEST_USER@@</Name>
            <Group>Administrators</Group>
            <Password><Value>@@GUEST_PASSWORD@@</Value><PlainText>true</PlainText></Password>
          </LocalAccount>
        </LocalAccounts>
      </UserAccounts>
      <AutoLogon>
        <Enabled>true</Enabled>
        <Username>@@GUEST_USER@@</Username>
        <Password><Value>@@GUEST_PASSWORD@@</Value><PlainText>true</PlainText></Password>
        <LogonCount>999</LogonCount>
      </AutoLogon>
      <FirstLogonCommands>
        <SynchronousCommand wcm:action="add" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State">
          <Order>1</Order>
          <CommandLine>cmd /c for %i in (D E F G H I J) do @if exist %i:\keiko-firstlogon.ps1 powershell -NoProfile -ExecutionPolicy Bypass -File %i:\keiko-firstlogon.ps1</CommandLine>
        </SynchronousCommand>
      </FirstLogonCommands>
    </component>
  </settings>
</unattend>
```

### B. `keiko-firstlogon.ps1`

```powershell
# First-logon provisioning for the Keiko Windows test guest. Idempotent; log under ProgramData.
$ErrorActionPreference = 'Continue'
$log = 'C:\ProgramData\keiko-setup'
New-Item -ItemType Directory -Force -Path $log | Out-Null
Start-Transcript -Path "$log\firstlogon.log" -Append
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

# Never sleep, never lock: this machine is driven remotely.
powercfg /change standby-timeout-ac 0
powercfg /change monitor-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
reg add 'HKLM\SOFTWARE\Policies\Microsoft\Windows\Personalization' /v NoLockScreen /t REG_DWORD /d 1 /f

# Private network profile so the OpenSSH rule applies.
Get-NetConnectionProfile | Set-NetConnectionProfile -NetworkCategory Private

# OpenSSH server (guest only; the host forwards a loopback port to it).
for ($i = 0; $i -lt 10; $i++) {
  $cap = Get-WindowsCapability -Online -Name 'OpenSSH.Server*'
  if ($cap.State -eq 'Installed') { break }
  Add-WindowsCapability -Online -Name 'OpenSSH.Server~~~~0.0.1.0'
  Start-Sleep -Seconds 15
}
Set-Service -Name sshd -StartupType Automatic
Start-Service sshd
New-ItemProperty -Path 'HKLM:\SOFTWARE\OpenSSH' -Name DefaultShell -Value 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -PropertyType String -Force | Out-Null

# Key-only access for the administrator account.
$key = Get-Content -Raw (Join-Path $here 'host-ssh-public-key.txt')
$auth = 'C:\ProgramData\ssh\administrators_authorized_keys'
Set-Content -Path $auth -Value $key.Trim() -Encoding ascii
icacls $auth /inheritance:r /grant 'Administrators:F' /grant 'SYSTEM:F' | Out-Null
(Get-Content 'C:\ProgramData\ssh\sshd_config') -replace '^#?PasswordAuthentication .*', 'PasswordAuthentication no' | Set-Content 'C:\ProgramData\ssh\sshd_config' -Encoding ascii
Restart-Service sshd

Set-Content -Path "$log\done.txt" -Value (Get-Date -Format o)
Stop-Transcript
```

### C. `keiko-windows-update.ps1`

```powershell
# One Windows Update pass through the Windows Update Agent COM API. Run as SYSTEM (scheduled task):
# the API refuses a network-logon token. Writes a log and a result file; the caller reboots and repeats.
$ErrorActionPreference = 'Stop'
$dir = 'C:\ProgramData\keiko-setup'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$log = "$dir\update.log"
Remove-Item "$dir\update-result.txt" -ErrorAction SilentlyContinue
function Say($m) { "$(Get-Date -Format o) $m" | Add-Content $log }
try {
  $session = New-Object -ComObject Microsoft.Update.Session
  $searcher = $session.CreateUpdateSearcher()
  $found = $searcher.Search("IsInstalled=0 and Type='Software' and IsHidden=0").Updates
  Say "found $($found.Count)"
  if ($found.Count -eq 0) { Set-Content "$dir\update-result.txt" 'none'; exit 0 }
  $coll = New-Object -ComObject Microsoft.Update.UpdateColl
  foreach ($u in $found) { if (-not $u.InstallationBehavior.CanRequestUserInput) { [void]$coll.Add($u); Say "queue $($u.Title)" } }
  $dl = $session.CreateUpdateDownloader(); $dl.Updates = $coll; [void]$dl.Download()
  $inst = $session.CreateUpdateInstaller(); $inst.Updates = $coll
  $res = $inst.Install()
  Say "result code $($res.ResultCode) reboot $($res.RebootRequired)"
  Set-Content "$dir\update-result.txt" "installed;reboot=$($res.RebootRequired)"
} catch {
  Say "error $($_.Exception.Message)"
  Set-Content "$dir\update-result.txt" "error"
}
```

Run one pass with a SYSTEM scheduled task and read the result file:

```bat
schtasks /create /tn KeikoUpdate /tr "powershell -NoProfile -ExecutionPolicy Bypass -File C:\ProgramData\keiko-setup\keiko-windows-update.ps1" /sc once /st 23:59 /ru SYSTEM /rl HIGHEST /f
schtasks /run /tn KeikoUpdate
type C:\ProgramData\keiko-setup\update-result.txt
```

### D. `keiko-guest-toolchain.ps1`

```powershell
# Installs Node 26 twice, side by side, from nodejs.org zips verified against the published SHASUMS256.txt.
param([string]$NodeVersion = 'v26.13.1')
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$base = "https://nodejs.org/dist/$NodeVersion"
$sums = (Invoke-WebRequest -UseBasicParsing "$base/SHASUMS256.txt").Content -split "`n"
foreach ($arch in 'x64', 'arm64') {
  $name = "node-$NodeVersion-win-$arch.zip"
  $zip = Join-Path $env:TEMP $name
  Invoke-WebRequest -UseBasicParsing "$base/$name" -OutFile $zip
  $want = (($sums | Where-Object { $_ -match [regex]::Escape($name) + '$' }) -split '\s+')[0]
  $got = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
  if ($got -ne $want) { throw "checksum mismatch for $name" }
  $dest = "C:\tools\node-$arch"
  if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
  New-Item -ItemType Directory -Force -Path C:\tools | Out-Null
  Expand-Archive $zip -DestinationPath C:\tools
  Rename-Item "C:\tools\node-$NodeVersion-win-$arch" $dest
  Remove-Item $zip
  "$arch ok sha256=$got"
}
```

### E. `keiko-fetch-release.ps1`

```powershell
# Downloads the public Keiko release ZIP for a tag and verifies it against the release's own SHA256SUMS.
param([string]$Tag = 'v1.4.0', [string]$Root = 'C:\keiko')
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$base = "https://github.com/oscharko-dev/Keiko/releases/download/$Tag"
$dir = Join-Path $Root $Tag
New-Item -ItemType Directory -Force -Path $dir | Out-Null
Invoke-WebRequest -UseBasicParsing "$base/windows-x64-SHA256SUMS.txt" -OutFile "$dir\windows-x64-SHA256SUMS.txt"
Invoke-WebRequest -UseBasicParsing "$base/keiko-windows-x64.zip" -OutFile "$dir\keiko-windows-x64.zip"
$want = ((Get-Content "$dir\windows-x64-SHA256SUMS.txt" | Where-Object { $_ -match 'keiko-windows-x64\.zip' }) -split '\s+')[0].ToLower()
$got = (Get-FileHash "$dir\keiko-windows-x64.zip" -Algorithm SHA256).Hash.ToLower()
if ($got -ne $want) { throw "checksum mismatch: expected $want, got $got" }
"sha256 ok $got"
$out = Join-Path $dir 'extracted'
if (Test-Path $out) { Remove-Item -Recurse -Force $out }
Expand-Archive "$dir\keiko-windows-x64.zip" -DestinationPath $out
"extracted to $out"
```

### F. Lab reachability probe

```js
// Proves the guest reaches the lab over the tunnel with certificate verification ENABLED.
const https = require("node:https");
const port = Number(process.argv[2] || 18443);
https
  .get({ host: "127.0.0.1", port, path: "/status", rejectUnauthorized: true }, (res) => {
    const authorized = res.socket.authorized;
    let b = "";
    res.on("data", (d) => (b += d));
    res.on("end", () => {
      let state = "n/a";
      try {
        state = JSON.parse(b).state;
      } catch {
        /* non-JSON body */
      }
      console.log(
        process.arch,
        "status",
        res.statusCode,
        "tlsAuthorized",
        authorized,
        "jiraState",
        state,
      );
    });
  })
  .on("error", (e) => {
    console.log(process.arch, "ERR", e.code);
    process.exit(1);
  });
```
