# Windows on real hardware: contributor checks (#4358)

The Windows checks of epic #4351 ran in a virtual machine: Windows 11 on ARM64 with the release's
x64 Node under emulation ([Windows cross-test machine](windows-vm-cross-test-machine.md)). That
proves the Windows operating system. It does not prove an Intel or AMD computer, and its timings are
emulated and not representative. This page is what a contributor with such a computer checks, and
what to send back. Statements marked **(unverified)** were not run by the author of this page.

## 1. Get a Jira first

Keiko's Jira Pod needs a Jira Data Center to talk to. The repository carries one as a laboratory
with synthetic data only: [`scripts/testing/jira-chat-lab/README.md`](../../scripts/testing/jira-chat-lab/README.md).
Read its sections "Start an isolated session", "Seed and inspect basic fixtures" and "Connect the
existing local lab"; this page does not repeat them. From a fresh checkout, on the machine that runs
Docker:

```sh
npm install
npm run build:packages
node scripts/testing/jira-chat-lab/session.mjs init  "$HOME/.local/share/keiko-jira-win"
node scripts/testing/jira-chat-lab/session.mjs start "$HOME/.local/share/keiko-jira-win"
node scripts/testing/jira-chat-lab/setup.mjs "$HOME/.local/share/keiko-jira-win" /absolute/private/test-license
node scripts/testing/jira-chat-lab/seed.mjs  "$HOME/.local/share/keiko-jira-win"
```

- **Before `setup.mjs`.** It drives Jira's first-run forms in a headless Chromium through
  Playwright, so that browser must be installed for the checkout (`npx playwright install chromium`
  **(unverified)** as the exact command).
- **License.** `setup.mjs` takes Atlassian's published test license, saved by you in a private file.
  It lasts three hours; plan the checks of section 3 inside one such window and repeat a group that
  outlived it. Never change a clock or license data.
- **Certificate.** `init` creates a private authority and a server certificate that last 365 days;
  a session start renews them when seven days or less remain. After a renewal, copy the new
  `ca.pem` again: with the old one a "certificate not trusted" answer is expected.
- **Where it may run.** The lab publishes loopback ports only (HTTP 18081 and HTTPS 18443 by
  default; `init` accepts others), and its certificate and `Host` guard accept `localhost` and
  `127.0.0.1` alone. Two ways to reach it from the Windows computer:
  - On a second computer (macOS or Linux), reached through an SSH reverse tunnel that keeps the
    loopback origin, as described under "Reaching the lab Jira without any repository change" on the
    machine page. This is the proven way.
  - On the Windows computer itself, under Docker Desktop. **(unverified)**: the lab scripts were
    never run on Windows. The README documents `linux/arm64` image digests for its selectable
    releases; whether the default pin runs on an Intel or AMD Docker host is unchecked.
- **What is secret.** Everything under the session's `secrets/` directory except `secrets/tls/ca.pem`:
  the access tokens (`api-token` and the other `*-token` files), the passwords, the server key and
  the authority's key; also the license file. Copy only `ca.pem` to the Windows computer and type
  the token into Keiko by hand. Never put a token, a pairing address or a password into an issue, a
  log or a screenshot.
- **The token changes.** The lab's tokens expire one day after they were created
  (`seed-identities.mjs`), and a renewal writes new ones. A connection saved with an old token then
  answers "authentication failed"; that is the Jira's answer, not a defect. Connect again with the
  current token.

## 2. Install Keiko

Download `keiko-windows-x64.zip` and its checksum file from the GitHub release under test, compare
the SHA-256, extract, and double-click `Keiko.exe`. On the first start the launcher sets up the
installation under `%LOCALAPPDATA%\Programs\Keiko` and shows **no window** until the browser opens
(in the virtual machine: about 15 minutes; on real hardware unmeasured). Note how long it takes and
whether the browser opened by itself. In the virtual machine the state folder of a start through
`Keiko.exe` was `%USERPROFILE%\.keiko`; a start from a command line uses `.keiko` in its working
directory. To trust the lab's authority, set `KEIKO_CA_BUNDLE_PATH=<path to ca.pem>` for the user
before starting Keiko; certificate verification stays on.

