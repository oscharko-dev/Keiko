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
  <a href="#whats-in-12">What's in 1.2</a>
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

```bash
npm install -g @oscharko-dev/keiko
```

```bash
keiko start
```

Connected folders do not need Git metadata or a `package.json`. Run `keiko init` only if you want to add optional commands to an existing Node.js project. The UI opens at `http://127.0.0.1:1983` — `keiko stop` shuts it down, `keiko start --port <n>` picks another port. Requires Node.js `>=24.18.0 <25 || >=26.3.0 <27`; the desktop packages bring their own runtime. On macOS, npm selects the optional coding-runtime package for Apple Silicon or Intel, and Keiko verifies its contents before use. A missing or unsupported runtime is reported as unavailable; installing Keiko does not bypass platform checks.

## Honest limits

- Updating to 1.2.0 requires manual review of custom support scripts: legacy inclusion flags, filename-based `--out` arguments and sidecar bundles are replaced by the canonical private report workflow. See the [support guide](https://github.com/oscharko-dev/Keiko/blob/dev/docs/observability/support-workspace.md).
- Windows Chat, Files and manual Editor use are separate from Coding execution. The Windows gateway-filter work remains a development implementation and does not enable the Coding runtime; see the [qualification status](https://github.com/oscharko-dev/Keiko/blob/dev/docs/qa/windows-gateway-runtime-progress.md).
- Model weights and inference servers are not bundled. Connect a compatible local model server, including a separately installed Gemma server, through Keiko's gateway configuration, directly or through a proxy such as LiteLLM. This release does not install MLX or certify every model and context-window configuration.
- The CLI, the UI and the SDK share one product. Surface coverage is intentionally not identical. `keiko gen-tests` and `keiko investigate` print a reviewable report but do not persist an evidence manifest.
- The UI can create a local runtime config during first-run setup. To list models, Keiko calls the gateway model list endpoint you configured — credentials stay in your local config.
- Keiko serves loopback only: `keiko start` and the UI validate a loopback host value, and the server always binds `127.0.0.1`. `keiko start --port <n>` sets the Port to bind (default: 1983).

## What's in 1.2

1.2 brings the integrated changes since 1.1.13 to everyday chat, connected folders and support:

- **Model-aware context.** Chat uses the selected model's available gateway metadata for context and output limits. Context displays distinguish estimates from provider-reported usage, and compaction keeps conversation history within its budget.
- **Recursive source search.** Connected folders are searched through subfolders, with cancellation and workspace boundaries preserved. Source links retain the correct folder and file identity, and coverage indicators distinguish files examined from excerpts used in the answer. Chat can draft test examples from freshly read, budgeted folder evidence and return the code for copying.
- **A report at the error.** Download a private support report directly from an error message. The report carries bounded diagnostic evidence and can be validated offline; Keiko does not send it automatically. When server evidence is unavailable, the browser can retain available client failure facts in a limited report.
- **Reliable workspace navigation.** Files and the ordinary Editor retain their selected roots through navigation and recovery. The ordinary Editor remains a manual file editor; agent actions belong to the separate Coding Workbench. Windows Git checkout binding uses canonical paths.
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
