# Windows development UI investigation — 2026-11-16

This record captures functional checks from `dev`
`1906b6a5f28a4ec51fa93a18a3affade7194a126` and the repair branch in PR #4409.
The published 1.5.0 package and native platform qualification have their own lifecycles.

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

The development runtime reports `functional-not-platform-qualified`. A private candidate
using the independently pinned public Windows runtime completed a real GPT-5.4 Workbench run
in 20.6 seconds, with one file read and zero changes. The published-installer and native
qualification requirements remain tracked in [#4404](https://github.com/oscharko-dev/Keiko/issues/4404)
and [#4068](https://github.com/oscharko-dev/Keiko/issues/4068).

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

The follow-up in `d631a64b2` applies the same Windows lookup to the confirmed discovery
consumers and binds the independent bootstrap lookup to the canonical rule with parity
checks. The current Dev snapshot built and started on the Windows VM. In a real Workbench run
Gemma read the one requested file in the same three-file fixture, returned the correct
answer and completed in two model steps.

## Other actual UI checks

- Windows Git opened the tiny repository and showed the expected commit plus its three changed
  files. Fetch against an authenticated fixture reported ahead 0 and behind 1. Pull reported
  ahead 0 and behind 0. Native Git confirmed the new commit and a clean checkout. The fixture's
  credential removal was verified through native target metadata.
- Windows Knowledge indexed two small documents and gave a GPT-5.4 answer with sources. A
  separate isolated app check exercised a genuine stale-cursor refusal. The readable reason and
  recovery action persisted through a browser reload and same-store app restart.
- The real Jira Pod connected to the local lab. One report turn covered three synthetic issues.
  Both files downloaded. The same Chat card downloaded byte-identical Markdown and CSV after a
  normal Windows Dev restart. The recorded interval held two retained exports and zero new
  gateway or report-read calls. The lab issue field digests were identical.
- Published macOS 1.5.0 reproduced the cold LiteLLM Chat creation refusal. The repaired app
  opened the composer without starting another readiness call. Real LiteLLM/Gemma responded.
  A single-model 503 recovered on first Send after the existing cooldown. A definitive 401
  left Send disabled. The Windows Dev control opened Chat and returned a one-word GPT-5.4 answer.
- The exact installed Windows 1.5.0 setup receipt matched the manifest, canonical root and launcher.
  The corrected detector reported its managed install with in-app updating unavailable. Passing
  that receipt to a different copy produced a registration refusal. Nine scoped updater browser
  cases passed with fresh source evidence.

## Repair and acceptance queue

| Issue                                                      | Current implementation and acceptance                                                    |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| [#4400](https://github.com/oscharko-dev/Keiko/issues/4400) | Bound receipt and release navigation verified. Native Updates view remains to check.     |
| [#4401](https://github.com/oscharko-dev/Keiko/issues/4401) | Initial Jira repair pushed. Follow-up claim and context regressions are being reviewed.  |
| [#4402](https://github.com/oscharko-dev/Keiko/issues/4402) | Actual Windows report and both downloads verified. Language coverage follow-up pending.  |
| [#4403](https://github.com/oscharko-dev/Keiko/issues/4403) | Watch acknowledgements and competing Editor loads repaired. Live recovery check pending. |
| [#4404](https://github.com/oscharko-dev/Keiko/issues/4404) | Private Windows candidate read succeeded. Native qualification and verifier remain open. |
| [#4405](https://github.com/oscharko-dev/Keiko/issues/4405) | Closed after the real stale-cursor and restart journey.                                  |
| [#4406](https://github.com/oscharko-dev/Keiko/issues/4406) | Closed after a real full-filename link and targeted path and prose controls.             |
| [#4407](https://github.com/oscharko-dev/Keiko/issues/4407) | macOS launcher re-pair verified. Windows empty-selection journey remains open.           |
| [#4408](https://github.com/oscharko-dev/Keiko/issues/4408) | Closed after the copied-environment repair and real Windows Workbench controls.          |
| [#4410](https://github.com/oscharko-dev/Keiko/issues/4410) | Confirmed spawn class repaired. The report omits the original flagged paths.             |
| [#4411](https://github.com/oscharko-dev/Keiko/issues/4411) | Closed after Windows History, Fetch/Pull, and the scoped discovery refusal review.       |
| [#4412](https://github.com/oscharko-dev/Keiko/issues/4412) | Closed after Windows before/after with the same absent runtime.                          |
| [#4413](https://github.com/oscharko-dev/Keiko/issues/4413) | Closed after the Windows Workbench showed Not run and zero executed tests.               |
| [#4414](https://github.com/oscharko-dev/Keiko/issues/4414) | Closed after actual Fetch/Pull and native state readback.                                |
| [#4415](https://github.com/oscharko-dev/Keiko/issues/4415) | Closed after macOS cold-start repair and Windows control.                                |
| [#4416](https://github.com/oscharko-dev/Keiko/issues/4416) | Tiled layout blocked Send in a real browser. Focused geometry correction in progress.    |
| [#4390](https://github.com/oscharko-dev/Keiko/issues/4390) | Report retention verified on Windows. The other criteria are tracked in the task.        |

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
