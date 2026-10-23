# OpenCode capability parity matrix

Status: working inventory for [#3874](https://github.com/oscharko-dev/Keiko/issues/3874) and epic
[#3897](https://github.com/oscharko-dev/Keiko/issues/3897), refreshed 2026-10-23 against the
working tree of PR oscharko-dev/Keiko#4064. Pinned runtime: OpenCode 2.1.4 (`OPENCODE_PINNED_VERSION`,
commit `68bc26b7`, [versions][versions]); 2.0.10 stays admissible only until npm runtime packages
built from 2.1.4 are published. Executed heads and pending qualification are recorded separately in
the live lab ledger ([lab][lab]). This document does not qualify an unexecuted current head, and no
row records a run of the opt-in real-binary suites on the current head.

## Purpose

Issue #3874 asks for a matrix of what OpenCode can do against what the Coding Workbench offers.
Owner direction of 2026-10-23 ([ADR-0137][adr-0137] D10): the Workbench offers the original OpenCode
service as it runs standalone, and Keiko is the foundation around it (Git delivery, the Model
Gateway, later MCP, the UI). The only functions that may be unavailable are the ones that depend on
outbound internet or on other servers at a firewalled customer. Every other standalone function that
is narrower, switched off or missing here is an open acceptance item. A slow Model Gateway response
is absorbed by Keiko's gateway (S10), not by shortening the runtime's patience.

Two tool profiles exist, selected only by the server (`productionOpenCodeToolProfile`,
[deps][deps]):

- **Native profile (macOS).** The original OpenCode tools, agents and configuration run in the
  pinned service. Keiko binds the autonomy mode, the live Authority Envelope and the hard denials
  through the supported permission hook and the kernel (Seatbelt) boundary.
- **Mapped profile (`direct`; Linux and Windows).** OpenCode's native workspace tools are denied and
  the model sees 18 tools: native `question` plus 17 governed `keiko_*` tools. It stays in force
  where no native boundary is qualified. The `code-mode` mapped profile exists only for tests and an
  explicit server selection.

Statuses in section 3 describe the **native profile on macOS**. Notes marked "Mapped" state what the
mapped profile offers on Linux and Windows; those statements are carried over from the 2026-10-08
revision and were not re-verified in this refresh. The three autonomy modes, the Authority Envelope and the
mode-independent hard denials remain Keiko-owned ([ADR-0124][adr-0124], [ADR-0125][adr-0125],
[ADR-0129][adr-0129], [ADR-0138][adr-0138]); native permissions cannot widen them. Chat repository
search and its recursive search subsystem are retained unchanged.

Earlier revisions of this document tracked inactive private seam controls (a guarded Read helper,
instruction discovery fixtures, an inactive native host) as prerequisites of native Read. The native
profile supersedes that route: the original tools run in the service under the permission hook and
the kernel boundary, so those paragraphs were removed. The matrix grants no authority and adds no
behaviour. It refreshes, for 2.1.4, the comparison in
[coding-workbench-audit-3560.md][audit-3560]; the older
[opencode-native-quality-audit.md][audit-1517] remains the record for 1.17.17.

## 1. How to read this document

### Status values

| Status     | Meaning                                                                                                                                                                                                               |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `governed` | Available under Keiko's boundaries (mode policy, live-authority revalidation, kernel confinement): the original native capability on the native profile, a mapped equivalent elsewhere. A test is named in the notes. |
| `partial`  | Available but narrower than standalone, or only partly verified; the limits or the unverified part are named in the notes.                                                                                            |
| `disabled` | Switched off or unreachable for a named boundary; not a permanent veto, and an open acceptance item.                                                                                                                  |
| `gap`      | No integration yet. Usually a missing Keiko API, admitted endpoint or UI surface for a capability the runtime has; required work for complete parity.                                                                 |

### Evidence tags

| Tag | Meaning                                                                                                                                                                                                                                                                                                                                                                                         |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [R] | Pinned in this repository: code, fixtures, unit and kernel tests, ADRs, QA records.                                                                                                                                                                                                                                                                                                             |
| [B] | Verified against the pinned 2.1.4 executable: the producer-derived capture of its tools ([native-tools-fixture][native-tools-fixture]), the opt-in real-binary suites (`*.real.test.ts`, skipped unless `KEIKO_OPENCODE_REAL_BINARY` and `KEIKO_OPENCODE_REAL_RESOURCE_ROOT` are set), or this review's read-only inspection of the staged binary (`--version`, `--help`, embedded plugin ids). |
| [G] | General knowledge of OpenCode 2.x, not verified here. No row below rests on [G] alone.                                                                                                                                                                                                                                                                                                          |

### Mode summary used in the notes

Abbreviations: Ask = Ask for approval (`governed-assist`), Supervised = Supervised workspace
(`supervised-coding`), Full = Full access (`autonomous-delivery`). The shared policy is the total,
monotonic matrix of [ADR-0138][adr-0138] D2:

| Mode       | Workspace-contained, low or medium risk | Workspace-contained, high or critical risk | Internet          | Delivery                                                                                                                                              |
| ---------- | --------------------------------------- | ------------------------------------------ | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ask        | approval-required                       | approval-required                          | approval-required | approval-required                                                                                                                                     |
| Supervised | allowed                                 | approval-required                          | approval-required | approval-required                                                                                                                                     |
| Full       | allowed                                 | allowed                                    | allowed           | approval-required; Code-task commit, push and draft-PR execute are authorized by the live envelope (ADR-0138 D3 item 5); merge is never model-visible |

Reads and planning are allowed in every mode (ADR-0124 D1). Two reminders apply to every row. A
matrix cell is a ceiling, not a capability: it applies only where an execution path exists
(ADR-0138 D2, availability clarification). The hard denials hold in every mode (ADR-0129 D3):
invalid or expired authority, workspace escape, denied sensitive paths, secret exfiltration,
unsupported actions, exhausted budgets and platform restrictions.

### How the native policy maps actions onto that matrix

`decideOpenCodeNativePolicy` ([native-policy][native-policy]) classifies each permission the runtime
evaluates. [native-policy-test][native-policy-test] pins these classifications; `skill`, `question`,
`list` and `doom_loop` share the read set without an assertion of their own.

| Native permission                                                                                                           | Classification                     | Ask     | Supervised | Full    |
| --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | ------- | ---------- | ------- |
| `read`, `list`, `glob` and `grep` (the searched directory is checked), `skill`, `subagent`, `question`, `todo`, `doom_loop` | workspace read                     | allowed | allowed    | allowed |
| `edit` (the `edit`, `write` and `patch` tools)                                                                              | workspace-contained, medium        | asks    | allowed    | allowed |
| `shell`, vetted (package scripts, tests, type checks, linters, builds, read-only Git and file inspection)                   | workspace-contained, low           | asks    | allowed    | allowed |
| `shell`, any other command                                                                                                  | workspace-contained, high          | asks    | asks       | allowed |
| `webfetch`, `websearch`                                                                                                     | internet                           | refused | refused    | allowed |
| plan-directory read or edit (the plan agent's notes)                                                                        | planning                           | allowed | allowed    | allowed |
| `external_directory` outside the plan directory, a path outside the workspace                                               | hard denial (`workspace-escape`)   | refused | refused    | refused |
| `.env`, keys and other credential-named paths                                                                               | hard denial (`sensitive-path`)     | refused | refused    | refused |
| Git delivery or `gh pr`, `repo`, `release`, `api` through the shell                                                         | hard denial (`delivery-reserved`)  | refused | refused    | refused |
| Code Mode `opencode_session_move`, `opencode_worktree_create`; any unclassified action                                      | hard denial (`unsupported-action`) | refused | refused    | refused |

Internet below Full is refused at once, with an explanation, because the kernel profile has no route
outside the machine; see Q5 and section 6.

## 2. How Keiko runs OpenCode 2.1.4 today

All points are [R] unless tagged.

- **Profile.** `productionOpenCodeToolProfile` returns `native` on macOS and `direct` elsewhere; no
  request field selects it. The audited Linux mount plan still let a shell child read a workspace
  `.env` and a fresh network namespace could not reach the host-loopback gateway, and Windows has no
  native filesystem boundary yet, so both Linux wrappers refuse a native plan
  (`native-linux-backend-unqualified`, [backends][backends]; #3901).
- **Launch.** `buildOpenCodeLaunchProfile` ([profile][profile]) starts
  `opencode serve --hostname 127.0.0.1 --port 0` with a per-run password and a private `HOME`, XDG
  roots and `OPENCODE_DB` under the run's state root. `OPENCODE_CONFIG_DIR` names the run's private
  configuration directory, `OPENCODE_DISABLE_PROJECT_CONFIG=true` switches the repository layer off
  for every profile (#3903) and `npm_config_offline=true` keeps the package manager offline. The
  native child inherits only `PATH`, locale, `TZ`, `TERM` and `SHELL` from the launcher
  ([backend][backend]); a mapped child inherits `PATH` only to carry the verified ripgrep directory.
- **Native configuration.** `createNativeOpenCodeV2Config` sets `update: "disable"`,
  `share: "disabled"`, `snapshots: true`, one provider `keiko-runtime` with one model alias `coding`
  (text input and output, tool calling on, limits from the admitted gateway geometry, a 30-minute
  provider chunk timeout so a slow reasoning turn is not cut by the runtime while the gateway keeps
  its own deadline), `default_agent: "build"`, native auto-compaction sized from that geometry,
  `tool_output.max_bytes` of 262,144, and exactly one permission rule family: `external_directory`
  is denied except the run's plan directory. No rule names an ordinary action, because the producer
  appends configured rules after each built-in agent's own and the last match wins; every built-in
  agent keeps its own rules (ADR-0137 D10). The server-owned subset (`update`, `share`, `model`,
  `default_agent`, `providers`, `permissions`) is also passed as `OPENCODE_CONFIG_CONTENT`, which the
  producer merges last.
- **Policy hook.** The generated plugin `keiko.native-policy` ([plugin][native-policy-plugin])
  registers the supported `permission.evaluate` hook and asks the server-owned policy for the final
  effect of every evaluated action. It can only keep or narrow the configured effect; a missing,
  failed or oversized answer denies, and so does a resource list over 64 entries of 2,048
  characters. Its shell hook strips the server password and every `KEIKO_*` binding from each shell
  the agent starts; its `execute.before` hook decides the two state-changing Code Mode tools.
  A run is ready only once `GET /api/plugin` reports both generated plugins (`keiko.native-policy`,
  `keiko.native-context`) active within 10 seconds ([readiness][native-readiness]).
- **Live authority.** After the policy (and any human decision) allows an effect, the native-effect
  owner revalidates the run's capability, the envelope's action classes and the cumulative
  tool-call budget, one call per native invocation, child sessions included
  ([native-effect][native-effect]).
- **Protocol.** 15 operations on 14 paths are admitted and the structural digest is pinned per
  version ([protocol-surface][protocol-surface], [protocol fixture][protocol-fixture]): runtime
  info, session list and create, active session, message history, prompt, interrupt, agent switch
  (`session.switchAgent`), permission list and reply, plugin list, form list, reply and cancel, and
  the event stream. No fork, revert, command or share operation is admitted. The V2 client
  ([v2-client][v2-client]) sends a prompt `text` and `metadata` only.
- **Network.** The kernel decides, by effective mode: below Full the process tree reaches loopback
  only (the Model Gateway, the tool facade, local dev servers), with unix-socket peers and DNS
  denied; at Full egress is inherited and bounded by the Authority Envelope and the per-action
  policy (`nativeEgress`, [backend][backend]).
- **Filesystem and process boundary.** The `keiko-native` Seatbelt profile
  ([backends][backends], [seatbelt-root][seatbelt-root]) is a read allowlist (the task workspace,
  the run's private state, the runtime payload, system software and toolchain roots derived from the
  launcher's `PATH`), with writes limited to the workspace and the private state. The run's
  configuration directory (policy plugin and settings) is read-only to every descendant. Credential
  stores, credential-named files and Keiko's own state are unreadable, and signals and process
  information reach the tree's own sandbox only. Real-kernel proofs: [runtime-gateway.test.ts][kernel-test].
- **Search.** OpenCode's `glob`, `grep` and file finder run ripgrep. Keiko ships the pinned 15.1.0
  release, verifies its SHA-256 at every launch and puts only that directory in front of the child
  `PATH`, so the runtime never downloads one ([ripgrep-runtime][ripgrep-runtime],
  [ripgrep-launch][ripgrep-launch], [evidence][ripgrep-evidence]).
- **Context.** Native Build guidance stays intact; the additive `keiko.native-context` hook tells
  the agent that Git delivery belongs to Keiko and that a refusal is a policy decision
  ([native context](../../packages/keiko-server/src/coding-runtime/opencodeNativeContext.ts)).
- **Mapped profile (Linux, Windows).** The default direct profile advertises 18 tools: native
  `question` plus 17 `keiko_*` tools ([advertised fixture][tools-fixture]). The Model Gateway
  refuses a request that declares a different tool set (`tool-contract-drift`,
  [gateway][gateway]); on the native profile it forwards the runtime's own bounded advertisement as
  data (at most 128 admissible names, 64 KiB per schema, 512 KiB in all, [native-tools][native-tools]).
  The optional `keiko_research_fetch`, `keiko_skill_discover`, `keiko_skill` and
  `keiko_child_agent` appear only while their prerequisites are ready
  (`deriveOptionalToolAvailability`, [managed-tools][managed-tools]).

**Adding a mapped Keiko capability** takes all of the following together: a descriptor and alias in
the catalog ([catalog][catalog], identity reserved under ADR-0175 D2), a server handler bound to a
facade action, a generated plugin source ([adapter][adapter]), an updated exact tool contract and
digests ([schemas][schemas]), registered activity-log operations (AGENTS.md section 8,
`npm run generate:op-catalog`) and a mode policy mapping (ADR-0138 D2). Runtime-supplied tool
definitions are transport data and cannot register a descriptor, handler, effect or authority
(ADR-0175 D2). The native profile adds nothing per tool: a routine upgrade regenerates the
producer-derived fixture, its compatibility diff names every added or removed tool and permission
action, and the policy must classify each permission action or the hook refuses it.

## 3. Capability matrix

Native tool names are the ones the 2.1.4 producer registers [B] ([native-tools-fixture][native-tools-fixture]):
`read`, `glob`, `grep`, `edit`, `write`, `patch`, `shell`, `webfetch`, `websearch`, `skill`,
`subagent`, `question` and `todo`, plus the Code Mode tool `execute` with eight nested
`opencode_*` management tools. There is no `list` tool (a directory is read with `read`) and no
`lsp` tool.

### 3.1 Model-visible tools

| #   | OpenCode 2.1.4 capability                                                                                                      | Keiko integration (native on macOS; mapped on Linux and Windows)                                                                                               | Status     | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --- | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T01 | `read`: file contents with `offset` and `limit` [B]                                                                            | Native `read` under the policy hook; mapped: `keiko_workspace_read` ([schemas][schemas], [read-edit][read-edit])                                               | `governed` | Allowed in every mode. The hook refuses a path outside the workspace (`workspace-escape`) and a protected file (`sensitive-path`); the kernel read allowlist and the credential-name rules refuse the same files, a symlink to an outside file included, for any descendant ([kernel-test][kernel-test]). Real binary: a read goes through the hook and returns the file, and an external read is refused by the configured `external_directory` deny before the hook is asked ([boundary-test][boundary-test]). Mapped: windows of at most 5,000 lines and 64 KiB, bound to the whole-file SHA-256 (`partial`).                                                                                                                                                                                   |
| T02 | `read` of a directory (2.1.4 has no `list` tool; `list` is a permission action only) [B]                                       | Native `read`; mapped: `keiko_workspace_discover` directory mode                                                                                               | `partial`  | The same permission path and classification as T01 (`list` is a read too), but no test lists a directory through the real binary. Mapped: bounded immediate entries with explicit coverage and truncation facts (`partial`); denied and ignored paths stay excluded.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| T03 | `glob`: path search by pattern, `hidden`, `limit` [B]                                                                          | Native `glob` on the pinned ripgrep; mapped: `keiko_workspace_discover` glob mode                                                                              | `governed` | Allowed in every mode; the hook checks the searched directory, not the pattern. The pinned ripgrep 15.1.0 is digest-verified at every launch and is the only `rg` on the child `PATH`, so search works offline ([ripgrep-launch][ripgrep-launch]). Real binary: files are found with loopback-only networking and nothing is downloaded; with no verified ripgrep the run still starts, search returns nothing and nothing is downloaded ([ripgrep-test][ripgrep-test]); the closed reason is logged as `coding-runtime.ripgrep.resolved`. Mapped: workspace-root-relative patterns and bounded walks (`partial`).                                                                                                                                                                                 |
| T04 | `grep`: regex or literal content search with `include`, `path`, `caseSensitive`, `limit` [B]                                   | Native `grep` on the pinned ripgrep; mapped: `keiko_repository_search` ([schemas][schemas])                                                                    | `governed` | Same gate, same ripgrep and same real-binary proof as T03 (text found with its file name, no download). Chat repository search is unchanged. Mapped: lexical, literal, regex (bounded, ReDoS-safe) and symbol modes, 50 hits, 64 KiB, with a semantic rerank when an index exists (`partial`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| T05 | `edit`: exact-text replacement with `replaceAll` [B]                                                                           | Native `edit`; mapped: `keiko_changeset_edit` ([replacements][replacements])                                                                                   | `governed` | Workspace-contained, medium risk: Ask asks, Supervised and Full allow. In Ask the review names the target paths only, not the change body (`nativeAction`, [review UI][review-ui]); the mapped profile reviews the exact diff. Edit, write and patch arguments reach the runtime byte for byte (#4009). Each released effect is revalidated against live authority and charged to the tool-call budget. Real binary: an edit through the hook changes the file ([boundary-test][boundary-test]). Evidence: `coding-runtime.native-policy.decided`. Mapped: whole-file digests and one atomic multi-file transaction (`governed`).                                                                                                                                                                  |
| T06 | `write`: create a file [B]                                                                                                     | Native `write`; mapped: `keiko_changeset_edit` with an empty `oldString` ([file-creation-test][file-creation-test])                                            | `governed` | Same classification as T05 (`write` is an `edit` permission). Real binary: `write` creates the plan agent's file in the run's plan directory and replaces a workspace file; a new workspace file and automatic parent directories are not separately exercised. Mapped: `governed`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| T07 | `write`: overwrite an existing file [B]                                                                                        | Native `write`; mapped: restate the whole file as `oldString`                                                                                                  | `governed` | Real binary: Build's `write` replaces the whole content of a workspace file ([boundary-test][boundary-test]). Mapped: no overwrite form, the changeset diff is capped at 65,536 bytes and 50 files (`partial`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| T08 | `patch`: add, update, delete and move files through a patch envelope [B]                                                       | Native `patch` (an `edit` permission); mapped: `keiko_changeset_edit`                                                                                          | `partial`  | Registered and classified like `edit`, confined by the same boundary, but no test executes it, and the source comment in [native-tools][native-tools] records that the real-binary suite observed it registered but not advertised for the `coding` alias (not pinned by an assertion). Delete and move are reachable through `shell` (T09).                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| T09 | Delete, move and rename files (`patch`, `shell` `rm` and `mv`) [B]                                                             | Native `shell`; mapped: `keiko_changeset_edit` `changeset.deletions` and `changeset.renames`                                                                   | `governed` | `rm` and `mv` are unvetted commands: Ask and Supervised ask, Full allows. Real binary: the same shell command succeeds in the workspace and is refused by the kernel for the policy plugin's configuration directory, and the control without the protected root shows `rm` and `mv` succeeding there ([boundary-test][boundary-test]). Mapped: one hash-bound changeset at medium risk, refused above 2,000 changed lines or 65,536 bytes (`partial`).                                                                                                                                                                                                                                                                                                                                            |
| T10 | `shell`: run project verification (tests, typecheck, lint, build) [B]                                                          | Native `shell`; mapped: `keiko_verification` ([verify-detect][verify-detect])                                                                                  | `governed` | Vetted project commands run without asking in Supervised and Full, Ask asks. A Supervised native run executed `npm run lint` and received its findings ([lab][lab], 2026-10-23); the kernel suite runs `npm` and `node` from the workspace under the read boundary. Other toolchains (Maven, Gradle, Cargo, Go, make, pytest) are classified as vetted by name and run where the launcher's `PATH` exposes their install prefix to the kernel; no test runs one. Below Full the kernel allows loopback only, so a dependency download needs a warm cache or a loopback registry. The workspace script-trust grant (ADR-0147) and `commitProof` belong to `keiko_verification` and are not consulted by the native policy. Mapped: npm scripts only (`partial`).                                    |
| T11 | `shell`: any other command (installs, other toolchains, code generation, scripts) [B]                                          | Native `shell`; mapped: none                                                                                                                                   | `governed` | Vetted commands are low risk, every other command high risk (Ask and Supervised ask, Full allows); Git delivery is refused (T12). The shell loses the server password and every `KEIKO_*` binding. Kernel proofs for the shell and its descendants: workspace writes work; credential stores, `.env`-class files and Keiko's state are refused; below Full every non-loopback destination, DNS and unix socket is refused, and at Full the destination is open ([kernel-test][kernel-test]). Mapped: no command tool is offered (`gap`).                                                                                                                                                                                                                                                           |
| T12 | `shell`: Git through the CLI (status, diff, add, commit, push, pull request) [B]                                               | Native `shell` for reads and `git add`; mapped: `keiko_git_*` proposals redeemed by `keiko_git_execute` ([git-ipc][git-ipc], [authority-port][authority-port]) | `partial`  | Read-only Git (`status`, `diff`, `log`, `show`, `blame`, ...) runs as vetted; `git add` is an ordinary unvetted command. `commit`, `push`, `pull`, `fetch`, `merge`, `rebase`, `reset`, `checkout`, `switch`, branch, tag, remote, stash, `worktree` and `submodule` writes, and `gh pr`, `repo`, `release`, `api` are refused in every mode, also through `env`, `exec`, paths, `git -C` and quoted sub-shells ([native-policy-test][native-policy-test]). Keiko's delivery tools are mapped-profile only, the native profile registers no Keiko tool, and no route starts a commit, push or draft PR for a native run, although the mode descriptions state that Keiko performs them after approval. Backlog B1. Mapped: propose and redeem, wire limited to status, diff and stage (`partial`). |
| T13 | `shell`: background and long-running processes such as dev servers and watchers [B]                                            | Native `shell`; mapped: none                                                                                                                                   | `partial`  | Kernel and tree ownership allow it: below Full a local server may bind and be reached on loopback, descendants are signalled and reaped only inside the run's own sandbox, and Stop cancels the tree ([kernel-test][kernel-test]; ADR-0137 D5). No test starts a watcher or dev server through the native `shell`, and whether 2.1.4's `shell` runs a command in the background is unverified. Mapped: bounded runs only (`disabled`).                                                                                                                                                                                                                                                                                                                                                             |
| T14 | `webfetch`: fetch a URL as text, markdown or html with a timeout [B]                                                           | Native `webfetch`; mapped: `keiko_research_fetch` ([research-port][research-port], [research-grants][research-grants])                                         | `partial`  | Full access only. Below Full the policy refuses at once with an explanation and the kernel allows loopback only; at Full the policy allows (internet scope, medium risk), egress is inherited and the Authority Envelope bounds it, and no per-URL grant applies. The tool itself is not exercised by a real-binary test, and at a firewalled customer it is unavailable by design. Mapped: one exact https URL, an operator-approved grant per URL in every mode, 2 MB read, 64 KiB result (`partial`).                                                                                                                                                                                                                                                                                           |
| T15 | `websearch`: providers exa, firecrawl, parallel, tavily and tinyfish [B]                                                       | Native `websearch`; mapped: none                                                                                                                               | `partial`  | Same gate as T14. The 2.1.4 bundle ships the five provider plugins (`opencode.websearch.*`) [B]; Keiko configures none, and whether the tool is usable at Full access is unverified. Mapped: none (`gap`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| T16 | `subagent`: named agents (`general`, `explore`), background runs, nesting [B]                                                  | Native `subagent`; mapped: `keiko_child_agent` ([child][child])                                                                                                | `partial`  | A read-class action, allowed in every mode. A child session is admitted only when its `parentID` chain reaches the run's session within eight steps inside the run's workspace; its asks take the parent's mode, policy, approval lane and budget (`nativeSessionDescendsFromRun`, unit-tested; ADR-0137 D10). Real binary: `general` cannot launch subagents and `explore` cannot edit or execute. No test runs a subagent end to end, and history reads the run's one session, so the child's own messages are not in the timeline. Mapped: one read-only layer with one child tool (`partial`).                                                                                                                                                                                                 |
| T17 | `skill`: skills from configured sources, including remote indexes [B]                                                          | Native `skill` (read class); mapped: `keiko_skill_discover` and `keiko_skill` ([skill-catalog][skill-catalog])                                                 | `disabled` | No native skill source is populated: repository skills (`.opencode/skills`, `.claude/skills`) are part of the project layer that stays off until #3903 admits individual items, the private `HOME` holds none, and a remote index needs outbound internet. Not verified against the real binary. Mapped: a server-approved read-only catalog seeded with one skill (`partial`).                                                                                                                                                                                                                                                                                                                                                                                                                    |
| T18 | `question`: structured questions to the operator [B] [R]                                                                       | Native `question` mapped to Workbench questions ([questions][questions])                                                                                       | `governed` | V2 forms are listed, answered or rejected through the admitted form endpoints and the Workbench question port; at most 32 fields and options, hidden, conditional or external fields refused. Questions are distinct from permission approvals. Evidence: `coding-runtime.native-question.observed`. Same on both profiles.                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| T19 | `todo`: the merged `todowrite` and `todoread` [B]                                                                              | Native `todo` (read class), projected as the plan card                                                                                                         | `partial`  | A `todo` part projects as the governed plan snapshot, never as productive tool activity (#2480, [safe-activity][safe-activity]); the timeline shows it as a plan card with progress. Whether the runtime advertises `todo` for the `coding` alias is unverified: the source comment in [native-tools][native-tools] says the real-binary suite saw it registered but not advertised, and no assertion pins that. Mapped: none (`disabled`, ADR-0175 D2).                                                                                                                                                                                                                                                                                                                                           |
| T20 | `lsp`: language-server intelligence [B]                                                                                        | none                                                                                                                                                           | `gap`      | The 2.1.4 producer registers no `lsp` tool (no `opencode.tool.lsp` plugin in the bundle) [B]. Its `lsp` configuration, whether language servers can start under the Seatbelt profile, and how their diagnostics would reach the timeline are unverified, and Keiko configures none. Keiko's managed language service (ADR-0069, ADR-0132) serves the human-operated Editor only. Backlog B7.                                                                                                                                                                                                                                                                                                                                                                                                       |
| T21 | Code Mode `execute`: model-authored JavaScript calling namespaced tools [B]                                                    | Native `execute`; mapped: not offered                                                                                                                          | `governed` | Offered beside the ordinary tools; the catalog lists exactly the eight `opencode.*` management tools and not `read`, `edit`, `shell` or `write`. The runtime evaluates no permission for the `execute` call itself, so no mode gate applies to a script; its reach is bounded by the confined interpreter (no process, environment or module access), the kernel egress rule for `fetch` (loopback below Full, an external destination fails with EPERM) and the nested tools (T22). A thrown program is read as failed. All pinned in [boundary-test][boundary-test]. Q4.                                                                                                                                                                                                                         |
| T22 | Namespaced `opencode.*` management tools (session rename and move, worktrees, model search, MCP resources; Code Mode only) [B] | Native, nested in `execute`                                                                                                                                    | `partial`  | `session_rename`, `models` and `worktree_list` run without a permission; `worktree_remove` asserts `edit` on the directory. `session_move` and `worktree_create` are refused with an explanation (Keiko owns the workspace binding, ADR-0088 and ADR-0089); the refusal is decided in `execute.before` ([policy test][native-policy-test], [plugin][native-policy-plugin]). The two MCP resource tools assert their own tool name as the permission, which the policy does not classify, so the hook refuses them as `unsupported-action` (by code reading; not exercised end to end), moot while no MCP server is configured.                                                                                                                                                                     |

### 3.2 Session and runtime behaviour

| #   | OpenCode 2.1.4 capability                                                                                              | Keiko integration                                                                                                        | Status     | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S01 | Session API: create, list, prompt, interrupt, permission and form replies, event stream [R]                            | One session per run through the 15 admitted operations ([v2-client][v2-client], [protocol-surface][protocol-surface])    | `governed` | The runtime host creates the one session; Stop maps to `interrupt`, Build and Plan to `session.switchAgent`, and the event stream with history reconciliation drives the timeline. The prompt body carries `text` and `metadata` only: `files`, `agents`, `skills`, `delivery` and `resume` are in the admitted schema and never sent (S07, S14, S15). The pinned structural digest refuses protocol drift.                                                                             |
| S02 | Continue or resume a session (`--continue`, `--session`) [B]                                                           | Follow-ups in the live run's session; Coding History across runs (ADR-0137 D4; [audit-3560][audit-3560])                 | `partial`  | While a run lives, a follow-up is another prompt to the same native session. Once a run has settled (Stop, completion, a server restart), the next task starts a fresh runtime (its `OPENCODE_DB` is per run) with bounded Coding History context (24,000 characters); this is not native resumption. Keiko's run snapshot, workspace binding, authority digest and explicit Retry carry the run.                                                                                       |
| S03 | Fork a session (`--fork`, `Session.ForkBoundary`) [B]                                                                  | none                                                                                                                     | `gap`      | No fork operation is admitted, and the Workbench has no fork action. Backlog B6; a Keiko-owned fork must keep predecessor receipts and not copy stale authority context ([audit-1517][audit-1517]).                                                                                                                                                                                                                                                                                     |
| S04 | Undo and revert through snapshots (`snapshots`, `Session.Revert`) [B]                                                  | Snapshots are on (`snapshots: true`); no revert                                                                          | `gap`      | The native profile enables the runtime's snapshots, and the kernel profile opens the ancestor directory nodes Git needs to record them ([lab][lab], 2026-10-23). No revert operation is admitted and the Workbench has no undo action. Backlog B3; it must preserve Keiko's workspace and change-review ownership. Mapped: `snapshots: false`.                                                                                                                                          |
| S05 | Share, export and import sessions (`share`, `enterprise`, `session export`, `session import`) [B]                      | none; `share: "disabled"`                                                                                                | `disabled` | `share` is server-owned (also in `OPENCODE_CONFIG_CONTENT`), and sharing would publish outside the machine [G]. The local `session export` and `import` commands are CLI surfaces Keiko never starts (S18). Support exports stay a human-initiated local export (AGENTS.md section 8).                                                                                                                                                                                                  |
| S06 | Self-update (`update`, `upgrade`) [B]                                                                                  | none; `update: "disable"`                                                                                                | `disabled` | Runtime updates belong to the portable release and updater contracts (ADR-0121, ADR-0163); there is no self-update, global install or `PATH` fallback (ADR-0163 D6).                                                                                                                                                                                                                                                                                                                    |
| S07 | Steer or queue a prompt while a turn runs (`delivery`) [R]                                                             | none                                                                                                                     | `gap`      | `delivery` is in the admitted prompt schema but the V2 client never sends it, and while a turn runs the composer's submit button becomes Pause, so a message cannot be queued or steered. Follow-up turns after the turn are supported. Backlog B2.                                                                                                                                                                                                                                     |
| S08 | Compaction, pruning and a retained tail [R] [B]                                                                        | Native auto-compaction with admitted context geometry ([profile][profile])                                               | `governed` | Auto-compaction stays on; `keep.tokens` and `buffer` derive from the admitted geometry, and no compaction-agent override exists. The strict decoder reads 2.1.4's compaction layout and the lifecycle is projected as body-free `coding-runtime.compaction` evidence ([history][history]). A live long-run compaction on 2.1.4 is not recorded.                                                                                                                                         |
| S09 | Tool-output truncation (`tool_output`) [R] [B]                                                                         | `tool_output.max_bytes` of 262,144                                                                                       | `governed` | Equals the governed IPC body ceiling and applies to native tool output on the native profile; on the mapped profile Keiko's per-tool bounds stay authoritative.                                                                                                                                                                                                                                                                                                                         |
| S10 | Provider retry, fallback and circuit handling; slow gateway responses [R]                                              | Keiko Model Gateway ([gateway][gateway])                                                                                 | `governed` | The gateway owns retries, the circuit breaker and the coding outage window (`gateway.retry.*`, `gateway.circuit.*`) and settles spend; the provider chunk timeout is 30 minutes. The runtime's own retry state is projected into the timeline and the Workbench shows "Model gateway unavailable, retrying" while a call is held (ADR-0137, `coding-sidecar.gateway.retry-surfaced`).                                                                                                   |
| S11 | Providers, model catalog and credentials (`providers`, `opencode auth`, `models`) [B]                                  | One provider `keiko-runtime`, one model alias `coding`, through the Model Gateway                                        | `governed` | Credentials and provider endpoints never reach the runtime (ADR-0163 D6). The server-owned binding is merged last; real binary: a repository that points the provider at another listener produces no request to it ([boundary-test][boundary-test]). Model choice and capability probes (tool calling, minimum context window) are Keiko's (ADR-0124 D5).                                                                                                                              |
| S12 | Reasoning variants (`provider/model#variant`) [B] [R]                                                                  | `reasoningEffort` on the run's model profile, admitted per configured capability ([gateway][gateway])                    | `governed` | A different mechanism with the same intent: an effort the configured model does not list is refused (`reasoning-effort-unavailable`). Reasoning is forwarded to the runtime and never enters the Activity Log, support exports or Coding History.                                                                                                                                                                                                                                       |
| S13 | Streaming of model output [B]                                                                                          | Gateway streaming when the upstream route advertises it ([gateway][gateway])                                             | `partial`  | Native gateway SSE is forwarded when the configured route advertises streaming; a strict proxy can still require the bounded buffered compatibility fallback. Final live matrix qualification remains open (lab findings F2, F28, F29; #3873).                                                                                                                                                                                                                                          |
| S14 | Image, PDF and other file input (`files` prompt parts, `media`) [R] [B]                                                | none                                                                                                                     | `gap`      | The provider model declares text input only, the gateway rejects every non-text content part closed, and the composer has no attachment control. Backlog B4.                                                                                                                                                                                                                                                                                                                            |
| S15 | Prompt references: `@file`, `@agent` and `$skill` attachments [R]                                                      | none                                                                                                                     | `gap`      | The prompt client never sends `files`, `agents` or `skills`, and the composer has no mention picker. The `$skl_...@<version>` token is bound to the mapped `keiko_skill` tools ([skill-catalog][skill-catalog]). Backlog B4 ([audit-3560][audit-3560]).                                                                                                                                                                                                                                 |
| S16 | Permission rules and prompts (`permissions`, `ask`, `--auto`) [R] [B]                                                  | The permission hook, Keiko's policy and approval lane ([native-policy][native-policy], [authority-port][authority-port]) | `governed` | The only configured rule denies `external_directory`; the real decision is Keiko's per request (mode matrix, hard denials, live envelope, budgets). Asks go to the approval lane with the action's own command, paths or address on the authenticated review channel; a declined step returns to the model as the call's own result while the run continues (ADR-0124 D6). `--auto` is never used. Evidence: `coding-runtime.native-policy.decided`, `coding-runtime.approval.decided`. |
| S17 | Worktrees and the session working directory (`worktree`, `session_move`) [B]                                           | Managed task workspaces ([ADR-0088][adr-0088], [ADR-0089][adr-0089])                                                     | `partial`  | The task workspace root, branch constraints and source identity are server-bound in the Authority Envelope and the runtime's session location is fixed at creation. The native Code Mode `opencode_session_move` and `opencode_worktree_create` are refused (T22), so the runtime's own worktree management is not available.                                                                                                                                                           |
| S18 | Command-line and server surfaces (`run`, `serve`, `acp`, `mini`, `service`, `api`, `pair`, `stats`, `reload`, ...) [B] | `serve` only, started by the runtime host                                                                                | `disabled` | The 2.1.4 CLI lists `upgrade`, `uninstall`, `acp`, `api`, `debug`, `auth`, `mcp`, `plugin`, `models`, `stats`, `mini`, `run`, `session`, `service`, `reload`, `pair` and `serve` [B]. Keiko starts `opencode serve` on loopback with a per-run password and owns the UI; no other surface is reachable.                                                                                                                                                                                 |
| S19 | Rich rendering of model output: math, Mermaid, diff views (`opencode.latex`, `opencode.merman`, `opencode.diffs`) [B]  | The Workbench timeline and Changes panel                                                                                 | `gap`      | Math notation is shown verbatim (lab finding F3, filed under #3874 in the lab record); Mermaid rendering was not assessed. Diff review is covered by Keiko's Changes panel, which refreshes when a native edit, write, patch or shell call settles. Backlog B8.                                                                                                                                                                                                                         |

### 3.3 Configuration and extension surfaces

| #   | OpenCode 2.1.4 capability                                                                       | Keiko integration                                                                                                                               | Status     | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C01 | `agents`: built-ins `build`, `plan`, `general`, `explore`; custom agents and plan mode [B]      | Primary-agent selection between `build` and `plan` ([agents][agents]); the producer's own agent rules                                           | `partial`  | The Workbench sends an optional `agent` with a start, retry or follow-up and the composition issues `session.switchAgent` once, before the prompt, when it differs from the run's agent; a refused switch fails the submission. The Build and Plan switch shows only where the server offers `plan` (native profile) and is fixed while a turn runs. Every built-in agent keeps the producer's rules and Keiko writes none over them: Plan cannot edit project files and writes only its plan directory, Explore cannot edit or execute, General cannot launch subagents (real binary). The autonomy mode selects authority, never the agent. Mapped profiles and Codex runs refuse `plan` as `invalid-intent`. Not available: custom agents (project layer off, no Keiko surface to define them). Evidence: `coding-runtime.agent.selected`. |
| C02 | `commands`: `init`, `review`, custom commands, MCP prompts as commands [B]                      | none                                                                                                                                            | `gap`      | No command operation is admitted and the composer has no slash-command surface; custom commands come from the project layer (off). Backlog B4. Server-authored prompts would be untrusted intent like any other task text ([audit-3560][audit-3560]).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| C03 | `instructions` and AGENTS.md discovery, global and walking up from the project; `init` [B]      | `AGENTS.md` at the task workspace root attached to the first message by Keiko's own loader ([repository instructions][repository-instructions]) | `partial`  | Keiko reads exactly the workspace-root `AGENTS.md` through the secure read helper (first 800 lines, at most 16 KiB; files up to 1 MiB are read, larger ones refused as `too-large`) and attaches it as a nonce-framed, repository-authored, untrusted block that grants no authority. On by default; `KEIKO_CODING_REPOSITORY_INSTRUCTIONS_ENABLED=false` opts out. The runtime's own discovery is off with the project layer: nested and walk-up `AGENTS.md`, `CLAUDE.md`, `.claude/`, `.agents/`, global instructions (the private `HOME` is empty) and the `instructions` setting do not load, and `init` is not offered. Evidence: `coding-runtime.repository-instructions.context`.                                                                                                                                                      |
| C04 | `mcp`: MCP servers, tools, OAuth and prompts (`opencode mcp add`, `list`, `auth`, `logout`) [B] | none                                                                                                                                            | `gap`      | No MCP server is configured: Keiko writes no `mcp` configuration and the project layer that could carry one is off. There is no Keiko registry, trust admission or UI for MCP servers; it is deferred to #2287 ([migration][migration]) and must stay inside the live envelope and admitted egress (a remote server also needs outbound internet). A configured server's tools would still meet the fail-closed policy, which refuses any permission action outside the pinned inventory (by code reading; the MCP resource tools are refused today, T22). Backlog B5.                                                                                                                                                                                                                                                                        |
| C05 | `plugins`: npm and local plugins (`opencode plugin add`) [B]                                    | Only Keiko's generated plugins                                                                                                                  | `disabled` | Project plugins do not load (`OPENCODE_DISABLE_PROJECT_CONFIG`) and the package manager is offline. Real binary: a repository that executes a canary from a file plugin, a directory plugin and a configured plugin at module load produces none, and a control with the layer on shows all three executing ([boundary-test][boundary-test]). The generated plugins live in the private run directory with mode 0600, and the run is not ready without them active.                                                                                                                                                                                                                                                                                                                                                                           |
| C06 | Project configuration: `opencode.json` and `.opencode/` directories [B]                         | none                                                                                                                                            | `disabled` | `OPENCODE_DISABLE_PROJECT_CONFIG=true` for every profile: the producer offers no per-item admission, imports a plugin's top-level code before any permission is evaluated, and would merge a project `providers` entry above Keiko's file. Nothing under the workspace configures agents, commands, skills, plugins, providers or permissions until #3903 admits individual items (ADR-0137 D10). Real binary: no project plugin runs and the model route stays on the gateway across reloads.                                                                                                                                                                                                                                                                                                                                                |
| C07 | `formatter`: built-in formatters after native edits [B]                                         | none                                                                                                                                            | `gap`      | The 2.1.4 bundle ships `opencode.config.formatter` [B]. Keiko neither configures nor disables formatters, no test observes one running under the Seatbelt profile, and the project layer that carries custom formatter configuration is off, so whether native edits are formatted is unverified. Backlog B7.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| C08 | External context: `references` and the `external_directory` permission [B]                      | none                                                                                                                                            | `disabled` | Workspace escape is a mode-independent hard denial (ADR-0129 D3) and no external-file broker exists (ADR-0125 D2). A configured `external_directory` deny is applied before the hook and never asks the policy; only the run's plan directory is admitted ([boundary-test][boundary-test]).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

Runtime settings (`watcher`, `warming`, `username`, `shell`, `media`, `experimental`) and the other
plugins the 2.1.4 bundle embeds (for example `opencode.browser`, `opencode.btw`,
`opencode.notifications`, `opencode.stats`, `opencode.wellknown`, `opencode.vcs.git`,
`opencode.vcs.hg`, `opencode.sidebar.*`) [B] need a separate service and configuration comparison;
their omission from this table is not parity evidence. Whether any of them adds model-visible
capability under Keiko's profile is unverified.

### 3.4 Summary

| Status     | Count |
| ---------- | ----- |
| `governed` | 18    |
| `partial`  | 14    |
| `disabled` | 7     |
| `gap`      | 10    |
| Total      | 49    |

## 4. Keiko capabilities without a native counterpart

On both profiles:

- Every native evaluation and decision leaves body-free activity-log evidence
  (`coding-runtime.native-policy.decided`, history projection, `keiko support analyze`).
- The live Authority Envelope, a per-run tool-call budget and the approval lane with a typed,
  content-free request and an authenticated review of the action's own command, paths or address.
- Issue context, Local Project Memory and repository instructions attached as labelled, untrusted
  initial context.
- Model Gateway resilience facts (`model-gateway-retrying`, `recovered`, `retry-stopped`) shown in
  the run status.

Mapped profile only (Linux and Windows; the native profile does not offer them):

- `keiko_ci_status` observes the accepted run's CI readiness (`git.ci-observation`).
- Verification returns a commit-eligibility proof (`commitProof`) separately from the executed
  checks, and delivery runs propose first and redeem later with immutable receipts.
- Edits are bound to whole-file digests, applied as one atomic multi-file transaction and reviewed
  in Ask with the exact diff.
- Research uses request-scoped grants and content quarantine; repository search has a semantic
  rerank; skills come from a server-approved catalog with budget-aware discovery.

## 5. Backlog and open decisions

Each backlog entry lists the matrix rows it covers, what is missing and the files that would own it.
The order is by developer impact, not a schedule.

- **B1. Git delivery for native runs** (T12). Commit, push, draft PR and CI observation exist only
  as mapped tools; the native shell may not deliver and the native profile registers no Keiko tool.
  Needed: a Keiko-owned delivery action for a native run that reuses the existing propose and
  execute ports, either human-initiated in the Workbench or as generated plugin tools (the latter
  needs an ADR-0175 D2 decision). Owners: `codingRuntimeRoutes.ts`,
  `productionDraftDeliveryRuntime.ts`, `productionVerifiedCommitRuntime.ts`,
  `opencodeRuntimeAdapter.ts`, `CodingWorkbenchCommitReview.tsx` and
  `CodingWorkbenchDraftDelivery.tsx`. Must respect ADR-0135, ADR-0087 (merge never model-visible)
  and ADR-0138 D3 item 5.
- **B2. Steering a running turn** (S07). Send `delivery` on the prompt and let the composer queue a
  message while a turn runs. Owners: `opencodeV2HttpClient.ts` (`prompt`),
  `opencodeRuntimeComposition.ts` (`submitTask`), `codingRuntimeOperationCoordinator.ts`,
  `coding-workbench-runtime-api.ts`, `CodingWorkbenchSections.tsx`. Must respect one active run per
  BFF and authority revalidation before every delegation (ADR-0137 D2).
- **B3. Undo of run changes** (S04). Snapshots are already recorded. Needed: admit the revert
  operation, a route and an Undo action over the task worktree and the Changes panel. Owners:
  `opencodeProtocolSurface.ts` with its fixture and pin, `opencodeV2HttpClient.ts`,
  `codingRuntimeRoutes.ts`, `CodingWorkbenchChanges.tsx`. Must keep workspace and change-review
  ownership (ADR-0089, [audit-3560][audit-3560]).
- **B4. Prompt inputs** (S15, C02, S14). `@file` references, slash commands and image input: a
  composer mention picker and command menu, `files`, `agents` and command operations on the client,
  and, for images, a model profile that declares image input and bounded, redacted content.
  Owners: `ComposerShell.tsx`, `CodingWorkbenchSections.tsx`, `opencodeV2HttpClient.ts`,
  `opencodeProtocolSurface.ts`, `opencodeLaunchProfile.ts` (`fixedOpenCodeV2Provider`),
  `coding-sidecar-gateway.ts`. Must respect evidence confidentiality (ADR-0048) and the gateway's
  closed content contract.
- **B5. Repository configuration, skills and MCP** (C03 walk-up, C04, C05, C06, T17, C01 custom
  agents). Admit individual repository items and MCP servers through workspace trust and the live
  envelope without letting any of them replace `keiko.native-policy` or move the model route; also
  classify the `opencode_*_mcp_resource` actions. Owners: `opencodeLaunchProfile.ts`
  (`OPENCODE_DISABLE_PROJECT_CONFIG`, server-owned binding), `opencodeNativePolicy.ts`,
  `codingRuntimeRepositoryInstructions.ts`, a new admission module beside
  `opencodeNativePluginReadiness.ts`. Tracked by #3903 and #2287.
- **B6. Fork and native resume** (S03, S02). Admit the fork operation, add a Workbench action and
  keep predecessor receipts. Owners: `opencodeProtocolSurface.ts`, `opencodeV2HttpClient.ts`,
  `codingRuntimeOrchestrator.ts`, `codingRuntimeHistory.ts`.
- **B7. Language servers and formatters** (T20, C07). Decide and verify the runtime's `lsp` and
  `formatter` settings under the Seatbelt profile and project diagnostics into the timeline.
  Owners: `createNativeOpenCodeV2Config` in `opencodeLaunchProfile.ts`, `seatbelt-execution-root.ts`
  (read roots), `opencodeV2History.ts`.
- **B8. Rendering and timeline** (S19). Render `latex` and `math` code blocks and, optionally,
  Mermaid; label `execute` and show a subagent's own work. Owners: `CodingWorkbenchTimeline.tsx`,
  `coding-workbench-i18n.*.ts`, `opencodeV2History.ts`; component-scoped classes only, never
  `globals.css` (AGENTS.md section 9).
- **B9. Native boundary on Linux and Windows** (profile). A qualified Linux boundary must enforce the
  shared sensitive exclusions for descendants and keep the gateway reachable; Windows has no native
  filesystem boundary. Owners: `backends.ts`, `productionOpenCodeToolProfile` in `deps.ts` (#3901).
- **B10. Real-binary controls for unexercised rows** (T02, T08, T13, T14, T15, T16, T19, C07, S08).
  Add opt-in cases to `opencodeNativeProjectBoundary.real.test.ts` and keep every real-binary suite
  on `OPENCODE_PINNED_VERSION`.

### Currently disabled surfaces (open native-parity acceptance items)

| Capability                                                                     | Decision source                                                   | What would reopen it                                                                                                                |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Repository configuration, plugins and skills (C05, C06, T17, parts of C01/C03) | ADR-0137 D10 (#3903)                                              | Individual items admitted through workspace trust and the live envelope; an accepted plugin must not replace `keiko.native-policy`. |
| Sharing, self-update, CLI surfaces (S05, S06, S18)                             | Local-first boundary; ADR-0121; ADR-0163 D6; server-owned binding | An equivalent user-controlled Keiko product operation, or an original supported service path that is qualified.                     |
| External context (C08)                                                         | ADR-0129 D3; ADR-0125 D2                                          | An external-file broker inside the Authority Envelope.                                                                              |
| Code Mode `session_move` and `worktree_create` (T22, S17)                      | ADR-0088; ADR-0089; ADR-0137 D10                                  | A Keiko-owned worktree and session-move action that keeps the workspace binding.                                                    |
| Internet below Full access (T14, T15)                                          | `opencodeNativePolicy.ts` (#3897); kernel loopback-only rule      | An owner decision to ask instead of refuse (Q5) with a route outside the machine.                                                   |
| Todo tracking on the mapped profile (T19)                                      | ADR-0175 D2 (#3561)                                               | An ADR amendment that admits a Keiko-owned plan carrier.                                                                            |

### Questions for the owner

- **Q1 (mapped profile only).** `keiko_research_fetch` still needs an operator-approved grant per
  exact URL in every mode ([research-grants][research-grants]), while the native profile lets Full
  fetch without a grant. Keep the per-URL grant on the mapped profile, or let the live envelope
  mint it?
- **Q2.** Which risk class applies to file deletion and move under ADR-0138 D2? **Decided
  2026-10-07:** the same `medium` risk as an edit on the mapped profile; on the native profile the
  shell classification applies (T09).
- **Q3.** Superseded: the native `shell` replaced the planned governed command tool, so the order of
  work between it and the connector, plugin and MCP packs (#2287) no longer applies.
- **Q4.** The runtime evaluates no permission for a Code Mode `execute` call (T21). In Ask and
  Supervised a script may therefore run without a decision, bounded by the confined interpreter,
  the kernel egress rule and the nested tools. Keep that, or ask for every `execute` call?
- **Q5.** ADR-0124 and the Workbench text say internet use asks below Full access, but the native
  policy refuses it at once because the kernel profile has no route outside the machine. Keep the
  immediate refusal, or ask and let the kernel profile follow the decision?

## 6. Documentation drift found while building this matrix

- ADR-0124 (native paragraph) says internet use asks below Full access; the native policy refuses it
  at once (`decideOpenCodeNativePolicy`). The reasoning is in a code comment only.
- The mode descriptions in the Workbench selector say Git commit, push and pull request are done by
  Keiko after separate approval, but the native profile has no path for it (T12).
- ADR-0137 D10 names a `PRODUCTION_OPENCODE_TOOL_PROFILE` constant in `deps.ts`; the code exports
  the function `productionOpenCodeToolProfile`.
- `opencodeNativeFilesystem.real.test.ts` still expects version 2.0.10 and its SHA-256, so it cannot
  pass against the 2.1.4 pin; the boundary and ripgrep suites use `OPENCODE_PINNED_VERSION`.
- The policy classifies a permission action `execute` (high risk), but the pinned runtime evaluates
  none for the Code Mode call, and its nested MCP resource tools assert their own tool names that
  the policy does not classify (T21, T22).
- OpenCode 1.18.30 is still cited in `docs/coding-runtime/dev-lane.md` and in comments of
  `opencodeToolSchemas.ts`, `opencodeLaunchProfile.ts`, `opencodeProtocolSurface.ts` and
  `opencodeHttpClient.ts`. The 1.17.17 audit ([audit-1517][audit-1517]) predates #3561 and treats
  `todowrite` as a native feature in use.
- `OPENCODE_PINNED_BUILT_IN_TOOLS` lists V1 tool names and applies to the mapped profiles only.
- `docs/coding-runtime/research-content-threat-model.md` names `keiko_command` as a mutation-capable
  tool; no such tool is offered.
- The lab record `docs/qa/coding-workbench-gemma-litellm-lab.md` files finding F3 (math notation
  shown verbatim) under #3874; this matrix covers it as S19.

## 7. Verification sources

Repository files read or searched for this refresh (paths relative to the repository root):

- Versions, protocol and tools:
  `packages/keiko-server/src/coding-runtime/opencodeRuntimeVersions.ts`,
  `opencodeProtocolSurface.ts` and `opencodeProtocolSurface.opencode-2.1.4.fixture.json`,
  `opencodeV2HttpClient.ts`, `opencodeProtocol.ts`, `opencodeNativeTools.ts` and
  `opencodeNativeTools.opencode-2.1.4.fixture.json` and `opencodeToolSchemas.ts` (mapped set).
- Native profile: `opencodeLaunchProfile.ts`, `opencodeNativePolicy.ts` (and its test),
  `opencodeNativePolicyPlugin.ts`, `opencodeNativePluginReadiness.ts`, `opencodeNativeContext.ts`,
  `opencodeAgents.ts`, `opencodeRuntimeAdapter.ts`, `opencodeRuntimeComposition.ts`,
  `codingToolNativeEffect.ts`, `productionOpenCodeBackend.ts`,
  `opencodeV2History.ts`, `opencodeSafeActivity.ts`, `codingRuntimeOperationCoordinator.ts`,
  `codingRuntimeHistory.ts`, `codingRuntimeRoutes.ts` (all under
  `packages/keiko-server/src/coding-runtime/`), and `packages/keiko-server/src/deps.ts`.
- Search: `ripgrepRuntime.ts`, `opencodeRipgrepLaunch.ts`, `opencodeRipgrep.real.test.ts`,
  `docs/qa/ripgrep-runtime-evidence.md`.
- Confinement: `packages/keiko-sandbox/src/backends.ts`, `seatbelt-execution-root.ts`,
  `runtime-gateway.ts`, `runtime-gateway.test.ts`.
- Real-binary evidence: `opencodeNativeProjectBoundary.real.test.ts`, `opencodeRipgrep.real.test.ts`.
- Workbench UI (`packages/keiko-ui/src/app/components/desktop/widgets/coding-workbench/`):
  `CodingWorkbenchAgentToggle.tsx`, `CodingWorkbenchSections.tsx`,
  `CodingWorkbenchNativeActionReview.tsx`, `CodingWorkbenchTimeline.tsx`,
  `coding-workbench-i18n.en.ts`.
- Records read for this refresh: the native paragraph of ADR-0124, ADR-0137 (the retry and outage
  sections and D10), `docs/qa/coding-workbench-gemma-litellm-lab.md` (the 2026-10-23 entry),
  `docs/qa/coding-workbench-audit-3560.md`, `docs/qa/ripgrep-runtime-evidence.md` and
  `docs/observability/op-catalog.generated.json`.

Carried over from the 2026-10-08 revision (reviewed at `33cc2d001`) and not re-verified in this
refresh: every statement about the mapped profile, and the cited records ADR-0043, ADR-0088,
ADR-0089, ADR-0121, ADR-0125, ADR-0129, ADR-0135, ADR-0138, ADR-0147, ADR-0163 and ADR-0175,
`docs/architecture/governed-tool-migration.md` and `docs/qa/opencode-native-quality-audit.md`. The
mapped statements rest on `packages/keiko-tool-catalog/src/opencode.ts`,
`packages/keiko-server/src/coding-sidecar-gateway.ts`, `codingToolIpc.ts`,
`codingToolAuthorityPort.ts`, `codingToolReadEditPorts.ts`, `codingToolReplacementEdits.ts`,
`codingRuntimeGitIpc.ts`, `productionManagedWorktreeTools.ts`, `researchEgressPort.ts`,
`researchApprovalIssuance.ts`, `skillCatalog.ts`, `readOnlyChildOrchestrator.ts`,
`explicitSkillInvocation.ts`, `opencodeV2Questions.ts` (the T18 limits) and
`packages/keiko-verification/src/detect.ts`.

Staged-binary checks [B], run with a private `HOME` and XDG roots so nothing is written under the
real home. The executable is staged by `npm run dev:coding-runtime:stage`:

```sh
OC=.portable-sidecar-payloads/<target>/opencode-compatible/payload/bin/opencode
"$OC" --version                      # opencode v2.1.4
"$OC" --help                         # subcommands and flags
"$OC" mcp --help                     # likewise: plugin, session, debug, run, serve
grep -a -o -E 'id:"opencode\.[A-Za-z0-9._-]+"' "$OC" | sort -u   # native plugin ids
```

The plugin ids list the tool plugins (`opencode.tool.*`: edit, glob, grep, patch, question, read,
shell, skill, subagent, todo, webfetch, websearch, write; no `lsp`), the configuration plugins
(`opencode.config.*`) and the web search providers. The tool inventory itself is the
producer-derived capture of `ctx.tool.list()` in
[native-tools-fixture][native-tools-fixture], regenerated on every runtime upgrade. The bundle is
plain text inside the executable, so a fixed-string `grep -a -b -o -F` finds a byte offset and `dd`
reads its context. Offsets and minified names change with every build; the plugin ids and tool
names are the stable facts. The opt-in real-binary suites run with `KEIKO_OPENCODE_REAL_BINARY` and
`KEIKO_OPENCODE_REAL_RESOURCE_ROOT` set, the ripgrep suite additionally after
`npm run provision:ripgrep`.

[adr-0088]: ../adr/ADR-0088-task-workspace-domain-contract.md
[adr-0089]: ../adr/ADR-0089-managed-task-worktree-provisioning.md
[adr-0124]: ../adr/ADR-0124-coding-autonomy-modes-and-sidecar-runtime-authority.md
[adr-0125]: ../adr/ADR-0125-governed-agent-docking-and-editor-changesets.md
[adr-0129]: ../adr/ADR-0129-product-wide-authority-and-autonomy-model.md
[adr-0137]: ../adr/ADR-0137-server-owned-coding-runtime-contracts.md
[adr-0138]: ../adr/ADR-0138-monotonic-product-wide-autonomy-semantics-and-code-task-terminology.md
[audit-1517]: opencode-native-quality-audit.md
[audit-3560]: coding-workbench-audit-3560.md
[lab]: coding-workbench-gemma-litellm-lab.md
[migration]: ../architecture/governed-tool-migration.md
[adapter]: ../../packages/keiko-server/src/coding-runtime/opencodeRuntimeAdapter.ts
[agents]: ../../packages/keiko-server/src/coding-runtime/opencodeAgents.ts
[authority-port]: ../../packages/keiko-server/src/coding-runtime/codingToolAuthorityPort.ts
[backend]: ../../packages/keiko-server/src/coding-runtime/productionOpenCodeBackend.ts
[backends]: ../../packages/keiko-sandbox/src/backends.ts
[boundary-test]: ../../packages/keiko-server/src/coding-runtime/opencodeNativeProjectBoundary.real.test.ts
[catalog]: ../../packages/keiko-tool-catalog/src/opencode.ts
[child]: ../../packages/keiko-server/src/coding-runtime/readOnlyChildOrchestrator.ts
[deps]: ../../packages/keiko-server/src/deps.ts
[file-creation-test]: ../../packages/keiko-server/src/coding-runtime/codingToolFileCreation.test.ts
[gateway]: ../../packages/keiko-server/src/coding-sidecar-gateway.ts
[git-ipc]: ../../packages/keiko-server/src/coding-runtime/codingRuntimeGitIpc.ts
[history]: ../../packages/keiko-server/src/coding-runtime/opencodeV2History.ts
[kernel-test]: ../../packages/keiko-sandbox/src/runtime-gateway.test.ts
[managed-tools]: ../../packages/keiko-server/src/coding-runtime/productionManagedWorktreeTools.ts
[native-policy]: ../../packages/keiko-server/src/coding-runtime/opencodeNativePolicy.ts
[native-policy-plugin]: ../../packages/keiko-server/src/coding-runtime/opencodeNativePolicyPlugin.ts
[native-policy-test]: ../../packages/keiko-server/src/coding-runtime/opencodeNativePolicy.test.ts
[native-readiness]: ../../packages/keiko-server/src/coding-runtime/opencodeNativePluginReadiness.ts
[native-effect]: ../../packages/keiko-server/src/coding-runtime/codingToolNativeEffect.ts
[native-tools]: ../../packages/keiko-server/src/coding-runtime/opencodeNativeTools.ts
[native-tools-fixture]: ../../packages/keiko-server/src/coding-runtime/opencodeNativeTools.opencode-2.1.4.fixture.json
[profile]: ../../packages/keiko-server/src/coding-runtime/opencodeLaunchProfile.ts
[protocol-fixture]: ../../packages/keiko-server/src/coding-runtime/opencodeProtocolSurface.opencode-2.1.4.fixture.json
[protocol-surface]: ../../packages/keiko-server/src/coding-runtime/opencodeProtocolSurface.ts
[questions]: ../../packages/keiko-server/src/coding-runtime/opencodeV2Questions.ts
[read-edit]: ../../packages/keiko-server/src/coding-runtime/codingToolReadEditPorts.ts
[replacements]: ../../packages/keiko-server/src/coding-runtime/codingToolReplacementEdits.ts
[repository-instructions]: ../../packages/keiko-server/src/coding-runtime/codingRuntimeRepositoryInstructions.ts
[research-grants]: ../../packages/keiko-server/src/coding-runtime/researchApprovalIssuance.ts
[research-port]: ../../packages/keiko-server/src/coding-runtime/researchEgressPort.ts
[review-ui]: ../../packages/keiko-ui/src/app/components/desktop/widgets/coding-workbench/CodingWorkbenchNativeActionReview.tsx
[ripgrep-evidence]: ripgrep-runtime-evidence.md
[ripgrep-launch]: ../../packages/keiko-server/src/coding-runtime/opencodeRipgrepLaunch.ts
[ripgrep-runtime]: ../../packages/keiko-server/src/coding-runtime/ripgrepRuntime.ts
[ripgrep-test]: ../../packages/keiko-server/src/coding-runtime/opencodeRipgrep.real.test.ts
[safe-activity]: ../../packages/keiko-server/src/coding-runtime/opencodeSafeActivity.ts
[schemas]: ../../packages/keiko-server/src/coding-runtime/opencodeToolSchemas.ts
[seatbelt-root]: ../../packages/keiko-sandbox/src/seatbelt-execution-root.ts
[skill-catalog]: ../../packages/keiko-server/src/coding-runtime/skillCatalog.ts
[tools-fixture]: ../../packages/keiko-server/src/coding-runtime/opencodeToolSchemas.opencode-2.0.10-advertised.fixture.json
[v2-client]: ../../packages/keiko-server/src/coding-runtime/opencodeV2HttpClient.ts
[verify-detect]: ../../packages/keiko-verification/src/detect.ts
[versions]: ../../packages/keiko-server/src/coding-runtime/opencodeRuntimeVersions.ts
