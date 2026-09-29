# Complete chat recovery inventory — #3674

The v1.1.12 release included the merged gateway admission repairs, but omitted the uncommitted Composer and conversation-continuity work. This change recovers that complete work on current `dev`. No release or deployment is part of this delivery.

The original checkout remains unchanged. All 108 changed and untracked paths were captured in signed commit `9dc5868be677ff0af6d95a71b1e3739030ed58ba` before integration. Current reviewed gateway implementations take precedence over older overlapping patches. This inventory accounts for every original path. Local verification is recorded below; required exact-head CI and review settlement remain merge prerequisites.

## Acceptance and verification

- Recover Markdown editing, reversible formatting, local Monaco highlighting, clipboard input, and wheel scrolling.
- Keep the model dropdown and context popover visible within the viewport. Search appears from ten options; unsupported attachment controls are hidden.
- Use branding green below 80%, warning at 80%, critical at 90%, automatic compaction and manual maintenance with token savings.
- Preserve whole-day continuity, corrections, stable source references, edits/deletions, model switches, and repeated compaction through the existing components.
- Verify Azure and LiteLLM with actual short and long German prompts, not only adapter fixtures.
- Permit a large current prompt to use available input capacity by adapting output allocation; qualify semantic compaction of oversized current prompts without losing the persisted original.
- Diagnose the reported all-model customer context rejection. The supplied screenshots show the generic error; the customer installation state is unavailable. Local real v1.1.12 requests currently succeed for GPT-5.4, Mistral-Large-3, and GPT-OSS-120B both with empty history and twelve-message history. This is a limitation of reproduction, not a customer resolution claim.
- Run local applicable gates and required current-head CI, address every review conversation, and merge only after verified green checks. Do not publish a new release.

## Audit follow-up

Failure-first regressions reproduced and repaired a private-use Unicode caret-marker collision, truncated supplementary-plane letters in history recall, and unregistered checkpoint metadata being copied into evidence. The Composer cursor now selects a collision-free marker; history lookup preserves complete Unicode code points; checkpoint validation rejects unknown fields, and persistence copies only registered metadata. Additional schema tests cover invalid identities, revisions and window limits. The CodeQL trailing-argument finding is also repaired. Local failing and passing outputs are retained; review resolution awaits the published repair reference. Fourteen HTTP-boundary tests exercise persisted manual compaction, unchanged source messages, wrong-project/model validation, CSRF rejection, and cancellation/listener cleanup behind a real predecessor. The initial required new-code coverage result was 84.55%; the added schema and route regressions exercise those observed gaps; coverage on the repaired current head still requires measurement.

Normal buffered, streamed and regenerated answers no longer inherit an explicit output cap from the input-accounting reserve. An explicit output limit is applied only when a large current prompt actually reduces that reserve, and the allocation keeps a usable answer floor or falls back to optional context-lane reduction. A smaller request window now receives a bounded projection of its summary without overwriting the canonical checkpoint. Additional old turns are folded before projection trimming; omitted categories are counted in the registered Activity Log. Checkpoint token cost is recounted from the production gateway rendering after model enrichment and when loading legacy checkpoints. Failed or timed-out refreshes retain a valid previous summary and its coverage boundary. Regeneration and grounded recall query the original user task rather than the semantic-preparation preamble. Grounded checkpoints carry their actual bounded continuity window, pre-admission message count and measured start time. Provider-boundary rejections settle legacy admitted rows, and context-read, preparation, summary-discard and browser failures keep their originating correlation and structured body-free evidence. Failure-first tests cover these review repairs.

The exact workflow OSV scanner reproduced two high-severity fast-uri findings and one medium-severity jsdom undici finding. Only the relevant overrides and lock entries are updated to fast-uri 3.1.7 and undici 8.10.2. The scanner passes the repaired lockfile without policy exceptions. A separate current npm audit reports zero known vulnerabilities across 1,025 resolved dependencies; both documented generic and provider secret-scanning queries return zero open alerts. Scoped registry signatures were verified; the full-tree attestation check remains limited by the existing upstream whatwg-url attestation 404. The native clipboard gesture remains directly in the Chat journey; the shared editor performance ruler is byte-identical to reviewed dev again. Its committed evidence is therefore retained unchanged. Lock-bound tool-catalog reference evidence was regenerated with the pinned Linux ARM64 reference producer. Production-bundle evidence was regenerated from signed recovery head `3535cac38` with pinned Node 24.18.0 on Linux ARM64; its release-evidence and editor-size checks pass. These measurements do not replace current-head required CI.

## Complete review audit — 2026-09-29

