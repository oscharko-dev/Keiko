<p align="center">
  <img src="https://raw.githubusercontent.com/oscharko-dev/Keiko/dev/packages/keiko-ui/public/keiko-logo.svg" alt="Keiko logo" width="144" />
</p>

<h1 align="center">Keiko</h1>

<p align="center"><strong>Ex experientia disco</strong></p>

<p align="center">
  The governed agentic workspace for professional knowledge work.<br />
  Local-first. Human-controlled. It learns from experience.<br />
  Manifest-producing surfaces emit redacted evidence for audit.
</p>

<p align="center">
  <a href="https://github.com/oscharko-dev/Keiko/blob/dev/LICENSE"><img alt="License" src="https://img.shields.io/badge/license-Apache%202.0-4EBA87.svg"></a>
  <a href="https://github.com/oscharko-dev/Keiko/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/oscharko-dev/Keiko/actions/workflows/ci.yml/badge.svg?branch=dev"></a>
  <a href="https://github.com/oscharko-dev/Keiko/actions/workflows/codeql.yml"><img alt="CodeQL" src="https://github.com/oscharko-dev/Keiko/actions/workflows/codeql.yml/badge.svg?branch=dev"></a>
  <img alt="Local first" src="https://img.shields.io/badge/runtime-local--first-1F2937.svg">
</p>

<p align="center">
  <a href="https://sonarcloud.io/project/overview?id=oscharko-dev_Keiko"><img alt="Quality gate" src="https://sonarcloud.io/api/project_badges/measure?project=oscharko-dev_Keiko&metric=alert_status"></a>
  <a href="https://sonarcloud.io/project/overview?id=oscharko-dev_Keiko"><img alt="Lines of code" src="https://sonarcloud.io/api/project_badges/measure?project=oscharko-dev_Keiko&metric=ncloc"></a>
  <a href="https://sonarcloud.io/project/overview?id=oscharko-dev_Keiko"><img alt="Coverage" src="https://sonarcloud.io/api/project_badges/measure?project=oscharko-dev_Keiko&metric=coverage"></a>
  <a href="https://sonarcloud.io/project/overview?id=oscharko-dev_Keiko"><img alt="Maintainability" src="https://sonarcloud.io/api/project_badges/measure?project=oscharko-dev_Keiko&metric=sqale_rating"></a>
  <a href="https://sonarcloud.io/project/overview?id=oscharko-dev_Keiko"><img alt="Security" src="https://sonarcloud.io/api/project_badges/measure?project=oscharko-dev_Keiko&metric=security_rating"></a>
</p>

<p align="center">
  <a href="https://www.oscharko.dev">Product page</a>
  ·
  <a href="#download">Download</a>
  ·
  <a href="#install-with-npm">npm</a>
  ·
  <a href="#whats-new-in-131">What's new in 1.3</a>
  ·
  <a href="https://github.com/oscharko-dev/Keiko/blob/dev/CONTRIBUTING.md">Contributing</a>
  ·
  <a href="https://github.com/oscharko-dev/Keiko/blob/dev/SECURITY.md">Security policy</a>
</p>

---

Keiko turns your repository, your documents and your models into one calm place to work: chat with the models you configure, understand a codebase, generate reviewable tests, investigate bugs, and keep a memory of what was learned along the way. Everything runs on your machine, and every action stays inside the authority you grant.

## What you get

- **A workspace that understands your repository** — inspect, search and reason over real code, not snippets.
- **Your own models** — bring the endpoints you already trust; Keiko never ships or hides credentials.
- **A coding workbench** — plan and edit inside a verified sandbox, under an autonomy mode you choose. It can take an issue all the way to a pull request in one governed run.
- **Tests, investigations, verification** — reviewable outcomes with honest state: no green over a broken gateway, and every refusal names its reason.
- **Memory that learns from experience** — decisions and findings persist locally and sharpen future answers.
- **Evidence you can show an auditor** — counts, hashes and statuses; never your content.

## Download

The desktop packages include the Node.js runtime and launch Keiko without a separate Node.js installation. Coding execution also requires a supported, verified platform runtime; a bundled executable alone does not make it available.

