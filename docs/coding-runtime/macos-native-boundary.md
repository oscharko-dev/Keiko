# The macOS coding boundary: each statement and its proof

Keiko runs OpenCode on macOS under its own Seatbelt profile (`keiko-native`) in every delivery form
it supports there: the npm package, the npm folder package and the standalone folder. Each form
uses the dev-lane process backend (`macos-app-sandbox`, ADR-0163 D9). This page lists what Keiko
states about that boundary. Each statement names the test that proves it from the shell of a real
run of the pinned runtime, and the positive control that shows the same action succeeds
unconfined. A sentence without a proof is not published; what does not hold is listed under
limits. The proofs run on macOS 15 on Apple silicon, from the runtime a checkout stages; Intel Macs,
other macOS releases and the portable `Keiko.app` are not proven here.

The proofs run in the **macOS native boundary** lane (`.github/workflows/macos-native-boundary.yml`)
on a pull request that touches the boundary, every night, and before every release, where the npm
publish needs it to succeed. The lane runs as a standard account it creates, on a Mac without a
container runtime. A skipped proof fails the lane (`scripts/check-vitest-report-ran.mjs`).

Suites, abbreviated below:

- **Q**: `packages/keiko-server/src/coding-runtime/opencodeNativeQualification.real.test.ts`, the
  pinned runtime under the native profile with Keiko's own policy, in all three modes.
- **D**: `packages/keiko-server/src/coding-runtime/opencodeNativeDelivery.real.test.ts`.
- **F**: `packages/keiko-server/src/coding-runtime/productionOpenCodeBackend.functional.test.ts`,
  the production path through the dev-lane process backend.
- **K**: `packages/keiko-sandbox/src/runtime-gateway.test.ts`, the profile against the real kernel.
- **A**: `packages/keiko-server/src/coding-runtime/productionOpenCodeBackend.acceptance.test.ts`,
  the acceptance task as the same standard account, in the repository-relay job of
  `.github/workflows/coding-workbench-customer-shape.yml`.

## Statements

