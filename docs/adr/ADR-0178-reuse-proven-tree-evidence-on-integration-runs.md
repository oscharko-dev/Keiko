# ADR-0178: Reuse proven tree evidence on integration runs

## Status

Accepted (owner decision, 2026-09-20).

## Amends

- [ADR-0135](ADR-0135-deterministic-dev-delivery-and-keiko-for-quality.md): the required matrix that
  proves an accepted change is measured once, on the pull-request head. The integration run on `dev`
  re-establishes that verdict from the pull-request run's evidence when — and only when — the
  integration commit's tree is byte-identical to the head that evidence binds.

## Context

Every merge into `dev` ran the complete required matrix a second time. Measured over the 100 most
recent `dev` push runs of `ci.yml` before this decision:

| Measurement | Value |
| ----------- | ----- |
| Total wall-clock time spent on `dev` push runs | 4,898 minutes (81.6 hours) |
| Mean duration of one `dev` push run | 48 minutes |
| `dev` push runs that concluded `failure` | 15 of 100 |
| `dev` commits whose tree an already-green pull-request run had proven | 100 of 100 |

The second measurement cannot produce evidence the first did not, and the reason is structural
rather than statistical. `dev` is protected with linear history and signed squash merges, and branch
protection only integrates a head that is up to date with its base. The squash commit therefore
carries a new commit sha and the *identical tree sha* as the pull-request head the matrix already
measured. A tree sha is the recursive content hash of the whole worktree — every source file, the
lockfile, and every workflow file under `.github/`. Two commits that share one cannot differ in a
single byte that a gate could read. This was verified against the five most recent merges at the
time of the decision (#3561, #3557, #3559, #3554, #3555): five of five carried a tree identical to
their pull-request head.

What the repetition did produce was false red. The 15 failures name no defect class that the
pull-request run could have missed; they are per-job infrastructure flake, re-rolled against a tree
already proven. Run 35496443122 is the representative case: `Cross-platform smoke (macos-latest)`
died after 3 minutes in a V8 heap check (`Check failed: !IsFreelistEntry()`, exit 133) — an engine
abort on a hosted runner, measured at 1 failure in 60 on that leg. The run kept going for a further
37 minutes before the aggregate reported red. Roughly 1% of per-job flake across the ~18 jobs a run
starts predicts ~15% of runs going red, which is what the ledger shows.

A red `dev` check is indistinguishable from a real defect until a human reads the log, so the
repetition did not add safety — it consumed 81.6 hours to manufacture a 15% chance of a false alarm
against code that was already proven.

## Decision

### D1 — A tree that a pull-request run proved green is not re-measured

An integration run (`push` to a protected integration branch, or `merge_group`) resolves, before any
gate starts, whether this commit's tree is already bound to complete green evidence. When it is, the
jobs whose verdict that evidence carries do not run: `semantic-duplication`, `core-quality`,
`coverage-packages`, `coverage-ui`, `coverage-scripts`, `coverage-sonar`, `build-scan-sbom-smoke`,
`cross-platform-smoke`, `node-26-compatibility`, and `ui`.

`protected-branch-gate`, `secret-scan`, `change-scope`, and the resolver itself always run: they cost
under two minutes in total and they judge the integration commit's own identity and history rather
than its content.

### D2 — Reuse requires a complete, unambiguous evidence chain

`scripts/resolve-verified-tree-evidence.mjs` answers `true` only when every one of these holds:

1. the event is `push` or `merge_group` — a pull request never reuses anything;
2. a merged pull request exists whose `merge_commit_sha` is exactly this commit, which excludes a
   pull request that merely contains it;
3. that pull request's head tree sha equals this commit's tree sha;
4. a completed `pull_request` run of the same workflow on that head concluded `success`;
5. that run *executed* every job D1 skips — a candidate that skipped one is not evidence, which
   forecloses a chain in which one reuse authorizes the next.

### D3 — Every uncertainty runs the full matrix

Absent evidence, a malformed payload, an unreadable field, an API error, a missing environment
variable, or any unhandled condition resolves to `false`, and the complete matrix runs. The resolver
has exactly one success path and treats everything else as unproven.

### D4 — The aggregate still fails closed

The `ci` aggregate verifies the resolver's own job succeeded, that a reuse claim carries a complete
evidence identity (run id and tree sha), and that no gate *ran and failed* on this run. Reuse
accepts only the `skipped` state D1's guard produces; a gate that executed and failed still fails
the aggregate. The non-reuse verdict is unchanged, including the documentation-only skip for the
cross-platform matrix and the editor fast-path skip for the packaging job.

### D5 — Changing CI forces a full run by construction

Workflow files live inside the tree, so any edit to `ci.yml`, to the resolver, or to any script a
gate invokes changes the tree sha and forecloses reuse for that commit. This decision cannot outlive
the evidence it cites, and needs no expiry, allowlist, or manual invalidation.

## Consequences

- An integration run of an already-proven tree completes in about two minutes instead of 48, and
  cannot be turned red by infrastructure flake against code that is already proven.
- The pull-request run is unchanged and remains the complete arbiter. The quality bar is untouched:
  the same gates decide, once, on the bytes they actually judge.
- SonarCloud's `dev` branch analysis and the packaging job's attestations are not re-emitted for an
  identical tree. The pull-request run's analysis binds the same bytes, and both remain reachable on
  demand via `workflow_dispatch`, which never reuses evidence. The `dev` Banking Grade verification
  already ran only under `workflow_dispatch` before this decision.
- `scripts/__tests__/verified-tree-evidence-reuse.test.mjs` pins both halves: that every job in D1
  carries the guard and can resolve it, and that the aggregate's fail-closed verdicts in D4 hold.
