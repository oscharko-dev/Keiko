# Private Chat Skills repair: agent handoff

Handoff requested by the repository owner on 2026-10-15. This document records the
expanded follow-up to PR #4029 / Epic #4022 in PR #4035. It is not a release or an
all-acceptance-criteria qualification. Continue on `codex/fix-private-skill-upload`;
the PR targets `dev`, is not a draft, and must keep auto-merge disabled. Integration
and publication are not authorized.

## Release continuation: 2026-10-15

The owner has now requested version 1.2.3, conditional on completed qualification. The repairs
from this branch are included in the combined release candidate in PR #4033. Auto-merge remains
disabled. Earlier statements below that integration/publication is unauthorized describe the
handoff checkpoint; the new owner request authorizes the protected release path after acceptance
and all required checks/review settlement. It does not waive incomplete acceptance.

A fresh visible-browser authoring run used pasted source, generated and reviewed the draft,
changed its title, explicitly saved without activation, downloaded byte-identical Markdown,
deleted this disposable test skill, reimported that download with the native picker and explicitly
selected it. Immediate reload before the draft debounce exposed a lost unsaved edit; the release
repair adds page-hide flush and bounded keepalive transport while retaining the existing warning
and revision checks. The actual browser repair retest remains required.

## Latest checkpoint: 2026-10-15, resumed qualification

Both defects identified at the earlier handoff are now repaired and pushed:

- Deleted immutable selections are checked during shared turn admission. Actual two-tab deletion
  now returns `SKILL_SELECTION_CHANGED` (409), shows the unavailable selection, and preserves the
  draft. Plain and grounded admission regression tests verify refusal before provider dispatch.
  The retained browser-run closure contains corrupt historical lines, so that closure cannot prove
  a complete zero-dispatch count; do not present the unit assertion as complete browser evidence.
- History rehydration selects complementary relevant sections within the existing budget instead
  of losing an earlier rule to the last query-term hit. The actual 8k-model compaction repair run
  preserved missing/null, invalid/non-finite values, inclusive 20/80 boundaries, and unresolved
  calibration ownership/interval. The original failed answer remains recorded separately.
- Review fixes reject invalid closing Markdown fences and unsupported empty source references.
  The final sort implementation remains compatible with the package's TypeScript library target.

Code head `f8ad827be` passed the complete local `test:coverage:quality` chain (all 27 package
floors and 73 governed file floors), root typecheck, full lint, architecture positive/negative,
Activity Log/error-observability checks, and the local Sonar analyzer. Required CI is separate;
check its exact current head before integration. No integration or publication is authorized.

The combined local runtime also contains voice PR #4033. An actual In-App Browser microphone
recording reached local LiteLLM and Whisper, returned HTTP 200, retained the selected skill,
and populated the editable Chat draft. The owner requested a subsequent simpler one-control
waveform design; its implementation and final UI qualification belong to PR #4033. Additional
room audio in a long capture means this observation is not a perfect-transcription claim.

The semantic campaign has **19/48 answers captured**, including retained failures, plus a
separate successful compaction repair retest. Three independently assessed authoring generations
are complete. This is not an all-acceptance-criteria release qualification.

## Implemented repair

- Refresh private skill selection and library reads when the existing launcher
  session is redeemed, including pending-read races. Never replay a mutation.
  Upload and generated-skill save require an authoritative successful library read.
- Persist unsent Chat text in the existing authenticated private UiStore, with
  revision compare-and-swap and explicit concurrent-edit resolution. Schema 44 adds
  `chat_drafts`; empty saved drafts retain revision tombstones. Chat deletion cascades
  to its draft. Bodies do not enter browser persistence, lists, or Activity Log.
- Protect pending drafts during Chat close and the asynchronous connection-unbind
  interval. Retain transient attachments through the existing close/unload guard.
- Recover the unchanged local draft after a canonically proven failed/cancelled or
  absent send. Do not restore successful, running, or ambiguous turns, overwrite
  later edits, or automatically replay a send.
- Preserve keyboard focus when Preview loads and Select becomes Active, including
  Escape returning to the Skills trigger.