| Statement                                                                                                                                                                                                                                                                                                                                                | Proof                                                                                                                                                                                                                                                                                                                                                                                                                               | Positive control                                                                                             |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| A shell child writes inside the opened folder and the run's private area only. A write beside the folder or into the account's home is refused in every mode.                                                                                                                                                                                            | Q: "keeps a shell's writes inside the opened folder and its .env files unreadable, in every mode"; Q: "keeps the account's credential files and its home out of a shell's reach in every mode, while the account reads and writes them"                                                                                                                                                                                             | The test process writes beside the folder and into the home.                                                 |
| In an opened repository the shell cannot write the hooks in its `.git` folder, which the person's own Git would run, or the configuration there, which decides what Keiko's Git runs. Ordinary repository work (refs, objects, the index) stays writable.                                                                                                | Q: "keeps what Keiko's own Git runs out of a shell's reach, and ordinary repository work in it"                                                                                                                                                                                                                                                                                                                                     | `git add` and `git init` of a nested repository run in the same folder.                                      |
| `.env` files are unreadable to the shell even inside the opened folder. So are the account's SSH folder, cloud credential folders and Git's stored credentials.                                                                                                                                                                                          | The same two Q tests.                                                                                                                                                                                                                                                                                                                                                                                                               | The test process reads every canary.                                                                         |
| No Keychain item and no item name can be read from the shell, in any mode, even from a keychain file in a folder the shell may read.                                                                                                                                                                                                                     | Q: "keeps a Keychain item out of a shell's reach in every mode, while the account itself reads it"                                                                                                                                                                                                                                                                                                                                  | The test process reads both canary items and lists their names.                                              |
| The shell can neither read nor write the clipboard, in any mode.                                                                                                                                                                                                                                                                                         | Q: "keeps the person's clipboard out of a shell's reach, to read and to write, in every mode"                                                                                                                                                                                                                                                                                                                                       | An ordinary program in the same shell line runs.                                                             |
| In Ask for approval and Supervised workspace, the kernel refuses connections to the internet and to the local network, and name resolution, before any packet is sent. Loopback stays open, and with it this computer's own network addresses.                                                                                                           | Q: "refuses public, local-network and name-resolution connections from a shell below Full access before any traffic, and keeps loopback open"; K: "native profile: unix-socket peers and DNS are denied below Full access"                                                                                                                                                                                                          | At Full access the same connections leave and the name resolves. Loopback connects in every mode.            |
| At Full access the internet is open. Unix sockets of other programs, such as ssh-agent or a container daemon, stay closed.                                                                                                                                                                                                                               | Q: the network test above; K: "native profile: Full access reaches no foreign unix socket, and its own"                                                                                                                                                                                                                                                                                                                             | The run's own socket connects.                                                                               |
| No provider key and no Keiko capability is passed into the environment of a shell child or of the runtime, even when the key sits in a secret-named variable of Keiko's own environment. Keiko's own start environment stays readable, see the limits.                                                                                                   | F: "keeps provider keys planted in secret-named host variables out of the runtime and its shell"; Q: "leaves no launch secret readable in the runtime's exec environment"                                                                                                                                                                                                                                                           | The shell sees an inherited variable (`OPENSSL_CONF`), and the runtime's environment reads back with `PATH`. |
| Keiko refuses `git commit`, `git push` and `gh pr create` typed into the shell in every mode, and points the model to Keiko's governed delivery tools.                                                                                                                                                                                                   | D: "still refuses a shell Git write in the real policy, in every mode, and points the model to the delivery tools"; Q: "records each Git route a shell can take to the history of an opened folder, in every mode"                                                                                                                                                                                                                  | `git status` and `git add` in the same folder run.                                                           |
| A run that changed files and ran no check after its last change keeps its reported outcome and names the gap in the log; a check that failed, did not start or exhausted its budget fails the run (owner decision 2026-11-28).                                                                                                                           | A: every case of "Coding acceptance task on macOS without a container runtime (#4492)", and "never reports success for a failing shell check followed by a refused governed verifier"; F: the held-runtime process test below, whose shell changed a file without a check and settled `verification-not-evidenced` (superseded by the 2026-11-28 owner decision: a shell change with no check now keeps the reported outcome)       | The correct fix of each acceptance case ends `succeeded`.                                                    |
| When a run's runtime ends, no process it started remains, including one that ignores SIGHUP, a double fork, a new session and a file watcher. A run that changed nothing ends its runtime when it settles. One that changed files keeps it for the undo window, until the next run, Stop, takeover, the end of that window, a crash or Keiko's shutdown. | F: "ends what a shell took out of the run's tree when a run that changed nothing settles: SIGHUP ignored, a double fork, a new session and a file watcher"; F: "ends what a shell took out of the run's tree when a held runtime ends with the next run: SIGHUP ignored, a double fork, a new session and a file watcher"; F: the lifecycle tests of "original OpenCode service lifecycle through the production owner (#3899 AC2)" | The four processes run, adopted by launchd, while the runtime lives.                                         |

## Git routes from the shell, per mode

