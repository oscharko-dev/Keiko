# Epic #518 — Governed Workspace Product Boundaries, Object Taxonomy, and Primary Journeys

Status: Wave 2 deliverable for [issue #522](https://github.com/oscharko-dev/Keiko/issues/522) under parent epic [#518](https://github.com/oscharko-dev/Keiko/issues/518).

Audit date: 2026-06-06. Builds on [518-capability-audit.md](518-capability-audit.md) and [518-reference-analysis.md](518-reference-analysis.md).

## Purpose

This document defines the product boundary for Keiko's governed workspace, the first-class object taxonomy, the primary user journeys, and the authority model that distinguishes user, agent, server, model, and evidence behavior. It is the input that constrains #523 (UX blueprint), #524 (UI blueprint), #525 (architecture blueprint + ADRs), and the implementation issues #526–#530.

## Primary users and jobs-to-be-done

Keiko is for **regulated engineering teams** that must reason about code and infrastructure changes with traceable evidence, controlled model access, and explicit human authority over what an agent may do.

The primary user roles addressed by the workspace foundation:

| Role                                                 | Job-to-be-done in the workspace                                                                                                |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Senior engineer reviewing agent-assisted change      | Understand what context was used, what the agent proposed, what was applied, what verification ran, and what evidence persists |
| Tech lead / staff engineer governing agent use       | Inspect trust boundaries, confirm Model Gateway routing, confirm tool authorization, review evidence redaction                 |
| QA / verification engineer                           | Re-run verification, inspect verification records, compare runs                                                                |
| Security / compliance reviewer                       | Audit evidence manifests, confirm denied paths, confirm credential redaction, inspect command boundaries                       |
| Subject-matter contributor exploring local knowledge | Inspect capsule graph, search context, attach context to conversations                                                         |

The workspace is **not** for: general-purpose drawing, presentation building, design hand-off, marketing collaboration, or remote-team whiteboarding.

## Workspace surface boundaries

A workspace surface is a region of the Keiko UI that owns a specific concern. The boundary is enforced by package ownership in `packages/keiko-*` and by the architecture invariants from [ADR-0019](../adr/ADR-0019-modular-package-architecture.md) and [ADR-0020](../adr/ADR-0020-workspace-tooling-and-architecture-gate.md).

| Surface                          | Owns                                                                      | Bounded by                                                                   |
| -------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| **Project selection**            | Active project root, project sidebar, project-scoped state                | `keiko-workspace` path validators; `keiko-ui` `ProjectPanel`                 |
| **Connected repository context** | Repository discovery, context packs, retrieval, git history, import graph | `keiko-workspace`                                                            |
| **Conversation**                 | Grounded chat threads, model selection, streaming responses, attachments  | `keiko-ui` `ChatWindow`; `keiko-server` chat handlers; `keiko-model-gateway` |
| **Workflow runs**                | Workflow descriptors, run state, run ledger entries                       | `keiko-workflows`; `keiko-server` run handlers                               |
| **Evidence**                     | Run manifests, evidence redaction, evidence references in UI              | `keiko-evidence`; `keiko-server` evidence routes                             |
| **Terminal / tool outputs**      | Controlled command execution, tool gating, terminal session               | `keiko-tools`; `keiko-server` terminal routes                                |
| **Generated patches**            | Proposed file changes, diff review, apply / reject decisions              | `keiko-tools` applyPatch; `keiko-ui` `ReviewWidget`                          |
| **Review state**                 | The "needs review", "verified", "blocked" status surfaces                 | `keiko-ui` `ReviewWidget`, `AgentGateCard`                                   |
| **Local knowledge**              | Capsules, capsule sets, connector graph, retrieval                        | `keiko-local-knowledge`; `keiko-ui` connector graph                          |
| **Memory**                       | Capture envelopes, governance, retrieval, vault                           | `keiko-memory-*`                                                             |
| **Quality intelligence**         | Test-design analysis                                                      | `keiko-quality-intelligence`; `keiko-ui` QualityIntelligencePanel            |

The workspace shell composes these surfaces; it does not own their state.

## First-class object taxonomy (initial production foundation)

A first-class object is a workspace object type that the production workspace foundation must support today, with: identity, display metadata, lifecycle state, trust boundary, authority requirement, and persistence expectation. The first-class object types are derived from the existing `WindowType` enum in `packages/keiko-ui/src/app/components/desktop/windows/WindowsRegistry.ts`.

| Object type                    | `WindowType`                | Owner                                                             | Lifecycle states                                                    | Trust boundary                                                 | User authority requirement                               | Persistence                                                           |
| ------------------------------ | --------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------- |
| **Repository context**         | `project`, `files`          | `keiko-workspace` + `keiko-ui`                                    | `none → connecting → connected → degraded → disconnected`           | Path containment + denied paths                                | User must connect a project root                         | Durable (project registry); FS access transient per request           |
| **Conversation**               | `chat`                      | `keiko-ui` + `keiko-server` chat handlers + `keiko-model-gateway` | `draft → streaming → final → archived`                              | Model Gateway routes all model calls; redactor scrubs payloads | User may send; agent may propose; apply requires confirm | Durable (UI persistence #62)                                          |
| **Workflow run**               | `agents`, `integ`           | `keiko-workflows` + `keiko-server` run handlers                   | `proposed → running → blocked → needs review → verified → archived` | Workflow descriptor + tool boundary                            | User explicitly starts a run                             | Durable (run ledger)                                                  |
| **Generated patch / proposal** | `review`                    | `keiko-tools` applyPatch + `keiko-ui` `ReviewWidget`              | `proposed → reviewing → applied → reverted → archived`              | applyPatch validator; workspace path containment               | User explicitly applies or rejects                       | Durable for proposals (evidence reference); applied changes go to FS  |
| **Verification result**        | `review` (verification tab) | `keiko-verification` + `keiko-server` run handlers                | `pending → running → passed → failed → cancelled`                   | Verification orchestrator                                      | User triggers; agent may propose                         | Durable (run ledger entry)                                            |
| **Evidence artifact**          | `review` (evidence tab)     | `keiko-evidence`                                                  | `created → redacted → archived`                                     | Redacted-by-construction                                       | Read-only in UI                                          | Durable (evidence store)                                              |
| **Terminal session**           | `terminal`                  | `keiko-tools` terminal policy + `keiko-server` terminal routes    | `idle → running → completed → blocked → cancelled`                  | Command allow-list + path containment                          | User confirms each command class                         | Transient (session)                                                   |
| **Browser tab**                | `browser`                   | `keiko-server` browser policy                                     | `closed → connecting → live → error`                                | Allow-list policy                                              | User opens explicitly                                    | Transient                                                             |
| **Editor view**                | `editor`                    | `keiko-ui` editor widget                                          | `closed → reading → editing → unsaved → saved`                      | Workspace path containment                                     | User opens / edits                                       | Transient unless file save                                            |
| **Settings**                   | `settings`                  | `keiko-ui` settings panel + `keiko-server` config                 | `viewing → editing → saved`                                         | Config validators                                              | User-only mutation                                       | Durable (config store)                                                |
| **Notifications**              | `notifications`             | `keiko-ui` notifications panel                                    | `unread → read → dismissed`                                         | UI-only                                                        | User dismisses                                           | Transient                                                             |
| **Activity / Timeline**        | `activity`                  | `keiko-ui` timeline panel                                         | `live → archived`                                                   | UI-only                                                        | UI-only                                                  | Transient                                                             |
| **Resources**                  | `resources`                 | `keiko-ui` resources panel                                        | `live`                                                              | UI-only                                                        | UI-only                                                  | Transient                                                             |
| **Inspector**                  | `inspector`                 | `keiko-ui` inspector panel                                        | `empty → focused`                                                   | UI-only                                                        | UI-only                                                  | Transient                                                             |
| **Mobile pairing**             | `mobile`                    | `keiko-server` host check + `keiko-ui` mobile panel               | `paired → unpaired`                                                 | Host check + authentication                                    | User confirms                                            | Durable (pairing token in OS keychain only — never persisted to repo) |
| **Search**                     | `search`                    | `keiko-ui` + `keiko-workspace` repoSearch                         | `idle → searching → results → error`                                | Workspace path containment                                     | UI-only                                                  | Transient                                                             |
| **Plugins**                    | `plugins`                   | `keiko-ui` plugins panel                                          | `idle → installed → disabled`                                       | Registry-only (no runtime hosting in #518)                     | UI-only                                                  | Durable (config)                                                      |
| **Automations**                | `automations`               | `keiko-ui` automations panel                                      | `idle → enabled → disabled`                                         | Workflow descriptors only                                      | User-only                                                | Durable (config)                                                      |
| **Keiko Twin**                 | `keiko`                     | `keiko-ui` Twin panel + `keiko-memory-*`                          | `live`                                                              | Memory governance                                              | User-only                                                | Durable (memory vault)                                                |

These 19 first-class types correspond 1:1 with the existing `WindowType` enum. The product boundary is therefore "the workspace foundation must support exactly these object types, with the lifecycle/trust/authority/persistence fields documented above." No new object type is added by #518.

## Extension-ready object taxonomy

An extension-ready object type is one whose contract is documented today so a future issue can add it through `registerWindowRender` without changing the workspace shell, the registry contract, or any other package's public surface.

| Future object type          | Trust boundary                                                  | Persistence expectation                           | When implemented                                              |
| --------------------------- | --------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------- |
| **Agent profile**           | Model Gateway + tool boundary; declared agent permissions       | Durable (config)                                  | When a future issue requires multiple distinct agent personas |
| **MCP tool**                | `keiko-tools` registry; allow-list                              | Durable (config)                                  | When a future issue adopts MCP tools                          |
| **Connector**               | `keiko-workspace` connector contract; allow-list                | Durable (config)                                  | When a future issue adds non-FS connectors                    |
| **Data source**             | `keiko-workspace` source contract; redacted in evidence         | Durable (config)                                  | When a future issue adds remote sources                       |
| **Document object**         | UI rendering only; persistence per evidence/workspace ownership | Per content type                                  | When a future issue adopts a Document object type             |
| **Knowledge object**        | `keiko-local-knowledge` capsule                                 | Durable (capsule store)                           | Already extensible today                                      |
| **Skill / template**        | UI metadata only                                                | Durable (config)                                  | When a future issue adds Skills                               |
| **Graph node / graph edge** | Reuse `ConnectionsLayer` + connector-graph patterns             | Transient unless persisted as capsule connections | When a future issue adopts agent / MCP / connector graphs     |

Each extension-ready type lands by adding an entry to the registry and a renderer, not by changing the shell.

## Deferred / explicit non-goals

| Concept                                            | Why deferred                                        |
| -------------------------------------------------- | --------------------------------------------------- |
| Real-time multi-user collaboration                 | Out of scope; epic invariant                        |
| WebRTC transport                                   | Architecture-only; requires separate ADR            |
| General-purpose drawing tool                       | Out of scope; not the product direction             |
| Marketplace plugin hosting                         | Architecture invariant; only `registerWindowRender` |
| Arbitrary canvas shape SDK                         | Architecture invariant                              |
| Remote workspace hosting                           | Architecture invariant                              |
| Full document editor with block tree               | Out of scope; existing widgets render rich text     |
| Automatic commits / pushes / merges by agent       | Epic non-goal                                       |
| Direct model calls from UI bypassing Model Gateway | Epic invariant                                      |

## Authority model

Every workspace action belongs to exactly one authority class. The class determines who may originate the action, who may execute it, and what evidence must be captured.

| Authority class             | Originator                         | Executor                                            | Evidence captured?                                                            |
| --------------------------- | ---------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------- |
| **User action (UI-only)**   | User                               | Browser                                             | No (UI state)                                                                 |
| **User action (persisted)** | User                               | `useWorkspace` → browser `localStorage` (current shell layout seam) | No new evidence; persisted layout remains browser-local in the current implementation |
| **Agent proposal**          | Agent (via model output)           | UI surfaces the proposal                            | Yes — model call recorded in run ledger                                       |
| **Tool execution**          | User confirms; tool runs           | `keiko-tools` terminal policy → OS                  | Yes — tool input/output redacted into evidence                                |
| **Model call**              | Either user or workflow            | `keiko-model-gateway` adapter                       | Yes — gateway records redacted exchange                                       |
| **Verification run**        | Either user or workflow            | `keiko-verification` orchestrator                   | Yes — verification record                                                     |
| **Patch application**       | User confirms an agent's proposal  | `keiko-tools` applyPatch                            | Yes — patch entry + verification                                              |
| **Evidence creation**       | Always derived from another action | `keiko-evidence` builder (redacted-by-construction) | The evidence itself                                                           |

The workspace foundation must never:

1. Let a UI surface bypass the Model Gateway.
2. Let a UI surface escape workspace path containment.
3. Let a UI surface execute an arbitrary shell command (only terminal-policy-allowed classes).
4. Let an undo/redo operation rewrite evidence, applied patches, verification records, or model-call records.
5. Persist raw evidence content, secrets, customer data, private logs, or token-bearing artifacts in UI durable state.

These five rules govern every implementation issue in Waves 4–6.

## Primary journeys

Each journey is a sequence of user actions across workspace surfaces. The journeys cover the epic's required Acceptance Criteria for #522.

### Journey 1 — Connect a project

1. User opens the workspace; the LeftRail shows the Keiko logo, Project, Search, Plugins.
2. If no project is connected, the workspace presents an empty shell with a project-connect call to action.
3. User clicks `Project`; the `ProjectPanel` opens.
4. User chooses a folder via the system picker; `keiko-workspace` discovers + validates the root.
5. Status surface in the Footer updates: connected project, model availability, evidence access.

**Authority moments:** user picks the root (user authority); `keiko-workspace` validates the path (server authority); no agent involvement.

### Journey 2 — Inspect repository context

1. User clicks `Files` from LeftRail or opens the Files widget from the command palette.
2. `FilesWidget` lists project files; `keiko-workspace` provides redacted previews.
3. User opens a file; `EditorWidget` renders it.
4. `Inspector` shows file metadata (size, last modified, import graph references).

**Authority moments:** read-only; workspace path containment enforced server-side.

### Journey 3 — Ask for assistance

1. User opens `Chat`; `ChatWindow` displays.
2. User selects a model; selection routes through `keiko-model-gateway`.
3. User types a prompt; the prompt is composed with grounded context from `keiko-workspace`.
4. Response streams via SSE; `GroundedAnswer` renders the response with citation references.
5. Run is added to the run ledger.

**Authority moments:** user originates; agent proposes; model call is gateway-mediated; evidence persists for the model call.

### Journey 4 — Review generated output

1. Agent or workflow produces a proposed patch; a `ReviewWidget` opens.
2. `AgentGateCard` shows the trust boundary, the diff, and the actions: apply, dismiss, request verification, escalate.
3. User reviews the diff inline.

**Authority moments:** user confirms; `keiko-tools` applies; verification triggered or deferred.

### Journey 5 — Run verification

1. From a `ReviewWidget` or directly via command palette, the user starts verification.
2. `keiko-verification` runs the plan; UI shows progress.
3. On completion, the verification record is added to the evidence ledger; the review state updates.

**Authority moments:** user starts; orchestrator executes; evidence captured.

### Journey 6 — Review evidence

1. User opens an evidence-bearing object (chat, run, patch) and chooses "Evidence".
2. `keiko-evidence` returns a redacted manifest; the UI renders it.
3. User may export a redacted bundle.

**Authority moments:** read-only; the redactor enforces the boundary.

### Journey 7 — Return to prior work

1. User closes the browser tab; the current workspace layout persists through `useWorkspace` to browser `localStorage`.
2. User returns; the workspace shell restores the last layout, the active project, the open windows, and the inspector focus.
3. Transient UI state (in-flight streaming, ephemeral notifications) does not restore; durable state does.

**Authority moments:** none beyond the durable/transient persistence boundary.

## Scope-risk register

| Risk                                               | Where it manifests         | Mitigation                                                                                  |
| -------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------- |
| Implementation drifts toward a generic whiteboard  | #527 interaction substrate | UX blueprint rejects mode-driven tools; substrate must be command-driven                    |
| Implementation adds a new state-management library | #526, #527, #528           | Audit and #525 ADR fix the per-package store seams; PR review rejects new libs              |
| Object registry grows into a runtime plugin host   | #528                       | `registerWindowRender` is a build-time registration; no dynamic code loading                |
| Canvas substrate becomes a parallel package        | #529                       | Issue #529 closes with deferral evidence per audit                                          |
| Undo/redo silently rewrites evidence               | #527                       | Undo contract types refuse evidence/patch/verification/model-call mutations at compile time |
| Workspace shell carries a new credential surface   | #526                       | Footer surfaces existing credential boundary; no new secret prompt added                    |

## Acceptance Criteria evidence

| #522 AC                                                                                                                               | Where in this document                                               |
| ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Workspace is not a general-purpose whiteboard or design canvas                                                                        | "Primary users and jobs-to-be-done", "Deferred / explicit non-goals" |
| Object taxonomy includes repository context, chat, workflow run, patch, evidence, document, agent, connector, MCP, skill, data source | "First-class object taxonomy" + "Extension-ready object taxonomy"    |
| Each object type has owner, lifecycle, trust boundary, persistence, delivery status                                                   | First-class taxonomy table                                           |
| Primary journeys cover connecting a project, inspecting context, asking, reviewing, verifying, evidence, return                       | "Primary journeys" 1–7                                               |
| Authority boundaries distinguish user action, agent proposal, tool execution, server behavior, model access, evidence capture         | "Authority model"                                                    |
| Deferred scope is written as follow-up candidates                                                                                     | "Deferred / explicit non-goals" + extension-ready taxonomy           |
| No section proposes a new dependency                                                                                                  | Implicit throughout; reinforced in scope-risk register               |

## Follow-up ADR candidates (for #525)

These are in addition to the five ADRs already named by #520:

6. ADR — Workspace authority model: five rules the workspace foundation must never violate.
7. ADR — Extension-ready object contracts: how a future agent / MCP / connector / document type registers without changing shell or registry contracts.

## References

- Epic: [#518](https://github.com/oscharko-dev/Keiko/issues/518)
- Child: [#522](https://github.com/oscharko-dev/Keiko/issues/522)
- Companions: [518-capability-audit.md](518-capability-audit.md), [518-reference-analysis.md](518-reference-analysis.md)
- Existing taxonomy seed: [packages/keiko-ui/src/app/components/desktop/windows/WindowsRegistry.ts](../../packages/keiko-ui/src/app/components/desktop/windows/WindowsRegistry.ts)