- Require generated skills to cite the actual admitted source sections and line
  ranges. Missing, invented, or altered references reject the generated draft;
  validation does not rewrite the model output or certify its interpretation.
- Defer QI host preparation through existing dynamic component boundaries so the
  expanded Chat implementation stays within the unchanged initial bundle budget.
- Fit synchronized maximized windows to the receiving tab's viewport, preserving
  restore geometry and avoiding synchronization echo. The visible failure was a
  tall tab's maximized Chat hiding the composer in a shorter tab.

Existing owner/authentication boundaries, skill revision binding, prompt budgeting,
Activity Log, private database, and UI runtime hooks remain the owning mechanisms.
The storage and prompt-enhancer ADRs, contributor guidance, and generated inventories
are updated with the implementation.

## Genuine visible-browser observations

The current campaign used the Codex In-App Browser, the normal application launcher,
native file selection, the installed local LiteLLM gateway, and real Gemma 4 31B.
These observations are distinct from automated browser fixtures and unit tests.

- Plain Markdown without frontmatter uploads, previews, explicitly selects, and
  affects a real response. Initial unpaired access was reproduced separately.
- Unicode/CRLF normalization and exported bytes, duplicate imports, distinct bodies
  with identical names, explicit replacement, pinned old revisions, deletion cancel,
  and unavailable selected revisions were exercised.
- Empty, oversized, NUL, and invalid UTF-8 files were rejected. Script markup,
  unsafe links, and remote-image syntax remained inert in preview.
- Manual compaction retained the selected skill contribution while conversation
  tokens decreased. Subsequent reload retained selection and history.
- A private Unicode draft survived reload and an actual server restart. Two real
  tabs exposed a concurrent-edit conflict; both explicit conflict resolutions were
  exercised without silent replacement.
- The repaired Preview/Select/Active sequence retained keyboard focus; Escape
  returned to Skills, and keyboard removal worked. German dark and light dialogs
  were inspected. The full compact-layout qualification still needs completion.
- Three fresh authoring outputs after the reference fix passed independent semantic
  inspection against the complete synthetic source. Earlier invalid-reference outputs
  remain recorded as failures. Source-file and pasted-text overflows were rejected
  without a truncated-success claim. Saving was explicit and did not activate a skill.
- One selected and one no-skill generated test file were copied unchanged from Chat,
  typechecked, and executed: the correct app passed 21/21 and 6/6 tests respectively;
  an independent `<20` to `<=20` mutant failed two and one assertions respectively.
- A real 8,192-token Gemma route triggered automatic history compaction through two
  actual user turns. The protected skill contribution remained 813 estimated tokens;
  3,595 tokens were saved across one summarized message. No messages were inserted
  by an API to manufacture this checkpoint.

### Retained semantic observations

The original `automatic-compaction-selected-1` answer classified `null` incorrectly. The repaired
production path was retested through the actual UI and answered correctly; retain both artifacts.
The repair retest is not an additional independent repetition in the 48-answer campaign.

All six generated-test answers were executed unchanged against the independent application:
selected runs passed 21/21, 15/15, and 20/20; controls passed 6/6 and 7/7, while control 2 failed
one of three tests because it accumulated multiple rendered status nodes. Boundary mutation
failed 2, 1, 2, 1, and 1 assertions in the five passing baseline suites respectively. Selected run 2
also lacks a meaningful component text assertion despite a passing logic assertion. Preserve these
semantic weaknesses; passing execution alone does not certify useful generated test coverage.

The earlier failed prompt-compaction timeout and its explicit successful retry remain separate.
The final real-browser interruption/recovery journey still needs qualification.

## Remaining acceptance work

Use the current issue text, not the closed checkboxes from yesterday. Epic #4022 has
children #4023, #4024, #4026, #4027, #4028, and follow-up #4034. Issue #4025 was explicitly
excluded by the owner and belongs to #3897. Merge authorization is a separate boundary.

1. Build the final committed tree and repeat the native upload/select/send path,
   normal launcher same-document recovery, and restart/export round trip. Preserve
   the dialog and draft; no recovery may replay an upload or other mutation.
