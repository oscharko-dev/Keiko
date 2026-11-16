# Windows development UI investigation — 2026-11-16

This is an ongoing functional investigation from `dev`
`1906b6a5f28a4ec51fa93a18a3affade7194a126`, following the published 1.5.0 UI campaign.
It is not a release qualification or a completed acceptance report.

## Environment and setup actually exercised

- Windows 11 ARM64 VM, with the supported Node 26.13.1 **x64 process** under Windows emulation.
  This does not qualify native Intel/AMD hardware.
- Eight virtual CPUs and 16 GiB RAM; about 9–10 GiB guest RAM remained free during setup.
- A complete checkout and separate development state on the Windows system volume.
  The installed 1.5.0 application's state was retained.
- Visual Studio 2022 Build Tools with the x64/x86 C++ component, verified through the signed
  Microsoft installer; Node's archive matched the upstream SHA-256 manifest.
- npm installed 1,006 packages. USearch and ripgrep provisioning, the package/root build, and
  native development-runtime staging completed. An npm update notice caused the initial
  PowerShell wrapper to report failure after installation; the subsequent build completed.
- The existing `gateway-service install --dev-lane` path completed through its UAC prompt.
  The service reports ready. No pin, confinement rule, or qualification flag was relaxed.
- The trusted development launcher serves the actual Windows Edge UI. **Connect browser**
  established the browser session. Azure/GPT-5.4 configuration was tested and saved through
  the UI with credentials entered separately from the import file.

