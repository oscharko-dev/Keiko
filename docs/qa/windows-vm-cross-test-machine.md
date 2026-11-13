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
6. Install the two Node builds, then take the `clean-updated` snapshot of the stopped machine, and
   write the expiry date and reminder date into the issue. The snapshot comes before any Keiko
   release or browser policy, so it matches the restore note in step 8 of the build procedure.
7. Fetch and verify the Keiko release and run the start proofs.

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
if [ -n "$(git -C "$WT" status --porcelain --untracked-files=no)" ]; then
  echo "refusing to build: $WT has modified tracked files; commit, stash or reset them first" >&2
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
if [ -n "$(git -C "$CO" status --porcelain --untracked-files=no)" ]; then
  echo "refusing to build: $CO has modified tracked files; commit, stash or reset them first" >&2
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

```bash
#!/bin/bash
# Reboot the guest, then repeat update passes until none are left. Reboots whenever a pass asks.
SSH="ssh -i <ssh-private-key> -p 2222 -o BatchMode=yes -o ConnectTimeout=10 keiko@127.0.0.1"
waitssh() { for i in $(seq 1 120); do $SSH hostname >/dev/null 2>&1 && return 0; sleep 10; done; return 1; }
reboot_guest() { $SSH 'shutdown /r /t 5' >/dev/null 2>&1; sleep 90; waitssh || exit 1; sleep 120; }
reboot_guest
for pass in $(seq 1 10); do
  $SSH 'Remove-Item C:\ProgramData\keiko-setup\update-result.txt -ErrorAction SilentlyContinue; schtasks /run /tn KeikoUpdate' >/dev/null 2>&1
  r=""
  for i in $(seq 1 300); do
    r=$($SSH 'if (Test-Path C:\ProgramData\keiko-setup\update-result.txt) { Get-Content C:\ProgramData\keiko-setup\update-result.txt }' 2>/dev/null)
    [ -n "$r" ] && break; sleep 10
  done
  echo "pass $pass: $r"; $SSH 'Get-Content C:\ProgramData\keiko-setup\update.log -Tail 4' 2>&1 | cut -c1-180
  case "$r" in
    none) echo "NO UPDATES LEFT"; exit 0;;
    error|"") echo "ERROR"; exit 2;;
    *reboot=True*) reboot_guest;;
  esac
done
```
