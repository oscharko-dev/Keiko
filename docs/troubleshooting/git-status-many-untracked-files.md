# Open a repository with many untracked files

| Field             | Value                                                                                                                   |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Severity          | High                                                                                                                    |
| Surface           | Local UI / Workspace                                                                                                    |
| Stable identifier | `git.status.bounded` (activity log, informational); "The selected checkout could not be opened." (releases up to 1.5.3) |

**Symptom**

A folder that is a Git repository cannot be used although Git itself works in it. On Keiko 1.5.3 and
earlier the Coding Workbench shows "The selected checkout could not be opened. Choose a branch in
Git, then try again.", and the Git window shows "Could not load the repository status." and "Could
not read the sync state.". The folder usually contains a large untracked tree, most often a
`node_modules` directory (10,000 to 20,000 files) that its `.gitignore` does not exclude.

**Root Cause**

`git status --untracked-files=all` lists every untracked file. Keiko reads that listing through a
byte-capped process runner (512 KiB for the status and summary reads, 128 KiB for the fetch/pull
preview). A tree with tens of thousands of untracked files exceeds the cap, the runner stops Git
and the run ends with a signal instead of exit status 0. Releases up to 1.5.3 treated that stop as
a failed status, so the repository looked unavailable.

From the release that contains this repair, a status the byte cap itself ended is a bounded,
truncated answer: the branch, upstream, ahead and behind counts and the complete change records
that fit are shown, the response reports `truncated: true`, and the repository is no longer called
clean. A cut that lands inside a record is discarded; a rename or copy whose second record was cut
off is dropped whole. A timeout, a cancelled request, a refused Git option, Git error output and an
exit status Git chose itself remain failures.

**Diagnostic Steps**

Count what Git would list, from the repository root:

```bash
git status --porcelain=v1 --untracked-files=all | wc -l
```

A number in the tens of thousands confirms the cause. Then read the activity log for the request
(see [Observability](../observability/README.md)):

```bash
keiko support query --correlation-id <id> --json
```

- A `git.status.bounded` line (`surface`, `shownRecordCount`, `partialRecordDropped`, `maxBytes`)
  means the cap cut the status and Keiko answered with the bounded view; the repository is usable.
- A `git.process.failed` line for the `status` subcommand with `errorKind` `output-truncated` on a
  1.5.3 or earlier release confirms this entry. Any other `errorKind` (`unsafe-repository`,
  `timeout`, `git-missing`) belongs to a different cause.

**Resolution**

1. Update to the release that contains this repair. The repository then opens and the Git window
   shows the bounded status with a truncation notice.
2. Keep dependency and build output out of the status. Add it to the repository's `.gitignore`:

   ```gitignore
   node_modules/
   dist/
   build/
   ```

   Files that are already tracked are not affected by `.gitignore`; remove them from the index
   with `git rm -r --cached node_modules` and commit the removal if they were added by mistake.

3. Do not raise the byte caps or disable the truncation to make a large untracked tree list in
   full; the cap protects the local server and the bounded view is the intended behaviour.