All 43 review findings have implementations or documented retained behavior. Thirty conversations still await the pushed repair references and substantive resolution. The original 108-path manifest was checked again: no path is missing from this inventory, and the original checkout hashes are unchanged.

The latest repair batch includes literal clipboard and external drafts, visible inert link/image destinations, reversible headings and undo isolation, nested code-block exits, native keyboard focus, separate routine diagnostics, correlated continuity capture and recall, referent queries for every retrieval consumer, bounded history work, Coding History isolation, manual-compaction failure diagnostics and emitted outcome proofs. Buffered and streamed pre-answer preparation now settle legacy rows for all failures and cancellation, including final gateway assembly failures. The actual selected model determines snapshot capacity; a dropped optional lane restores the original answer allocation when the complete winning prompt fits.

Current local results: 649 focused server tests passed before the final assembly-stage extension; the latest five-file regression run passes 180 tests including those assembly failures. The style-governance and Composer run passes 31 tests after removing the global focus-selector exception. Generated logging evidence resolves all 490 failure-surface proofs and 29 scenarios with zero violations. The updater's eight browser journeys regenerated its source-bound evidence successfully. Complete coverage, current browser/voice checks, actual-model qualification, local Sonar and required exact-head CI are still running or pending; these targeted results are not a full green claim.

## Verified behavior and limits

All five real Chromium journeys in `tests/e2e/chat-send.smoke.spec.ts` pass: a persisted chat send; six Backspaces removing an empty heading; local Monaco highlighting with native system-clipboard paste and wheel scrolling; overlay containment in a short viewport; and twelve-model scrolling/filtering with unsupported attachment controls hidden. Clipboard input uses the actual operating-system paste chord rather than a Monaco command or a fabricated paste event.

The UI coverage run for the first audit repair batch passes 478 files and 8,851 tests, with one existing skipped test (90.45% statements, 83.22% branches, 92.02% functions, 93.27% lines). Five real Composer browser journeys pass separately in Chromium, Firefox and WebKit, including native clipboard input and code wheel scrolling. The shared Composer Monaco adapter has 100% coverage across all four metrics in lifecycle tests. Production assembly and editor bundle checks pass on pinned Linux Node 24.18.0; the first-load editor/Monaco byte budget remains zero. The complete Activity Log inventory passes all seven checks. The context and preparation review batch passes 295 focused tests, and its subsequent refactors pass 208 focused tests. Earlier full-package coverage passed 2,176 files and 45,985 tests; a subsequent complete run exposed the E2E prerequisite-build and modifier-derivation findings, both reproduced and repaired locally. The script run likewise exposed modifier derivation and requires a complete rerun. These earlier complete runs do not prove the later source changes. Required current-head CI and complete repaired-head coverage remain prerequisites for integration. No full-matrix or customer-resolution claim is made.

The [body-free actual-model qualification report](chat-context-model-qualification-3674.json) records five large-current-prompt tests and nine repeated-compaction/model-switch tests. Large prompts contain 106,557 German characters; all source characters are processed in ordered, individually admitted requests. The final answers preserve corrected amounts/deadlines, exact identifiers and JSON output on GPT-5.4, Mistral-Large-3 and GPT-OSS-120B through LiteLLM, and GPT-5.4/Mistral-Large-3 directly through Azure. The repeated-history matrix tests configured 4,096/16,384/4,096-token admission windows, persistent checkpoints and later corrections across three rounds. These are configured Keiko admission windows; the underlying deployed model can have a larger physical window.

Qualification exposed real defects before repair: an overly short foreground timeout, descriptive summaries being treated as another summarization task, loss of an exact identifier, duplicate follow-ups displacing a historical correction, and later output-field matches clipping a corrected amount out of a pasted-text excerpt. Follow-up rehydration now retains short correction paragraphs and uses original Unicode offsets, avoiding lowercase-expansion index drift. The final execution projection now retains bounded, redacted original opening/closing fragments alongside the semantic summary. It counts that complete projection before admission, preserves Unicode boundaries and keeps the canonical original unchanged. Regression tests fail before the corresponding fixes. The literal fragments are bounded hints, not a guarantee that arbitrary semantic compression is lossless.

Real Qwen qualification remains unavailable; Qwen aliases and admission geometries have synthetic regression coverage. The supplied customer screenshots and available local logs do not identify the cause of the reported all-model rejection. Available local v1.1.12 and recovery requests succeed, so this task does not claim that customer incident has been resolved. Provider throttling and bounded preparation timeouts still surface explicitly. No release, version change or deployment is authorized.

## Future update impact