"`keiko <command>`" below means the release's own command line: a portable install puts no `keiko`
command on PATH. From the folder that holds `Keiko.exe` (the extracted folder, or the installed copy
under `%LOCALAPPDATA%\Programs\Keiko`), run
`.\runtime\node\node.exe .\app\dist\cli\index.js <command>`, for example `… status`. This form ran
in the virtual machine for the extracted release (start, stop, status, support export and analyze).

## 3. The checks

Each row is one acceptance criterion of #4358. "VM" says what the virtual machine already showed.

| #   | Do                                                                                                                                                                     | Expect                                                                                                                                   | VM                                                                      |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 1a  | In the Local Knowledge window choose **Create Jira Pod**, enter a name, the lab's HTTPS address and the token, submit.                                                 | The Pod is created and the connection verified in that one step.                                                                         | Shown by script against the same routes, not by a person in the window. |
| 1b  | Stop Keiko (`keiko stop`), start it again, open the Pod.                                                                                                               | The connection works; Keiko never asks for the token again.                                                                              | Shown.                                                                  |
| 1c  | Install an older release first, connect, then install the release under test over it.                                                                                  | The Pod and its connection are still there and work without the token.                                                                   | Not shown.                                                              |
| 2a  | `keiko status`.                                                                                                                                                        | A line "Credential custody: attested (…private to this Windows account)".                                                                | Shown.                                                                  |
| 2b  | Search Keiko's state folder (see section 2), its credential folder and a saved support report for the token text.                                                      | No file holds it.                                                                                                                        | Shown for the folders; the saved report was not searched.               |
| 2c  | Optional, only on a test account: stop Keiko, grant the `Users` group read access to the vault key file, start Keiko.                                                  | Status says the key file was readable by another account and to replace stored tokens; the workspace shows a notice; the access is gone. | Shown except the notice in the window.                                  |
| 3a  | With `KEIKO_CA_BUNDLE_PATH` set, connect the lab Jira.                                                                                                                 | Connected, verification on.                                                                                                              | Shown.                                                                  |
| 3b  | Remove `KEIKO_CA_BUNDLE_PATH`, restart Keiko, open the Pod and verify the connection.                                                                                  | A readable message that the certificate is not trusted, with the remedy; the saved connection is kept.                                   | The closed result (`tls-failed`) was shown; the message was not seen.   |
| 3c  | Enter a wrong token.                                                                                                                                                   | A readable "authentication failed" message.                                                                                              | A wrong token was not entered; seen once with a replaced token.         |
| 4   | Nothing to do on real hardware: the template check is plain text logic and gave identical digests on Windows and macOS, for LF and CRLF.                               |                                                                                                                                          | Shown.                                                                  |
| 5   | Right after 3b: `keiko support export`, then `keiko support analyze <file> --json`. Search the file and the analysis for your Windows user name, a `S-1-5-` and `C:\`. | The analysis succeeds; none of the three appears.                                                                                        | Shown, but the test account was named like the product.                 |
| 6   | `keiko uninstall` **(unverified)**.                                                                                                                                    | The installation is gone. Note what stays in the state folder.                                                                           | Not shown.                                                              |

A journey that lets a model create a Jira issue from the Chat needs a model gateway and is not part
of these checks.

## 4. What to send back

Per row: done or not, the result in one line, and the time where the row names one, with the
processor model, the Windows edition and build, and the release tag. Screenshots of Keiko's own
messages are welcome when they show no token and no address with a secret in it. A support report is
body-free by contract, but it is your file: attach it only if you choose to. Report anything that
differs from "Expect" as a comment on #4358.