The runtime remains `functional-not-platform-qualified`. This setup does not resolve the
published-installer finding [#4404](https://github.com/oscharko-dev/Keiko/issues/4404), whose
existing implementation owner is [#4068](https://github.com/oscharko-dev/Keiko/issues/4068).

## Coding Workbench: reproduced failure and verified progress

The small synthetic repository contains only `package.json`, `sum.js`, and `sum.test.js`, with
two intentionally failing addition tests. Git's real UI opens it on `main` and reports a clean
tree. Its local `core.autocrlf` setting is false.

Selecting that repository in Coding Workbench offered **New local worktree**, GPT-5.4, and
**Ask for approval**. The runtime and model were available, but workspace preparation failed:
the UI asks the person to choose a branch in Git, and Start remains disabled. Retrying reproduces
the refusal. The Activity Log records a successful Git status read followed by HTTP 500 from
`POST /api/task-workspaces`, with `GitWorktreeSpawnError` at the existing worktree adapter's
repository-root probe. The copied Windows environment exposed `Path`, while the adapter read
`PATH` case-sensitively. The worktree repair is in `e83bf57ef` and `ebee3eb3b` (#4408);
the pure environment helper subsequently moved to the contracts leaf in `5b39ff2a5`.

With that repair deployed, the actual UI created a task worktree, started GPT-5.4 through the
native gateway, and proposed the one-line addition repair. The task file changed only after
the UI approval; the original repository remained unchanged.

Product-managed verification was denied before a test process started because this VM has no
enforcing execution-root backend. The original UI/model projection described it as a failed
test. The #4413 repair (`3bac860b9`) preserves the denial while reporting **Not run**. A new
real UI run approved exactly one verifier invocation, displayed that outcome, and received an
honest model response of zero executed tests, without retries. The Activity Log records zero
passed, zero failed and one denied verifier step. No passing verification or commit proof is
claimed. Native Windows execution qualification remains separate from this functional VM check.

Review subsequently identified additional consumers of copied Windows environment values.
#4408 is reopened until those consumers and bootstrap-helper parity are repaired and checked.
The worktree success does not qualify every Windows executable probe.

## Other actual Windows UI checks

- Git #4411: a clean, synthetic two-commit repository fetched through the actual Git UI and
  installed Windows Credential Manager in 0.9 seconds. The expected remote ref advanced and
  local HEAD stayed unchanged. A separate native product-runner fetch also passed. The fixture
  credential's removal was verified through Windows credential-target metadata without reading
  credential blobs. The temporary repository and test tasks were removed.
- That successful fetch exposed #4414: the next action correctly becomes **Pull**, but the
  outcome suffix shows the old `behind 0` rather than the observed `behind 1`.
- The incremental review also found that unavailable credential discovery can be mistaken for
  successful remote execution. That #4411 negative path remains under repair; a successful
  credential-manager happy path alone is insufficient acceptance.
- Knowledge Pods: created one pod and connected two synthetic Markdown documents totaling
  fewer than 250 bytes. Indexing completed with two documents, two embedded chunks, and no
  failures or skips. Connected the pod to a new Chat through the real workspace controls.
- The first GPT-5.4 answer returned the fixture's project name and review day. Its evidence
  warning and file-opening behavior still require inspection; this is not yet complete Chat
  or Knowledge refusal-recovery acceptance.

## Repair and acceptance queue

| Issue                                                      | Current implementation / remaining acceptance                                                                                                   |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| [#4400](https://github.com/oscharko-dev/Keiko/issues/4400) | Legacy Windows updater receipt presentation committed; private candidate UI check pending.                                                      |
| [#4401](https://github.com/oscharko-dev/Keiko/issues/4401) | Jira approval-claim correction implemented and independently reviewed; commit and UI check pending.                                             |
| [#4402](https://github.com/oscharko-dev/Keiko/issues/4402) | Jira download-result correction implemented and independently reviewed; commit and UI check pending.                                            |
| [#4403](https://github.com/oscharko-dev/Keiko/issues/4403) | Editor snapshot acknowledgement committed; review found ordinary events must also retain a pending recovery warning.                            |
| [#4404](https://github.com/oscharko-dev/Keiko/issues/4404) | Additive, signed-public-artifact runtime admission implemented and independently reviewed; isolated candidate and native/UI acceptance pending. |
| [#4405](https://github.com/oscharko-dev/Keiko/issues/4405) | Closed Knowledge refusal presentation committed; review vocabulary/copy refinements and UI recovery check pending.                              |
| [#4406](https://github.com/oscharko-dev/Keiko/issues/4406) | Spaced filename repair committed; review found canonical separator/case and ordinary dash-prose regressions to repair.                          |
| [#4407](https://github.com/oscharko-dev/Keiko/issues/4407) | Expired Skills connection recovery committed; real reconnection acceptance pending.                                                             |
| [#4408](https://github.com/oscharko-dev/Keiko/issues/4408) | Actual worktree repair verified; reopened for other affected copied-environment consumers.                                                      |
| [#4410](https://github.com/oscharko-dev/Keiko/issues/4410) | Contributor report analyzed; worktree and public-runtime repairs require combined acceptance.                                                   |
| [#4411](https://github.com/oscharko-dev/Keiko/issues/4411) | Host credential reuse committed and real UI fetch verified; discovery-refusal review finding remains open.                                      |
| [#4412](https://github.com/oscharko-dev/Keiko/issues/4412) | Platform-appropriate readiness copy committed; actual refusal view still to qualify.                                                            |
| [#4413](https://github.com/oscharko-dev/Keiko/issues/4413) | Not-run verification repair tested, critically reviewed and verified in the Windows UI; issue closed, PR unmerged.                              |
| [#4414](https://github.com/oscharko-dev/Keiko/issues/4414) | Newly confirmed stale Git sync outcome counts; repair assigned.                                                                                 |
| [#4390](https://github.com/oscharko-dev/Keiko/issues/4390) | Related completed Jira export retention across restart implemented; independent review and UI restart check pending.                            |

Targeted tests and a first review do not close subsequent review findings. The remaining
independent PR conversations are tracked alongside this table. Reports distinguish a rejected
operation from an executed effect and a model claim from an actual approval card or download.

Continue with Coding, Knowledge Pods, Chat, Jira Pod, and Git, including cancellation, retry,
reload, and restart. Use Azure/GPT-5.4 first and then LiteLLM/Gemma. Model tests use only small
synthetic fixtures; the Keiko checkout is for implementation and deterministic checks. The
owner's Azure allowance is at most USD 75. Existing spend accounting must not be reset.

Publish small reviewable increments with a current PR description and auto-merge disabled.
During implementation run only affected checks; complete the final applicable coverage, test,
and gate requirements after the whole implementation. Under the owner's explicit follow-up,
close a finding once its complete implementation, tests and critical review are evidenced;
state clearly that its PR is still unmerged and that published 1.5.0 does not yet contain the
repair. Reopen when a later confirmed finding leaves that scope incomplete. Epics also require
all acceptance criteria. Release 1.5.0 is already published; another release is outside this
investigation. PR #4409 is regular, targets `dev`, and has auto-merge disabled.