What each Git route a shell can take does to the history of a folder the person opened themself,
with every ask approved as a person would (Q: "records each Git route a shell can take to the
history of an opened folder, in every mode"). A Keiko-managed task worktree keeps its Git directory
read-only to the shell (F, #3902).

| Route                                                | Ask for approval                        | Supervised workspace                    | Full access                             |
| ---------------------------------------------------- | --------------------------------------- | --------------------------------------- | --------------------------------------- |
| `git commit` typed in the shell line                 | refused by Keiko's policy, no commit    | refused by Keiko's policy, no commit    | refused by Keiko's policy, no commit    |
| `git add`                                            | asks; after approval the file is staged | asks; after approval the file is staged | runs without asking; the file is staged |
| A script file that runs `git commit`                 | asks; after approval the commit lands   | asks; after approval the commit lands   | runs without asking; the commit lands   |
| Low-level Git (`commit-tree` and a written ref file) | asks; after approval the commit lands   | asks; after approval the commit lands   | runs without asking; the commit lands   |

## Limits

- **Loopback is open below Full access.** The shell reaches every port a program on this computer
  serves on loopback, a local forwarding proxy included. The computer's own network addresses count
  as loopback, so a program that listens on them is reachable as well. Narrowing loopback to
  Keiko's own ports breaks a project's own checks: a test suite that serves and fetches on an
  ephemeral port, and a dev server a second process calls, are both refused (`EPERM`) under that
  rule. Decision and measurement: ADR-0137 and K "loopback decision: a project's own local servers
  work natively and break under a Keiko-ports-only rule".
- **Full access opens the internet**, so project content can leave the computer. The secret
  statements above hold in every mode.
- **Git in the shell is held back by Keiko's policy, not by the kernel.** The policy reads the
  command text. In an opened folder a script file, a Git alias or low-level Git (`commit-tree` and a
  ref file) still writes local history: after
  approval in Ask for approval and Supervised workspace, without asking at Full access. A managed
  task worktree's Git directory is read-only to the shell (F, #3902). Pushing needs credentials
  and, below Full access, a network the shell does not have. The shell cannot read the account's
  SSH keys, Git's stored credentials or the Keychain (proofs above). A token written into the
  opened repository's own remote URL is readable like any file of the folder, and at Full access
  the shell can push with it.
- **Processes live as long as the runtime.** A settled run that changed files keeps its runtime for
  the undo window (30 minutes, #3904 AC3), and what its shell started keeps running until the
  runtime ends. Keiko ends a run's processes while it runs itself; when its sweep cannot prove that
  none is left, it records that instead of reporting a clean end. No test shows that a detached
  process of a run ends when the Keiko server itself ends abruptly.
- **The preferences service stays reachable.** Foundation tools need macOS's preferences service,
  so the profile leaves it open. Through it (`defaults write`) the shell can change the account's
  app settings outside the folder; no file rule sees that write, because the service writes it.
- **Credential files are refused by name.** The kernel denies the names of the shared list
  (`.ssh`, `.aws`, `.azure`, `.kube`, `.env*`, `.npmrc`, `.netrc` and others) wherever they sit.
  A credential file whose name is not on the list is readable when it lies inside the opened
  folder, for example the gcloud or GitHub CLI credentials under `~/.config` when the home folder
  is opened. Keiko refuses a folder that contains its own runtime, which in the usual setups covers
  the home folder, but not when the runtime lives elsewhere. `.env.example` stays readable.
- **A hook folder inside the project.** When the repository's configuration sets `core.hooksPath`
  to a folder of the project, as husky does, that folder is writable like every project file, and
  the person's next `git commit` runs what a run wrote there.
- **A repository inside the project.** A repository that a run creates in a subfolder, or that
  already lies in one, is the run's own: its `.git` folder, hooks included, is writable, and the
  person's next `git commit` in that subfolder runs what a run wrote there. The protection covers
  the opened repository only.
- **The repository relay reads for the run.** Below Full access Keiko's repository relay reads the
  Maven and npm repositories the person configured, for the run and without an approval for each
  read (ADR-0184 D6).
- **Inbound connections.** No test shows whether a device on the local network can reach a server
  that a run's shell starts.
- **Git comes from the Xcode Command Line Tools.** Keiko runs the Git that `xcrun` finds and
  installs none.
- **Other programs' start environments.** macOS lets any process of an account read the start
  environment of the account's other processes (`KERN_PROCARGS2`), and no Seatbelt rule gates it.
  A secret any program of the same account was started with is therefore readable from the shell,
  Keiko's own included: a provider key given to Keiko as a variable when it starts can be read
  this way (Q: "pins the KERN_PROCARGS2 limit: a run's shell reads another same-user process's
  exec environment, in every mode"; ADR-0137 D10). Keiko keeps its own launch secrets out of the
  runtime's exec environment.
- **The boundary protects the computer and its secrets, not the project's own files.** A bad edit
  is still a bad edit; Git and undo are the remedy.
