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

## Before you rebuild: time, resources, ports, names and the image

### Time and resources

Plan **about three hours** from an empty Mac to the `clean-updated` snapshot; most of that is Windows
Update passes. The guest holds **8 virtual cores and 16 GB of memory** and nothing heavy may run beside
it: no lab run, no model, no Docker job. Before starting the machine, `uptime` must show a 1-minute
load average of 8 or less, and the machine guard's rule above (below 90 % of processor and memory)
applies for the whole build. Disk: the image is 5.0 GB, the guest tools ISO 0.13 GB, the machine
bundle holds a private copy of the image (another 5.0 GB) and the system disk is sparse, up to 128 GB;
keep 60 GB free to be safe.

| Phase (step of the checklist)                    | Expected duration | What it rests on                                                                                     |
| ------------------------------------------------ | ----------------- | ---------------------------------------------------------------------------------------------------- |
| Tools, downloads (1, 2)                          | 10 to 60 minutes  | estimate; depends on the network, the image is 5.0 GB                                                |
| Verify the image (2)                             | about 10 seconds  | measured: SHA-256 of the 5.0 GB file took 9.7 s on the M4 Max host                                   |
| Answer ISO, machine, bundle, import (3 to 6)     | 20 to 40 minutes  | estimate; copying the image into the bundle is most of it                                            |
| Unattended installation to the desktop (7)       | about 15 minutes  | from the first build (step 2 of the build procedure)                                                 |
| Network driver, activation, SSH (8 to 10)        | 20 to 30 minutes  | estimate                                                                                             |
| Windows Update, several passes with reboots (11) | 1.5 to 2 hours    | the Windows agent's estimate; the number of passes depends on how old the image is relative to today |
| Toolchain, license check, snapshot (12, 13)      | 10 to 15 minutes  | estimate                                                                                             |
| Keiko release and start proof (14)               | 10 to 15 minutes  | measured on 2026-11-13: 605 s from guest start to a healthy Keiko, an upper bound on a busy host     |

Only the two measured rows are measurements. Replace each estimate with the observed time in the
issue after the first rebuild.

### Ports and names: a rebuilt machine beside the first one

The machine listens on three loopback ports, fixed in its configuration and in the helper scripts:
SSH **2222**, the screen connection (VNC) **5977** (display 77) and the QEMU monitor **55577**. Two
guests cannot hold the same loopback port, so a second guest cannot run beside the first with these
values: **stop the first guest before the rebuilt one starts**, or give the rebuilt machine other
ports in `mkcfg.py` (appendix P, optional arguments) and in every script that names them. A rebuilt
machine always gets **its own UTM name** (this page uses `keiko-win11-arm64-rebuild`), so the first
machine and its snapshots stay untouched; never import over, delete or rename the first one.

Check both before the first step. All four commands only read:

```sh
utmctl list                                           # every machine and its state; the first one must say "stopped"
lsof -nP -iTCP:2222 -iTCP:5977 -iTCP:55577 -sTCP:LISTEN   # no output means the three ports are free
utmctl list | awk 'NR>1 {print $3}' | grep -x "keiko-win11-arm64-rebuild" && echo "name taken" || echo "name free"
osascript -e 'tell application "UTM" to get name of every snapshot of virtual machine id "<id-of-the-first-machine>"'
```

The first machine's id is the first column of `utmctl list`. Its snapshots are listed by the last
command (on the development Mac: `eval-1.4.0-connected, clean-updated`); run it again after the
rebuild, and an identical list shows that nothing of the first machine was touched. To stop the first
guest: `utmctl stop keiko-win11-arm64 --request`, then repeat `utmctl status keiko-win11-arm64` until
it says `stopped` (this can take several minutes under memory pressure).

### An image that is already on the host

Microsoft's registration form is only the source of last resort. An image already on the host serves
equally when its size and SHA-256 equal the values recorded in "Image provenance":

| Value     | Recorded                                                                              |
| --------- | ------------------------------------------------------------------------------------- |
| File name | `26100.1742.240906-0331.ge_release_svc_refresh_CLIENT_IOT_LTSC_EVAL_A64FRE_en-us.iso` |
| Size      | 5,042,194,432 bytes                                                                   |
| SHA-256   | `3dcdba9c9c0aa0430d4332b60c9afcb3cd613d648a49cbba2d4ef7b5978f32e8`                    |

Path convention: any directory you own, the file name unchanged; the default below is `$HOME/Downloads`
(where a browser puts it), which is also where the first build kept the file, and the machine bundle holds its own copy named
`windows.iso`, so removing the download afterwards does not break the machine. Check:

```sh
ISO="$HOME/Downloads/26100.1742.240906-0331.ge_release_svc_refresh_CLIENT_IOT_LTSC_EVAL_A64FRE_en-us.iso"
stat -f %z "$ISO"           # expect 5042194432
shasum -a 256 "$ISO"        # expect 3dcdba9c9c0aa0430d4332b60c9afcb3cd613d648a49cbba2d4ef7b5978f32e8
```

Both must match. If either differs, the file is not the recorded image: download from Microsoft as in
step 2 of the checklist and record the new size and SHA-256 in the issue before you use it.

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
folder of a working tree; the release proof tests what a customer downloads. The developer loop
below is the one deliberate exception.

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

## Running the current development state: two developer loops

The owner's task for this machine is to run the state of the source branch
`feat/jira-pod-release-1` (a moving branch; it equalled `dev` when this was set up) on both the
Windows guest and the Mac, with an update loop measured in minutes. Both loops are one command on
the host. The scripts live outside the repository, next to the other helpers of this machine; their
full text is in appendices G to K so the loops can be rebuilt. This lifts "never from a working
tree" for the developer loop only; the customer-shaped path below and the release proof above still
use the artifacts a customer receives.

### Windows guest: `keiko-win-dev-loop [<branch|commit>] [--clean]`

One command takes a branch or a commit (default `origin/feat/jira-pod-release-1`) and ends with
Keiko running in the guest on that commit. It prints the commit, a verification of what runs in the
guest, the time of every phase and the elapsed time.

1. **Worktree.** A dedicated detached worktree of the repository is fetched and moved to the commit.
   `npm ci` runs only when `package-lock.json` changed (about 6 seconds with a warm npm cache).
2. **Build and pack, on the host.** `npm run build`, `prepare:bin`, `build:ui`, the two `prune:*`
   steps and `npm pack --ignore-scripts`: the `prepack` of the root package minus its release gates
   (arch checks, package-surface and manifest checks, release-impact), which CI runs on the pull
   request. About 45 seconds in total. Every heavy host step goes through the machine guard
   `heavy-slot.sh`, so at most two heavy jobs run at once. `--clean` runs `npm run clean` first.
3. **Copy.** The tarball (about 35 MB, named by the short commit) goes over the loopback SSH port.
4. **Install in the guest.** The tarball bundles every dependency, so extracting it with `tar` into
   `C:\keiko\dev\<commit>\node_modules\@oscharko-dev\keiko` is the whole installation: about 20 to 60
   seconds. `npm install` of the same file took **11 minutes** in this guest (13,807 small files
   written by an emulated x64 Node under Defender) and is not used. The script stops the earlier dev
   install first and keeps the new and the previous one.
5. **Start.** `keiko start --start-timeout 240` runs in the interactive session through a scheduled
   task that starts in the user profile (the default 20-second window and a `System32` working
   directory both fail here, see the start proofs). Edge then opens the UI on the loopback URL.
6. **Verification printed at the end.** `/api/health` (`status`, `version`, `launchId`,
   `readiness`) and the command line of the process that listens on port 1983. That command line
   must contain the commit-named install directory, otherwise the script exits with an error.

`/api/health` carries no commit or build identity: `version` is the compile-time constant `1.4.0`
for every commit, and the `launchId` changes with every start. The commit-named install directory of
the listener is therefore the proof of which build runs. The packed tarball is not byte-reproducible
either: two builds of the same commit produced different SHA-256 values, so the tarball digest
identifies a run, not a commit.

#### Measured on 2026-11-13

