# Complete chat recovery inventory — #3674

The v1.1.12 release included the merged gateway admission repairs, but omitted the uncommitted Composer and conversation-continuity work. This change recovers that complete work on current `dev`. No release or deployment is part of this delivery.

The original checkout remains unchanged. All 108 changed and untracked paths were captured in signed commit `9dc5868be677ff0af6d95a71b1e3739030ed58ba` before integration. Current reviewed gateway implementations take precedence over older overlapping patches. This inventory accounts for every original path; it does not claim that every gate has passed.

## Acceptance and verification

- Recover Markdown editing, reversible formatting, local Monaco highlighting, clipboard input, and wheel scrolling.
- Keep the model dropdown and context popover visible within the viewport. Search appears from ten options; unsupported attachment controls are hidden.
- Use branding green below 80%, warning at 80%, critical at 90%, automatic compaction and manual maintenance with token savings.
- Preserve whole-day continuity, corrections, stable source references, edits/deletions, model switches, and repeated compaction through the existing components.
- Verify Azure and LiteLLM with actual short and long German prompts, not only adapter fixtures.
- Permit a large current prompt to use available input capacity by adapting output allocation; qualify semantic compaction of oversized current prompts without losing the persisted original.
- Diagnose the reported all-model customer context rejection. The supplied screenshots show the generic error; the customer installation state is unavailable. Local real v1.1.12 requests currently succeed for GPT-5.4, Mistral-Large-3, and GPT-OSS-120B both with empty history and twelve-message history. This is a limitation of reproduction, not a customer resolution claim.
- Run local applicable gates and required current-head CI, address every review conversation, and merge only after verified green checks. Do not publish a new release.

## Original path disposition

