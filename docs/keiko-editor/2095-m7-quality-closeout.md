# Epic #2095 M7 quality closeout

This is the Issue #2327 closeout report for Epic #2095. It aggregates child evidence, names the
remaining final-gate requirements, and records the release/operator boundaries for the M7
personalized and resilient editor work.

Authoritative implementation traceability lives in
[`2095-m7-conformance-matrix.md`](2095-m7-conformance-matrix.md). This report adds release,
security, performance, accessibility, migration, rollback, and demo guidance for final PR review.

Reference behavior was checked against the Epic-linked upstream documentation for
[VS Code settings](https://code.visualstudio.com/docs/configure/settings),
[VS Code enterprise policies](https://code.visualstudio.com/docs/enterprise/policies),
[VS Code keybindings](https://code.visualstudio.com/docs/configure/keybindings),
[VS Code snippets](https://code.visualstudio.com/docs/editing/userdefinedsnippets),
[VS Code extension APIs](https://code.visualstudio.com/api/references/vscode-api),
[Node `fs.watch`](https://nodejs.org/api/fs.html), and
[Monaco editor](https://github.com/microsoft/monaco-editor). Keiko intentionally follows the
familiar IDE shape only where it can preserve stricter local-first governance.

## Scope audited

Epic #2095 covers the M7 editor personalization and resilience layer:

- revisioned user/workspace editor settings and live Settings UI;
- root-scoped workspace watcher and external-change reconciliation;
- Monaco model retention under memory pressure;
- keyboard shortcut customization;
- governed workspace snippets;
- explicit AI-assist activation within operator ceilings;
- cross-window, migration, degraded-mode, and release-closeout evidence.

The implementation reuses existing Keiko editor, BFF, contract, evidence, settings, watcher,
agent-bridge, hot-exit, Model Gateway, patch-apply, verification, and design-system surfaces. It does
not add a parallel workspace, model, evidence, settings, snippet, watch, or workflow subsystem.

## Child issue status

| Issue | Closeout status                                      | Primary evidence                                                                          |
| ----- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| #2317 | Implemented in this branch                           | ADR-0133, contract parsers/resolvers, export tests.                                       |
| #2318 | Implemented in this branch                           | Settings control service, private state store, BFF routes, SSE event bus.                 |
| #2320 | Implemented in this branch                           | Live Settings panel, i18n, source badges, policy locks, reset/mutate flows.               |
| #2319 | Implemented in this branch                           | Workspace watch service/routes, event replay, degraded health, UI hook.                   |
| #2321 | Implemented in this branch                           | External-change state machine, clean/dirty decisions, EditorWidget integration.           |
| #2322 | Implemented in this branch                           | Editor model registry, retained view/undo state, memory pressure diagnostics.             |
| #2324 | Implemented in this branch                           | Shortcut registry, collision/protected-key handling, Settings editor.                     |
| #2323 | Implemented in this branch                           | Snippet contracts/service/UI/completion bridge and VS Code subset documentation.          |
| #2325 | Implemented in this branch                           | AI activation contracts, route gates, Settings status/confirmation, legacy ceiling tests. |
| #2326 | Implemented in this branch                           | Conformance matrix, cross-window settings test, deterministic watch-route gap test.       |
| #2327 | Implemented by this report plus final local/CI gates | This report, troubleshooting page, final PR/gate evidence.                                |

Issues must remain open until the PR is merged and maintainer-controlled closure evidence is
recorded. The AGENTS.md human-control invariant still applies: commit, push, PR creation, merge, and
issue closure are delivery actions that require explicit current-session authority.

## Security review matrix

| Threat or abuse case                                                       | Expected M7 behavior                                                                                                                                           | Evidence                                                                                                |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Corrupt, future-versioned, or oversized settings state                     | Store becomes unavailable and refuses writes; defaults are shown only as safe effective state.                                                                 | `editorSettingsControl.test.ts` corrupt/future/oversized cases.                                         |
| Stale or replayed settings mutation                                        | Returns conflict or idempotency replay/conflict; no last-writer-wins overwrite.                                                                                | `editorSettingsControl.test.ts`, `editorSettingsRoutes.test.ts`, `useEditorSettings.test.tsx`.          |
| Workspace path escape, symlink substitution, denied paths                  | Watcher/hot-exit/snippet/file paths fail closed without leaking hostile content.                                                                               | `workspaceWatchService.test.ts`, `hotExitRoutes.test.ts`, snippet parser/service tests.                 |
| Dirty-buffer overwrite by external or agent write                          | UI requires explicit dirty-buffer decision; agent reconciliation targets other panes only after committed writes.                                              | `editorExternalChangeState.test.ts`, `EditorWidget.test.tsx`, `editorAgentReconciliationQueue.test.ts`. |
| Reserved or colliding shortcut                                             | Mutation is rejected before persistence and Settings does not silently replace protected commands.                                                             | `keyboardShortcutsRegistry.test.ts`, `EditorSettingsPanel.test.tsx`.                                    |
| Snippet injection or unsupported VS Code snippet semantics                 | Parser accepts only a bounded TextMate subset and rejects unsafe bodies/path globs.                                                                            | `editor-snippets.test.ts`, `workspaceSnippetsService.test.ts`, `workspace-snippets.md`.                 |
| AI activation bypass                                                       | Legacy env flags are ceilings, explicit opt-in is required, inactive routes do not call models or apply patches.                                               | `aiAssistActivation.test.ts`, inline/test-generation/patch-apply route tests.                           |
| Provider endpoint, prompt, source body, completion, patch, or root leakage | Evidence/status surfaces carry counts, hashes, reason codes, and relative paths only.                                                                          | Settings/watch/snippet/AI route tests plus conformance matrix evidence.                                 |
| Unbounded watcher/model/listener resources                                 | Watchers close after last unsubscribe; model cache evicts clean models and degrades on protected pressure; editor providers/listeners return to zero on close. | `workspaceWatchService.test.ts`, `editor-model-registry.test.ts`, `editor-memory-lifecycle.test.ts`.    |

## Performance, memory, and release evidence

M7 does not introduce a new benchmark harness. It reuses the existing editor and workspace gates:

- editor memory/listener lifecycle: `packages/keiko-editor/src/components/editor-memory-lifecycle.test.ts`;
- Monaco model retention pressure: `packages/keiko-editor/src/components/editor-model-registry.test.ts`;
- workspace watcher pressure and replay bounds: `packages/keiko-server/src/editor/watch/workspaceWatchService.test.ts`;
- editor/UI release evidence: `npm run check:editor-release-evidence`;
- editor/workspace performance gates: existing editor/workspace Playwright performance configs under
  `tests/e2e/config/`.

Linux CI remains authoritative for editor release/performance evidence. macOS and Windows runs are
compatibility signals and must not replace Linux fingerprints or release evidence values.

## Accessibility and visual review

New M7 UI surfaces reuse component-scoped Settings panel classes and the existing design-system
tokens. The Settings panel tests cover keyboard-driven shortcut recording/removal/reset and disabled
policy states. Final PR review should run the applicable UI gates:

- `npm run test:coverage:ui`;
- `npm run check:editor-release-evidence`;
- the affected Playwright smoke/a11y/visual gate selected by the final changed areas.

No global CSS hash was intentionally changed for M7. If final diff review shows a global CSS change,
the visual-proof gate must be rerun and the change must be justified separately.

## Migration, rollback, and operator behavior

- No existing user action is required for migration. M7 settings records are created lazily by
  server-owned mutations.
- Corrupt, oversized, or future-versioned records fail closed as unavailable instead of being
  auto-rewritten.
- Reset and rollback are done through revisioned Settings reset mutations, not by deleting unrelated
  private state.
- M6 managed-language state remains independently owned and is summarized in M7 snapshots only for
  Settings visibility.
- Hot-exit recovery remains workspace/file-bound and is neither migrated into nor controlled by M7
  settings.
- AI-assist legacy environment flags are operator ceilings. They do not silently enable AI during
  upgrade. Explicit opt-in is still required, and settings cannot exceed policy.
- Operator-facing troubleshooting is documented in
  [`../troubleshooting/editor-m7-personalization.md`](../troubleshooting/editor-m7-personalization.md).

## Clean-checkout demo script

Use a clean checkout and a disposable workspace fixture. The demo must use the real BFF/UI path and
must not rely on test-only toggles.

1. Install and build:

   ```bash
   npm install
   npm run typecheck
   npm run build
   ```

2. Start Keiko:

   ```bash
   npm run dev:start
   ```

3. Open the Editor and verify:

   - Settings show default values, source badges, modified-only filtering, reset, and policy locks.
   - Two editor windows on the same root receive one settings change after a refresh/SSE event.
   - External clean-file change reloads or marks clean state; dirty-file change prompts before
     replacing editor content.
   - File tree refresh recovers from watcher degraded/rescan state.
   - Undo/view state survives tab switching for retained Monaco models.
   - Keyboard shortcut conflict/reset works without overriding protected commands.
   - Workspace snippets insert placeholders through the snippet completion path.
   - AI-assist status distinguishes policy denied, available, active, and degraded states; disabling
     the setting prevents new optional calls.

4. Stop Keiko:

   ```bash
   npm run dev:stop
   ```

## Release impact

M7 is release-impacting and user-visible. The normalized PR metadata is:

- Release-note category: `new-additions`
- Priority: `high`
- User-visible change: Built-in editor personalization and resilience: durable settings,
  external-change protection, retained editor models, keyboard customization, safe workspace
  snippets, and governed AI-assist activation.
- Release-note bullet: Built-in editor adds durable Settings, external-change protection, retained
  undo/view state, safe workspace snippets, keyboard customization, and policy-aware AI-assist
  activation.
- Supported-from versions: first release carrying M7 editor personalization and resilience.
- Affected state stores: M7 editor settings, workspace snippet records, workspace watch runtime
  state, content-free activation/settings evidence; existing hot-exit/model/patch stores remain
  separately owned.
- User action required and remediation: no required migration action; features stay at safe defaults
  until explicit user/workspace opt-in and operator prerequisites are satisfied.

`release-impact.catalog.json` is intentionally not edited in this branch without release-owner review
evidence. The catalog gate requires reviewed release-owner metadata for every entry. The PR must carry
the metadata above, and the release owner can normalize the catalog entry once the target package
version and approval reference exist.

## Final gate requirements

Before claiming Epic #2095 complete, the final immutable implementation head must pass:

- `npm run typecheck`
- `npm run lint`
- `npm run format:check`
- `npm test`
- `npm run arch:check`
- `npm run arch:check:negative`
- `npm run check:ui-i18n`
- `npm run test:coverage:ui`
- `npm run test:coverage:quality`
- `npm run check:editor-release-evidence`
- `npm run check:adr-index`
- `npm run check:error-observability`
- `npm run check:security-regression-matrix`
- `npm run check:release-impact`

If public exports or package manifests drift, also run `npm run build && npm run
check:package-surface`. Any gate that cannot run locally must be named in the PR with the exact
reason and the nearest deterministic local substitute.

## Residual limitations

- Network filesystems, SMB/NFS mounts, container bind mounts, and case-folding races are supported
  through the degraded watcher/rescan contract, not through strong real-time event guarantees.
- Workspace snippets are a bounded Keiko subset and do not claim VS Code extension/global snippet
  parity.
- AI activation does not provision models, providers, egress, budgets, patch authority, or delivery
  authority. It only exposes explicit consent/discoverability within existing policy.
- Linux/CI release evidence remains authoritative; local macOS evidence is not a substitute for
  Linux editor release fingerprints.
