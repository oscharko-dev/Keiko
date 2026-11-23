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
many entries carry it and what the start did: `start-refused`, `started-coding-run-failed` or
`started-coding-run-succeeded`. An extracted copy without a mark observes nothing and fails the
job.

After the forms, `scripts/testing/standard-account-footprint.mjs` walks the whole writable data
volume (`/System/Volumes/Data`) as root and lists every entry changed after a marker the job wrote
before the account acted. It ignores the account's home and the per-user folder macOS assigns it
under `/var/folders` (its temporary and cache folders). An entry counts against the promise when
the account owns it, or when it is a regular file the account may write. The job fails on one,
even when a program of another account changed that file: the check errs towards failing.

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