This is release-impacting UI/context work with additive SQLite chat-history revision metadata. The future release should describe Markdown/code composition, context visibility/manual compaction, usable model selection and long-conversation/current-prompt continuity. Migration tests preserve existing chat messages and revision invalidation. No manual data conversion is required; the future installed version needs the normal restart. No target version is approved for this feature PR, so insertion into the append-only release-impact catalog belongs to the separately authorized release cut. Published v1.1.12 metadata remains unchanged.

## Original path disposition

| Original path                                                                            | Integration disposition                                                             |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `docs/adr/ADR-0042-keiko-editor-package-and-boundaries.md`                               | Recovered original work                                                             |
| `docs/observability/failure-surface-inventory.generated.json`                            | Integrated original work with reviewed dev implementation                           |
| `docs/observability/op-catalog.generated.json`                                           | Integrated original work with reviewed dev implementation                           |
| `docs/release/1209-bundle-evidence.json`                                                 | Recovered original work                                                             |
| `docs/release/2296-dependency-security-closeout.md`                                      | Recovered original work                                                             |
| `package-lock.json`                                                                      | Integrated original work with reviewed dev implementation                           |
| `packages/keiko-contracts/src/activity-log-failure-class-contracts.ts`                   | Integrated original work with reviewed dev implementation                           |
| `packages/keiko-contracts/src/activity-log-registry.generated.ts`                        | Integrated original work with reviewed dev implementation                           |
| `packages/keiko-contracts/src/bff-wire.ts`                                               | Recovered original work                                                             |
| `packages/keiko-contracts/src/context-engineering-compaction-validation.ts`              | Recovered original work                                                             |
| `packages/keiko-contracts/src/context-engineering.ts`                                    | Recovered original work                                                             |
| `packages/keiko-evidence/src/compaction-evidence.ts`                                     | Recovered original work                                                             |
| `packages/keiko-model-gateway/src/gateway-prompt-admission.test.ts`                      | Retained reviewed dev implementation; overlapping original patch superseded         |
| `packages/keiko-model-gateway/src/gateway-prompt-admission.ts`                           | Retained reviewed dev implementation; overlapping original patch superseded         |
| `packages/keiko-model-gateway/src/gateway.admission-regressions.test.ts`                 | Retained reviewed dev implementation; overlapping original patch superseded         |
| `packages/keiko-model-gateway/src/gateway.logging.test.ts`                               | Already present on dev; original snapshot and recovered head are identical          |
| `packages/keiko-model-gateway/src/gateway.test.ts`                                       | Retained reviewed dev implementation; overlapping original patch superseded         |
| `packages/keiko-model-gateway/src/gateway.tool-schema-repair.test.ts`                    | Retained reviewed dev implementation; overlapping original patch superseded         |
| `packages/keiko-model-gateway/src/gateway.ts`                                            | Retained reviewed dev implementation; overlapping original patch superseded         |
| `packages/keiko-model-gateway/src/observability.ts`                                      | Already present on dev; original snapshot and recovered head are identical          |
| `packages/keiko-model-gateway/src/prompt-admission.test.ts`                              | Retained reviewed dev implementation; overlapping original patch superseded         |
| `packages/keiko-model-gateway/src/prompt-admission.ts`                                   | Retained reviewed dev implementation; overlapping original patch superseded         |
| `packages/keiko-model-gateway/src/prompt-token-accounting.test.ts`                       | Retained reviewed dev implementation; overlapping original patch superseded         |
| `packages/keiko-model-gateway/src/prompt-token-accounting.ts`                            | Retained reviewed dev implementation; overlapping original patch superseded         |
| `packages/keiko-model-gateway/src/provider-token-counter.test.ts`                        | Retained reviewed dev implementation; overlapping original patch superseded         |
| `packages/keiko-model-gateway/src/provider-token-counter.ts`                             | Retained reviewed dev implementation; overlapping original patch superseded         |
| `packages/keiko-model-gateway/src/toolCatalogBridge.ts`                                  | Already present on dev; original snapshot and recovered head are identical          |
| `packages/keiko-server/src/chat-compaction-evidence.test.ts`                             | Recovered original work                                                             |
| `packages/keiko-server/src/chat-compaction-evidence.ts`                                  | Retained reviewed dev implementation; obsolete recovered alias removed during audit |
| `packages/keiko-server/src/chat-compaction-model-summary.ts`                             | Recovered original work                                                             |
| `packages/keiko-server/src/chat-compaction-resurfacing.ts`                               | Recovered original work                                                             |
| `packages/keiko-server/src/chat-context-log.ts`                                          | Recovered original work                                                             |
| `packages/keiko-server/src/chat-context-status.test.ts`                                  | Recovered original work                                                             |
| `packages/keiko-server/src/chat-context-status.ts`                                       | Recovered original work                                                             |
| `packages/keiko-server/src/chat-gateway-assembly.test.ts`                                | Integrated original work with reviewed dev implementation                           |
| `packages/keiko-server/src/chat-handlers.ts`                                             | Integrated original work with reviewed dev implementation                           |
| `packages/keiko-server/src/chat-history-rehydration.ts`                                  | Recovered original work                                                             |
| `packages/keiko-server/src/chat-history-snapshot.test.ts`                                | Integrated original work with reviewed dev implementation                           |
| `packages/keiko-server/src/chat-history-snapshot.ts`                                     | Recovered original work                                                             |
| `packages/keiko-server/src/chat-prompt-budget-diagnostics.ts`                            | Recovered original work                                                             |
| `packages/keiko-server/src/chat-prompt-budget-token-summary.ts`                          | Retained reviewed dev implementation; overlapping original patch superseded         |
| `packages/keiko-server/src/chat-prompt-budget.ts`                                        | Integrated original work with reviewed dev implementation                           |
| `packages/keiko-server/src/conversation-compaction.test.ts`                              | Integrated original work with reviewed dev implementation                           |
| `packages/keiko-server/src/conversation-compaction.ts`                                   | Integrated original work with reviewed dev implementation                           |
| `packages/keiko-server/src/conversation-gateway.ts`                                      | Integrated original work with reviewed dev implementation                           |
| `packages/keiko-server/src/conversation-structured-compaction.test.ts`                   | Recovered original work                                                             |
| `packages/keiko-server/src/gateway-discovery-log.ts`                                     | Already present on dev; original snapshot and recovered head are identical          |
| `packages/keiko-server/src/gateway-setup.test.ts`                                        | Retained reviewed dev implementation; overlapping original patch superseded         |
| `packages/keiko-server/src/gateway-setup.ts`                                             | Retained reviewed dev implementation; overlapping original patch superseded         |
| `packages/keiko-server/src/gitDelivery/commitDraftQuality.test.ts`                       | Already present on dev; original snapshot and recovered head are identical          |
| `packages/keiko-server/src/gitDelivery/commitDraftQuality.ts`                            | Already present on dev; original snapshot and recovered head are identical          |
| `packages/keiko-server/src/grounded-conversation-continuity.ts`                          | Integrated original work with reviewed dev implementation                           |
| `packages/keiko-server/src/grounded-qa-hybrid.ts`                                        | Recovered original work                                                             |
| `packages/keiko-server/src/grounded-qa-multi-source.ts`                                  | Recovered original work                                                             |
| `packages/keiko-server/src/grounded-qa.ts`                                               | Recovered original work                                                             |
| `packages/keiko-server/src/process-log-sink.test.ts`                                     | Retained reviewed dev implementation; overlapping original patch superseded         |
| `packages/keiko-server/src/process-log-sink.ts`                                          | Already present on dev; original snapshot and recovered head are identical          |
| `packages/keiko-server/src/routes.ts`                                                    | Recovered original work                                                             |
| `packages/keiko-server/src/store-handlers.ts`                                            | Recovered original work                                                             |
| `packages/keiko-server/src/store/db.ts`                                                  | Recovered original work                                                             |
| `packages/keiko-server/src/store/messages.ts`                                            | Recovered original work                                                             |
| `packages/keiko-server/src/store/schema.ts`                                              | Recovered original work                                                             |
| `packages/keiko-server/src/store/types.ts`                                               | Recovered original work                                                             |
| `packages/keiko-ui/eslint-suppressions.json`                                             | Recovered original work                                                             |
| `packages/keiko-ui/package.json`                                                         | Integrated original work with reviewed dev implementation                           |
| `packages/keiko-ui/src/app/components/desktop/AttachmentIntake.test.tsx`                 | Recovered original work                                                             |
| `packages/keiko-ui/src/app/components/desktop/AttachmentStrip.tsx`                       | Recovered original work                                                             |
| `packages/keiko-ui/src/app/components/desktop/ChatContextMeter.module.css`               | Recovered original work                                                             |
| `packages/keiko-ui/src/app/components/desktop/ChatContextMeter.test.tsx`                 | Recovered original work                                                             |
| `packages/keiko-ui/src/app/components/desktop/ChatContextMeter.tsx`                      | Recovered original work                                                             |
| `packages/keiko-ui/src/app/components/desktop/ChatContextMeterContainer.tsx`             | Recovered original work                                                             |
| `packages/keiko-ui/src/app/components/desktop/ChatWindow.test.tsx`                       | Recovered original work                                                             |
| `packages/keiko-ui/src/app/components/desktop/ChatWindow.tsx`                            | Recovered original work                                                             |
| `packages/keiko-ui/src/app/components/desktop/ComposerEmptyState.test.tsx`               | Recovered original work                                                             |
| `packages/keiko-ui/src/app/components/desktop/KeikoSelect.module.css`                    | Recovered original work                                                             |
| `packages/keiko-ui/src/app/components/desktop/KeikoSelect.test.tsx`                      | Recovered original work                                                             |
| `packages/keiko-ui/src/app/components/desktop/KeikoSelect.tsx`                           | Recovered original work                                                             |
| `packages/keiko-ui/src/app/components/desktop/composer/ComposerShell.tsx`                | Recovered original work                                                             |
| `packages/keiko-ui/src/app/components/desktop/composer/MarkdownComposer.module.css`      | Recovered original work                                                             |
| `packages/keiko-ui/src/app/components/desktop/composer/MarkdownComposer.test.tsx`        | Recovered original work                                                             |
| `packages/keiko-ui/src/app/components/desktop/composer/MarkdownComposer.tsx`             | Recovered original work                                                             |
| `packages/keiko-ui/src/app/components/desktop/composer/composer-code-runtime.ts`         | Recovered original work                                                             |
| `packages/keiko-ui/src/app/components/desktop/composer/composer-code-view.test.ts`       | Recovered original work                                                             |
| `packages/keiko-ui/src/app/components/desktop/composer/composer-code-view.ts`            | Recovered original work                                                             |
| `packages/keiko-ui/src/app/components/desktop/composer/composer-editor-controller.ts`    | Recovered original work                                                             |
| `packages/keiko-ui/src/app/components/desktop/composer/composer-editor-state.ts`         | Recovered original work                                                             |
| `packages/keiko-ui/src/app/components/desktop/composer/composer-editor-types.ts`         | Recovered original work                                                             |
| `packages/keiko-ui/src/app/components/desktop/composer/composer-format-commands.ts`      | Recovered original work                                                             |
| `packages/keiko-ui/src/app/components/desktop/composer/composer-input-rules.ts`          | Recovered original work                                                             |
| `packages/keiko-ui/src/app/components/desktop/composer/composer-markdown.test.ts`        | Recovered original work                                                             |
| `packages/keiko-ui/src/app/components/desktop/composer/composer-markdown.ts`             | Recovered original work                                                             |
| `packages/keiko-ui/src/app/components/desktop/hooks/useWorkspace.ts`                     | Integrated original work with reviewed dev implementation                           |
| `packages/keiko-ui/src/app/components/desktop/hooks/useWorkspace.wheel.test.tsx`         | Integrated original work with reviewed dev implementation                           |
| `packages/keiko-ui/src/app/components/desktop/useContextDisclosure.ts`                   | Recovered original work                                                             |
| `packages/keiko-ui/src/app/components/desktop/viewport-overlay.test.ts`                  | Recovered original work                                                             |
| `packages/keiko-ui/src/app/components/desktop/viewport-overlay.ts`                       | Recovered original work                                                             |
| `packages/keiko-ui/src/app/components/desktop/widgets/cards/editorMonacoRuntime.test.ts` | Recovered original work                                                             |
| `packages/keiko-ui/src/app/components/desktop/widgets/cards/editorMonacoRuntime.ts`      | Recovered original work                                                             |
| `packages/keiko-ui/src/lib/api.ts`                                                       | Recovered original work                                                             |
| `packages/keiko-ui/src/lib/i18n-messages.de.ts`                                          | Recovered original work                                                             |
| `packages/keiko-ui/src/lib/i18n-messages.en.ts`                                          | Recovered original work                                                             |
| `packages/keiko-ui/vitest.setup.ts`                                                      | Recovered original work                                                             |
| `packages/keiko-workflows/src/context-budget/index.ts`                                   | Recovered original work                                                             |
| `packages/keiko-workflows/src/context-budget/rehydration.ts`                             | Recovered original work                                                             |
| `packages/keiko-workflows/src/context-budget/structured-digest.test.ts`                  | Recovered original work                                                             |
| `packages/keiko-workflows/src/context-budget/structured-digest.ts`                       | Recovered original work                                                             |
| `scripts/lib/activity-log-failure-surfaces.mjs`                                          | Recovered original work                                                             |
| `tests/activity-log-scenarios/model-gateway.test.ts`                                     | Already present on dev; original snapshot and recovered head are identical          |
