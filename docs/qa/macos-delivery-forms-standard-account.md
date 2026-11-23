# macOS delivery forms without administrator rights

Record of [#4520](https://github.com/oscharko-dev/Keiko/issues/4520), part of Milestone 0 of
[epic #4491](https://github.com/oscharko-dev/Keiko/issues/4491). It shows, for each delivery form
the promise names, that a person without administrator rights gets Keiko onto a Mac, starts it
and completes a coding run, and what the operating system's download mark does on each way a
package reaches that person.

The forms are the npm package (with a Node.js the person unpacked in their own folder), the
[npm folder package](../release/standalone-npm-package.md) and the
[standalone folder package](../release/standalone-folder-package.md). The portable `Keiko.app` is
not one of them: its setup copies Keiko to `/Applications`, which needs an administrator.

## How it is proven

The job **macOS delivery forms as a standard account** in
`.github/workflows/npm-folder-qualify.yml` runs on a hosted macOS runner for a published version,
on a pull request that changes the qualification, on demand, and in the publication of the npm
folder packages (`npm-folder-publish.yml` calls this workflow). It creates the standard account
`keikoqa` (`.github/actions/macos-standard-account`), which is not in the `admin` group and may not
use `sudo`, and runs `scripts/testing/qualify-macos-standard-account-forms.mjs` as that account.

For each form, from an empty state (no `~/.keiko`, `~/.keiko-standalone` or
`~/Library/Application Support/Keiko`):

| Form               | Install                                                                                                                                  | Start and stop                                                        |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| npm package        | The Node.js commands of [README.md](../../README.md#on-a-mac-without-administrator-rights), executed line by line, then `npm install -g` | `keiko start --no-open`, `keiko stop`                                 |
| npm folder package | Built from the release's portable archive with the repository's builder, extracted with `ditto`                                          | `Start Keiko.command`; its first start runs `npm ci --ignore-scripts` |
| Standalone folder  | The release asset `keiko-<target>.standalone.zip`, checked against its `.sha256`, extracted with `ditto`                                 | `Start Keiko.command`, `Stop Keiko.command`                           |

Each form then passes, in order: the first start, health reporting the version, one coding run
that settles `succeeded` (the model is the customer-shape LiteLLM twin on loopback), a second
start that reports the running instance, stop, no process of the form left, and no entry of the
form's folder carrying the download mark. A form whose checks stop before the coding run does not
pass.

Then a copy of the standalone archive gets the mark a browser writes (`com.apple.quarantine`) and
is extracted with `ditto`, which carries the mark to every extracted file. The record names how
many entries carry it, whether Gatekeeper assesses programs on that Mac (`spctl --status`), and
what the start did: `start-refused`, `started-coding-run-failed` or `started-coding-run-succeeded`.
An extracted copy without a mark observes nothing and fails the job. A hosted macOS image turns
Gatekeeper off, so there the mark changes nothing and the outcome says nothing about a Mac where
Gatekeeper is on; a pinned outcome (`--expect-marked`) holds only where it is on.

After the forms, `scripts/testing/standard-account-footprint.mjs` walks the whole writable data
volume (`/System/Volumes/Data`) as root and lists every entry changed after a marker the job wrote
before the account acted. It ignores the account's home and the per-user folder macOS assigns it
under `/var/folders` (its temporary and cache folders). An entry counts against the promise when
the account owns it: the account created or replaced it, and the job fails. Two kinds of change
are listed in full but not attributed:

- An entry the account owns in a folder below `/private/var` that macOS's own services name after
  the account's GeneratedUID or uid (trustd's trust cache, sfanalytics, mds messages). Like
  `/var/folders`, the system assigns that folder to the account; no program the account runs
  chooses it.
- A regular file of another account that the account may also write. A change to it cannot be told
  apart from that account's own change, and on a hosted runner the runner account works through
  the whole job. A program the account runs that wrote outside its areas would create a file there,
  and that file would be owned by the account.

## Record

To be filled from the job's run on the pull request.

## What this does not prove

- **The desktop session.** The account acts without a desktop session or a terminal, so a step
  that asked for an administrator would fail, not wait. A dialog that only a desktop session
  shows, such as Finder's approval of a marked program, is not exercised: the standard-user proof
  comes only from the hosted runner (owner decision 2026-11-23).
- **The login keychain.** The account has no login session, so Keiko runs with
  `KEIKO_OS_KEYCHAIN=off`; the keychain lies in the account's home in any case.
- **An internal file share.** A copy taken from a share carries no mark; the job stands in for it
  with a copy that carries none, written by the download and the builder.
- **Folders root cannot read, and other volumes.** A folder that even root cannot read (protected
  by the system's privacy controls) is counted, not walked; a standard account cannot write there
  either. The walk stays on the data volume, so an external disk or a mounted share is not
  examined.
- **Intel Macs.** The job runs on Apple silicon (`macos-15`).
- **Changes to files other accounts also write.** The footprint walk lists them; it cannot tell
  whether the account or their owner changed one. It proves that the account created nothing
  outside its areas.
- **The marked download where Gatekeeper is on, as a standard account.** The hosted image has
  Gatekeeper off. The observation with Gatekeeper on comes from a Mac where an administrator ran the
  same qualification (`--account any`): macOS held the folder's Node.js before it ran.
