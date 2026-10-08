# OpenCode capability parity matrix

Status: working inventory for [#3874](https://github.com/oscharko-dev/Keiko/issues/3874), snapshot
2026-10-08. The initial inventory reviewed `33cc2d001`; subsequent native-context and confinement corrections
are described below. Executed heads and pending qualification remain recorded separately in the
live lab ledger. This document does not qualify an unexecuted current head. Pinned runtime: OpenCode 2.0.10
(`portable-runtime-approvals.json`, `OPENCODE_PINNED_VERSION`).

## Purpose

Issue #3874 (governed OpenCode capability parity in the Coding Workbench) asks first for a matrix of
what OpenCode can do against what the Coding Workbench offers. This document is that matrix.
OpenCode 2.0.10 is the packaged autonomous Coding Workbench service. Its native agent owns
planning, context, tool selection and the edit/test/repair loop. Keiko integrates the service through
the Model Gateway, authenticated lifecycle transport, the accepted workspace and server-owned
authority/evidence boundaries. The target is to preserve original native tool implementations and
schemas where those boundaries can enforce the accepted task safely; replacing every native tool
with a Keiko implementation is not the target. The current production profile still exposes mapped
`keiko_*` tools and denies native workspace effect tools. That is an incomplete integration state,
not proof of full parity or a permanent prohibition on native capabilities.

The three autonomy modes, the Authority Envelope and the mode-independent hard denials remain
Keiko-owned ([ADR-0124][adr-0124], [ADR-0125][adr-0125], [ADR-0129][adr-0129],
[ADR-0138][adr-0138]). Native permissions cannot widen them. Native tool admission also requires
truthful gateway schema admission, contained filesystem/process/network execution, cancellation,
redaction and evidence. The matrix records current mapped equivalents, narrower implementations,
explicitly disabled surfaces and remaining native-service gaps. Chat repository search and its
recursive search subsystem are retained unchanged.
The inactive private byte/range/stat/list prerequisite now passes eight actual original Read
output/error comparisons, including large-file paging, directories and media, through real helper
executions. Its guarded read/edit port uses the existing current authority and body-free log owner.
These are private seam controls; initial/global instruction discovery, invocation accounting,
queued admission, complete platform coverage and production native service ingress remain open.
T01 and the other production statuses below therefore remain incomplete native-parity acceptance.
The owner requires complete functional parity with Standalone OpenCode. Every narrower, disabled
or missing native capability is therefore an open acceptance item, including extension and
configuration surfaces. A mapped equivalent or an inactive seam test does not close that item.
The matrix grants no authority and adds no behaviour. Qualification must retain the original
implementation and prove the supported integration with the same accepted workspace, model,
authority and verifier; final service, platform and live-model controls remain required. It refreshes, for 2.0.10, the comparison in
[coding-workbench-audit-3560.md][audit-3560]; the older [opencode-native-quality-audit.md][audit-1517]
remains the record for 1.17.17.

## 1. How to read this document

### Status values

| Status     | Meaning                                                                                                                       |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `governed` | An available mapped capability; this alone does not prove original native parity.                                             |
| `partial`  | A governed equivalent exists but is narrower than the native capability; the limits are named in the notes.                   |
| `disabled` | The native capability is currently disabled or unreachable for a named boundary; this is not a permanent native-service veto. |
| `gap`      | No available integration; required work for complete native parity.                                                           |

### Evidence tags

| Tag | Meaning                                                                                                                                                                                                                                                                                 |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [R] | Pinned in this repository: fixtures, adapter and launch-profile code, ADRs, QA records. The protocol fixture contains only the 13 endpoints Keiko admits, so it cannot show which native features exist beyond them.                                                                    |
| [B] | Verified during this review in the staged OpenCode 2.0.10 binary: `--help` output and the JavaScript bundle embedded in the executable (plugin ids, tool registrations, configuration schema). Local evidence only; the binary sits under the gitignored `.portable-sidecar-payloads/`. |
| [G] | General knowledge of OpenCode 2.x, not verified here. No row below rests on [G] alone.                                                                                                                                                                                                  |

### Mode summary used in the notes

Abbreviations: Ask = Ask for approval (`governed-assist`), Supervised = Supervised workspace
(`supervised-coding`), Full = Full access (`autonomous-delivery`). The shared policy is the total,
monotonic matrix of [ADR-0138][adr-0138] D2:

| Mode       | Workspace-contained, low or medium risk | Workspace-contained, high or critical risk | Internet          | Delivery                                                                                                                                              |
| ---------- | --------------------------------------- | ------------------------------------------ | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ask        | approval-required                       | approval-required                          | approval-required | approval-required                                                                                                                                     |
| Supervised | allowed                                 | approval-required                          | approval-required | approval-required                                                                                                                                     |
| Full       | allowed                                 | allowed                                    | allowed           | approval-required; Code-task commit, push and draft-PR execute are authorized by the live envelope (ADR-0138 D3 item 5); merge is never model-visible |

Two reminders apply to every row. A matrix cell is a ceiling, not a capability: it applies only where
a governed execution path exists (ADR-0138 D2, availability clarification). The hard denials hold in
every mode (ADR-0129 D3): invalid or expired authority, workspace escape, denied sensitive paths,
secret exfiltration, unsupported actions, exhausted budgets and platform restrictions.

## 2. How Keiko constrains OpenCode 2.0.10 today

All points are [R] unless tagged.

- **Launch.** `buildOpenCodeLaunchProfile` ([profile][profile]) starts
  `opencode serve --hostname 127.0.0.1 --port 0` with a per-run password, private `HOME` and XDG
  roots, `OPENCODE_DISABLE_PROJECT_CONFIG=true`, `OPENCODE_CONFIG_DIR` pointing at the run's private
  configuration directory and `npm_config_offline=true`.
- **Configuration.** `createFixedOpenCodeV2Config` sets `update: "disable"`, `share: "disabled"` and
  `snapshots: false`; one provider `keiko-runtime` with one model alias `coding` (text input and
  output, tool calling on, limits from the admitted gateway geometry); native `build` system guidance
  and model optimizers remain intact, with a concise additive native `context` hook for Keiko
  interface/authority facts. No V2 Build or compaction-agent system replacement is configured.
  Automatic compaction remains native;
  `tool_output.max_bytes` of 262,144; and a `permissions` list that denies `*` and allows `question`
  and each of the 17 Keiko tools.
- **Tools.** The shared generated tools and native-context plugin sources are written to the run's private
  `config/opencode/plugins/` directory with mode 0600 ([composition][composition],
  [adapter][adapter]). The captured direct profile registers tools with `codemode: false`; the separately
  selected Code Mode profile registers the same governed inner tools with `codemode: true` and
  permits original `execute`. The source cache is immutable per closed profile. Both call the
  Keiko tool facade over loopback with a run-bound capability, and attaches the per-mode approval proof where the mode
  requires one (`toolApprovalRequired`).
- **Advertised set.** The default direct profile advertises 18 tools: native `question` plus 17 `keiko_*` tools
  ([advertised fixture][tools-fixture], `OPENCODE_MODEL_VISIBLE_TOOLS`). The Model Gateway refuses
  a request that declares a different tool set (`tool-contract-drift`, [gateway][gateway]). The optional tools
  `keiko_research_fetch`, `keiko_skill_discover`, `keiko_skill` and `keiko_child_agent` are offered
  only while their prerequisites are ready (`deriveOptionalToolAvailability` in
  [managed-tools][managed-tools]).
- **Protocol.** 13 endpoints are admitted and the surface digest is pinned
  ([protocol-surface][protocol-surface], [protocol fixture][protocol-fixture]). The V2 client
  ([v2-client][v2-client]) creates one session, sends `text` and `metadata`, interrupts, lists
  permission requests and forms, and replies to them.
- **Network.** The runtime is loopback-only and may reach only the authenticated Keiko gateway and
  BFF (ADR-0137 D6). Native `webfetch`, `websearch`, remote MCP and remote skill download could not
  leave the host even if they were enabled.
- **Filesystem foundation.** macOS direct and supervisor-prepared launches derive the same exact
  gateway wrapper. The staged kernel root union permits workspace reads, private per-run state
  writes (including the normal `<workspace>/.keiko` metadata subtree), immutable runtime/OS/Git
  support and no foreign file access. Actual OS probes and the exact 2.0.10 native Read fixture
  exercise contained reads and external symlink denial. This is not native tool admission:
  sensitive workspace/private-state access still needs a canonical native permission hook, and
  production native workspace effect tools remain denied. The spawned Activity Log records only
  closed access facts, including `read-only-outside-private-state`, never root paths.
- **Deny list.** `OPENCODE_PINNED_BUILT_IN_TOOLS` carries V1-era tool names. [B] The 2.0.10 bundle
  registers `shell`, `subagent` and `patch` and maps the legacy names `bash`, `task` and
  `apply_patch` onto them; in the V2 configuration these tools are blocked by the `*` rule, not by
  that list.

**Adding a mapped Keiko capability** currently takes all of the following together: a descriptor and alias in the catalog
([catalog][catalog], with the identity reserved under ADR-0175 D2), a server handler bound to a
facade action ([ipc][ipc], [bridge][bridge]), a generated plugin source ([adapter][adapter]), an
updated exact tool contract and digests ([schemas][schemas]), truthful schema descriptions and interface guidance ([profile][profile], the additive native context),
registered activity-log operations (AGENTS.md section 8, `npm run generate:op-catalog`) and a mode
policy mapping (ADR-0138 D2). Runtime-supplied tool definitions are transport data and cannot
register a descriptor, handler, effect or authority (ADR-0175 D2). Native service admission instead
retains the native identity/schema/executor and integrates the existing authority and evidence
owners through supported native hooks; it must not add a second planner or coding loop. Neither
route may relax the gateway's exact catalog or expand permissions before an execution path is proven.

## 3. Capability matrix

Native tool names are the ones the 2.0.10 bundle registers [B]: `read`, `glob`, `grep`, `edit`,
`write`, `patch`, `shell`, `webfetch`, `websearch`, `skill`, `subagent` and `question`, plus the
code-mode tool `execute`. Native `list`, `todowrite`, `todoread` and `lsp` are not registered.

### 3.1 Model-visible tools

| #   | OpenCode 2.0.10 capability                                                                                       | Keiko governed equivalent                                                                                                                                                                                          | Status     | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T01 | `read`: file contents with `offset` and `limit` [B]                                                              | `keiko_workspace_read` ([schemas][schemas], [read-edit][read-edit]); catalog id `keiko.workspace.read`                                                                                                             | `partial`  | Windows of at most 5,000 lines and 64 KiB of UTF-8; a larger or non-UTF-8 window is refused. The result carries `totalLines`, `nextStartLine` and the whole-file SHA-256 that `keiko_changeset_edit` must echo. Reads use the secure workspace-text-read helper, denied and ignored paths never appear, and the path must stay inside the task workspace. Read class: allowed in every mode. Evidence: `coding-runtime.workspace-read`, `coding-runtime.tool-result`.                                                                                                                                                                                                                                                                                                                                                   |
| T02 | `read` of a directory (V2 folds the former `list` tool into `read`) [B]                                          | `keiko_workspace_discover` directory mode                                                                                                                                                                          | `partial`  | The shared workspace walker returns bounded immediate admitted file/directory entries, workspace-relative paths and explicit coverage/truncation facts. Native Read directory pagination, display and output contracts are not preserved by this mapped tool. Denied and ignored paths remain excluded. Evidence: `coding-runtime.workspace-discovery`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| T03 | `glob`: path search by glob pattern, `hidden`, `limit` [B]                                                       | `keiko_workspace_discover` glob mode and existing repository-search include/exclude globs                                                                                                                          | `partial`  | G9 adds bounded glob walking without replacing Chat search. Patterns are matched against workspace-root-relative paths even when a selected directory narrows walking; native selected-path-relative matching and `hidden:false` are not equivalent. Walk budgets and truncation are explicit, so incomplete coverage is not absence. Original native Glob still needs pinned `rg` provisioning, exact executable admission and canonical access hooks before production enablement.                                                                                                                                                                                                                                                                                                                                    |
| T04 | `grep`: regex or literal content search with `include`, `path`, `caseSensitive`, `limit` [B]                     | `keiko_repository_search` ([schemas][schemas]; `buildRepositorySearchPort` in [managed-tools][managed-tools])                                                                                                      | `partial`  | Modes lexical, literal, regex (bounded and ReDoS-safe) and symbol; at most 200 query characters, 50 hits, 512-byte snippets and 64 KiB of output. Truncation is reported, and an empty truncated result is never proof of absence. A semantic rerank runs above the handler when an index exists (#3416). Read class: allowed in every mode. Evidence: `coding-runtime.repository-rerank`, `coding-runtime.tool-result`.                                                                                                                                                                                                                                                                                                                                                                                                |
| T05 | `edit`: exact-text replacement with `replaceAll` [B]                                                             | `keiko_changeset_edit` with `edits` ([schemas][schemas], [replacements][replacements]); catalog id `keiko.changeset.edit`                                                                                          | `governed` | Same replacement form since #3873, bound to the whole-file digest from `keiko_workspace_read` (`files[].expectedContentHash`) and materialized into the unified diff the governed editor path validates, reviews and applies. At most 50 edits and files, strings up to 65,536 characters, one atomic multi-file transaction with optional `selectedFiles` (ADR-0125 D3); CRLF files keep their line endings. Mode: Ask reviews the exact change in the Workbench before it is written; Supervised and Full apply it through the same boundary without a per-edit decision (ADR-0124 D6, pinned by `productionManagedWorktreeTools.test.ts`). Evidence: `coding-runtime.editor-review.decided`, `coding-runtime.editor-changeset`, `coding-runtime.editor-mutation.settled`, `coding-runtime.edit.refused`.             |
| T06 | `write`: create a file, parent directories created automatically [B]                                             | `keiko_changeset_edit` with an empty `oldString` and the empty-content SHA-256                                                                                                                                     | `governed` | An empty `oldString` is valid only as the first edit of a file that does not exist or is empty. Native `edit` rejects an empty `oldString`, so the two tools differ here. Until F27 (#3876) no live run created a file: the secure read answered a missing path `denied`, since the native helper has only `access-denied`. The server now answers `not-found` when a no-follow walk under the live root proves the path absent ([secure-read][secure-read]); a denied path stays `denied` whether or not it exists, as do a link, a file used as a directory and an unusable root. Pinned by [tests][file-creation-test] over the real governed read, secure-read wrapper and patch engine, parent directories included; not yet re-run live.                                                                          |
| T07 | `write`: overwrite an existing file [B]                                                                          | `keiko_changeset_edit`                                                                                                                                                                                             | `partial`  | There is no overwrite form: the model restates the whole current text as `oldString` (at most 65,536 characters) or issues several ordered edits. A changeset's materialized diff is capped at 65,536 bytes and 50 files (`EDITOR_AGENT_CHANGESET_MAX_PATCH_BYTES`, ADR-0125 D3), so one call cannot create or rewrite a larger file. A file that spells a backslash-n before +, - or a space is rewritten like any other (ADR-0125 D3).                                                                                                                                                                                                                                                                                                                                                                                |
| T08 | `patch`: add and update files through a patch envelope [B]                                                       | `keiko_changeset_edit`                                                                                                                                                                                             | `governed` | The unified-diff input is intentionally no longer model-visible: two of three live patches were refused over hunk headers and context (#3873, lab finding F12). The capability is covered by the replacement form.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| T09 | `patch`: delete a file and move or rename it with `movePath` [B]; `shell` `rm` and `mv`                          | `keiko_changeset_edit` `changeset.deletions` and `changeset.renames`                                                                                                                                               | `partial`  | One call applies renames, then edits, then deletions as one hash-bound changeset through the governed editor path (ADR-0125 D3), at the same `medium` risk as an edit (owner decision Q2, 2026-10-07): Ask reviews it, Supervised and Full access apply it. A deletion or rename renders the whole file, so a file over 2,000 changed lines or the 65,536-byte cap, or one the governed read cannot return as text, cannot be moved or deleted; each is refused with a closed class before the run's patch budget is charged. A file that spells a backslash-n before +, - or a space moves like any other (ADR-0125 D3). No `shell` `rm` or `mv`. Evidence: `coding-runtime.edit.refused` / `coding-runtime.editor-mutation.settled` with `deletionCount`, `renameCount` and `replacementRefusal`.                     |
| T10 | `shell`: run project verification (tests, typecheck, lint, build) [B]                                            | `keiko_verification` (ids `test`, `targeted-test`, `typecheck`, `lint`, `build`)                                                                                                                                   | `partial`  | No free arguments. Detection reads `package.json` scripts only ([detect.ts][verify-detect]); no code in `keiko-verification` or the coding runtime reads `pyproject.toml`, `go.mod`, `Cargo.toml`, `pom.xml` or `requirements.txt`, so other ecosystems have no governed verifier. Steps run egress-denied; dependencies come from an `npm install --ignore-scripts` bootstrap confined to a loopback registry proxy (ADR-0043 D17); package scripts need the workspace script-trust grant (ADR-0147 D3, mode-independent). Failures return at most 8 revalidated locations and a redacted excerpt. Mode: Ask asks the operator per run; Supervised and Full allow. Evidence: `coding-runtime.verification`, `coding-runtime.verification-summarized`, `verification.dependency-bootstrap`, `workspace-script-trust.*`. |
| T11 | `shell`: any other command (dependency installs, other toolchains, code generation, scripts) [B]                 | none offered; server side only: the `command` action and `commandRunner` port ([ipc][ipc], [managed-tools][managed-tools])                                                                                         | `gap`      | The facade already parses a `command` action (a named task from the command runner's catalog, no executable or argv from the caller, 120 s cap, per-command approval below Full) and mounts a runner port. The OpenCode profile has no descriptor for it: `keiko.command.run` exists only in the `legacy-native` profile, the catalog bridge maps no catalog action to `command`, and no plugin source is generated. There is no `keiko_command` alias.                                                                                                                                                                                                                                                                                                                                                                 |
| T12 | `shell`: Git through the CLI (status, diff, add, commit, push, pull request) [B]                                 | `keiko_git_status`, `keiko_git_diff`, `keiko_git_stage`, `keiko_git_commit`, `keiko_git_push`, `keiko_pull_request`, `keiko_git_execute`, `keiko_ci_status` ([git-ipc][git-ipc], [authority-port][authority-port]) | `partial`  | Commit, push and draft PR are proposals that `keiko_git_execute` redeems; the model never commits, pushes or opens a PR directly (ADR-0175 D2). The wire accepts only status, diff and stage: there is no unstage, log, show, blame, branch, fetch, pull, stash or checkout, and merge is never model-visible (ADR-0087). Mode: staging asks in Ask; commit, push and PR execute need a one-use operator approval in Ask and Supervised; in Full the live envelope authorizes commit, push and draft-PR execute without a per-action claim (ADR-0138 D3 item 5); CI observation asks in Ask and Supervised. Evidence: `git.runtime-action`, `git.verified-commit`, `git.draft-delivery`, `git.ci-observation`, `git.delivery.*`.                                                                                        |
| T13 | `shell`: background and long-running processes such as dev servers and watchers [B]                              | none                                                                                                                                                                                                               | `disabled` | Governed runs are bounded: a per-run wall-clock timeout, no shell, and descendant reaping. A watcher or daemon is out of scope for the command runner (`docs/command-runner/security-notes.md`), and process-tree ownership is a fail-closed invariant (ADR-0137 D5).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| T14 | `webfetch`: fetch a URL as text, markdown or html with a timeout [B]                                             | `keiko_research_fetch` ([research-port][research-port], [research-grants][research-grants]); catalog id `keiko.research.fetch`                                                                                     | `partial`  | One exact https URL (no credentials or port), GET only, public hosts only. Every URL needs an operator-approved, request-scoped grant bound to its host and request line (lifetime at most 10 minutes, 16 fetches, 10 MB); no mode mints one automatically, so Full still asks per URL. 15 s timeout, at most 2 MB read, result capped at 64 KiB, redirects revalidated. The page is projected to visible text and fenced as untrusted content (`docs/coding-runtime/research-content-threat-model.md`); PDFs and other binaries are not parsed. Offered only while the research approval path is ready. Evidence: the content-free `research-performed` runtime event and `coding-runtime.tool-result` (`actionKind` `egress`).                                                                                        |
| T15 | `websearch`: providers exa, firecrawl, parallel, tavily and tinyfish, chosen through an operator question [B]    | none                                                                                                                                                                                                               | `gap`      | The model cannot discover URLs; research needs an exact https URL taken from the task or the repository. Native search could not reach the network anyway because the runtime is loopback-only (ADR-0137 D6).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| T16 | `subagent`: named agents (`general`, `explore`), background runs, model override, nesting limit 1 by default [B] | `keiko_child_agent` ([child][child]); the child's one tool is `keiko_child_workspace_read`                                                                                                                         | `partial`  | One layer, read-only, a single child tool; `maxToolCalls` 1 to 32, objective at most 512 characters, every child call charged to the parent budget, cancelled with the run, nested children denied. Offered only when a coding-safe child model resolves. No named agents, no parallel or background children, no write-capable child (#2289 owns future orchestration). Read class: allowed in every mode. Evidence: `coding-runtime.read-only-child.completed`.                                                                                                                                                                                                                                                                                                                                                       |
| T17 | `skill`: skills from configured sources, including remote indexes [B]                                            | `keiko_skill_discover` and `keiko_skill` ([skill-catalog][skill-catalog])                                                                                                                                          | `partial`  | Server-approved catalog only, addressed as `skl_<name>@<version>`, read-only, seeded with one skill (`skl_repo-structure-summary@1`, category `repository-analysis`). The categories `public-research` and `documentation-lookup` are defined without handlers. The human can request a skill with a `$skl_...@<version>` token. Repository-authored and remote skills are not admitted: skill metadata is an authority-smuggling channel, and native discovery downloads skill files from URLs. Read class: allowed in every mode. Evidence: `coding-runtime.skill-discovery`.                                                                                                                                                                                                                                         |
| T18 | `question`: structured questions to the operator [B] [R]                                                         | native `question`, retained as the one native extension (`OPENCODE_NATIVE_EXTENSION_DEFINITIONS` in [catalog][catalog]; [questions][questions])                                                                    | `governed` | The only native tool in the advertised set. V2 forms are mapped to Workbench questions and answered or rejected through the Workbench question port; at most 32 fields and options, and hidden, conditional or external fields are refused. Questions are distinct from permission approvals. Evidence: `coding-runtime.native-question.observed`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| T19 | `todowrite` and `todoread` (V1) [R]; not registered by 2.0.10 [B]                                                | none; planning stays in the agent conversation                                                                                                                                                                     | `disabled` | OpenCode V2 no longer registers them. ADR-0175 D2 (#3561) removed `todowrite` from the catalog, history projection and prompt rather than inventing a replacement tool. The name stays on the deny list defensively.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| T20 | `lsp`: language-server intelligence [R] [B]                                                                      | none                                                                                                                                                                                                               | `gap`      | No model-facing equivalent. Keiko owns a managed language-service lifecycle for the Editor (ADR-0069, ADR-0132; `packages/keiko-server/src/editor/lsp`), but the Editor has been a human-operated surface since 2026-10-03. 2.0.10 registers no `lsp` tool plugin; its `lsp` setting configures built-in language servers. Enabling a native LSP lifecycle would add a second process and file-access path ([audit-1517][audit-1517]).                                                                                                                                                                                                                                                                                                                                                                                  |
| T21 | Code mode `execute`: model-authored JavaScript calling namespaced tools [B]                                      | none                                                                                                                                                                                                               | `disabled` | It would be a second execution path outside the governed catalog (ADR-0137 D4). The `*` deny rule blocks it, Keiko's plugin tools register with `codemode: false`, and `execute` is on the pinned deny list.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| T22 | Namespaced `opencode.*` management tools (session rename and move, model search; code mode only) [B]             | none                                                                                                                                                                                                               | `disabled` | Reachable only through `execute`; blocked for the same reasons.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

### 3.2 Session and runtime behaviour

| #   | OpenCode 2.0.10 capability                                                                                            | Keiko governed equivalent                                                                                                       | Status     | Notes                                                                                                                                                                                                                                                                                                                                                                                            |
| --- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| S01 | Session API: create, list, prompt, interrupt, permission and form replies, event stream [R]                           | One fixed session per run through the 13 admitted endpoints ([v2-client][v2-client], [protocol-surface][protocol-surface])      | `governed` | The runtime host creates the one session, the prompt body carries `text` and `metadata`, Stop maps to `interrupt`, and the event stream with history reconciliation drives the Workbench. The pinned surface digest refuses protocol drift.                                                                                                                                                      |
| S02 | Continue or resume a session (`--continue`, `--session`) [B]                                                          | Coding History plus a fresh runtime per turn (ADR-0137 D4; [audit-3560][audit-3560])                                            | `partial`  | Each turn starts a fresh runtime with bounded historical context (24,000 characters); this is not native resumption. Keiko's run snapshot, workspace binding, authority digest and explicit Retry carry the run.                                                                                                                                                                                 |
| S03 | Fork a session (`--fork`, `Session.ForkBoundary`) [B] [R]                                                             | none                                                                                                                            | `disabled` | Native fork lacks Keiko predecessor receipts and could copy stale authority context; the fork endpoint is outside the admitted surface ([audit-1517][audit-1517]).                                                                                                                                                                                                                               |
| S04 | Undo and revert through snapshots (`snapshots`, `Session.Revert`) [B] [R]                                             | none; `snapshots: false`                                                                                                        | `disabled` | A future product action must preserve Keiko's workspace and change-review ownership and cannot call native revert ([audit-3560][audit-3560]); see candidate G13.                                                                                                                                                                                                                                 |
| S05 | Share, export and import sessions (`share`, `enterprise`, `session export`, `session import`) [B]                     | none; `share: "disabled"`                                                                                                       | `disabled` | Local-first boundary: the runtime is loopback-only and Keiko keeps history in its own store. Support exports are a human-initiated local export (AGENTS.md section 8).                                                                                                                                                                                                                           |
| S06 | Self-update (`update`, `upgrade`) [B]                                                                                 | none; `update: "disable"`                                                                                                       | `disabled` | Runtime updates belong to the portable release and updater contracts (ADR-0121, ADR-0163); there is no self-update, global install or `PATH` fallback (ADR-0163 D6).                                                                                                                                                                                                                             |
| S07 | Steer or queue a prompt while a turn runs (`delivery`) [R]                                                            | none; the V2 prompt client never sends `delivery`                                                                               | `gap`      | Low priority. Follow-up turns are supported; steering an active turn is not used.                                                                                                                                                                                                                                                                                                                |
| S08 | Compaction, pruning and a retained tail [R] [B]                                                                       | Native automatic compaction with admitted context geometry ([profile][profile])                                                 | `governed` | Native auto-compaction stays enabled; kept tail and buffer derive from admitted context geometry. The ineffective V2 compaction-agent prompt setting was removed. Actual V2 compaction lifecycle is projected as body-free evidence; unknown overflow remains unknown. Evidence: `coding-runtime.compaction`. The historical post-answer delay remains open pending native qualification.        |
| S09 | Tool-output truncation (`tool_output`) [R] [B]                                                                        | `tool_output.max_bytes` of 262,144                                                                                              | `governed` | Equals the governed IPC body ceiling so a valid JSON result keeps its continuation; Keiko's per-tool bounds stay authoritative.                                                                                                                                                                                                                                                                  |
| S10 | Provider retry, fallback and circuit handling [R]                                                                     | Keiko Model Gateway ([gateway][gateway])                                                                                        | `governed` | The gateway owns retries, the circuit breaker and the coding outage window (`gateway.retry.*`, `gateway.circuit.*`, #3873) and settles spend; the runtime's retry status is observed, not trusted.                                                                                                                                                                                               |
| S11 | Providers, model catalog and credentials (`providers`, `opencode auth`, `models`) [B]                                 | One provider `keiko-runtime`, one model alias `coding`, through the Model Gateway                                               | `governed` | Credentials and provider endpoints never reach the runtime (ADR-0163 D6). Model choice and the capability probes (tool calling, minimum context window) are Keiko's; a model that fails them is refused before any runtime starts (ADR-0124 D5).                                                                                                                                                 |
| S12 | Reasoning variants (`provider/model#variant`) [B] [R]                                                                 | `reasoningEffort` on the run's model profile, admitted per configured capability ([gateway][gateway])                           | `governed` | A different mechanism with the same intent: an effort the configured model does not list is refused (`reasoning-effort-unavailable`).                                                                                                                                                                                                                                                            |
| S13 | Streaming of model output [B]                                                                                         | Gateway streaming when the upstream route advertises it ([gateway][gateway])                                                    | `partial`  | Native gateway SSE is forwarded when the configured route advertises streaming; the current tool readiness probe exercises that same production assembler. A strict proxy can still require the bounded buffered compatibility fallback. Final live matrix qualification remains open (lab findings F2/F28/F29, #3873).                                                                          |
| S14 | Image, PDF and other file input (`files` prompt parts, `media`) [R] [B]                                               | none                                                                                                                            | `gap`      | The provider model declares text input only and the gateway rejects every non-text content part closed.                                                                                                                                                                                                                                                                                          |
| S15 | Prompt references: `@file`, `@agent` and `$skill` attachments [R]                                                     | the `$skl_...@<version>` token only (`explicitSkillInvocation.ts`)                                                              | `partial`  | The V2 prompt client never sends `files`, `agents` or `skills`. File references are a composer candidate in [audit-3560][audit-3560].                                                                                                                                                                                                                                                            |
| S16 | Permission rules and prompts (`permissions`, `ask`, `--auto`) [R] [B]                                                 | Fixed default-deny ruleset plus Keiko's authority port and approval lane ([profile][profile], [authority-port][authority-port]) | `governed` | `*` is denied; `question` and the 17 Keiko tools are allowed; the real decision is Keiko's per request (mode matrix, envelope, budgets). Asks go to Keiko's approval lane, and a declined step returns to the model as the call's own result while the run continues (ADR-0124 D6). `--auto` is never used. Evidence: `coding-runtime.approval.decided`, `coding-runtime.tool-authority.denied`. |
| S17 | Worktrees and the session working directory (`worktree`, `session_move`) [B]                                          | Managed task workspaces ([ADR-0088][adr-0088], [ADR-0089][adr-0089])                                                            | `governed` | The task workspace root, branch constraints and source identity are server-bound in the Authority Envelope; the runtime cannot move its working directory.                                                                                                                                                                                                                                       |
| S18 | Command-line and server surfaces (`run`, `serve`, `acp`, `mini`, `service`, `api`, `pair`, `stats`) [B]               | `serve` only, started by the runtime host                                                                                       | `disabled` | Keiko starts `opencode serve` on loopback with a per-run password and owns the UI; no other surface is reachable.                                                                                                                                                                                                                                                                                |
| S19 | Rich rendering of model output: math, Mermaid, diff views (`opencode.latex`, `opencode.merman`, `opencode.diffs`) [B] | The Workbench timeline and Changes panel                                                                                        | `gap`      | Math notation is shown verbatim (lab finding F3, filed under #3874 in the lab record); Mermaid rendering was not assessed. Diff review is covered by Keiko's Changes panel.                                                                                                                                                                                                                      |

### 3.3 Configuration and extension surfaces

| #   | OpenCode 2.0.10 capability                                                                                                          | Keiko governed equivalent                                                                                                                             | Status     | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C01 | `agents`: built-ins `build`, `plan`, `general`, `explore`, hidden `compaction`, `title`, `summary`; custom agents and plan mode [B] | Native `build` base/optimizers plus additive Keiko `context` facts ([profile][profile], [adapter][adapter])                                           | `partial`  | V2 Build and compaction system replacements were removed. A real pinned-binary provider-request fixture proves native base guidance and the additive hook; configured addon digests alone do not prove application. The native loop owns planning and continuation. Agent selection, custom agents and native subagent integration remain unimplemented; the Keiko autonomy mode selects authority, not a native agent.                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| C02 | `commands`: built-in `init` and `review`, custom commands, MCP prompts as commands [B]                                              | none (the explicit skill token only)                                                                                                                  | `gap`      | Command shortcuts are a composer candidate in [audit-3560][audit-3560]. Server-authored prompts would be untrusted intent like any other task text.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| C03 | `instructions` and AGENTS.md discovery, global and walking up from the project; `init` [B]                                          | `AGENTS.md` at the task workspace root, attached to the first message as bounded initial context ([repository instructions][repository-instructions]) | `partial`  | Keiko reads exactly `AGENTS.md` at the task workspace root through the secure read helper, only while the run's own workspace is the active one, and attaches its first 800 lines, at most 16 KiB, as a nonce-framed, repository-authored, untrusted block that grants no authority; the frame's tag is neutralized in every other part of the first message. The helper reads bounded whole files up to 1 MiB; model read windows remain capped at 64 KiB and initial context at 16 KiB / 800 lines. Files above 1 MiB are refused as `too-large`. Not supported: global and walk-up discovery, `CLAUDE.md`, the `instructions` setting and `init`; OpenCode's own project layer stays switched off. On by default; `KEIKO_CODING_REPOSITORY_INSTRUCTIONS_ENABLED=false` opts out. Evidence: `coding-runtime.repository-instructions.context` (state, counts, whole-file digest, estimated tokens). |
| C04 | `mcp`: MCP servers, tools, OAuth and prompts (`opencode mcp add`, `list`, `auth`, `logout`) [B]                                     | none                                                                                                                                                  | `disabled` | Deferred by decision to #2287 (connector, plugin and MCP capability packs, [governed-tool-migration.md][migration]). Runtime-supplied tool definitions are transport data and cannot register a handler, effect or authority (ADR-0175 D2); the `*` deny rule blocks any MCP tool.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| C05 | `plugins`: npm and local plugins (`opencode plugin add`) [B]                                                                        | Only Keiko's generated plugin shim                                                                                                                    | `disabled` | Project configuration discovery is disabled and the package manager is offline (`npm_config_offline`); the shim lives in the private run directory with mode 0600.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| C06 | Project configuration: `opencode.json` and `.opencode/` directories [B]                                                             | none                                                                                                                                                  | `disabled` | `OPENCODE_DISABLE_PROJECT_CONFIG=true` gates the config service's project layer (verified in the bundle for AGENTS.md discovery; not individually for agents, commands, skills or MCP). Repository files are not meant to add authority-bearing configuration.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| C07 | `formatter`: built-in formatters after native edits [B]                                                                             | none                                                                                                                                                  | `gap`      | Low priority. Governed edits are applied verbatim; `lint` and `typecheck` verifiers exist but there is no `format` verifier id.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| C08 | External context: `references` and the `external_directory` permission [B]                                                          | none                                                                                                                                                  | `disabled` | Workspace escape is a mode-independent hard denial (ADR-0129 D3) and no external-file broker exists (ADR-0125 D2); every governed tool is workspace-contained.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

Runtime settings (`watcher`, `warming`, `username`, `shell`, `media`, `experimental`) require
separate service/configuration comparison; their omission from this table is not parity evidence.
Legacy tools absent from the pinned standalone baseline must be distinguished from actual native
capabilities when completing the final producer-derived inventory.

### 3.4 Summary

| Status     | Count |
| ---------- | ----- |
| `governed` | 12    |
| `partial`  | 16    |
| `disabled` | 13    |
| `gap`      | 8     |
| Total      | 49    |

## 4. Keiko capabilities without a native counterpart

These exist in the governed catalog or the runtime host and have no OpenCode 2.0.10 equivalent:

- `keiko_ci_status` observes the accepted run's CI readiness (`git.ci-observation`).
- Verification returns a commit-eligibility proof (`commitProof`) separately from the executed
  checks, and delivery runs propose first and redeem later with immutable receipts.
- Edits are bound to whole-file digests, applied as one atomic multi-file transaction and reviewed in
  Ask.
- Research uses request-scoped grants and content quarantine; repository search has a semantic
  rerank.
- Skills come from a server-approved catalog with budget-aware discovery.
- Issue context and Local Project Memory are attached as labelled, untrusted initial context.
- Every tool call leaves body-free activity-log evidence that `keiko support analyze` can
  reconstruct.

## 5. Gaps and candidates

Each entry lists the matrix rows it covers, a one-line proposal and the constraint it must respect.
The order is not a schedule. Any new model-visible tool also follows the checklist in section 2.

- **G1. General command execution and non-npm verification** (T10, T11). Preferred native-service
  increment: retain the pinned native `shell` executor and its test/repair orchestration, then bind
  supported permission hooks and the existing process boundary to the accepted workspace, command
  trust and envelope. Provision required toolchains explicitly and preserve redacted, bounded model
  diagnostics and truthful verification freshness. The current named npm command runner is narrower
  than native Shell and does not establish Java/Spring or other ecosystem parity. Merely allowing
  the tool cannot work: the current process profile permits only OpenCode and attested Git, and the
  gateway admits only its fixed catalog. Commands, cancellation, background descendants and native
  verification evidence must be qualified before production admission; do not build another coding
  planner or a parallel command policy to hide these gaps.
- **G2. File delete, rename and move** (T09). Proposal: add closed per-file operations to
  `keiko_changeset_edit`, materialized into the same hash-bound unified-diff changeset. Must respect:
  the atomic, fully preconditioned changeset and review in Ask (ADR-0125 D3); a risk class for
  deletes under ADR-0138 D2; the closed, all-required schema dialect, so any new argument changes the
  digests (ADR-0175 D3).
- **G3. Repository instruction files** (C03). Implemented for `AGENTS.md` at the task workspace
  root by PR #3876 (`partial` above): the server reads it through the secure read helper while the
  run's workspace is the active one and attaches it as bounded, nonce-framed, non-authority initial
  context with a body-free operation. PR #3895 admits whole files up to 1 MiB while keeping the
  initial context and model windows bounded (F18). Remaining: walk-up discovery, other instruction
  files and windows into files above 1 MiB. Must respect: initial context is untrusted and
  never authority (ADR-0137 D1); digests and counts only in logs (AGENTS.md section 8); denied
  sensitive paths (ADR-0129 D3).
- **G4. Code intelligence** (T20). Proposal: a read-only catalog tool (diagnostics, definition,
  references, symbols) that projects the managed language-service port; no second language-server
  process. Must respect: the governed process manager and executable allowlists (ADR-0069,
  ADR-0132); the ordinary Editor is no agent surface since 2026-10-03 (ADR-0061, ADR-0125
  retirement notes), so call the language-service port directly rather than the editor agent routes;
  one owner per responsibility (ADR-0175 D1).
- **G5. Git reads and hygiene** (T12). Proposal: bounded read-only `log`, `show` and `blame` plus an
  `unstage` proposal through the existing stage proposal path, with fetch and pull staying behind
  delivery approval. Must respect: Git Delivery admission, where fetch and pull have no kernel
  policy pack (ADR-0138 D3 item 5); propose-phase only, the model never mutates directly (ADR-0175
  D2); merge stays out of the model's reach (ADR-0087).
- **G6. Web search and research breadth** (T14, T15). Proposal: a governed search tool whose query is
  shown to and approved by the operator like the research request line, bounded PDF and Markdown
  extraction through the Local Knowledge parsers, and an owner decision on whether Full may mint
  grants itself (question Q1). Must respect: loopback-only runtime and egress only through Keiko-owned
  boundaries (ADR-0137 D6, ADR-0038); fetched content stays untrusted and no sanitiser may turn the
  quarantine into a filter (research threat model); the internet row of ADR-0138 D2; secret
  exfiltration is a hard denial (ADR-0129 D3), so the request line stays bound.
- **G7. Child agents** (T16). Proposal: let the read-only child use `keiko_repository_search` and
  `keiko_workspace_discover` and allow bounded parallel children; leave write-capable children to
  #2289. Must respect: the child envelope carries no mutation, command, delivery or connector
  authority; ADR-0175 D2 reserves `keiko.child.workspace.read` as the child's one tool, so additions
  need an identity reservation; every child call charges the parent budget.
- **G8. Skills** (T17). Proposal: implement handlers for the two defined categories, seed further
  read-only skills, and consider a human-reviewed admission path for repository-authored skills as
  untrusted text. Must respect: the server-approved catalog owns skill state and only the descriptor
  lives in the catalog package (ADR-0175 D1); skill metadata is an authority-smuggling channel
  (`skillCatalog.ts`); no remote skill download.
- **G9. Directory listing and glob discovery** (T02, T03). The existing Keiko workspace walker
  now supports bounded keyword, glob and directory discovery with explicit coverage facts; the
  Chat search subsystem is unchanged. This mapped path is not complete native Glob/Grep parity:
  glob patterns remain workspace-root-relative when a directory narrows walking, and native
  `hidden:false`, regex and offset semantics are not all represented. Prefer original pinned native
  Glob/Grep executors after digest-verified `rg` provisioning and exact process-exec admission, with
  canonical sensitive-path/realpath authority enforcement. Do not duplicate the recursive search
  subsystem or claim parity from an adapter with different semantics. Production native tools stay
  denied until gateway schema, containment, permission and result contracts are qualified.
- **G10. Overwriting and larger files** (T07). Proposal: a replace-whole-file edit guarded by
  `expectedContentHash`, so the model need not restate the old text. Must respect: the 65,536-byte
  patch and 50-file caps (ADR-0125 D3) and the run's patch budget of 262,144 bytes.
- **G11. Attachments and references** (S14, S15). Proposal: file references resolved server-side into
  digest-bound initial context, and images only after the model profile declares image input and the
  content class is bounded and redacted. Must respect: the gateway's closed text-only contract;
  evidence confidentiality (ADR-0048) and body-free evidence; validation through existing Keiko paths
  ([audit-3560][audit-3560]).
- **G12. Steering a running turn** (S07). Proposal: map a Workbench follow-up during an active turn
  to the V2 `delivery` field, which is inside the pinned surface. Must respect: one active run per BFF
  and authority revalidation before every delegation (ADR-0137 D2).
- **G13. Undo of run changes** (S04). Proposal: a Keiko-owned "undo run changes" action over the task
  worktree and change review instead of native revert. Must respect: edits only through the governed
  transaction (ADR-0125 D3); task-worktree ownership (ADR-0089); [audit-3560][audit-3560].
- **G14. Streaming** (S13). Implemented: the model profile selects native streaming for coding
  turns; readiness verifies fragmented function calls on that production response path. Buffered
  compatibility fallback remains explicit. Final live matrix qualification is pending. Authority
  is unchanged; stream resources and completion evidence settle before the terminal packet
  (AGENTS.md section 8), under gateway admission.
- **G15. Session continuity** (S02). Proposal: none beyond improving the bounded context restoration;
  fresh-runtime-per-turn is by design. Must respect: native resume lacks Keiko receipts and could
  carry stale authority ([audit-1517][audit-1517]).
- **G16. Command shortcuts and formatting** (C02, C07). Proposal: composer commands that expand to
  server-authored prompts, and an optional `format` verifier id. Must respect: the verifier ids are
  part of the digest-pinned visible schema (`OPENCODE_VERIFICATION_IDS`); prompts remain untrusted
  intent.
- **G17. Rich rendering** (S19). Proposal: render `latex` and `math` code blocks in the Workbench
  timeline, Mermaid optionally. Must respect: the design system, including component-scoped classes
  instead of `globals.css` edits (AGENTS.md section 9).

### Currently disabled surfaces (open native-parity acceptance items)

| Capability                                                             | Decision source                                                          | What would reopen it                                                                                                      |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| Todo tracking (T19)                                                    | ADR-0175 D2 (#3561)                                                      | An ADR amendment that admits a Keiko-owned plan carrier.                                                                  |
| MCP servers (C04)                                                      | #2287 deferral; ADR-0175 D2                                              | Original MCP client integration through the existing catalog, explicit effects and admitted egress policy.                |
| Native fork, resume and snapshots (S03, S04)                           | [audit-3560][audit-3560]; [audit-1517][audit-1517]                       | A Keiko-owned product action that keeps workspace and change-review ownership.                                            |
| Share, update, CLI surfaces (S05, S06, S18)                            | Local-first boundary; ADR-0121; ADR-0163 D6                              | Equivalent user-controlled Keiko product operation or original supported service path must be qualified.                  |
| Code mode and management tools (T21, T22)                              | ADR-0137 D4                                                              | Original native execute and management services must reuse the existing admitted effect and lifecycle owners.             |
| Background processes (T13)                                             | ADR-0137 D5; command runner security notes                               | A supervised long-running-process design with tree ownership proof.                                                       |
| Agents, plugins, project config, external context (C01, C05, C06, C08) | ADR-0163 D6; ADR-0175 D2; ADR-0129 D3 and ADR-0125 D2 (external context) | Supported original configuration/extension loading must stay inside the server-validated envelope; qualification is open. |

### Questions for the owner

- **Q1.** Full access is described as allowing internet work inside the validated envelope without
  per-action approval, yet `keiko_research_fetch` still needs an operator-approved grant per exact
  URL in every mode, because only an approved research ask mints a grant
  ([research-grants][research-grants]). Keep the per-URL grant in Full, or let the live envelope mint
  it?
- **Q2.** Which risk class applies to file deletion and move under ADR-0138 D2 (affects whether
  Supervised asks)? **Decided 2026-10-07:** the same `medium` risk as an edit, so Supervised does not
  ask (ADR-0138 D2, pinned per mode).
- **Q3.** Order of work between a governed command tool (G1) and the connector, plugin and MCP packs
  (#2287).

## 6. Documentation drift found while building this matrix

Historical drift and current corrections:

- The system prompt (`OPENCODE_GOVERNED_SYSTEM_PROMPT` in [profile][profile], and the V2 variant
  formerly derived from it) told the model to submit one strict unified diff and to use a `/dev/null` source
  diff for new files after the model-visible schema had taken replacements only (#3873). Corrected
  in the same pull request: the prompt now describes `changeset.edits`, whole-file reads batched in
  one turn, one edit call per decided change set, and fixing every verifier finding before
  re-verifying. That detailed replacement remains isolated to V1 compatibility; V2 now keeps the
  native base and applies only concise additive interface/authority and verification-freshness facts.
- The `changesetEditSpec` comment in [catalog][catalog] says every mode below Full parks the edit in
  the review panel; the code and ADR-0124 D6 apply Supervised edits without a per-edit decision
  (`editorReviewRequirement`, pinned by `productionManagedWorktreeTools.test.ts`).
- `OPENCODE_PINNED_BUILT_IN_TOOLS` lists V1 names (see section 2); its header comment should say that
  the `*` deny rule is what blocks the 2.0.10 names.
- OpenCode 1.18.30 is still cited in ADR-0137 D1, `docs/coding-runtime/dev-lane.md` and comments in
  `opencodeToolSchemas.ts`, `opencodeLaunchProfile.ts`, `opencodeProtocolSurface.ts`,
  `opencodeProtocol.ts` and `opencodeHttpClient.ts`. The 1.17.17 audit ([audit-1517][audit-1517])
  predates #3561 and treats `todowrite` as a native feature in use.
- `docs/coding-runtime/research-content-threat-model.md` names `keiko_command` as a mutation-capable
  tool; no such tool is offered (T11).
- The lab record `docs/qa/coding-workbench-gemma-litellm-lab.md` files finding F3 (math notation
  shown verbatim) under #3874; this matrix covers it as S19.

## 7. Verification sources

Repository files read for this matrix (paths relative to the repository root):

- Pinned protocol and tools:
  `packages/keiko-server/src/coding-runtime/opencodeProtocolSurface.opencode-2.0.10.fixture.json`,
  `packages/keiko-server/src/coding-runtime/opencodeToolSchemas.opencode-2.0.10-advertised.fixture.json`,
  `packages/keiko-server/src/coding-runtime/opencodeToolSchemas.ts`,
  `packages/keiko-server/src/coding-runtime/opencodeProtocolSurface.ts`,
  `packages/keiko-server/src/coding-runtime/opencodeV2HttpClient.ts`,
  `packages/keiko-server/src/coding-runtime/opencodeV2Questions.ts`,
  `portable-runtime-approvals.json`.
- Config, plugin generation and launch:
  `packages/keiko-server/src/coding-runtime/opencodeRuntimeAdapter.ts`,
  `packages/keiko-server/src/coding-runtime/opencodeLaunchProfile.ts` (and its test),
  `packages/keiko-server/src/coding-runtime/opencodeRuntimeComposition.ts`,
  `packages/keiko-tool-catalog/src/opencode.ts`,
  `packages/keiko-server/src/coding-sidecar-gateway.ts`.
- Tool facade, authority and ports:
  `packages/keiko-server/src/coding-runtime/codingToolIpc.ts`,
  `codingToolFacade.ts`, `codingToolGovernedDelegate.ts`, `codingToolAuthorityPort.ts` (and its test),
  `codingToolApprovalBridge.ts`, `codingToolReadEditPorts.ts`, `codingToolReplacementEdits.ts`,
  `codingRuntimeGitIpc.ts`, `gitOperationRequirements.ts`, `productionManagedWorktreeTools.ts` (and
  its test), `productionRuntimeWorkspaceAuthority.ts`, `runtimeAuthorityService.ts`,
  `productionCodingRuntimeResolver.ts`, `codingRuntimeActivityOperations.ts`,
  `codingRuntimeProjectMemory.ts`, `researchEgressPort.ts`, `researchApprovalIssuance.ts`,
  `researchGrantRegistry.ts`, `skillCatalog.ts`, `skillInvocationPort.ts`,
  `explicitSkillInvocation.ts`, `readOnlyChildOrchestrator.ts`, `productionReadOnlyChildRunner.ts`
  (all under `packages/keiko-server/src/coding-runtime/`),
  `packages/keiko-server/src/tool-catalog/catalogToolFacadeBridge.ts`,
  `packages/keiko-server/src/editor/agentRoutes.ts`.
- Verification and contracts: `packages/keiko-verification/src/detect.ts`,
  `packages/keiko-verification/src/dependencies.ts`,
  `packages/keiko-contracts/src/editor-agent.ts`,
  `packages/keiko-contracts/src/coding-repository-search.ts`,
  `packages/keiko-contracts/src/tools.ts`.
- Records: ADR-0043, ADR-0124, ADR-0125, ADR-0129, ADR-0137, ADR-0138, ADR-0147, ADR-0163 and
  ADR-0175 under `docs/adr/`; `docs/architecture/governed-tool-migration.md`;
  `docs/qa/opencode-native-quality-audit.md`; `docs/qa/coding-workbench-audit-3560.md`;
  `docs/qa/coding-workbench-gemma-litellm-lab.md`; `docs/coding-runtime/research-content-threat-model.md`;
  `docs/coding-runtime/dev-lane.md`; `docs/command-runner/security-notes.md`;
  `docs/observability/op-catalog.generated.json`;
  `tests/e2e/code-task-research-skills-subagents.spec.ts`.

Staged-binary checks [B], run with a private `HOME` and XDG roots so nothing is written under the real
home. The executable is staged by `npm run dev:coding-runtime:stage`:

```sh
OC=.portable-sidecar-payloads/<target>/opencode-compatible/payload/bin/opencode
"$OC" --version                      # opencode v2.0.10
"$OC" --help                         # subcommands and flags
"$OC" mcp --help                     # likewise: plugin, session, debug, run, serve
grep -a -o -E 'id:"opencode\.[A-Za-z0-9._-]+"' "$OC" | sort -u   # native plugin ids
grep -a -o -E 'tool\.transform\(\([A-Za-z_$]+\)=>[A-Za-z_$]+\.add\(\{name:[^,]{1,40},' "$OC"
```

The last command lists the tool registrations; each minified name constant resolves with
`grep -a -o -E '(var |,|;)<constant>="[A-Za-z_]+"' "$OC"`. The bundle is plain text inside the
executable, so a fixed-string `grep -a -b -o -F` finds a byte offset and `dd` reads its context.
Offsets and constant names change with every build; the plugin ids and tool names are the stable
facts.

[adr-0088]: ../adr/ADR-0088-task-workspace-domain-contract.md
[adr-0089]: ../adr/ADR-0089-managed-task-worktree-provisioning.md
[adr-0124]: ../adr/ADR-0124-coding-autonomy-modes-and-sidecar-runtime-authority.md
[adr-0125]: ../adr/ADR-0125-governed-agent-docking-and-editor-changesets.md
[adr-0129]: ../adr/ADR-0129-product-wide-authority-and-autonomy-model.md
[adr-0138]: ../adr/ADR-0138-monotonic-product-wide-autonomy-semantics-and-code-task-terminology.md
[adr-0163]: ../adr/ADR-0163-self-contained-release-qualified-coding-runtime.md
[adr-0175]: ../adr/ADR-0175-canonical-governed-tool-catalog.md
[audit-1517]: opencode-native-quality-audit.md
[audit-3560]: coding-workbench-audit-3560.md
[migration]: ../architecture/governed-tool-migration.md
[adapter]: ../../packages/keiko-server/src/coding-runtime/opencodeRuntimeAdapter.ts
[authority-port]: ../../packages/keiko-server/src/coding-runtime/codingToolAuthorityPort.ts
[bridge]: ../../packages/keiko-server/src/tool-catalog/catalogToolFacadeBridge.ts
[catalog]: ../../packages/keiko-tool-catalog/src/opencode.ts
[child]: ../../packages/keiko-server/src/coding-runtime/readOnlyChildOrchestrator.ts
[composition]: ../../packages/keiko-server/src/coding-runtime/opencodeRuntimeComposition.ts
[file-creation-test]: ../../packages/keiko-server/src/coding-runtime/codingToolFileCreation.test.ts
[gateway]: ../../packages/keiko-server/src/coding-sidecar-gateway.ts
[git-ipc]: ../../packages/keiko-server/src/coding-runtime/codingRuntimeGitIpc.ts
[ipc]: ../../packages/keiko-server/src/coding-runtime/codingToolIpc.ts
[managed-tools]: ../../packages/keiko-server/src/coding-runtime/productionManagedWorktreeTools.ts
[profile]: ../../packages/keiko-server/src/coding-runtime/opencodeLaunchProfile.ts
[project-memory]: ../../packages/keiko-server/src/coding-runtime/codingRuntimeProjectMemory.ts
[repository-instructions]: ../../packages/keiko-server/src/coding-runtime/codingRuntimeRepositoryInstructions.ts
[protocol-fixture]: ../../packages/keiko-server/src/coding-runtime/opencodeProtocolSurface.opencode-2.0.10.fixture.json
[protocol-surface]: ../../packages/keiko-server/src/coding-runtime/opencodeProtocolSurface.ts
[questions]: ../../packages/keiko-server/src/coding-runtime/opencodeV2Questions.ts
[read-edit]: ../../packages/keiko-server/src/coding-runtime/codingToolReadEditPorts.ts
[replacements]: ../../packages/keiko-server/src/coding-runtime/codingToolReplacementEdits.ts
[research-grants]: ../../packages/keiko-server/src/coding-runtime/researchApprovalIssuance.ts
[research-port]: ../../packages/keiko-server/src/coding-runtime/researchEgressPort.ts
[schemas]: ../../packages/keiko-server/src/coding-runtime/opencodeToolSchemas.ts
[secure-read]: ../../packages/keiko-server/src/coding-runtime/secureWorkspaceTextRead.ts
[skill-catalog]: ../../packages/keiko-server/src/coding-runtime/skillCatalog.ts
[tools-fixture]: ../../packages/keiko-server/src/coding-runtime/opencodeToolSchemas.opencode-2.0.10-advertised.fixture.json
[v2-client]: ../../packages/keiko-server/src/coding-runtime/opencodeV2HttpClient.ts
[verify-detect]: ../../packages/keiko-verification/src/detect.ts