| Run | Commit                                                              | Elapsed | Phases (seconds)                                                                        |
| --- | ------------------------------------------------------------------- | ------- | --------------------------------------------------------------------------------------- |
| 1   | `c8c716131228` (branch head at that time), `npm install` in guest   | 14m02s  | deps 6, build 33, pack 12, ship 11, **install 688**, start 63, browser 8, verify 15     |
| 2   | `1f2707acd97f` (newer: the head of #4383, a lab-only change)        | 5m37s   | build 31, pack 12, ship 14, install 56, **start 192**, browser 10, verify 14            |
| 3   | `1f2707acd97f` again                                                | 4m34s   | build 29, pack 12, ship 13, install 41, start 151, browser 8, verify 12                 |
| 4   | `940d0b4bb7c6` (branch head after the merge of #4383), guest booted | 10m55s  | build 31, pack 12, guest boot 51, ship 38, install 309, start 192, browser 8, verify 12 |

Run 1 used `npm install`; runs 2 to 4 use `tar`. Runs 2 and 3 are the steady state with a running
guest: **about 4.5 to 5.5 minutes**. Run 4's longer install (309 s) came right after a guest boot, when Defender is busy; the cause
was not analyzed further. The host part (checkout, build, pack) is
under a minute; what remains is the guest: the UI start dominates at 150 to 190 seconds, because
the UI process runs several PowerShell identity checks at startup and each costs 13 to 20 seconds
under x64 emulation (see the start proofs). The loop proves a new commit reaches the guest and
starts there: run 1 to run 2 changed the commit, the install directory and the `launchId`, and the
guest's `/api/health` stayed `ok` / `ready`.

### Mac: `keiko-mac-dev [up|stop|status] [<branch|commit>]`

One dedicated checkout, a detached worktree that follows `origin/feat/jira-pod-release-1`. `up`
fetches the branch, moves the checkout to its head, runs `npm ci` only when the lockfile changed and
starts Keiko with `npm run dev:start -- --no-open` (the repository's own dev starter, which builds
first) on `127.0.0.1:1990`, with `KEIKO_STATE_DIR` in a private directory outside the checkout and
`KEIKO_OS_KEYCHAIN=off` so no keychain dialog can appear. It prints the commit, `/api/health` and the
elapsed time. `stop` runs `npm run dev:stop`; no instance is left running.

Measured on 2026-11-13: first run on `940d0b4bb7c6` **31 seconds** (including `npm ci`), a repeat run
through the machine guard **11 seconds**; `/api/health` returned `ok` / `ready` on
`http://127.0.0.1:1990`, then `stop` and the port was closed.

## The customer-shaped path, exercised

The path documented before (`portable-assets.yml` with `evaluation_build=true`) was run once on
2026-11-13 against `feat/jira-pod-release-1` (`c8c716131228`):

| Step                                                                          | Time                                                                   | Result                                                                                       |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `gh workflow run portable-assets.yml --ref <branch> -f evaluation_build=true` | 15 min 18 s until the `windows-x64` artifact existed (run 15 min 22 s) | All four stage jobs green; artifact `portable-stage-windows-x64-evaluation-unsigned`, 622 MB |
| `gh run download <run-id> -n portable-stage-windows-x64-evaluation-unsigned`  | 2 min                                                                  | 952 MB: `keiko-windows-x64.zip`, `keiko-windows-x64-setup.exe`, `payload/`, `evidence/`      |
| Copy the zip and `evidence/SHA256SUMS.txt` into the guest                     | 7 s                                                                    | Digest matches the staged `SHA256SUMS.txt`                                                   |
| Verify and extract (`Expand-Archive`)                                         | 5 min 48 s                                                             | Slow: tens of thousands of small files under Defender                                        |
| Start `Keiko.exe`                                                             | refused after 70 s                                                     | `keiko portable setup: Windows managed root must be on a local volume`                       |

`Keiko.exe` does not start in the x64 leg for the same reason as with v1.4.0: the local-volume check
has a fixed 10-second limit and emulated PowerShell needs 13 to 20 seconds. That is a finding for
#4358, not a defect of this machine; it was not worked around. Total from dispatch to the refusal:
about 24 minutes, of which CI is 15. The `keiko-windows-x64-setup.exe` companion was not run: it
delegates to the same managed-install check. After a start proof the extracted tree is deleted
again.

The machine guard (`heavy-slot.sh`, at most two heavy jobs at a time) was added to both scripts after
run 4. The Mac command passed it (11 seconds, above). A complete governed run of the Windows loop is
still to be recorded: it was cut short because the host needed the guest's memory for a lab
measurement; its first host step only reached "waiting for a free slot".

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
- **No build identity in `/api/health`.** `version` is the compile-time constant for every commit and
  only `launchId` changes. The developer loop therefore proves the commit by the install directory
  of the listening process. A commit or build id in the health response would make this a one-line
  check; that is a product question for #4358, not changed here.
- **The packed tarball is not byte-reproducible.** Two builds of one commit gave different SHA-256
  values; use the commit, not the tarball digest, as identity.
- **`npm install` of the packed tarball is the wrong install in this guest** (11 minutes against
  about 20 seconds for extracting it); the tarball bundles every dependency.
- **Memory.** Guest (16 GB) plus a local-model lab measurement plus Docker exceeds the host's memory.
  Stop the guest when it is not in use (`utmctl stop <machine> --request`, which can take several
  minutes under memory pressure) and run heavy host steps through the machine guard.
- **Edition.** The guest is Windows 11 IoT Enterprise LTSC 2024 (24H2 servicing), not Windows 11
  Enterprise 26H2. Quote that edition in every result.
- **Host load.** The guest (8 cores, 16 GB) is not run beside a model run: it runs only when the
  machine guard's state line (`~/.keiko-lab/governor/watchdog.state`) shows headroom (load <= 8,
  availGB >= 24, compGB <= 18), never while a performance-evidence measurement is running or queued, and it is
  shut down (`utmctl stop <machine> --request`) as soon as it is not in use. A guest of 16 GB beside
  a local model plus Docker exceeds the host's memory, so "below 90 % of processor and memory with
  guest and lab together" is not demonstrated; this rule is what is enforced.
- **Snapshot restore (one measurement, upper bound).** On 2026-11-13, `restore` of `clean-updated`
  plus `utmctl start`: SSH answered after 191 s and the interactive desktop session after 203 s. The
  snapshot holds no Keiko, so fetching, verifying and extracting the v1.4.0 release (appendix E)
  took 298 s and `keiko start --start-timeout 240` reported a healthy UI after a further 104 s:
  605 s from start to a healthy Keiko. The host was busy: the 1-minute load average rose from 7 at
  the start to about 15 during the run (other heavy jobs were running), so these are upper bounds,
  not a representative value. Repeat once on a quiet host with the 1-minute load recorded at start
  and end.
- **A program started through an interactive scheduled task opens a console window.** The loop starts
  `keiko-dev-start.cmd` and `open-browser.cmd` with `schtasks /create ... /it /ru <user>`: they run in
  the signed-in user's desktop session, so each shows its own `cmd` console on that desktop. The
  console sits over the desktop and over Edge, and a screenshot taken over the screen connection then
  shows the console, not the Keiko page. Take the screenshot after Edge has started, and read
  `/api/health` (not the picture) as the proof that Keiko runs. A process started over SSH has no
  desktop at all, which is why the interactive task is used.
- **Pointer clicks over the screen connection do not arrive.** The Windows agent found that mouse
  clicks sent through VNC never reach the guest, while keyboard input through the QEMU monitor does
  (`mon.sh`, `vmkeys.py`; appendices M and N). Anything that needs a click, a dialog button or a
  control in Edge, therefore needs a helper that runs **inside the guest's interactive desktop
  session**, started through an interactive scheduled task as above, because only that session owns
  the desktop. **This page's tooling has no such helper**: `vncshot.py` takes screenshots and
  `vmkeys.py` types keys, nothing else. Until one exists, drive the guest by keyboard (the Run dialog,
  `Tab` and `Enter`, the keyboard shortcut of a dialog button) and open pages by URL as
  `open-browser.cmd` does.
- **Real hardware.** What this machine cannot show is checked by a contributor on an Intel or AMD
  computer: [Windows on real hardware: contributor checks](windows-real-hardware-handover.md).
- **Clock.** Without `RealTimeIsUniversal` the guest runs an hour behind. Never move the clock back
  to extend the evaluation.

## Rebuild checklist

**Status:** documented, not proven by a rebuild; due at the latest when the evaluation license
expires on 2027-02-11. The proof is a second guest built from this page alone by someone who never
touched the first one; until it has run, this sentence stays.

Each step names its commands, the result to expect and where every input comes from. The host shell
is zsh (the macOS default); the commands also run in bash. Placeholders in angle brackets are yours to
fill. Nothing here records a password or a key. No step uses a pointer click, because clicks do not
arrive (see "Operating limits and findings"): the guest console is driven by keyboard through the
monitor. A step marked **not yet run** was corrected by reading, without a guest to test it; the
first rebuild is its test, and it must be reported as such.

| Input                                    | Where it comes from                                                                                     |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| UTM 5.0.8                                | `brew install --cask utm`, checked against the version (step 1)                                         |
| Guest tools ISO 0.1.271                  | the URL and digest in step 2                                                                            |
| Windows 11 IoT LTSC ARM64 evaluation ISO | an image on the host with the recorded size and SHA-256, otherwise Microsoft's form (step 2)            |
| SSH key pair, guest credential           | created in step 3, kept outside every repository                                                        |
| Answer file, first-logon script          | appendices A and B                                                                                      |
| Host helpers, guest scripts              | the appendices named in the table below                                                                 |
| Node 26 zips, Keiko release              | `nodejs.org` and the public GitHub release, fetched by the scripts of steps 12 and 14, digests verified |

Where each appendix is saved (create the folders in step 1; every name is the file name used below):

| Appendix                                  | Save as                                                                                                   |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| A `Autounattend.xml`                      | `$W/Autounattend.xml.tmpl`                                                                                |
| B `keiko-firstlogon.ps1`                  | `$W/ans/keiko-firstlogon.ps1`                                                                             |
| C `keiko-windows-update.ps1`              | `$W/guest/keiko-windows-update.ps1`                                                                       |
| D `keiko-guest-toolchain.ps1`             | `$W/guest/keiko-guest-toolchain.ps1`                                                                      |
| E `keiko-fetch-release.ps1`               | `$W/guest/keiko-fetch-release.ps1`                                                                        |
| R `keiko-release-start.cmd`               | `$W/guest/keiko-release-start.cmd`                                                                        |
| L `keiko-win-update-loop`                 | `$W/bin/keiko-win-update-loop` (executable; its key and host-key file come from the environment, step 11) |
| M `mon.sh`, N `vmkeys.py`, O `vncshot.py` | `$W/bin/mon.sh`, `$W/bin/vmkeys.py`, `$W/bin/vncshot.py` (`mon.sh` executable)                            |
| P `mkcfg.py`                              | `$W/bin/mkcfg.py`                                                                                         |
| Q the six AppleScripts                    | `$W/bin/create.applescript`, `import`, `attach-tools`, `network`, `snapshot`, `restore` (same suffix)     |
| S `rebuild-env.sh`                        | `$W/bin/rebuild-env.sh`: the block "Variables and helpers" below, saved as a file (paths only, no secret) |

Variables and helpers used below (set them once in the shell you work in, or save the block as
appendix S, `$W/bin/rebuild-env.sh`, and `source` it at the start of every new shell, as a tool that starts a
fresh shell for each command needs; it holds paths and function definitions only, never the password
or the key itself):

```sh
W="$HOME/keiko-windows-rebuild"   # private work directory; step 1 creates it, mode 700
VM=keiko-win11-arm64-rebuild      # the rebuilt machine's own name (see "Ports and names")
ISO="$HOME/Downloads/26100.1742.240906-0331.ge_release_svc_refresh_CLIENT_IOT_LTSC_EVAL_A64FRE_en-us.iso"
KEY="$W/keiko-win-vm-rebuild"     # created in step 3
KH="$W/known_hosts"               # host keys of THIS guest only, so the first guest's key on 127.0.0.1:2222 never clashes
GUEST_USER=keiko
SSHO=(-i "$KEY" -p 2222 -o BatchMode=yes -o ConnectTimeout=10 -o UserKnownHostsFile="$KH" -o StrictHostKeyChecking=accept-new)
guest()     { ssh "${SSHO[@]}" "$GUEST_USER@127.0.0.1" "$@"; }                  # run a command in the guest over SSH
guestcopy() { scp -q -i "$KEY" -P 2222 -o BatchMode=yes -o UserKnownHostsFile="$KH" -o StrictHostKeyChecking=accept-new "$@"; }
typeline()  { python3 -I "$W/bin/vmkeys.py" "$1" --enter; }                     # type one line into the guest console
waitstopped() { for i in $(seq 1 100); do [ "$(utmctl status "$VM")" = stopped ] && return 0; sleep 6; done; echo "machine still not stopped after 10 minutes"; return 1; }
```

Typing into the guest: `typeline '<text>'` sends the text as key presses through the monitor and
presses Enter. Put the text in shell **single quotes**; the Windows text then must not contain an
apostrophe (use double quotes inside it). `typeline` works only while the guest console has the
keyboard focus; take a screenshot (`vncshot.py`) after each line and read the result from the picture.
`nc` (macOS's netcat) does not end when its input ends: `-w` is an **idle** timeout, so a call lasts until
the monitor has been silent for that many seconds. Measured against a silent local listener: with
`-w 5` one key call took 5 s (the key loop would then press a key every 5.5 s, and the boot prompt
waits only a few seconds), with `-w 1` it takes 1.5 s. `mon.sh` and the key loop below therefore use
`nc -w 1`; a call with two monitor commands takes about 3 s. If a call hangs anyway, press Ctrl-C and check `lsof -nP -iTCP:55577 -sTCP:LISTEN` (the monitor must listen).

0. **Preconditions.** Run the four checks of "Ports and names". Expect: the first machine `stopped`, no
   listener on 2222, 5977 and 55577, `name free`, and the first machine's snapshot list noted. Then:
   ```sh
   df -g "$HOME" | awk 'NR==2 {print $4 " GB free"}'                          # expect 60 or more
   osascript -e 'tell application "UTM" to get name of every virtual machine'   # expect the list of machines
   ```
   The first `osascript` call that addresses UTM makes macOS ask whether the terminal app may control
   UTM; the person at the Mac must **allow** it. To see or change the decision: System Settings →
   Privacy & Security → Automation → the terminal app → UTM. A refused call fails with `Not authorized
to send Apple events to UTM. (-1743)`. UTM is sandboxed and writes the exported skeleton (step 4)
   into `$W/vm`; a folder directly under the home directory is not one of the folders macOS protects.
   If `$W/vm/skel.utm` does not exist after step 4, allow UTM under Privacy & Security → Files and
   Folders (or choose another work folder). **Not yet run** on a Mac without earlier permissions.
1. **Host tools.** **UTM already installed** (the first machine needs it): check the version, do not
   reinstall; run only the two version lines and go on if they say 5.0.8. Without UTM:
   ```sh
   brew install --cask utm                         # only on a host without UTM
   brew list --cask --versions utm                 # expect: utm 5.0.8
   utmctl version                                  # expect: 5.0.8
   mkdir -p "$W/bin" "$W/ans" "$W/guest" && chmod 700 "$W"
   python3 --version && which nc hdiutil xmllint osascript plutil shasum curl ssh scp   # all found
   ```
   Homebrew installs the current cask version. The commands of this page were written for **5.0.8**
   (checked: the release `v5.0.8` of the UTM project carries `UTM.dmg`). If the version shown is
   another one, stop and install 5.0.8 from `https://github.com/utmapp/UTM/releases/tag/v5.0.8`
   (`brew uninstall --cask utm`, then open `UTM.dmg` and drag UTM into Applications). **Not yet run.**
   Save the appendices as the table above says.
2. **Inputs and their digests.**
   ```sh
   curl -sL -o "$W/utm-guest-tools-0.1.271.iso" \
     https://github.com/utmapp/qemu/releases/download/v10.0.2-utm/utm-guest-tools-0.1.271.iso
   stat -f %z "$W/utm-guest-tools-0.1.271.iso"     # expect 127084544
   shasum -a 256 "$W/utm-guest-tools-0.1.271.iso"  # expect 65b6a69b392ee01dd314c10f3dad9ebbf9c4160be43f5f0dd6bb715944d9095b
   stat -f %z "$ISO"                               # expect 5042194432
   shasum -a 256 "$ISO"                            # expect 3dcdba9c9c0aa0430d4332b60c9afcb3cd613d648a49cbba2d4ef7b5978f32e8
   ```
   If the image is not on the host or its values differ, register on Microsoft's evaluation site,
   download the IoT Enterprise LTSC 2024 evaluation ARM64 ISO (or a current ARM64 evaluation if
   Microsoft lists one) and record its size and SHA-256 in the issue.
3. **Credentials and the answer-file ISO.**
   ```sh
   ssh-keygen -t ed25519 -N '' -f "$KEY"           # a new key pair for this machine; $KEY.pub goes into the ISO
   PW=$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 24)
   printf 'user=%s\npassword=%s\n' "$GUEST_USER" "$PW" > "$W/guest-credential" && chmod 600 "$W/guest-credential"
   sed -e "s/@@GUEST_USER@@/$GUEST_USER/g" -e "s/@@GUEST_PASSWORD@@/$PW/g" \
     "$W/Autounattend.xml.tmpl" > "$W/ans/Autounattend.xml"
   cp "$KEY.pub" "$W/ans/host-ssh-public-key.txt"
   xmllint --noout "$W/ans/Autounattend.xml" && echo xml-ok          # expect xml-ok
   hdiutil makehybrid -quiet -iso -joliet -default-volume-name KEIKOANS -o "$W/autounattend.iso" "$W/ans"
   ls -l "$W/autounattend.iso"                                       # expect the file to exist
   ```
   `$W/ans` now holds `Autounattend.xml`, `keiko-firstlogon.ps1` and `host-ssh-public-key.txt`.
4. **Create the skeleton and export it.**
   ```sh
   SKEL=$(osascript "$W/bin/create.applescript" "$VM" "$ISO")       # prints a UUID
   rm -rf "$W/vm" && mkdir "$W/vm"
   osascript -e 'tell application "UTM" to export virtual machine id "'$SKEL'" to POSIX file "'$W'/vm/skel.utm"'
   ls "$W/vm/skel.utm" "$W/vm/skel.utm/Data"    # expect config.plist; Data holds efi_vars.fd and one .qcow2
   ```
5. **Edit the configuration and assemble the bundle.**
   ```sh
   mkdir -p "$W/b/$VM.utm/Data"
   python3 -I "$W/bin/mkcfg.py" "$W/vm/skel.utm/config.plist" "$W/b/$VM.utm/config.plist"
   plutil -p "$W/b/$VM.utm/config.plist" | grep -A4 AdditionalArguments
   # expect "-monitor", "tcp:127.0.0.1:55577,server,nowait", "-vnc", "127.0.0.1:77"
   cp "$W/vm/skel.utm/Data/efi_vars.fd" "$W"/vm/skel.utm/Data/*.qcow2 "$W/b/$VM.utm/Data/"
   cp "$W/autounattend.iso" "$W/b/$VM.utm/Data/autounattend.iso"
   cp "$ISO" "$W/b/$VM.utm/Data/windows.iso"
   ```
6. **Import it.** The import deletes the skeleton by its id first, so the first machine is never named.
   ```sh
   ID=$(osascript "$W/bin/import.applescript" "$SKEL" "$W/b/$VM.utm")     # prints the new machine's UUID
   utmctl list                                                            # expect a row "<ID> stopped <VM>"
   ```
7. **Install Windows, unattended.**
   ```sh
   utmctl start "$VM"; sleep 6; utmctl status "$VM"        # expect: started
   "$W/bin/mon.sh" "info status"                            # expect: VM status: running
   for i in $(seq 1 30); do (sleep 0.2; echo "sendkey spc"; sleep 0.3) | nc -w 1 127.0.0.1 55577 >/dev/null; sleep 0.5; done
   python3 -I "$W/bin/vncshot.py" 127.0.0.1 5977 "$W/shot.png"   # expect: ok <width> <height>
   ```
   The loop presses space for about a minute (30 calls, about two seconds each) so the Windows CD boot loader ("Press any key to boot
   from CD or DVD") continues once, at the start. **Do not press keys afterwards.** Setup restarts the
   machine itself; the Windows ISO stays first in the boot order, so each later boot shows the same
   prompt for a few seconds, and leaving it alone lets the machine fall through to the system disk and
   continue Setup (pressing a key there would start Setup from the beginning, a loop). If the first
   screenshot shows the UEFI shell instead, send `"$W/bin/mon.sh" system_reset` and repeat the loop.
   Take a screenshot every five minutes and compare: Setup shows its progress screens ("Getting
   ready", "Working on updates", the restart countdown) and, **after about 15 minutes**, a desktop
   with a taskbar and the first-logon script's window. Two screenshots in a row of the language or
   "Install now" page, or a Setup that has started over after 25 minutes, mean a loop: stop and
   report. The guest has no network yet. The after-reboot behaviour is the first build's, **not yet
   run** on a rebuild.
8. **Network driver.** Stop the machine, attach the tools ISO and move the adapter.
   ```sh
   utmctl stop "$VM" --request; waitstopped                 # expect no message
   osascript -e 'tell application "UTM" to get configuration of virtual machine id "'$ID'"' \
     | sed 's/, /\n/g' | grep -oE 'id:[0-9A-F]{8}(-[0-9A-F]{4}){3}-[0-9A-F]{12}' | head -3 | cut -d: -f2
   ```
   The last command prints three UUIDs, in this order: Windows ISO, answer ISO, system disk. Sample from
   the first machine (yours differ; the three lines, one UUID each, are the point):
   ```
   615B2C09-6348-489B-8148-143AA2D23E3C
   4B6A7601-CFB8-44B4-9277-C28D5B08E833
   B534A6AC-C99B-4986-B597-85B577BFC85F
   ```
   ```sh
   osascript "$W/bin/attach-tools.applescript" "$ID" "$W/utm-guest-tools-0.1.271.iso" <id-1> <id-2> <id-3>   # expect: drives-ok
   osascript "$W/bin/network.applescript" "$ID" 2222                                                         # expect: net-ok
   utmctl start "$VM"
   ```
   When the desktop is back (screenshot), open a command prompt through the keyboard and from it an
   **elevated PowerShell**, then install the driver in that window (the Windows text of every line
   has no apostrophe):
   ```sh
   python3 -I "$W/bin/vmkeys.py" --keys meta_l-r; sleep 2
   typeline 'cmd'; sleep 3
   typeline 'powershell -c "Start-Process powershell -Verb RunAs"'; sleep 5
   ```
   If Windows asks to confirm administrator rights, confirm by keyboard
   (`python3 -I "$W/bin/vmkeys.py" --keys alt-y`) and take a screenshot: a second, administrator
   PowerShell window must be in front. Then:
   ```sh
   typeline 'pnputil /add-driver D:\Drivers\NetKVM\w11\ARM64\netkvm.inf /install'
   typeline 'ipconfig'
   typeline 'ping www.microsoft.com'
   ```
   Expect the driver added, an address from 10.0.2.0/24 and replies; read each result from a
   screenshot. If `D:` is not the tools drive, try the next letters. Every later line of steps 9 and 10
   is typed into this elevated window. The elevation prompt and the drive letter are **not yet run** on a
   rebuild (the first build used a different line that depended on shell quoting).
9. **Activation.** In the elevated window (PowerShell, so write `$env:windir` for `%windir%`):
   ```sh
   typeline 'cscript //nologo $env:windir\system32\slmgr.vbs /ato'
   typeline 'cscript //nologo $env:windir\system32\slmgr.vbs /xpr'
   typeline 'cscript //nologo $env:windir\system32\slmgr.vbs /dli'
   ```
   Expect `Product activated successfully`, `Timebased activation will expire <date>` and
   `License Status: Licensed` in the `TIMEBASED_EVAL` channel. Write the expiry date down; if `/ato`
   does not take, follow "4. Activation" (`/rearm`, reboot, repeat) and otherwise stop and report.
10. **OpenSSH, key-only.** In the elevated PowerShell window, run the first-logon script again from the
    answer-file drive (PowerShell syntax; the answer file's own `cmd` line does not work here), then
    widen the firewall rule:
    ```sh
    typeline 'Get-PSDrive -PSProvider FileSystem | ForEach-Object { $f = Join-Path $_.Root "keiko-firstlogon.ps1"; if (Test-Path $f) { powershell -NoProfile -ExecutionPolicy Bypass -File $f } }'
    typeline 'netsh advfirewall firewall set rule name="OpenSSH SSH Server (sshd)" new profile=any'
    ```
    The script prints its transcript and ends by writing `C:\ProgramData\keiko-setup\done.txt`; the
    `netsh` line prints `Updated 1 rule(s).` **Not yet run** (the first build reached the same state
    by other lines). From the host:
    ```sh
    guest hostname                                   # expect: KEIKO-WIN11 (the answer file's computer name)
    guest 'reg add "HKLM\SYSTEM\CurrentControlSet\Control\TimeZoneInformation" /v RealTimeIsUniversal /t REG_DWORD /d 1 /f'   # expect: The operation completed successfully.
    guest 'shutdown /r /t 5'
    ```
    The first `guest` call stores this guest's host key in `$KH` (`accept-new`), so the host key of the
    first guest, held in the default `known_hosts` for the same `127.0.0.1:2222`, is neither used nor
    overwritten. If `guest hostname` reports `Connection timed out during banner exchange`, the firewall
    rule does not cover all profiles yet. When the guest is back (a reboot takes a few minutes), `guest hostname`
    answers again and the answer-file drive may be removed.
11. **Windows Update until none is left.**
    ```sh
    guestcopy "$W/guest/keiko-windows-update.ps1" "$W/guest/keiko-guest-toolchain.ps1" \
      "$W/guest/keiko-fetch-release.ps1" "$W/guest/keiko-release-start.cmd" \
      "$GUEST_USER@127.0.0.1:C:/ProgramData/keiko-setup/"
    guest 'schtasks /create /tn KeikoUpdate /tr "powershell -NoProfile -ExecutionPolicy Bypass -File C:\ProgramData\keiko-setup\keiko-windows-update.ps1" /sc once /st 23:59 /ru SYSTEM /rl HIGHEST /f'
    KEIKO_SSH_KEY="$KEY" KEIKO_KNOWN_HOSTS="$KH" "$W/bin/keiko-win-update-loop"   # appendix L
    ```
    The loop reboots the guest, repeats up to ten passes and ends with `NO UPDATES LEFT`; each pass
    prints `pass <n>: installed;reboot=True` and the last one `pass <n>: none`. A pass that ends
    `error` or after ten passes with updates pending stops the loop: read `update.log` and report.
12. **Toolchain.**
    ```sh
    guest 'powershell -NoProfile -ExecutionPolicy Bypass -File C:\ProgramData\keiko-setup\keiko-guest-toolchain.ps1'
    # expect: x64 ok sha256=<digest> and arm64 ok sha256=<digest>
    guest 'C:\tools\node-x64\node.exe -p process.arch; C:\tools\node-arm64\node.exe -p process.arch'   # expect: x64 and arm64
    ```
13. **License check and snapshot.** Check the license **over SSH** (an administrator's SSH session is
    elevated), not at the console:
    ```sh
    guest 'cscript //nologo $env:windir\system32\slmgr.vbs /xpr'    # expect: Timebased activation will expire <date>
    guest 'cscript //nologo $env:windir\system32\slmgr.vbs /dli'    # expect: License Status: Licensed, TIMEBASED_EVAL channel
    ```
    (**Not yet run** over SSH; if the output is empty or a dialog is needed, run the two lines in the
    console window of step 9 instead.) Then, with the machine stopped and **before any Keiko release or
    browser policy**:
    ```sh
    guest 'shutdown /s /t 5'; waitstopped
    osascript "$W/bin/snapshot.applescript" "$ID" clean-updated      # expect: clean-updated
    ```
    Write the expiry date and the reminder date (expiry minus one week) into the issue, record the
    observed duration of every phase, and run the snapshot list of "Ports and names" for the first
    machine again: it must equal the list noted in step 0.
14. **Keiko release and start proof.** Start the machine (`utmctl start "$VM"`; `guest hostname` answers
    after about three minutes, as in the 191 s restore measurement), then fetch, start and check the x64 leg:
    ```sh
    guest 'powershell -NoProfile -ExecutionPolicy Bypass -File C:\ProgramData\keiko-setup\keiko-fetch-release.ps1 -Tag v1.4.0'
    # expect: sha256 ok ba6ae83c7655b69e1266beaeb9ce2eef6babffda1b4820a25a463ae5e5f22b76, then: extracted to C:\keiko\v1.4.0\extracted
    guest 'reg add "HKLM\SOFTWARE\Policies\Microsoft\Edge" /v HideFirstRunExperience /t REG_DWORD /d 1 /f; reg add "HKLM\SOFTWARE\Policies\Microsoft\Edge" /v BrowserSignin /t REG_DWORD /d 0 /f'
    guest 'Remove-Item C:\ProgramData\keiko-setup\release-start.log -ErrorAction SilentlyContinue; schtasks /create /tn KeikoReleaseX64 /tr C:\ProgramData\keiko-setup\keiko-release-start.cmd /sc once /st 23:59 /it /ru keiko /f; schtasks /run /tn KeikoReleaseX64'
    for i in $(seq 1 60); do
      r=$(guest 'if (Test-Path C:\ProgramData\keiko-setup\release-start.log) { Get-Content C:\ProgramData\keiko-setup\release-start.log -Raw }')
      case "$r" in *exit=*) break;; esac; sleep 5
    done; echo "$r"                                                              # expect a last line: exit=0 (waits at most five minutes)
    guest 'curl.exe -s -m 30 http://127.0.0.1:1983/api/health'                    # expect: "status":"ok" ... "readiness":"ready"
    ```
    Then the ARM64 leg. Port 1983 is held by the x64 instance, so stop it first, then start the same
    script with the ARM64 Node as its argument in a second task:
    ```sh
    guest 'C:\keiko\v1.4.0\extracted\Keiko\runtime\node\node.exe C:\keiko\v1.4.0\extracted\Keiko\app\dist\cli\index.js stop'
    guest 'Remove-Item C:\ProgramData\keiko-setup\release-start.log -ErrorAction SilentlyContinue; schtasks /create /tn KeikoReleaseArm64 /tr "C:\ProgramData\keiko-setup\keiko-release-start.cmd C:\tools\node-arm64\node.exe" /sc once /st 23:59 /it /ru keiko /f; schtasks /run /tn KeikoReleaseArm64'
    ```
    Poll `release-start.log` for `exit=0` and read `/api/health` exactly as above; stop the instance
    with the same `stop` line afterwards. Both starts, the stop and the second task are **not yet run**;
    the first build ran the start by hand in the interactive session (see "Start proofs (v1.4.0)").

## Appendix: scripts

The helper files are small enough to keep here. Placeholders in angle brackets (including the
directory and key defaults at the top of the two host scripts) or `@@…@@` are filled in on the host
and are never committed.

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

Run one pass with a SYSTEM scheduled task. `schtasks /run` only starts the task and returns, so
delete the previous result first and wait for the new one before reading it:

```powershell
schtasks /create /tn KeikoUpdate /tr "powershell -NoProfile -ExecutionPolicy Bypass -File C:\ProgramData\keiko-setup\keiko-windows-update.ps1" /sc once /st 23:59 /ru SYSTEM /rl HIGHEST /f
Remove-Item C:\ProgramData\keiko-setup\update-result.txt -ErrorAction SilentlyContinue
schtasks /run /tn KeikoUpdate
while (-not (Test-Path C:\ProgramData\keiko-setup\update-result.txt)) { Start-Sleep -Seconds 10 }
Get-Content C:\ProgramData\keiko-setup\update-result.txt
```

The host helper `keiko-win-update-loop` does this for every pass, reboots when a pass reports
`reboot=True` and stops when a pass reports `none`.

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

### G. `keiko-win-dev-loop` (host)

```bash
#!/bin/bash
# keiko-win-dev-loop [<branch|commit>] [--clean]
# Builds a branch or commit on this Mac, packs it with `npm pack`, copies the tarball into the Windows
# guest over the loopback SSH port, installs it there with the x64 Node, starts it with
# `keiko start --start-timeout 240` in the interactive session and opens the UI in Edge.
# Ends by printing the commit, a verification of what runs in the guest and the elapsed time.
# Default ref: origin/feat/jira-pod-release-1. --clean runs `npm run clean` first (fresh dist).
set -euo pipefail

HOME_DIR="<helper-dir>"
SRC="${KEIKO_SRC_REPO:-<repo-checkout>}"       # repository that owns the worktree
WT="${KEIKO_WIN_LOOP_WT:-$HOME_DIR/work/keiko-win-loop}"
VM="${KEIKO_WIN_VM:-keiko-win11-arm64}"
KEY="<ssh-private-key>"
PORT=2222
GUEST_USER="$(sed -n 's/^user=//p' "$HOME_DIR/guest-credential")"
SSHO=(-i "$KEY" -p "$PORT" -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new)
# Heavy host work goes through the machine guard: at most two heavy jobs at a time.
HEAVY="${KEIKO_HEAVY_SLOT:-<machine-guard>/heavy-slot.sh}"
heavy() { local what="$1"; shift; if [ -x "$HEAVY" ]; then "$HEAVY" "4374-$what" -- "$@"; else "$@"; fi; }
ssh_g() { ssh "${SSHO[@]}" "$GUEST_USER@127.0.0.1" "$@"; }
scp_g() { scp -q -i "$KEY" -P "$PORT" -o BatchMode=yes "$@"; }

REF="origin/feat/jira-pod-release-1"; CLEAN=0
for a in "$@"; do case "$a" in --clean) CLEAN=1;; *) REF="$a";; esac; done

declare -a PHASES
T0=$(date +%s); TP=$T0
phase() { local now; now=$(date +%s); PHASES+=("$1=$((now - TP))s"); TP=$now; }
fmt() { printf '%dm%02ds' $(($1 / 60)) $(($1 % 60)); }
log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }

# 1. worktree at the requested commit
[ -d "$WT/.git" ] || [ -f "$WT/.git" ] || git -C "$SRC" worktree add --detach "$WT" HEAD >/dev/null
git -C "$WT" fetch --quiet origin
if git -C "$WT" rev-parse --verify --quiet "origin/$REF^{commit}" >/dev/null; then REF="origin/$REF"; fi
SHA="$(git -C "$WT" rev-parse --verify "$REF^{commit}")"
SHORT="${SHA:0:12}"
SUBJECT="$(git -C "$WT" log -1 --format=%s "$SHA")"
if [ -n "$(git -C "$WT" status --porcelain --untracked-files=all -- . ':!.keiko-loop-lock')" ]; then
  echo "refusing to build: $WT has modified or untracked files; commit, stash or reset them first" >&2
  exit 1
fi
git -C "$WT" checkout --quiet --detach "$SHA"
log "commit $SHORT  $SUBJECT"
phase checkout

# 2. dependencies only when the lockfile changed
LOCK_NOW="$(shasum -a 256 "$WT/package-lock.json" | cut -d' ' -f1)"
LOCK_MARK="$WT/.keiko-loop-lock"
if [ ! -d "$WT/node_modules" ] || [ "$(cat "$LOCK_MARK" 2>/dev/null || true)" != "$LOCK_NOW" ]; then
  log "npm ci (lockfile changed or first run)"
  heavy win-npm-ci bash -c 'cd "$1" && npm ci --no-audit --no-fund --loglevel=error' _ "$WT"
  echo "$LOCK_NOW" > "$LOCK_MARK"
fi
phase deps

# 3. build, then pack without the release gates (CI is the arbiter; the loop only needs the artifact)
log "build"
heavy win-build bash -c '
  set -euo pipefail
  cd "$1"
  [ "$2" = 1 ] && npm run --silent clean
  npm run --silent build
  npm run --silent prepare:bin
  npm run --silent build:ui
  npm run --silent prune:package-build-artifacts
  npm run --silent prune:package-native-optionals
' _ "$WT" "$CLEAN"
phase build

log "npm pack"
OUT="<packs-dir>"; mkdir -p "$OUT"
TGZ_SRC="$(heavy win-pack bash -c 'cd "$1" && npm pack --ignore-scripts --silent --pack-destination "$2" | tail -1' _ "$WT" "$OUT")"
TGZ="$OUT/$SHORT.tgz"
mv -f "$OUT/$TGZ_SRC" "$TGZ"
TGZ_SHA="$(shasum -a 256 "$TGZ" | cut -d' ' -f1)"
find "$OUT" -name '*.tgz' ! -name "$SHORT.tgz" -mtime +1 -delete
phase pack

# 4. guest up?
if [ "$(utmctl status "$VM" 2>/dev/null)" != "started" ]; then
  log "starting guest $VM"
  utmctl start "$VM" >/dev/null
fi
for _ in $(seq 1 60); do ssh_g hostname >/dev/null 2>&1 && break; sleep 5; done
ssh_g hostname >/dev/null 2>&1 || { echo "guest not reachable over 127.0.0.1:$PORT" >&2; exit 1; }
phase guest

# 5. ship + install
log "copy $(du -h "$TGZ" | cut -f1) into the guest"
ssh_g 'New-Item -ItemType Directory -Force -Path C:\keiko\dev, C:\ProgramData\keiko-setup | Out-Null' >/dev/null
scp_g "$TGZ" "$GUEST_USER@127.0.0.1:C:/keiko/dev/$SHORT.tgz"
scp_g "$HOME_DIR/guest/keiko-dev-install.ps1" "$HOME_DIR/guest/keiko-dev-start.cmd" "$HOME_DIR/guest/open-browser.cmd" \
  "$GUEST_USER@127.0.0.1:C:/ProgramData/keiko-setup/"
phase ship
log "install in the guest (x64 Node)"
ssh_g "powershell -NoProfile -ExecutionPolicy Bypass -File C:\\ProgramData\\keiko-setup\\keiko-dev-install.ps1 -Id $SHORT" | tail -2
phase install

# 6. start in the interactive session
log "start (keiko start --start-timeout 240)"
ssh_g "Remove-Item C:\\ProgramData\\keiko-setup\\dev-start.log -ErrorAction SilentlyContinue
schtasks /create /tn KeikoDevStart /tr \"C:\\ProgramData\\keiko-setup\\keiko-dev-start.cmd $SHORT\" /sc once /st 23:59 /it /ru $GUEST_USER /f | Out-Null
schtasks /run /tn KeikoDevStart | Out-Null" >/dev/null
for _ in $(seq 1 60); do
  R="$(ssh_g 'if (Test-Path C:\ProgramData\keiko-setup\dev-start.log) { Get-Content C:\ProgramData\keiko-setup\dev-start.log -Raw }' 2>/dev/null || true)"
  case "$R" in *exit=*) break;; esac; sleep 5
done
case "$R" in *"exit=0"*) ;; *) echo "start failed:"; echo "$R" | tail -6; exit 2;; esac
phase start

# 7. browser (Edge policy values keep the first-run overlay away)
ssh_g 'reg add "HKLM\SOFTWARE\Policies\Microsoft\Edge" /v HideFirstRunExperience /t REG_DWORD /d 1 /f | Out-Null
reg add "HKLM\SOFTWARE\Policies\Microsoft\Edge" /v BrowserSignin /t REG_DWORD /d 0 /f | Out-Null
taskkill /F /IM msedge.exe 2>$null | Out-Null' >/dev/null || true
ssh_g "schtasks /create /tn KeikoDevBrowser /tr \"C:\\ProgramData\\keiko-setup\\open-browser.cmd http://127.0.0.1:1983/\" /sc once /st 23:59 /it /ru $GUEST_USER /f | Out-Null; schtasks /run /tn KeikoDevBrowser | Out-Null" >/dev/null
phase browser

# 8. what actually runs in the guest
VERIFY="$(ssh_g '$h = curl.exe -s -m 30 http://127.0.0.1:1983/api/health | ConvertFrom-Json
$pidx = (Get-NetTCPConnection -LocalPort 1983 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess
$cmd = (Get-CimInstance Win32_Process -Filter "ProcessId=$pidx").CommandLine
"health=$($h.status) version=$($h.version) launchId=$($h.launchId) readiness=$($h.diagnostics.readiness)"
"listener=$cmd"')"
phase verify

END=$(date +%s)
echo
echo "commit      $SHA"
echo "subject     $SUBJECT"
echo "tarball     $SHORT.tgz  sha256 $TGZ_SHA"
echo "$VERIFY" | sed 's/^/guest       /'
case "$VERIFY" in *"\\keiko\\dev\\$SHORT\\"*) echo "guest       listener runs from the install of $SHORT";; *) echo "guest       WARNING: listener is not the install of $SHORT"; exit 3;; esac
echo "phases      ${PHASES[*]}"
echo "elapsed     $(fmt $((END - T0)))"
```

### H. `keiko-dev-install.ps1` (guest)

```powershell
# Installs a packed Keiko build (C:\keiko\dev\<Id>.tgz) into its own directory,
# after stopping any earlier dev install. Keeps the new and the previous install only.
param([Parameter(Mandatory = $true)][string]$Id)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$root = 'C:\keiko\dev'
$env:Path = 'C:\tools\node-x64;' + $env:Path
Get-ChildItem $root -Directory -ErrorAction SilentlyContinue | ForEach-Object {
  $cli = Join-Path $_.FullName 'node_modules\@oscharko-dev\keiko\dist\cli\index.js'
  if (Test-Path $cli) { & node $cli stop 2>&1 | Out-Null }
}
# Whatever the clean stop above left behind: only processes started from an earlier dev install.
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*C:\keiko\dev\*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
$pkg = Join-Path $root "$Id\node_modules\@oscharko-dev\keiko"
if (Test-Path (Join-Path $root $Id)) { Remove-Item -Recurse -Force (Join-Path $root $Id) }
New-Item -ItemType Directory -Force -Path $pkg | Out-Null
# The packed tarball bundles every dependency, so extracting it is the whole install; `npm install`
# of the same file needed 11 minutes in this guest, `tar` needs about 20 seconds.
& tar.exe -xzf (Join-Path $root "$Id.tgz") -C $pkg --strip-components=1
if ($LASTEXITCODE -ne 0) { throw "tar failed ($LASTEXITCODE)" }
if (-not (Test-Path (Join-Path $pkg 'dist\cli\index.js'))) { throw 'dist\cli\index.js missing after extraction' }
Set-Content -Path (Join-Path $root 'current.txt') -Value $Id -Encoding ascii
Get-ChildItem $root -Directory | Sort-Object LastWriteTime -Descending | Select-Object -Skip 2 | Remove-Item -Recurse -Force
Get-ChildItem $root -Filter *.tgz | Sort-Object LastWriteTime -Descending | Select-Object -Skip 2 | Remove-Item -Force
"installed $Id"
```

### I. `keiko-dev-start.cmd` (guest)

```bat
@echo off
rem Starts the dev install %1 in the interactive session (a scheduled task starts in System32, which breaks `keiko start`).
cd /d "%USERPROFILE%"
set PATH=C:\tools\node-x64;%PATH%
set OUT=C:\ProgramData\keiko-setup\dev-start.log
node "C:\keiko\dev\%1\node_modules\@oscharko-dev\keiko\dist\cli\index.js" start --start-timeout 240 > "%OUT%" 2>&1
echo exit=%ERRORLEVEL% >> "%OUT%"
```

### J. `open-browser.cmd` (guest)

```bat
@echo off
rem Opens the default browser (Edge) on the local Keiko URL in the interactive session.
start "" "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --new-window --no-first-run --hide-crash-restore-bubble %1
```

### K. `keiko-mac-dev` (host)

```bash
#!/bin/bash
# keiko-mac-dev [up|stop|status] [<branch|commit>]
# One dedicated checkout that follows origin/feat/jira-pod-release-1 (detached at the fetched commit).
# `up` (default) updates it, installs dependencies only when the lockfile changed, builds it and starts
# Keiko with `npm run dev:start` on a loopback port. `stop` stops that instance; leave none running.
set -euo pipefail

CO="${KEIKO_MAC_CHECKOUT:-<mac-checkout>}"
SRC="${KEIKO_SRC_REPO:-<repo-checkout>}"
STATE="${KEIKO_MAC_STATE:-<mac-state-dir>}"
PORT="${KEIKO_MAC_PORT:-1990}"
CMD="${1:-up}"; shift || true
REF="${1:-origin/feat/jira-pod-release-1}"

HEAVY="${KEIKO_HEAVY_SLOT:-<machine-guard>/heavy-slot.sh}"
heavy() { local what="$1"; shift; if [ -x "$HEAVY" ]; then "$HEAVY" "4374-$what" -- "$@"; else "$@"; fi; }
fmt() { printf '%dm%02ds' $(($1 / 60)) $(($1 % 60)); }
log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }
export KEIKO_STATE_DIR="$STATE" KEIKO_DEV_UI_PORT="$PORT" KEIKO_OS_KEYCHAIN=off

case "$CMD" in
  stop)
    [ -d "$CO" ] && (cd "$CO" && npm run --silent dev:stop) || true
    echo "stopped (port $PORT)"; exit 0;;
  status)
    curl -s -m 5 "http://127.0.0.1:$PORT/api/health" || echo "not running on 127.0.0.1:$PORT"; echo; exit 0;;
  up) ;;
  *) echo "usage: keiko-mac-dev [up|stop|status] [<branch|commit>]" >&2; exit 64;;
esac

T0=$(date +%s)
mkdir -p "$STATE"
[ -e "$CO/.git" ] || git -C "$SRC" worktree add --detach "$CO" HEAD >/dev/null
git -C "$CO" fetch --quiet origin
if git -C "$CO" rev-parse --verify --quiet "origin/$REF^{commit}" >/dev/null; then REF="origin/$REF"; fi
SHA="$(git -C "$CO" rev-parse --verify "$REF^{commit}")"
SUBJECT="$(git -C "$CO" log -1 --format=%s "$SHA")"
(cd "$CO" && npm run --silent dev:stop >/dev/null 2>&1 || true)
if [ -n "$(git -C "$CO" status --porcelain --untracked-files=all -- . ':!.keiko-loop-lock')" ]; then
  echo "refusing to build: $CO has modified or untracked files; commit, stash or reset them first" >&2
  exit 1
fi
git -C "$CO" checkout --quiet --detach "$SHA"
log "commit ${SHA:0:12}  $SUBJECT"

LOCK_NOW="$(shasum -a 256 "$CO/package-lock.json" | cut -d' ' -f1)"
if [ ! -d "$CO/node_modules" ] || [ "$(cat "$CO/.keiko-loop-lock" 2>/dev/null || true)" != "$LOCK_NOW" ]; then
  log "npm ci (lockfile changed or first run)"
  heavy mac-npm-ci bash -c 'cd "$1" && npm ci --no-audit --no-fund --loglevel=error' _ "$CO"
  echo "$LOCK_NOW" > "$CO/.keiko-loop-lock"
fi

log "build and start on 127.0.0.1:$PORT (npm run dev:start -- --no-open)"
heavy mac-build-start bash -c 'cd "$1" && npm run --silent dev:start -- --no-open' _ "$CO"

HEALTH="$(curl -s -m 20 "http://127.0.0.1:$PORT/api/health")"
echo
echo "commit      $SHA"
echo "subject     $SUBJECT"
echo "health      $HEALTH"
echo "url         http://127.0.0.1:$PORT  (state $STATE)"
echo "elapsed     $(fmt $(($(date +%s) - T0)))"
echo "stop with   keiko-mac-dev stop"
```

### L. `keiko-win-update-loop` (host)

Set `KEIKO_SSH_KEY` to the private key and, for a rebuilt machine, `KEIKO_KNOWN_HOSTS` to its own
host-key file; the guest user is `keiko`.

```bash
#!/bin/bash
# Reboot the guest, then repeat update passes until none are left. Reboots whenever a pass asks.
KEY="${KEIKO_SSH_KEY:?set KEIKO_SSH_KEY to the guest's private key}"
KH="${KEIKO_KNOWN_HOSTS:-$HOME/.ssh/known_hosts}"
SSH="ssh -i $KEY -p 2222 -o BatchMode=yes -o ConnectTimeout=10 -o UserKnownHostsFile=$KH -o StrictHostKeyChecking=accept-new keiko@127.0.0.1"
waitssh() { for i in $(seq 1 120); do $SSH hostname >/dev/null 2>&1 && return 0; sleep 10; done; return 1; }
reboot_guest() { $SSH 'shutdown /r /t 5' >/dev/null 2>&1; sleep 90; waitssh || exit 1; sleep 120; }
reboot_guest
for pass in $(seq 1 10); do
  $SSH 'Remove-Item C:\ProgramData\keiko-setup\update-result.txt -ErrorAction SilentlyContinue; schtasks /run /tn KeikoUpdate' >/dev/null 2>&1 || { echo "ERROR: update pass not started"; exit 2; }
  r=""
  for i in $(seq 1 300); do
    r=$($SSH 'if (Test-Path C:\ProgramData\keiko-setup\update-result.txt) { Get-Content C:\ProgramData\keiko-setup\update-result.txt }' 2>/dev/null | tr -d '\r')
    [ -n "$r" ] && break; sleep 10
  done
  echo "pass $pass: $r"; $SSH 'Get-Content C:\ProgramData\keiko-setup\update.log -Tail 4' 2>&1 | cut -c1-180
  case "$r" in
    none) echo "NO UPDATES LEFT"; exit 0;;
    error|"") echo "ERROR"; exit 2;;
    *reboot=True*) reboot_guest;;
  esac
done
echo "UPDATES STILL PENDING AFTER 10 PASSES"
exit 3
```

### M. `mon.sh` (host)

Sends commands to the QEMU monitor of the machine (`$W/bin/mon.sh`); set `KEIKO_MONITOR_PORT` when the
machine got another monitor port.

```bash
#!/bin/bash
# usage: mon.sh "cmd" ["cmd"...]  — send commands to the QEMU monitor
PORT="${KEIKO_MONITOR_PORT:-55577}"
( sleep 0.3; for c in "$@"; do printf '%s\n' "$c"; sleep 0.4; done; sleep 0.5 ) | nc -w 1 127.0.0.1 "$PORT" | sed 's/\x1b\[[0-9;]*[A-Za-z]//g' | tr -d '\r' | grep -v -E "^\(qemu\) *$"
```

### N. `vmkeys.py` (host)

Types text or named keys into the guest console through the monitor (`python3 -I vmkeys.py ...`). Its
monitor port is the `55577` in the `create_connection` line.

```python
import socket, sys, time
# usage: vmkeys.py "text to type" [--enter] | vmkeys.py --keys meta_l-r ret
MAP = {' ':'spc','\n':'ret','-':'minus','=':'equal','[':'bracket_left',']':'bracket_right','\\':'backslash',';':'semicolon',"'":'apostrophe','`':'grave_accent',',':'comma','.':'dot','/':'slash'}
SHIFT = {'_':'minus','+':'equal','{':'bracket_left','}':'bracket_right','|':'backslash',':':'semicolon','"':'apostrophe','~':'grave_accent','<':'comma','>':'dot','?':'slash','!':'1','@':'2','#':'3','$':'4','%':'5','^':'6','&':'7','*':'8','(':'9',')':'0'}
def keys_for(text):
    for ch in text:
        if ch in MAP: yield MAP[ch]
        elif ch in SHIFT: yield 'shift-' + SHIFT[ch]
        elif ch.isupper(): yield 'shift-' + ch.lower()
        else: yield ch
s = socket.create_connection(('127.0.0.1', 55577)); time.sleep(0.3)
def send(k):
    s.sendall(('sendkey %s 80\n' % k).encode()); time.sleep(0.09)
a = sys.argv[1:]
if a and a[0] == '--keys':
    for k in a[1:]: send(k)
else:
    for k in keys_for(a[0]): send(k)
    if '--enter' in a: send('ret')
time.sleep(0.4); s.close()
```

### O. `vncshot.py` (host)

Writes a PNG of the guest screen: `python3 -I vncshot.py 127.0.0.1 5977 shot.png` prints
`ok <width> <height>`. It needs nothing beyond Python 3.

```python
import socket, struct, sys, zlib
host, port, out = sys.argv[1], int(sys.argv[2]), sys.argv[3]
s = socket.create_connection((host, port), timeout=20)
def rd(n):
    b = b''
    while len(b) < n:
        c = s.recv(n - len(b))
        if not c: raise EOFError
        b += c
    return b
rd(12); s.sendall(b'RFB 003.008\n')
n = rd(1)[0]; types = rd(n)
assert 1 in types, types
s.sendall(b'\x01'); assert struct.unpack('>I', rd(4))[0] == 0
s.sendall(b'\x01')
w, h = struct.unpack('>HH', rd(4)); rd(16); ln = struct.unpack('>I', rd(4))[0]; rd(ln)
# 32bpp little-endian BGRX
s.sendall(struct.pack('>BxxxBBBBHHHBBBxxx', 0, 32, 24, 0, 1, 255, 255, 255, 16, 8, 0))
s.sendall(struct.pack('>BxHHHHH' if False else '>BxHi', 2, 1, 0))
s.sendall(struct.pack('>BBHHHH', 3, 0, 0, 0, w, h))
buf = None
while True:
    t = rd(1)[0]
    if t != 0: raise SystemExit('unexpected msg %d' % t)
    rd(1); nr = struct.unpack('>H', rd(2))[0]
    for _ in range(nr):
        x, y, rw, rh, enc = struct.unpack('>HHHHi', rd(12))
        if enc != 0: raise SystemExit('enc %d' % enc)
        data = rd(rw * rh * 4)
        if rw == w and rh == h: buf = data
    if buf: break
    s.sendall(struct.pack('>BBHHHH', 3, 0, 0, 0, w, h))
raw = b''.join(b'\x00' + bytes(sum(([buf[i+2], buf[i+1], buf[i]] for i in range(r*w*4, (r+1)*w*4, 4)), [])) for r in range(h))
def ch(t, d): return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d))
open(out, 'wb').write(b'\x89PNG\r\n\x1a\n' + ch(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) + ch(b'IDAT', zlib.compress(raw, 6)) + ch(b'IEND', b''))
print('ok', w, h)
```

### P. `mkcfg.py` (host)

Turns UTM's exported skeleton configuration into the machine of "Build procedure", step 1. The three
optional arguments give a rebuilt machine other loopback ports when the first one must stay running
(then change the same ports in `mon.sh`, `vmkeys.py`, `vncshot.py`, the `network.applescript` call and
the loop scripts).

```python
# usage: python3 -I mkcfg.py <skeleton config.plist> <edited config.plist> [ssh-port] [monitor-port] [vnc-display]
# Turns UTM's exported skeleton into the machine of this page. Defaults: SSH 2222, monitor 55577, VNC 5977.
import plistlib
import sys
import uuid

src, dst = sys.argv[1], sys.argv[2]
ssh_port = int(sys.argv[3]) if len(sys.argv) > 3 else 2222
monitor_port = int(sys.argv[4]) if len(sys.argv) > 4 else 55577
vnc_display = int(sys.argv[5]) if len(sys.argv) > 5 else 77  # VNC port is 5900 + display
c = plistlib.load(open(src, "rb"))
disk = [d for d in c["Drive"] if d["ImageType"] == "Disk"][0]
disk["Interface"] = "NVMe"
win = {"Identifier": str(uuid.uuid4()).upper(), "ImageName": "windows.iso", "ImageType": "CD", "Interface": "USB", "InterfaceVersion": 1, "ReadOnly": True}
ans = {"Identifier": str(uuid.uuid4()).upper(), "ImageName": "autounattend.iso", "ImageType": "CD", "Interface": "USB", "InterfaceVersion": 1, "ReadOnly": True}
c["Drive"] = [win, ans, disk]
c["Display"] = [{"Hardware": "virtio-ramfb", "DynamicResolution": True, "NativeResolution": False, "UpscalingFilter": "Nearest", "DownscalingFilter": "Linear"}]
c["QEMU"]["TPMDevice"] = True
c["QEMU"]["AdditionalArguments"] = ["-monitor", "tcp:127.0.0.1:%d,server,nowait" % monitor_port, "-vnc", "127.0.0.1:%d" % vnc_display]
c["Network"][0]["Mode"] = "Emulated"
c["Network"][0]["PortForward"] = [{"Protocol": "TCP", "GuestAddress": "", "GuestPort": 22, "HostAddress": "127.0.0.1", "HostPort": ssh_port}]
c["Information"]["Icon"] = "windows"
c["Sound"] = []
plistlib.dump(c, open(dst, "wb"))
```

### Q. UTM AppleScripts (host)

Each file is run as `osascript <file> <arguments>`; the usage line at the top of each says which.
`update configuration` needs the machine stopped.

`create.applescript`:

```applescript
-- usage: osascript create.applescript <machine-name> <windows-iso-path>
-- Creates the skeleton machine and prints its id. The skeleton is exported and edited in step 6.
on run argv
  set vmName to item 1 of argv
  set iso to POSIX file (item 2 of argv)
  tell application "UTM"
    set vm to make new virtual machine with properties {backend:qemu, configuration:{name:vmName, architecture:"aarch64", memory:16384, cpu cores:8, hypervisor:true, uefi:true, drives:[{removable:true, source:iso}, {guest size:131072}], network interfaces:[{hardware:"e1000e"}]}}
    return id of vm
  end tell
end run
```

`import.applescript`:

```applescript
-- usage: osascript import.applescript <skeleton-id> <edited-bundle.utm>
on run argv
  tell application "UTM"
    delete virtual machine id (item 1 of argv)
    set vm to import new virtual machine from POSIX file (item 2 of argv)
    return (id of vm)
  end tell
end run
```

`attach-tools.applescript`:

```applescript
-- usage: osascript attach-tools.applescript <machine-id> <tools-iso-path> <drive-id-1> <drive-id-2> <drive-id-3>
-- Keeps the three existing drives (by id, in their order) and adds the guest tools ISO as a fourth.
-- Run it with the machine stopped.
on run argv
  set tools to POSIX file (item 2 of argv)
  tell application "UTM"
    set vm to virtual machine id (item 1 of argv)
    update configuration of vm with {drives:{{id:(item 3 of argv)}, {id:(item 4 of argv)}, {id:(item 5 of argv)}, {removable:true, source:tools}}}
    return "drives-ok"
  end tell
end run
```

`network.applescript`:

```applescript
-- usage: osascript network.applescript <machine-id> <ssh-host-port>
-- Moves the adapter to virtio-net-pci in Emulated mode with the loopback port forward host port -> guest 22.
-- Run it with the machine stopped.
on run argv
  set hostPort to (item 2 of argv) as integer
  tell application "UTM"
    set vm to virtual machine id (item 1 of argv)
    update configuration of vm with {network interfaces:{{index:0, hardware:"virtio-net-pci", mode:emulated, port forwards:{{guest port:22, host port:hostPort, host address:"127.0.0.1", guest address:""}}}}}
    return "net-ok"
  end tell
end run
```

`snapshot.applescript`:

```applescript
-- usage: osascript snapshot.applescript <machine-id> <snapshot-name>   (machine stopped)
on run argv
  set snapName to item 2 of argv
  tell application "UTM"
    set vm to virtual machine id (item 1 of argv)
    set s to create snapshot vm named snapName
    return (name of every snapshot of vm) as text
  end tell
end run
```

`restore.applescript`:

```applescript
-- usage: osascript restore.applescript <machine-id> <snapshot-name>   (machine stopped)
on run argv
  set snapName to item 2 of argv
  tell application "UTM"
    set vm to virtual machine id (item 1 of argv)
    restore (first snapshot of vm whose name is snapName)
    return "restored"
  end tell
end run
```

### R. `keiko-release-start.cmd` (guest)

Starts the extracted release in the interactive session, like appendix I does for the developer loop.
Run it through an interactive scheduled task as in step 14 of the checklist (the optional argument
selects the ARM64 Node); it writes
`C:\ProgramData\keiko-setup\release-start.log` and ends it with `exit=<code>`.

```bat
@echo off
rem usage: keiko-release-start.cmd [path-to-node.exe]   (default: the release's own x64 Node)
rem Starts the extracted v1.4.0 release in the interactive session (a scheduled task starts in System32, which breaks `keiko start`).
cd /d "%USERPROFILE%"
set NODE=%~1
if "%NODE%"=="" set NODE=C:\keiko\v1.4.0\extracted\Keiko\runtime\node\node.exe
set OUT=C:\ProgramData\keiko-setup\release-start.log
"%NODE%" "C:\keiko\v1.4.0\extracted\Keiko\app\dist\cli\index.js" start --start-timeout 240 > "%OUT%" 2>&1
echo exit=%ERRORLEVEL% >> "%OUT%"
```