2. Verify the latest draft recovery, immediate close during pending save/unbind, and
   two differently sized tabs after the viewport fix. Repeat long-preview keyboard
   scrolling/focus trapping and EN/DE, light/dark, ordinary/compact layouts.
3. Exercise skill-specific stale tabs: replace/delete in tab B while A holds an old
   selection, then stale selection mutation/send. Verify explicit unavailable state,
   no implicit no-skill send, and isolation between different chats. Draft CAS alone
   does not qualify immutable skill-selection races.
4. Complete the repaired authoring round trip from file and pasted text through
   generation, review/edit, explicit save, download, deletion, native reimport, and
   explicit selection. Include unavailable-model/rejected-output/cancel behavior and
   a benign untrusted instruction attempting publication or provider changes.
5. Preserve the failed automatic-compaction answer and the successful repair retest, then finish the remaining
   selected and matched no-skill semantic repetitions. The declared campaign contains
   six core and two grounded scenarios, each with three selected runs and three
   controls: **19/48 answers captured**, with failures retained; this is not 19 passes.
   Three separately evaluated authoring generations are complete. Setup replies do
   not count as qualification answers.
6. Import a valid but mandatory-budget-exceeding skill, select the real smaller-context
   route, and verify actionable refusal, retained chip/draft, and zero physical provider
   dispatch. Pair visible states with canonical body-free internal evidence.
7. Exercise actual single-folder, multi-folder, hybrid, and Knowledge grounding where
   supported, including manual/automatic compaction and truthful source citations.
   Regenerate an old turn after changing the future-turn selection and verify its
   original binding. Include streaming cancellation and explicit retry.
8. All six captured core generated-test answers have been executed; preserve their outcomes above.
   Execute any further generated-test answers unchanged against both the correct
   independent app and its boundary mutant. Inspect meaning and actual assertions;
   a compilation/infrastructure error is not mutation detection.
9. Finish current-head local gates and required CI/review settlement. Review the
   migration, changed-code coverage, generated inventories, and staged public evidence.
   Do not infer release readiness from historical checks or from this handoff.

## Evidence and continuation

The local private audit workspace is named `keiko-skill-upload-audit` under the host's
temporary directory. Its files include:

- `acceptance-matrix.md`: exact acceptance criteria and declared journeys.
- `acceptance-audit-independent-current.md`: independent AC-to-evidence assessment.
- `in-app-phase3-observations.json`: latest keyboard, restart, and automatic-compaction
  observations, supplementing the earlier observation files.
- `in-app-runs/ledger.json`, `usage-ledger.json`, semantic-review files, and unchanged
  answer/test-execution artifacts. Keep failed and successful attempts together.
- `internal-acceptance/acceptance-witnesses.json` and
  `internal-acceptance/private-draft-final-audit.json`: deterministic internal evidence.
- `phase2-*` and `webkit-*` logs: actual local commands and outcomes. The PR handoff
  comment records the final gate snapshot; earlier failing logs are not erased.

These private local files are not a portable public artifact. The committed document
and PR describe their conclusions without publishing credentials, customer material,
raw endpoint/configuration data, or private prompt archives. The synthetic source and
reproducible scenario definitions live in `scripts/testing/chat-skills-lab/`.

The active isolated browser instance was launched normally on loopback port 1996.
Its local state directory is named `.keiko-skills-launcher-audit` under the host user's
home. The runtime used Node 24.18.0 and npm 11.16; use the repository-supported runtime
for reproducible build/bundle evidence. Do not print launcher pairing tokens or copy
gateway credentials into evidence.

## Related dictation delivery

PR #4033, branch `codex/fix-litellm-dictation`, contains the separate Whisper/LiteLLM
dictation repair and was already committed and pushed. Its head at handoff preparation
was `09ed2c488`, with required CI green and auto-merge disabled. Browser recordings are
normalized to mono 16 kHz PCM16 WAV before the existing transcription endpoint.

The final combined skills-plus-dictation build and actual In-App Browser microphone
journey remain to be exercised. Existing local browser/audio fixture qualification
does not replace that requested human-facing combined run. Keep both PRs unmerged
and do not publish a release without the owner's authorization.