| Original path                                                                            | Integration disposition                                                     |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `docs/adr/ADR-0042-keiko-editor-package-and-boundaries.md`                               | Recovered original work                                                     |
| `docs/observability/failure-surface-inventory.generated.json`                            | Integrated original work with reviewed dev implementation                   |
| `docs/observability/op-catalog.generated.json`                                           | Integrated original work with reviewed dev implementation                   |
| `docs/release/1209-bundle-evidence.json`                                                 | Recovered original work                                                     |
| `docs/release/2296-dependency-security-closeout.md`                                      | Recovered original work                                                     |
| `package-lock.json`                                                                      | Integrated original work with reviewed dev implementation                   |
| `packages/keiko-contracts/src/activity-log-failure-class-contracts.ts`                   | Integrated original work with reviewed dev implementation                   |
| `packages/keiko-contracts/src/activity-log-registry.generated.ts`                        | Integrated original work with reviewed dev implementation                   |
| `packages/keiko-contracts/src/bff-wire.ts`                                               | Recovered original work                                                     |
| `packages/keiko-contracts/src/context-engineering-compaction-validation.ts`              | Recovered original work                                                     |
| `packages/keiko-contracts/src/context-engineering.ts`                                    | Recovered original work                                                     |
| `packages/keiko-evidence/src/compaction-evidence.ts`                                     | Recovered original work                                                     |
| `packages/keiko-model-gateway/src/gateway-prompt-admission.test.ts`                      | Retained reviewed dev implementation; overlapping original patch superseded |
| `packages/keiko-model-gateway/src/gateway-prompt-admission.ts`                           | Retained reviewed dev implementation; overlapping original patch superseded |
| `packages/keiko-model-gateway/src/gateway.admission-regressions.test.ts`                 | Retained reviewed dev implementation; overlapping original patch superseded |
| `packages/keiko-model-gateway/src/gateway.logging.test.ts`                               | Recovered original work                                                     |
| `packages/keiko-model-gateway/src/gateway.test.ts`                                       | Retained reviewed dev implementation; overlapping original patch superseded |
| `packages/keiko-model-gateway/src/gateway.tool-schema-repair.test.ts`                    | Retained reviewed dev implementation; overlapping original patch superseded |
| `packages/keiko-model-gateway/src/gateway.ts`                                            | Retained reviewed dev implementation; overlapping original patch superseded |
| `packages/keiko-model-gateway/src/observability.ts`                                      | Recovered original work                                                     |
| `packages/keiko-model-gateway/src/prompt-admission.test.ts`                              | Retained reviewed dev implementation; overlapping original patch superseded |
| `packages/keiko-model-gateway/src/prompt-admission.ts`                                   | Retained reviewed dev implementation; overlapping original patch superseded |
| `packages/keiko-model-gateway/src/prompt-token-accounting.test.ts`                       | Retained reviewed dev implementation; overlapping original patch superseded |
| `packages/keiko-model-gateway/src/prompt-token-accounting.ts`                            | Retained reviewed dev implementation; overlapping original patch superseded |
| `packages/keiko-model-gateway/src/provider-token-counter.test.ts`                        | Retained reviewed dev implementation; overlapping original patch superseded |
| `packages/keiko-model-gateway/src/provider-token-counter.ts`                             | Retained reviewed dev implementation; overlapping original patch superseded |
| `packages/keiko-model-gateway/src/toolCatalogBridge.ts`                                  | Recovered original work                                                     |
| `packages/keiko-server/src/chat-compaction-evidence.test.ts`                             | Recovered original work                                                     |
| `packages/keiko-server/src/chat-compaction-evidence.ts`                                  | Recovered original work                                                     |
| `packages/keiko-server/src/chat-compaction-model-summary.ts`                             | Recovered original work                                                     |
| `packages/keiko-server/src/chat-compaction-resurfacing.ts`                               | Recovered original work                                                     |
| `packages/keiko-server/src/chat-context-log.ts`                                          | Recovered original work                                                     |
| `packages/keiko-server/src/chat-context-status.test.ts`                                  | Recovered original work                                                     |
| `packages/keiko-server/src/chat-context-status.ts`                                       | Recovered original work                                                     |
| `packages/keiko-server/src/chat-gateway-assembly.test.ts`                                | Integrated original work with reviewed dev implementation                   |
| `packages/keiko-server/src/chat-handlers.ts`                                             | Integrated original work with reviewed dev implementation                   |
| `packages/keiko-server/src/chat-history-rehydration.ts`                                  | Recovered original work                                                     |
| `packages/keiko-server/src/chat-history-snapshot.test.ts`                                | Integrated original work with reviewed dev implementation                   |
| `packages/keiko-server/src/chat-history-snapshot.ts`                                     | Recovered original work                                                     |
| `packages/keiko-server/src/chat-prompt-budget-diagnostics.ts`                            | Recovered original work                                                     |
| `packages/keiko-server/src/chat-prompt-budget-token-summary.ts`                          | Retained reviewed dev implementation; overlapping original patch superseded |
| `packages/keiko-server/src/chat-prompt-budget.ts`                                        | Integrated original work with reviewed dev implementation                   |
| `packages/keiko-server/src/conversation-compaction.test.ts`                              | Integrated original work with reviewed dev implementation                   |
| `packages/keiko-server/src/conversation-compaction.ts`                                   | Integrated original work with reviewed dev implementation                   |
| `packages/keiko-server/src/conversation-gateway.ts`                                      | Integrated original work with reviewed dev implementation                   |
| `packages/keiko-server/src/conversation-structured-compaction.test.ts`                   | Recovered original work                                                     |
| `packages/keiko-server/src/gateway-discovery-log.ts`                                     | Recovered original work                                                     |
| `packages/keiko-server/src/gateway-setup.test.ts`                                        | Retained reviewed dev implementation; overlapping original patch superseded |
| `packages/keiko-server/src/gateway-setup.ts`                                             | Retained reviewed dev implementation; overlapping original patch superseded |
| `packages/keiko-server/src/gitDelivery/commitDraftQuality.test.ts`                       | Recovered original work                                                     |
| `packages/keiko-server/src/gitDelivery/commitDraftQuality.ts`                            | Recovered original work                                                     |
| `packages/keiko-server/src/grounded-conversation-continuity.ts`                          | Integrated original work with reviewed dev implementation                   |
| `packages/keiko-server/src/grounded-qa-hybrid.ts`                                        | Recovered original work                                                     |
| `packages/keiko-server/src/grounded-qa-multi-source.ts`                                  | Recovered original work                                                     |
| `packages/keiko-server/src/grounded-qa.ts`                                               | Recovered original work                                                     |
| `packages/keiko-server/src/process-log-sink.test.ts`                                     | Retained reviewed dev implementation; overlapping original patch superseded |
| `packages/keiko-server/src/process-log-sink.ts`                                          | Recovered original work                                                     |
| `packages/keiko-server/src/routes.ts`                                                    | Recovered original work                                                     |
| `packages/keiko-server/src/store-handlers.ts`                                            | Recovered original work                                                     |
| `packages/keiko-server/src/store/db.ts`                                                  | Recovered original work                                                     |
| `packages/keiko-server/src/store/messages.ts`                                            | Recovered original work                                                     |
| `packages/keiko-server/src/store/schema.ts`                                              | Recovered original work                                                     |
| `packages/keiko-server/src/store/types.ts`                                               | Recovered original work                                                     |
| `packages/keiko-ui/eslint-suppressions.json`                                             | Recovered original work                                                     |
| `packages/keiko-ui/package.json`                                                         | Integrated original work with reviewed dev implementation                   |
| `packages/keiko-ui/src/app/components/desktop/AttachmentIntake.test.tsx`                 | Recovered original work                                                     |
| `packages/keiko-ui/src/app/components/desktop/AttachmentStrip.tsx`                       | Recovered original work                                                     |
| `packages/keiko-ui/src/app/components/desktop/ChatContextMeter.module.css`               | Recovered original work                                                     |
| `packages/keiko-ui/src/app/components/desktop/ChatContextMeter.test.tsx`                 | Recovered original work                                                     |
| `packages/keiko-ui/src/app/components/desktop/ChatContextMeter.tsx`                      | Recovered original work                                                     |
| `packages/keiko-ui/src/app/components/desktop/ChatContextMeterContainer.tsx`             | Recovered original work                                                     |
| `packages/keiko-ui/src/app/components/desktop/ChatWindow.test.tsx`                       | Recovered original work                                                     |
| `packages/keiko-ui/src/app/components/desktop/ChatWindow.tsx`                            | Recovered original work                                                     |
| `packages/keiko-ui/src/app/components/desktop/ComposerEmptyState.test.tsx`               | Recovered original work                                                     |
| `packages/keiko-ui/src/app/components/desktop/KeikoSelect.module.css`                    | Recovered original work                                                     |
| `packages/keiko-ui/src/app/components/desktop/KeikoSelect.test.tsx`                      | Recovered original work                                                     |
| `packages/keiko-ui/src/app/components/desktop/KeikoSelect.tsx`                           | Recovered original work                                                     |
| `packages/keiko-ui/src/app/components/desktop/composer/ComposerShell.tsx`                | Recovered original work                                                     |
| `packages/keiko-ui/src/app/components/desktop/composer/MarkdownComposer.module.css`      | Recovered original work                                                     |
| `packages/keiko-ui/src/app/components/desktop/composer/MarkdownComposer.test.tsx`        | Recovered original work                                                     |
| `packages/keiko-ui/src/app/components/desktop/composer/MarkdownComposer.tsx`             | Recovered original work                                                     |
| `packages/keiko-ui/src/app/components/desktop/composer/composer-code-runtime.ts`         | Recovered original work                                                     |
| `packages/keiko-ui/src/app/components/desktop/composer/composer-code-view.test.ts`       | Recovered original work                                                     |
| `packages/keiko-ui/src/app/components/desktop/composer/composer-code-view.ts`            | Recovered original work                                                     |
| `packages/keiko-ui/src/app/components/desktop/composer/composer-editor-controller.ts`    | Recovered original work                                                     |
| `packages/keiko-ui/src/app/components/desktop/composer/composer-editor-state.ts`         | Recovered original work                                                     |
| `packages/keiko-ui/src/app/components/desktop/composer/composer-editor-types.ts`         | Recovered original work                                                     |
| `packages/keiko-ui/src/app/components/desktop/composer/composer-format-commands.ts`      | Recovered original work                                                     |
| `packages/keiko-ui/src/app/components/desktop/composer/composer-input-rules.ts`          | Recovered original work                                                     |
| `packages/keiko-ui/src/app/components/desktop/composer/composer-markdown.test.ts`        | Recovered original work                                                     |
| `packages/keiko-ui/src/app/components/desktop/composer/composer-markdown.ts`             | Recovered original work                                                     |
| `packages/keiko-ui/src/app/components/desktop/hooks/useWorkspace.ts`                     | Integrated original work with reviewed dev implementation                   |
| `packages/keiko-ui/src/app/components/desktop/hooks/useWorkspace.wheel.test.tsx`         | Integrated original work with reviewed dev implementation                   |
| `packages/keiko-ui/src/app/components/desktop/useContextDisclosure.ts`                   | Recovered original work                                                     |
| `packages/keiko-ui/src/app/components/desktop/viewport-overlay.test.ts`                  | Recovered original work                                                     |
| `packages/keiko-ui/src/app/components/desktop/viewport-overlay.ts`                       | Recovered original work                                                     |
| `packages/keiko-ui/src/app/components/desktop/widgets/cards/editorMonacoRuntime.test.ts` | Recovered original work                                                     |
| `packages/keiko-ui/src/app/components/desktop/widgets/cards/editorMonacoRuntime.ts`      | Recovered original work                                                     |
| `packages/keiko-ui/src/lib/api.ts`                                                       | Recovered original work                                                     |
| `packages/keiko-ui/src/lib/i18n-messages.de.ts`                                          | Recovered original work                                                     |
| `packages/keiko-ui/src/lib/i18n-messages.en.ts`                                          | Recovered original work                                                     |
| `packages/keiko-ui/vitest.setup.ts`                                                      | Recovered original work                                                     |
| `packages/keiko-workflows/src/context-budget/index.ts`                                   | Recovered original work                                                     |
| `packages/keiko-workflows/src/context-budget/rehydration.ts`                             | Recovered original work                                                     |
| `packages/keiko-workflows/src/context-budget/structured-digest.test.ts`                  | Recovered original work                                                     |
| `packages/keiko-workflows/src/context-budget/structured-digest.ts`                       | Recovered original work                                                     |
| `scripts/lib/activity-log-failure-surfaces.mjs`                                          | Recovered original work                                                     |
| `tests/activity-log-scenarios/model-gateway.test.ts`                                     | Recovered original work                                                     |
