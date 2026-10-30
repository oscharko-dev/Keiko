# Keiko #3914 handoff — addendum: everything now on origin

Prepared 30 October 2026, after `HANDOFF.md`. Read `HANDOFF.md` first; this addendum only adds
where the work now lives so a session on another machine (or in the cloud) can continue it.
Nothing below changes scope, authority, qualification state or any finding.

## What changed

The work that existed only on this Mac was pushed to `origin` with the operator's explicit
permission. No pull request was opened or updated, nothing was pushed to `dev`, nothing was
force-pushed, and PR #4013 still points at `557932c54df23cafbac73faf3c2922185463ddcd`.

| Branch on origin | Head | What it is |
| --- | --- | --- |
| `codex/3918-private-dev-sync-20261029` | `6dfe5f2bf7ffdd41b676d6c338166b66421cd5ea` | The current private checkpoint `HANDOFF.md` continues from (signed, clean). Pushed unchanged: same commits, same HEAD. Continue here. |
| `codex/3918-memory-record-admission` | `611ff0f67` | Previously **staged but uncommitted** Memory record admission candidate from the `anti-slop-memory` worktree (10 files, +610 −68, last edited 2026-10-16): `keiko-memory-vault` `serialize.ts` and tests, contracts/server Memory tests, `scripts/code-quality-policy.json`, policy/wiring tests, QA docs, an activity-log scenario. Committed as-is as a signed `wip` commit. **Not verified, reviewed or qualified.** Based on `8e0340275`, which predates the dev sync — it must be reconciled before use. Not mentioned in `HANDOFF.md`. |
| `codex/3918-perf-harness-investigation` | `c8c3f0957` | Previously **uncommitted** edit to `scripts/coding-runtime-performance-harness.mjs` (+69 −25, last edited 2026-10-29) from the `3918-perf-dev-control` worktree, based on dev `246efd46`. Most likely the investigation behind open native performance finding005. Signed `wip`; not reviewed or measured; no ceiling changed. |
| `codex/3918-stash-raw-marker-20261023` | `f30fd3101` | Archive of `stash@{0}` ("raw-marker verified candidate before independent fixture-cleanup repair", 11 files). Probably superseded by later commits; not verified. Stash commits are unsigned. |
| `codex/3918-stash-physical-candidate-20261022` | `fb6fbb1cd` | Archive of `stash@{1}` ("keiko3918 physical candidate awaiting scripts coverage and final proofs", 5 files). Same caveats. |
| `codex/requesty-model-catalog` | `7f12af1f7` | Previously **uncommitted** Requesty multi-provider catalog work from `/Users/niko/Documents/ChatGPT/Keiko 2` (15 files, last edited 2026-10-10). **Unrelated to #3914.** Signed `wip`; not verified. |

Unchanged and already on origin: `codex/epic-anti-slop-quality` (`8c710e08`, the immutable
comparison), `codex/epic-dev-sync-3914` (`aacd23426`), `codex/issue-3918-boundary-responsibilities`
(`557932c5`, PR #4013), `fix/4009-tool-argument-redaction` (`4f6ce804`). Remote `dev` was
`e153759e` at this addendum, as `HANDOFF.md` records; it is still not integrated.

## What still exists only on this Mac

A remote session can read the plan, but it cannot run any `HANDOFF.md` restart step as written,
because these are path-bound and were not moved:

- The 14 GB scratch tree `S` = `/tmp/keiko-3914-intake/osv-security-repair-557932c-20261023` and
  the rest of `/tmp/keiko-3914-intake/` (qualification tooling, Source proposals, `capture.py`).
  `/tmp` is not durable.
- This handoff bundle's `Evidence/` (169 MB, 477 files, indexed in `EVIDENCE-INDEX.json`).
- The pinned toolchain `/Users/niko/.local/share/keiko-toolchains/node-v24.18.0-darwin-arm64`.
- Commit signing (SSH key through the local agent) and the operator-approved performance
  reference machine (this 18-core/64 GiB Mac).

A remote agent therefore needs its own pinned Node 24.18.0 toolchain and signing, and must
re-derive any qualification request from the current signed HEAD instead of reusing `3597`.
Qualification, native performance and duplication evidence measured on another machine is not
comparable with the recorded Mac reference and must say so.

## Local worktrees (unchanged except for the commits above)

- `/Users/niko/.codex/worktrees/anti-slop-policy/Keiko 2` — on the private branch, clean, now tracking origin.
- `/Users/niko/.codex/worktrees/anti-slop-memory/Keiko 2` — on the Memory branch, clean after the wip commit.
- `/Users/niko/.codex/worktrees/3918-perf-dev-control/Keiko 2` — moved from detached HEAD onto the new perf branch, clean.
- `/Users/niko/Documents/ChatGPT/Keiko 2` — on `codex/requesty-model-catalog`, clean. `HANDOFF.md`'s rule still applies: do not operate on it for #3914.
- The local stashes were left in place; the archive branches are copies.