**[Download the latest release →](https://github.com/oscharko-dev/Keiko/releases/latest)**

| Platform              | Package                                                  |
| --------------------- | -------------------------------------------------------- |
| macOS (Apple Silicon) | `keiko-macos-arm64.zip`                                  |
| macOS (Intel)         | `keiko-macos-x64.zip`                                    |
| Windows x64           | `keiko-windows-x64-setup.exe` or `keiko-windows-x64.zip` |
| Linux x64             | `keiko-linux-x64.zip`                                    |

Keiko is an open-source project and does not yet buy Apple and Microsoft code-signing certificates, so macOS and Windows ask once before the first launch: on macOS **System Settings → Privacy & Security → Open Anyway**, on Windows SmartScreen **More info → Run anyway**. Every release states this plainly. Keiko then opens at `http://127.0.0.1:1983`.

## Install with npm

Install Keiko into a folder of its own and start it from there:

```bash
mkdir keiko && cd keiko && npm init -y
```

```bash
npm install @oscharko-dev/keiko
```

```bash
npx keiko start
```

A global installation (`npm install -g`) is not supported yet: npm leaves Keiko's runtime
dependencies out of it, so `keiko start` fails (see Honest limits).

Connected folders do not need Git metadata or a `package.json`. Run `keiko init` only if you want to add optional commands to an existing Node.js project. `keiko start` and `keiko restart`, including the generated `keiko:start` project script, open an authenticated browser session at `http://127.0.0.1:1983` by default. Use `--no-open` for a headless start. `keiko stop` shuts it down, and `keiko start --port <n>` picks another port. Requires Node.js `>=24.18.0 <25 || >=26.3.0 <27`; the desktop packages bring their own runtime. On macOS, npm selects the optional coding-runtime package for Apple Silicon or Intel, and Keiko verifies its contents before use. A missing or unsupported runtime is reported as unavailable; installing Keiko does not bypass platform checks.

## Honest limits

- `npm install -g @oscharko-dev/keiko` installs Keiko without its third-party runtime dependencies, and `keiko start` then fails at startup. Install it into a project folder instead, as shown above, or use the desktop packages ([#3582](https://github.com/oscharko-dev/Keiko/issues/3582)).
- Updating from before 1.2.0 requires manual review of custom support scripts: legacy inclusion flags, filename-based `--out` arguments and sidecar bundles are replaced by the canonical private report workflow. See the [support guide](https://github.com/oscharko-dev/Keiko/blob/dev/docs/observability/support-workspace.md).
- Windows Chat, Files and manual Editor use are separate from Coding execution. The Windows gateway-filter work remains a development implementation and does not enable the Coding runtime; see the [qualification status](https://github.com/oscharko-dev/Keiko/blob/dev/docs/qa/windows-gateway-runtime-progress.md).
- Model weights and inference servers are not bundled. Connect a compatible local model server, including a separately installed Gemma server, through Keiko's gateway configuration, directly or through a proxy such as LiteLLM. This release does not install MLX or certify every model and context-window configuration.
- The CLI, the UI and the SDK share one product. Surface coverage is intentionally not identical. `keiko gen-tests` and `keiko investigate` print a reviewable report but do not persist an evidence manifest.
- The UI can create a local runtime config during first-run setup. To list models, Keiko calls the gateway model list endpoint you configured — credentials stay in your local config.
- Keiko serves loopback only: `keiko start` and the UI validate a loopback host value, and the server always binds `127.0.0.1`. `keiko start --port <n>` sets the Port to bind (default: 1983).

## What's new in 1.3.1

- **Long coding runs stay connected.** The task timeline keeps updating during a long run, reconnects on its own after a brief drop, and a quiet stretch while the model thinks no longer signs your browser window out.
- **Clear reasons instead of bare failures.** A failed step in the timeline says why, for example which exit code a command returned. In Full access on macOS, when Keiko cannot prepare a project's dependencies for its isolated check, the model is pointed to the project's own checks and the Activity Log names the reason.
- **Editor and Git-change Chat work again.** Go to definition, find references, rename and the other code navigation commands answer again, and a Chat about a Git change can connect, send and apply proposals.

Updating from 1.2.7 or 1.3.0 needs no action, and your tasks and Coding History carry over unchanged.

An installation on 1.2.6 or earlier must run the verified updater bootstrap once before automatic updates. Back up local state and preserve private keys during that step; the [repair evidence](https://github.com/oscharko-dev/Keiko/blob/dev/docs/qa/portable-updater-repair-4055.md) describes it.

## What's new in 1.3.0

- **A stronger coding engine, still under your control.** On macOS the Coding Workbench now runs the original OpenCode 2.1.4 engine with its own tools for searching, reading, editing and running checks. Keiko's three modes — Ask for approval, Supervised workspace and Full access — still decide what it may do, and models are reached only through your configured gateway.
- **Work the way you think.** Plan first or build right away, undo the latest turn, queue follow-up messages, and read formulas and diagrams directly in the task timeline.
- **Pick up where you left off.** Continue or branch off a finished task, export it as JSON or Markdown, or import a saved task into Coding History. Secrets in imported text are masked before it is stored.
- **Honest status.** Without a network, web lookups and remote skills end promptly with a clear message instead of waiting. The Workbench shows which coding engine is installed and the latest Keiko release.

Your tasks and Coding History carry over unchanged; the first new run of an earlier task starts a fresh engine session with that task's history as context. The macOS desktop packages and npm installations include the new engine. On Linux the Workbench keeps Keiko's own coding tools, and Windows Coding remains unavailable (see Honest limits).

## What's new in 1.2.6

- **Portable updates on macOS.** Application lifecycle and update restart no longer depend on Apple Developer membership or Endpoint Security activation. Keiko release signatures continue to authenticate update artifacts.
- **Consecutive updates and workspace continuity.** Native cleanup finishes before startup reports ready, completed sessions release their ownership, and restart retains the selected workspace and existing state. This patch adds no database schema migration.
- **Future release metadata.** Signed manifests carry future release impacts, and archives declare measured expanded sizes. Invalid, altered or oversized inputs remain refused.

Already published 1.2.5 installations need the verified updater bootstrap before automatic updates.
Back up local state and preserve private keys during that repair. The [repair evidence](https://github.com/oscharko-dev/Keiko/blob/dev/docs/qa/portable-updater-repair-4055.md)
distinguishes local bootstrap and fixture qualification from the live public-release SSD test,
which remains pending deployment. Installed Windows and Linux cross-version qualification is not
claimed by the macOS repair.

## What's new in 1.2.5

- **Chat and connected Files.** Source transitions hold or cancel generation until the selected scope is acknowledged. Reconnection and shared conversation creation preserve request ownership and avoid replaying accepted sends.
- **Browser access and private drafts.** Approve another browser explicitly, optionally remember its access with expiration, and revoke it through the existing session controls. Draft acknowledgements remain bound to their originating conversation and revision.
- **Updater status and recovery.** Setup requirements are distinguished from an available newer version. Native handoff, cancellation and recovery retain bounded process and installation ownership checks.
- **Source fidelity and privacy.** Recursive evidence collection retains certified source relationships within existing grants. Credential redaction preserves supported code syntax, and copying an answer preserves its code formatting. Patched Vite tooling and private native-host MCP build inputs address newly reviewed security advisories.

Repository skill examples for import into Chat cover [Java/Spring Boot](scripts/testing/chat-skills-lab/skills/java-spring-unit-tests.md)
and [React/MUI/Vitest](scripts/testing/chat-skills-lab/skills/react-mui-vitest-tests.md).
These compact instructions remain model-agnostic and reviewable. Repeatable generated-test benefit,
installed update cycles, SSD continuity and complete browser/retrieval acceptance remain in
[follow-up #4051](https://github.com/oscharko-dev/Keiko/issues/4051); this release does not certify them.
The local UI store advances from V44 to V46 for browser approvals and shared Chat creation intents.
Back up local state before upgrading; older binaries cannot read the newer schema. Existing manual
update eligibility remains unchanged.

## What's new in 1.2.4

- **Slow-gateway resilience.** Chat waits through extended response-start silence within bounded gateway deadlines, preserves unchanged drafts after cancellation and avoids duplicate conversations during model-catalog refresh.
- **Clearer connected sources.** The compact Sources header follows acknowledged Files navigation without OK or Keep folder confirmations. Completed conversation history remains intact. A source snapshot invalidated while a window loads is refreshed before that window becomes ready.
- **More relevant repository evidence.** Search improves compound-term and related-source selection, retains explicitly requested files, and excludes incidental lockfiles while preserving dependency-version evidence. Cooperative indexing keeps existing authority and resource limits.
- **Windows host containment.** OpenCode metadata and home resolution stay inside private host state; original host and dependency-consumer compatibility tests cover the supported integration.

The [Java/Spring Boot skill](scripts/testing/chat-skills-lab/skills/java-spring-unit-tests.md) and
[React/MUI/Vitest skill](scripts/testing/chat-skills-lab/skills/react-mui-vitest-tests.md) are editable
candidates for review. Immediate client cancellation before source acknowledgement, complete
multi-source compaction qualification and repeated generated-test quality remain tracked in
[follow-up #4040](https://github.com/oscharko-dev/Keiko/issues/4040). This release does not claim
complete Gemma qualification.

## What's new in 1.2.3

- **Reliable dictation through LiteLLM.** Browser recordings are normalized to mono PCM16 WAV for compatible Whisper deployments. Click the microphone to record, follow the subtle input waveform, and click the same control to stop. The transcript is inserted directly into your editable draft; it is never sent automatically.
- **Skills and drafts that recover correctly.** The Skills dialog refreshes when the normal launcher session becomes available. Private Chat drafts survive reload and restart; simultaneous edits require an explicit choice. Deleted selected skills stop the turn rather than silently sending without the chosen instructions.
- **Better source fidelity.** Generated skill references must match the actual admitted source. History recovery after compaction retains complementary relevant sections, and maximized Chat windows fit the current tab's viewport.

The local UI store advances to schema V44 for private drafts. Keep a backup before changing versions; older binaries cannot read the newer schema. Existing manual-update eligibility and platform qualification limits remain unchanged.

## Previous additions in 1.2.2

- **Private skills in Chat.** Open **Skills** beside the Composer, upload a Markdown file and select it for that chat. The active skill is visible beside the context meter. Preview, replace, download or delete a skill in the same dialog; uploading alone does not activate it.
- **Instructions that survive compaction.** The complete selected revision counts toward the context budget and remains intact when conversation history is summarized. If it cannot fit or its revision is unavailable, Chat explains the correction instead of silently dropping it.
- **Create a skill from a concept.** Paste text or select a document, prepare a draft through your configured gateway, review and edit it, then explicitly save or download it. A repository is not required. Skills remain local and grant no additional execution or network permissions.

See the [private Chat skills guide](https://github.com/oscharko-dev/Keiko/blob/dev/docs/prompt-enhancer/user-guide.md#private-markdown-skills-in-chat) for import limits, selection, privacy and context handling. OpenCode/Coding Workbench skill integration is separate work; this release adds skills to Keiko Chat.

## Previous improvements in 1.2.1

- **More relevant source evidence.** Connected-folder questions retain named files and relevant implementation bodies more reliably within the existing read, token and time budgets. Physical source ranges and the evidence actually sent to the model stay aligned.
- **Reliable startup and edits.** Configured gateways and selected models survive normal project startup, readiness refreshes automatically, and governed file edits preserve ordinary text exactly. Coding completion requires fresh verification after the final edit.
- **Workbench progress and recovery.** Compatible self-hosted models stream answers and reasoning, with bounded repair of empty answers and visible recovery from temporary gateway outages. New runs default to 2,000,000 prompt tokens and 120 minutes; operators can lower these through `KEIKO_CODING_RUNTIME_MAX_PROMPT_TOKENS` and `KEIKO_CODING_RUNTIME_MAX_DURATION_MINUTES`.

The original long-context Gemma question still fails complete answer and validated-citation qualification even when the relevant implementation is present in the model's evidence. This release improves source selection and reliability; it does not establish complete Gemma qualification or standalone OpenCode parity. Existing Windows Coding and manual-update limitations above remain in force.

## What's in 1.2

1.2 brings the integrated changes since 1.1.13 to everyday chat, connected folders and support:

- **Model-aware context.** Chat uses the selected model's available gateway metadata for context and output limits. Context displays distinguish estimates from provider-reported usage, and compaction keeps conversation history within its budget.
- **Recursive source search.** Connected Git repositories and ordinary folders are searched through subfolders for eligible text files up to and including 2 MiB, with cancellation and workspace boundaries preserved. Unavailable subfolders do not discard directly readable declared manifests; incomplete coverage stays visible. Source links retain the correct folder and file identity, and coverage indicators distinguish files examined from excerpts used in the answer. Chat can draft test examples from freshly read, budgeted folder evidence and return the code for copying.
- **A report at the error.** Download a private support report directly from an error message. The report carries bounded diagnostic evidence and can be validated offline; Keiko does not send it automatically. When server evidence is unavailable, the browser can retain available client failure facts in a limited report.
- **Reliable workspace navigation.** Files and the ordinary Editor retain their selected roots through navigation and recovery. Reloaded file connections retain one copy of each selected folder. The ordinary Editor remains a manual file editor; agent actions belong to the separate Coding Workbench. Windows Git checkout binding uses canonical paths.
- **Clearer outcomes under failure.** Model retries, stream completion, cancellation and support-report delivery preserve their failure evidence and release owned resources. A failed or superseded operation cannot silently claim the result of a newer action.

See the [release notes and changelog](https://github.com/oscharko-dev/Keiko/releases) for the full change list, compatibility guidance and release-specific qualification limits.

## What's in 1.1

1.1 folds every reviewed customer-facing change since 1.0.5 into one minor bump. The published surface is unchanged from 1.0 — nothing was added, removed or renamed — so `1.x` remains the supported line under the same promise.

- The activity log is now a strict machine-reconstruction contract: every record is validated against a versioned registry, support exports refuse unsafe filesystem targets and never silently overwrite, and support analysis explicitly classifies legacy, corrupt, truncated or incomplete evidence.
- The Coding Workbench moves to OpenCode 2 and keeps per-conversation task history so a run's steps stay visible across restarts.
- Voice conversations with the Digital Twin are turn-based, with a simpler audio setup.
- The stable-release workflow gained an owner-authorized button and automatic publication after its prerequisites pass. The current workflow requires the chosen version and reviewed release metadata to land through a protected pull request before that button is pressed; it does not prepare a version bump itself.
- Chat and workbench polish: the Chat History **New** button no longer flashes enabled during load, and the workbench composer chip row is removed.

## What's in 1.0

1.0 is the first stable major. The published surface is unchanged from 0.3.17 — nothing was added, removed or renamed — so what changes is the promise around it: **`1.x` is the supported line, and a breaking change to it requires a new major release.**

- Updates are production-ready on Windows, macOS and Linux, and a failed update preserves the complete current install.
- The Coding Workbench takes an issue to a pull request in one governed run, and an approved changeset edit now lands instead of expiring beneath the decision.
- Linux x64 joins macOS and Windows as a downloadable package, with its coding runtime shipping qualified and generated code reaching the network only through the gateway boundary.
- Windows installs through a native bootstrap, with the setup executable's digest bound into the published manifest.
- Every Git outcome can be reconstructed from the activity log alone.
- Grounded retrieval is bounded on large workspaces, and local knowledge retrieval runs on a fast approximate-nearest-neighbour index.
- Security: Next.js 16.3.3 closes two critical advisories.

## Principles

- **Human-controlled by design.** You select the task, the autonomy mode and the authority envelope; hard limits fail closed.
- **Local-first.** Your repositories, memory and evidence live on your machine, and Keiko serves loopback only.
- **Evidence over trust.** Manifests and audit exports carry counts, scopes and hashes — never raw content.
- **Honest state.** No silent failure, no green over broken.

## Learn more

- [oscharko.dev](https://www.oscharko.dev) — the product page
- [Release notes and changelog](https://github.com/oscharko-dev/Keiko/releases) — published changes and compatibility guidance
- [Documentation](https://github.com/oscharko-dev/Keiko/tree/dev/docs) — architecture decisions, design system, troubleshooting
- [Operator runbook](https://github.com/oscharko-dev/Keiko/blob/dev/docs/ui-runbook.md) — the full operator reference
- [Contributing](https://github.com/oscharko-dev/Keiko/blob/dev/CONTRIBUTING.md) — the quality bar and how changes land
- [Security policy](https://github.com/oscharko-dev/Keiko/blob/dev/SECURITY.md) — reporting and boundaries
- [Report a finding](https://github.com/oscharko-dev/Keiko/blob/dev/docs/user-finding-report.md) — structured, account-free intake

## License

[Apache 2.0](https://github.com/oscharko-dev/Keiko/blob/dev/LICENSE) — © Oliver Scharkowski
