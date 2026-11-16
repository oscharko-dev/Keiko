# Jira compatibility metadata before reverting a build

The compatibility observation introduced by #4289 lives in the existing private
`credentials/atlassian-connector-credentials.metadata.json` store. Older builds reject this
additional `livePod.compatibility` key, so reverting executable code alone makes the **whole
credential metadata store unavailable**, including credentials without that observation. The
encrypted tokens have not been lost. Do not delete credentials or recreate Pods to hide this error.

Prefer a forward repair. If reverting to a build from before #4289 is necessary, use the following
offline procedure **from the exact currently installed build's source before installing the older build**. A normal
upgrade does not require this procedure. This is an operator maintenance command, not a remote
API or an automatic application downgrade.

1. Record the currently installed version with `keiko --version`. Obtain a fresh, clean source
   checkout of that exact release tag (`v<version>`) from the Keiko repository. For a development
   installation, use the exact source commit recorded when that build was produced; a shared
   development version number alone cannot identify it. Do not use an arbitrary newer `dev`
   checkout or mix package output from another version: the command must use the installed build's
   metadata validator. This source-checkout procedure also applies to **npm-installed Keiko**;
   the maintenance scripts are not included in the npm package. If the matching source is
   unavailable, retain the current installation and obtain it before attempting this downgrade.
2. Finish or cancel active Jira tasks and let credential replacement/deletion and verification
   settle. Reconcile uncertain Jira effects using the existing mutation recovery flow; never replay
   them as part of this procedure. Stop all Keiko processes using the target configuration. Keep
   them stopped until the migration and code reversion are complete.
3. Make a private backup of the complete configuration directory, including credentials, using the
   installation's existing backup process. The backup stays local; never attach it to an issue or
   support report. In the fresh matching source checkout, run `npm ci` and then
   `npm run build:packages` to build from its committed lockfile with no stale package output.
4. Preview against the **exact configuration file used by that installation**:

   ```sh
   node scripts/downgrade-jira-compatibility.mjs --config /absolute/path/to/keiko.config.json
   ```

   The output contains only affected/changed counts. Preview performs no writes. A pending
   credential operation, invalid store or exhausted revision/generation fails closed; repair it
   with the newer build before proceeding. A missing store also fails; verify the selected
   configuration path rather than creating an empty replacement store.

5. Apply while all Keiko processes remain stopped:

   ```sh
   node scripts/downgrade-jira-compatibility.mjs --config /absolute/path/to/keiko.config.json --server-stopped --apply
   ```

   `--server-stopped` records the operator's assertion; it cannot detect every process on the
   machine. The command removes only compatibility observations, marks affected Pods unverified,
   and advances their credential generations and verification revisions so existing grants and
   approvals cannot survive the downgrade. It preserves Pod/credential identities, tokens, Chat
   associations, target admissions and all other records. It uses the existing validated metadata
   store and atomic private writer. If interrupted between records, rerunning completes the
   remaining records without advancing an already migrated record again.

6. Repeat the preview: affected and changed must both be zero. Install the older build and restart
   Keiko. Verify connections through the ordinary UI under that build's rules. In particular, the
   previous exact **10.3.26** gate returns; a newer Jira release remains unsupported by that build.
   Return to the fixed newer build if its compatibility support is needed.

An older build already refusing the store cannot perform this repair. Stop it and use the newer
checkout's command while it remains stopped. The command never opens the vault, contacts Jira,
or prints paths, identities, stored content or credentials. Its private-store restart, admission
preservation, counter invalidation and repeatability are covered by
[`jira-compatibility-downgrade.test.mjs`](../../scripts/__tests__/jira-compatibility-downgrade.test.mjs).

Release impact: `state-or-compatibility-changes`; rollback remediation: `manual-review-required`.
Normal forward upgrades retain existing Pod identities and need explicit reverification only to
obtain new observations. Release catalog insertion remains deferred until the target release and
release-owner approval reference are assigned.
